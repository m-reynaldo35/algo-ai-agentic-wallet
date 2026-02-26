import { getRedis } from "../services/redis.js";

/**
 * Signing Audit Log — structured, append-only record of every signing attempt.
 *
 * Redis schema:
 *   x402:signing-log              → Sorted set, score = epoch ms, member = SigningAuditEntry JSON
 *   x402:signing-metrics:total    → Integer counter (all-time signing requests)
 *   x402:signing-metrics:rejected → Integer counter (all-time rejections)
 *   x402:signing-metrics:hourly   → Sorted set, score = epoch ms (1h rolling window)
 *
 * Retention: 7 days (capped at 10,000 entries via ZREMRANGEBYRANK).
 */

export type SigningOutcome = "signed" | "rejected";

export interface SigningAuditEntry {
  requestId: string;
  agentId: string;
  groupId: string;           // base64 group ID from the unsigned transactions
  txnCount: number;
  outcome: SigningOutcome;
  rejectionReason?: string;  // set when outcome === "rejected"
  durationMs: number;        // wall-clock time from request receipt to response
  requestedAt: string;       // ISO 8601
  signerAddress: string;
  cohort: string;
}

const LOG_KEY      = "x402:signing-log";
const HOURLY_KEY   = "x402:signing-metrics:hourly";
const TOTAL_KEY    = "x402:signing-metrics:total";
const REJECTED_KEY = "x402:signing-metrics:rejected";
const MAX_LOG_SIZE = 10_000;
const HOURLY_TTL   = 3_600_000; // 1 hour in ms

export async function writeSigningAudit(entry: SigningAuditEntry): Promise<void> {
  // ── Stdout rejection log (synchronous — Railway log drain primary signal) ──
  //
  // Emit before the Redis write so rejections are visible even if Redis is down.
  // Logged fields are safe for operational logs:
  //   ✓ requestId prefix   — correlation handle (not the full UUID)
  //   ✓ agentId            — Algorand public address, on-chain identifier
  //   ✓ groupId prefix     — partial group hash for txn correlation
  //   ✓ reason             — human-readable rejection code from the pipeline step
  //   ✓ signerAddress      — public address of this signer
  //   ✓ timestamp          — ISO 8601 from request receipt
  //   ✗ full transaction blobs  — never logged
  //   ✗ bearer tokens           — never logged
  //   ✗ signatures              — never logged
  //   ✗ private keys            — never logged
  if (entry.outcome === "rejected") {
    console.warn("[SigningRejection]", JSON.stringify({
      requestId_prefix: entry.requestId.slice(0, 8),
      agentId:          entry.agentId  || "unknown",
      groupId_prefix:   entry.groupId  ? entry.groupId.slice(0, 12) : "none",
      reason:           (entry.rejectionReason ?? "unknown").slice(0, 200),
      signerAddress:    entry.signerAddress,
      cohort:           entry.cohort,
      timestamp:        entry.requestedAt,
    }));
  }

  const redis = getRedis();
  if (!redis) return; // Redis audit is best-effort — never block signing

  const now    = Date.now();
  const member = JSON.stringify(entry);

  try {
    await Promise.all([
      // Append to time-sorted log, cap at MAX_LOG_SIZE
      redis.zadd(LOG_KEY, { score: now, member })
        .then(() => redis.zremrangebyrank(LOG_KEY, 0, -(MAX_LOG_SIZE + 1))),

      // Rolling 1-hour window for throughput metrics
      redis.zadd(HOURLY_KEY, { score: now, member: entry.requestId })
        .then(() => redis.zremrangebyscore(HOURLY_KEY, 0, now - HOURLY_TTL)),

      // All-time counters
      redis.incr(TOTAL_KEY),
      entry.outcome === "rejected" ? redis.incr(REJECTED_KEY) : Promise.resolve(),
    ]);
  } catch {
    // Never let audit failure surface to the caller
  }
}

export async function getSigningMetrics(): Promise<{
  totalRequests: number;
  totalRejections: number;
  requestsLastHour: number;
  recentEntries: SigningAuditEntry[];
}> {
  const redis = getRedis();
  if (!redis) {
    return { totalRequests: 0, totalRejections: 0, requestsLastHour: 0, recentEntries: [] };
  }

  const now = Date.now();

  const [total, rejected, hourlyCount, recentRaw] = await Promise.all([
    redis.get(TOTAL_KEY) as Promise<string | null>,
    redis.get(REJECTED_KEY) as Promise<string | null>,
    redis.zcount(HOURLY_KEY, now - HOURLY_TTL, now),
    redis.zrange(LOG_KEY, -20, -1) as Promise<string[]>, // last 20 entries
  ]);

  const recentEntries = (recentRaw ?? [])
    .map((r) => { try { return JSON.parse(r) as SigningAuditEntry; } catch { return null; } })
    .filter((e): e is SigningAuditEntry => e !== null)
    .reverse();

  return {
    totalRequests:    parseInt(total ?? "0", 10),
    totalRejections:  parseInt(rejected ?? "0", 10),
    requestsLastHour: Number(hourlyCount),
    recentEntries,
  };
}
