/**
 * Recipient Anomaly Detector — Transaction Recipient Monitoring
 *
 * Tracks every non-treasury address that appears as a recipient in a
 * signed transaction. Emits security alerts for patterns that may
 * indicate an active drain attempt:
 *
 *   Pattern 1 — New address, high value
 *     A recipient address never seen before (or seen < 24h ago)
 *     receiving above ANOMALY_NEW_ADDR_THRESHOLD_ALGO microALGO or
 *     ANOMALY_NEW_ADDR_THRESHOLD_USDC microUSDC in a single batch.
 *
 *   Pattern 2 — Single address daily cap
 *     Any single address receiving more than ANOMALY_SINGLE_ADDR_DAILY_ALGO
 *     microALGO or ANOMALY_SINGLE_ADDR_DAILY_USDC microUSDC in one UTC day.
 *     Catches slow-drains that stay under per-batch thresholds.
 *
 *   Pattern 3 — Scattershot drain
 *     More than ANOMALY_MAX_NEW_ADDRS_PER_HOUR unique NEW recipient
 *     addresses seen within a rolling 60-minute window. Signature of
 *     an attacker fanning out funds to many fresh wallets.
 *
 * Treasury address (X402_PAY_TO_ADDRESS) is always excluded — it is
 * the expected and legitimate recipient for x402 toll payments.
 *
 * Failure mode: FAIL OPEN — anomaly detection is never allowed to
 * block signing. If Redis is unavailable or an error occurs, a warning
 * is logged and signing proceeds. Use the treasury outflow guard and
 * velocity engine for hard blocking controls.
 *
 * Redis keys:
 *   x402:recipient:{addr}:first_seen         STRING  Unix ms (SET NX, no TTL)
 *   x402:recipient:{addr}:daily:{YYYY-MM-DD} STRING  microUSDC+ALGO total (INCRBY, TTL 48h)
 *   x402:recipient:new-addrs:1h              ZSET    timestamps of new addr sightings (TTL 3601s)
 *
 * Environment variables:
 *   ANOMALY_NEW_ADDR_THRESHOLD_ALGO    microALGO to new addr triggers alert (default: 1_000_000 = 1 ALGO)
 *   ANOMALY_NEW_ADDR_THRESHOLD_USDC    microUSDC to new addr triggers alert (default: 5_000_000 = $5)
 *   ANOMALY_SINGLE_ADDR_DAILY_ALGO     max microALGO to any one addr per day (default: 10_000_000 = 10 ALGO)
 *   ANOMALY_SINGLE_ADDR_DAILY_USDC     max microUSDC to any one addr per day (default: 50_000_000 = $50)
 *   ANOMALY_MAX_NEW_ADDRS_PER_HOUR     max new recipients per 60 min before scattershot alert (default: 20)
 *   ANOMALY_AUTO_HALT                  "true" to halt on any anomaly detection (default: false)
 *
 * Module 4 — Treasury Hardening (Recipient Anomaly Detection)
 */

import { getRedis } from "../services/redis.js";
import { setHalt }   from "../services/agentRegistry.js";
import { emitSecurityEvent } from "../services/securityAudit.js";

// ── Policy constants ───────────────────────────────────────────────

const NEW_ADDR_THRESHOLD_ALGO = BigInt(
  process.env.ANOMALY_NEW_ADDR_THRESHOLD_ALGO ?? "1000000",   // 1 ALGO
);
const NEW_ADDR_THRESHOLD_USDC = BigInt(
  process.env.ANOMALY_NEW_ADDR_THRESHOLD_USDC ?? "5000000",   // $5
);
const SINGLE_ADDR_DAILY_ALGO = BigInt(
  process.env.ANOMALY_SINGLE_ADDR_DAILY_ALGO ?? "10000000",   // 10 ALGO
);
const SINGLE_ADDR_DAILY_USDC = BigInt(
  process.env.ANOMALY_SINGLE_ADDR_DAILY_USDC ?? "50000000",   // $50
);
const MAX_NEW_ADDRS_PER_HOUR = parseInt(
  process.env.ANOMALY_MAX_NEW_ADDRS_PER_HOUR ?? "20", 10,
);
const AUTO_HALT = process.env.ANOMALY_AUTO_HALT === "true";

const ONE_HOUR_MS = 60 * 60 * 1_000;
const DAY_TTL_S   = 48 * 60 * 60;

// ── Redis key helpers ──────────────────────────────────────────────

function firstSeenKey(addr: string): string {
  return `x402:recipient:${addr}:first_seen`;
}

function dailyKey(addr: string): string {
  const day = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return `x402:recipient:${addr}:daily:${day}`;
}

const NEW_ADDRS_HOUR_KEY = "x402:recipient:new-addrs:1h";

// ── Anomaly handling ───────────────────────────────────────────────

interface Anomaly {
  pattern:    "NEW_ADDR_HIGH_VALUE" | "SINGLE_ADDR_DAILY_CAP" | "SCATTERSHOT_DRAIN";
  addr:       string;
  microAlgo?: bigint;
  microUsdc?: bigint;
  detail:     Record<string, unknown>;
}

async function handleAnomaly(anomaly: Anomaly, agentId: string): Promise<void> {
  const detail = {
    ...anomaly.detail,
    addr:     anomaly.addr,
    agentId,
    autoHalt: AUTO_HALT,
  };

  emitSecurityEvent({
    type:    "RECIPIENT_ANOMALY",
    agentId,
    detail,
    timestamp: new Date().toISOString(),
  });

  console.warn(
    `[RecipientAnomalyDetector] ${anomaly.pattern}: addr=${anomaly.addr} agent=${agentId}`,
    anomaly.detail,
  );

  if (AUTO_HALT) {
    const reason = `RECIPIENT_ANOMALY:${anomaly.pattern}: addr=${anomaly.addr} agent=${agentId}`;
    await setHalt(reason);
    console.error(`[RecipientAnomalyDetector] Auto-halt triggered: ${reason}`);
  }
}

// ── Core ───────────────────────────────────────────────────────────

/**
 * Asynchronously check a list of non-treasury recipient addresses for
 * anomalous patterns. Called from signAtomicGroup after signing — never
 * blocks the signing pipeline (fire-and-forget with error swallowing).
 *
 * @param addresses   Non-treasury recipient addresses in this signing batch
 * @param microAlgo   Total microALGO in this batch (for threshold checks)
 * @param microUsdc   Total microUSDC in this batch (for threshold checks)
 * @param agentId     Agent that triggered this batch (for audit events)
 */
export async function checkRecipients(
  addresses:  string[],
  microAlgo:  bigint,
  microUsdc:  bigint,
  agentId:    string,
): Promise<void> {
  if (!addresses.length) return;

  const redis = getRedis();
  if (!redis) {
    console.warn("[RecipientAnomalyDetector] Redis unavailable — skipping recipient checks");
    return;
  }

  const now = Date.now();
  const uniqueAddrs = [...new Set(addresses)];

  try {
    for (const addr of uniqueAddrs) {
      const fsKey   = firstSeenKey(addr);
      const dKey    = dailyKey(addr);

      // ── Pattern 1: New address high-value check ──────────────
      // SET NX returns the value if newly set, null if already existed.
      const setResult = await redis.set(fsKey, String(now), { nx: true });
      const isNew     = setResult !== null; // null = key already existed

      if (isNew) {
        // Track in the 1h scattershot window
        await redis.zadd(NEW_ADDRS_HOUR_KEY, { score: now, member: `${now}:${addr}` });
        await redis.expire(NEW_ADDRS_HOUR_KEY, Math.ceil(ONE_HOUR_MS / 1_000) + 1);
      } else {
        // Check if it was first seen < 24h ago
        const firstSeenMs = await redis.get(fsKey) as string | null;
        const isRecent = firstSeenMs ? (now - Number(firstSeenMs)) < 24 * 60 * 60 * 1_000 : false;
        if (isRecent && isNew === false) {
          // It's still within the 24h "new" window — treat it as new for high-value check
          if (microAlgo > NEW_ADDR_THRESHOLD_ALGO || microUsdc > NEW_ADDR_THRESHOLD_USDC) {
            await handleAnomaly({
              pattern:  "NEW_ADDR_HIGH_VALUE",
              addr,
              microAlgo,
              microUsdc,
              detail: {
                firstSeenMs,
                ageHours:         ((now - Number(firstSeenMs)) / 3_600_000).toFixed(1),
                microAlgo:        microAlgo.toString(),
                microUsdc:        microUsdc.toString(),
                thresholdAlgo:    NEW_ADDR_THRESHOLD_ALGO.toString(),
                thresholdUsdc:    NEW_ADDR_THRESHOLD_USDC.toString(),
              },
            }, agentId);
          }
        }
      }

      // New address with high value
      if (isNew && (microAlgo > NEW_ADDR_THRESHOLD_ALGO || microUsdc > NEW_ADDR_THRESHOLD_USDC)) {
        await handleAnomaly({
          pattern:  "NEW_ADDR_HIGH_VALUE",
          addr,
          microAlgo,
          microUsdc,
          detail: {
            newAddress:    true,
            microAlgo:     microAlgo.toString(),
            microUsdc:     microUsdc.toString(),
            thresholdAlgo: NEW_ADDR_THRESHOLD_ALGO.toString(),
            thresholdUsdc: NEW_ADDR_THRESHOLD_USDC.toString(),
          },
        }, agentId);
      }

      // ── Pattern 2: Single address daily cap ──────────────────
      const prevDaily = await redis.get(dKey) as string | null;
      const prevTotal = prevDaily ? BigInt(prevDaily) : 0n;

      // We store combined (algo + usdc) in microUSDC-equivalent for simplicity.
      // This is a heuristic; precise multi-asset accounting is in velocityEngine.
      const batchTotal = microAlgo + microUsdc;
      const newTotal   = prevTotal + batchTotal;

      await redis.incrby(dKey, Number(batchTotal));
      await redis.expire(dKey, DAY_TTL_S);

      if (
        (microAlgo > 0n && (prevTotal + microAlgo) > SINGLE_ADDR_DAILY_ALGO) ||
        (microUsdc > 0n && (prevTotal + microUsdc) > SINGLE_ADDR_DAILY_USDC)
      ) {
        await handleAnomaly({
          pattern:  "SINGLE_ADDR_DAILY_CAP",
          addr,
          microAlgo,
          microUsdc,
          detail: {
            prevDailyTotal:  prevTotal.toString(),
            newDailyTotal:   newTotal.toString(),
            microAlgo:       microAlgo.toString(),
            microUsdc:       microUsdc.toString(),
            capAlgo:         SINGLE_ADDR_DAILY_ALGO.toString(),
            capUsdc:         SINGLE_ADDR_DAILY_USDC.toString(),
          },
        }, agentId);
      }
    }

    // ── Pattern 3: Scattershot drain (many new recipients) ────
    await redis.zremrangebyscore(NEW_ADDRS_HOUR_KEY, 0, now - ONE_HOUR_MS);
    const newAddrCount = (await redis.zcard(NEW_ADDRS_HOUR_KEY)) as number;

    if (newAddrCount > MAX_NEW_ADDRS_PER_HOUR) {
      await handleAnomaly({
        pattern:  "SCATTERSHOT_DRAIN",
        addr:     uniqueAddrs.join(","),
        microAlgo,
        microUsdc,
        detail: {
          newAddrCountLastHour: newAddrCount,
          maxAllowed:           MAX_NEW_ADDRS_PER_HOUR,
          latestAddresses:      uniqueAddrs,
        },
      }, agentId);
    }

  } catch (err) {
    // Never allow anomaly detection to surface as a signing error
    console.error(
      "[RecipientAnomalyDetector] Error during check:",
      err instanceof Error ? err.message : err,
    );
  }
}
