/**
 * Velocity Engine — Rolling USDC Spend Tracking
 *
 * Prevents threshold bypass via group splitting (Attack 2).
 * Tracks cumulative USDC outflow per agent over sliding windows.
 * If the proposed spend would push the window total above the configured
 * threshold, the caller is instructed to require FIDO2 approval.
 *
 * Also implements a global "Mass Drain" circuit breaker: if total outflow
 * across ALL agents within the last hour exceeds a configured percentage
 * of declared TVL, the signing service enters fail-closed state requiring
 * manual admin override (same halt mechanism as the emergency halt flag).
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Sliding window encoding                                        │
 * │                                                                 │
 * │  Each outflow is stored in a Redis ZSET as:                     │
 * │    score  = Unix timestamp (ms)                                 │
 * │    member = "{microUsdc}:{random}"                              │
 * │                                                                 │
 * │  On query:                                                       │
 * │    ZREMRANGEBYSCORE  ← prune entries older than the window      │
 * │    ZRANGE 0 -1       ← get all members in window               │
 * │    sum(parseInt(member.split(':')[0]))  ← decode totals         │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Redis keys:
 *   x402:vel:10m:{agentId}   ZSET  per-agent 10-min window   TTL: 601s
 *   x402:vel:24h:{agentId}   ZSET  per-agent 24-hour window  TTL: 86401s
 *   x402:vel:global:1h       ZSET  global 1-hour window      TTL: 3601s
 *   x402:vel:mass-drain      STRING halt reason              (no TTL — cleared by admin)
 *
 * Environment variables:
 *   VELOCITY_THRESHOLD_10M_MICROUSDC  Per-agent 10-min ceiling  default: 50_000_000  ($50)
 *   VELOCITY_THRESHOLD_24H_MICROUSDC  Per-agent 24-hour ceiling default: 500_000_000 ($500)
 *   VELOCITY_TVL_MICROUSDC            Total Value Locked (required for mass drain)
 *   VELOCITY_MASS_DRAIN_PERCENT       % of TVL triggers halt    default: 10
 *
 * Failure mode: fail OPEN — if Redis is unavailable, velocity checks are
 * skipped and a warning is logged. This matches the existing rate limiter
 * behaviour: a Redis outage should not silently block all signing.
 */

import { getRedis } from "../services/redis.js";
import { setHalt }   from "../services/agentRegistry.js";
import { emitSecurityEvent } from "../services/securityAudit.js";
import algosdk from "algosdk";
import { config } from "../config.js";
import type { Redis } from "@upstash/redis";

// ── Policy constants ───────────────────────────────────────────────

const WIN_10M_MS  = 10  * 60 * 1_000;
const WIN_24H_MS  = 24  * 60 * 60 * 1_000;
const WIN_1H_MS   =        60 * 60 * 1_000;

const THRESHOLD_10M = BigInt(
  process.env.VELOCITY_THRESHOLD_10M_MICROUSDC ?? "50000000",   // $50
);
const THRESHOLD_24H = BigInt(
  process.env.VELOCITY_THRESHOLD_24H_MICROUSDC ?? "500000000",  // $500
);
const TVL_MICROUSDC = process.env.VELOCITY_TVL_MICROUSDC
  ? BigInt(process.env.VELOCITY_TVL_MICROUSDC)
  : null;
const MASS_DRAIN_PERCENT = BigInt(
  process.env.VELOCITY_MASS_DRAIN_PERCENT ?? "10",
);

// Amounts above this threshold require Redis to be reachable before proceeding.
// Amounts at or below it may pass through when Redis is unavailable so that
// automated test traffic and micro-payments survive a transient Redis outage.
// Default: 1_000_000 micro-USDC = $1.00.
const VELOCITY_FAIL_CLOSED_THRESHOLD = BigInt(
  process.env.VELOCITY_FAIL_CLOSED_THRESHOLD_MICROUSDC ?? "1000000",  // $1.00
);

// ── Redis key prefixes ─────────────────────────────────────────────

const KEY_10M     = "x402:vel:10m:";
const KEY_24H     = "x402:vel:24h:";
const KEY_GLOBAL  = "x402:vel:global:1h";
const KEY_DRAIN   = "x402:vel:mass-drain";

// ── Types ──────────────────────────────────────────────────────────

export interface VelocityResult {
  /** true = this spend, added to the window, would cross the threshold */
  requiresApproval:  boolean;
  /**
   * true = Redis was unreachable AND the proposed amount exceeds
   * VELOCITY_FAIL_CLOSED_THRESHOLD. Caller must return HTTP 503.
   * Never set when requiresApproval is true.
   */
  serviceUnavailable?: boolean;
  /** Current 10-minute window total BEFORE this proposed spend */
  tenMinTotal:       bigint;
  /** Current 24-hour window total BEFORE this proposed spend */
  dayTotal:          bigint;
  /** Configured 10-minute ceiling */
  threshold10m:      bigint;
  /** Configured 24-hour ceiling */
  threshold24h:      bigint;
  /**
   * Opaque key returned by checkAndReserveVelocity when the spend was
   * atomically reserved. Pass this to rollbackVelocityReservation if the
   * subsequent pipeline execution fails so the reservation is released.
   * Undefined when requiresApproval=true (no reservation was made).
   */
  reservationKey?:   string;
}

// ── Atomic check+reserve Lua script ───────────────────────────────
//
// Executes entirely on the Redis server — no round-trips between check
// and write. Prevents multi-region concurrent requests from both passing
// the velocity check before either writes.
//
// Arguments passed as strings (Lua tonumber() handles conversion):
//   KEYS[1]  key_10m        per-agent 10-min ZSET key
//   KEYS[2]  key_24h        per-agent 24-hour ZSET key
//   ARGV[1]  now_ms         current Unix time in milliseconds
//   ARGV[2]  win10m_start   10-min window start (now - 600000)
//   ARGV[3]  win24h_start   24-hour window start (now - 86400000)
//   ARGV[4]  amount         proposed spend in microUSDC (integer string)
//   ARGV[5]  thresh10m      10-min threshold in microUSDC
//   ARGV[6]  thresh24h      24-hour threshold in microUSDC
//   ARGV[7]  ttl10m_s       TTL for 10-min key in seconds
//   ARGV[8]  ttl24h_s       TTL for 24-hour key in seconds
//   ARGV[9]  member_suffix  random suffix for unique ZSET member key
//
// Returns: [requiresApproval, sum10m, sum24h]
//   requiresApproval: 0 = OK (spend reserved), 1 = rejected
//   sum10m/sum24h: window totals BEFORE this spend (as integers)
//
// Note: Lua numbers are 64-bit doubles. All microUSDC values fit safely
// within 2^53 (max $90 trillion), so no precision loss occurs.
const RESERVE_LUA_SCRIPT = `
local key10m        = KEYS[1]
local key24h        = KEYS[2]
local now           = tonumber(ARGV[1])
local win10m_start  = tonumber(ARGV[2])
local win24h_start  = tonumber(ARGV[3])
local amount        = tonumber(ARGV[4])
local thresh10m     = tonumber(ARGV[5])
local thresh24h     = tonumber(ARGV[6])
local ttl10m        = tonumber(ARGV[7])
local ttl24h        = tonumber(ARGV[8])
local suffix        = ARGV[9]

-- Prune expired entries and sum 10-min window
redis.call('ZREMRANGEBYSCORE', key10m, 0, win10m_start)
local members10m = redis.call('ZRANGE', key10m, 0, -1)
local sum10m = 0
for _, m in ipairs(members10m) do
  local colon = string.find(m, ':')
  if colon then
    local amt = tonumber(string.sub(m, 1, colon - 1))
    if amt then sum10m = sum10m + amt end
  end
end

-- Prune expired entries and sum 24-hour window
redis.call('ZREMRANGEBYSCORE', key24h, 0, win24h_start)
local members24h = redis.call('ZRANGE', key24h, 0, -1)
local sum24h = 0
for _, m in ipairs(members24h) do
  local colon = string.find(m, ':')
  if colon then
    local amt = tonumber(string.sub(m, 1, colon - 1))
    if amt then sum24h = sum24h + amt end
  end
end

-- Check thresholds (before recording)
if (sum10m + amount > thresh10m) or (sum24h + amount > thresh24h) then
  return {1, sum10m, sum24h}
end

-- Atomically reserve the spend in both windows
local member = tostring(amount) .. ':' .. suffix
redis.call('ZADD', key10m, now, member)
redis.call('EXPIRE', key10m, ttl10m)
redis.call('ZADD', key24h, now, member)
redis.call('EXPIRE', key24h, ttl24h)

return {0, sum10m, sum24h}
`;

// ── ZSET window helpers (used by global/mass-drain path) ──────────

/** Prune old entries and return the sum of all amounts in the window. */
async function getWindowSum(
  redis:    Redis,
  key:      string,
  windowMs: number,
): Promise<bigint> {
  const now         = Date.now();
  const windowStart = now - windowMs;

  await redis.zremrangebyscore(key, 0, windowStart);

  const members = await redis.zrange(key, 0, -1) as string[];
  let total = 0n;
  for (const member of members) {
    const amountStr = member.split(":")[0];
    if (amountStr) total += BigInt(amountStr);
  }
  return total;
}

/** Record a spend into a single ZSET window. Used by the global window only. */
async function addToWindow(
  redis:           Redis,
  key:             string,
  windowMs:        number,
  amountMicroUsdc: bigint,
): Promise<void> {
  const now    = Date.now();
  const ttlS   = Math.ceil(windowMs / 1_000) + 1;
  const random = Math.random().toString(36).slice(2, 10);
  const member = `${amountMicroUsdc}:${random}`;

  await redis.zadd(key, { score: now, member });
  await redis.expire(key, ttlS);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Sum USDC axfer amounts from unsigned transaction blobs.
 *
 * Unlike the strict decodeAxferTotal in custodyManager (which rejects
 * zero-value / wrong-sender axfers), this variant is lenient — it just
 * totals USDC axfers and ignores everything else. Suitable for accounting.
 * Does not throw on non-USDC or non-axfer transactions.
 */
export function sumUsdcAxfers(unsignedTxns: string[]): bigint {
  const usdcAssetId = BigInt(config.x402.usdcAssetId);
  let total = 0n;
  for (const b64 of unsignedTxns) {
    try {
      const blob = new Uint8Array(Buffer.from(b64, "base64"));
      const txn  = algosdk.decodeUnsignedTransaction(blob);
      if (
        txn.type === algosdk.TransactionType.axfer &&
        txn.assetTransfer?.assetIndex === usdcAssetId &&
        txn.assetTransfer.amount > 0n
      ) {
        total += txn.assetTransfer.amount;
      }
    } catch {
      // Malformed blob — skip; validation layer catches these separately
    }
  }
  return total;
}

/**
 * Atomically check whether a proposed USDC spend would exceed either rolling
 * window threshold, and if not, reserve the spend in both per-agent windows
 * in the same Redis round-trip via a Lua script.
 *
 * This eliminates the check-then-act race condition where two concurrent
 * requests from different region instances could both pass the velocity check
 * before either records its spend, effectively doubling the allowed throughput.
 *
 * On success (requiresApproval=false):
 *   - The spend is immediately recorded in the 10m and 24h windows.
 *   - `reservationKey` is returned for use with rollbackVelocityReservation()
 *     if the subsequent pipeline execution fails.
 *   - Call recordGlobalOutflow() after successful on-chain settlement.
 *
 * On rejection (requiresApproval=true):
 *   - Nothing is written to Redis.
 *   - VELOCITY_APPROVAL_REQUIRED security event is emitted.
 *
 * Fails OPEN on Redis error — a Redis outage should not silently halt signing.
 */
export async function checkAndReserveVelocity(
  agentId:           string,
  proposedMicroUsdc: bigint,
): Promise<VelocityResult> {
  const redis = getRedis();
  if (!redis) {
    if (proposedMicroUsdc > VELOCITY_FAIL_CLOSED_THRESHOLD) {
      console.error(
        `[VelocityEngine] Redis unavailable and proposed spend ${proposedMicroUsdc} micro-USDC ` +
        `exceeds fail-closed threshold ${VELOCITY_FAIL_CLOSED_THRESHOLD} — returning 503`,
      );
      return {
        requiresApproval:  false,
        serviceUnavailable: true,
        tenMinTotal:       0n,
        dayTotal:          0n,
        threshold10m:      THRESHOLD_10M,
        threshold24h:      THRESHOLD_24H,
      };
    }
    console.warn(
      `[VelocityEngine] Redis unavailable — skipping velocity check ` +
      `(amount ${proposedMicroUsdc} within micro-threshold ${VELOCITY_FAIL_CLOSED_THRESHOLD})`,
    );
    return {
      requiresApproval: false,
      tenMinTotal:      0n,
      dayTotal:         0n,
      threshold10m:     THRESHOLD_10M,
      threshold24h:     THRESHOLD_24H,
    };
  }

  const now           = Date.now();
  const win10mStart   = now - WIN_10M_MS;
  const win24hStart   = now - WIN_24H_MS;
  const ttl10mS       = Math.ceil(WIN_10M_MS  / 1_000) + 1;
  const ttl24hS       = Math.ceil(WIN_24H_MS  / 1_000) + 1;
  const memberSuffix  = Math.random().toString(36).slice(2, 12);
  const key10m        = `${KEY_10M}${agentId}`;
  const key24h        = `${KEY_24H}${agentId}`;
  const amountNum     = Number(proposedMicroUsdc); // safe: max realistic value << 2^53

  try {
    // One atomic round-trip: prune + sum + conditional write
    const result = await (redis as unknown as {
      eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
    }).eval(RESERVE_LUA_SCRIPT, [key10m, key24h], [
      now, win10mStart, win24hStart,
      amountNum,
      Number(THRESHOLD_10M), Number(THRESHOLD_24H),
      ttl10mS, ttl24hS,
      memberSuffix,
    ]);

    // Lua returns [requiresApproval, sum10m, sum24h] as an array of integers
    const [requiresApprovalInt, sum10mNum, sum24hNum] = result as [number, number, number];

    const requiresApproval = requiresApprovalInt === 1;
    const tenMinTotal      = BigInt(Math.round(sum10mNum));
    const dayTotal         = BigInt(Math.round(sum24hNum));

    if (requiresApproval) {
      const wouldExceed10m = (tenMinTotal + proposedMicroUsdc) > THRESHOLD_10M;
      const wouldExceed24h = (dayTotal    + proposedMicroUsdc) > THRESHOLD_24H;
      emitSecurityEvent({
        type:    "VELOCITY_APPROVAL_REQUIRED",
        agentId,
        detail: {
          proposedMicroUsdc: proposedMicroUsdc.toString(),
          tenMinTotal:       tenMinTotal.toString(),
          dayTotal:          dayTotal.toString(),
          threshold10m:      THRESHOLD_10M.toString(),
          threshold24h:      THRESHOLD_24H.toString(),
          exceeded10m:       wouldExceed10m,
          exceeded24h:       wouldExceed24h,
        },
        timestamp: new Date().toISOString(),
      });
      return { requiresApproval: true, tenMinTotal, dayTotal, threshold10m: THRESHOLD_10M, threshold24h: THRESHOLD_24H };
    }

    // Spend was reserved — return the member key for potential rollback
    const reservationKey = `${amountNum}:${memberSuffix}`;
    return {
      requiresApproval: false,
      tenMinTotal,
      dayTotal,
      threshold10m:   THRESHOLD_10M,
      threshold24h:   THRESHOLD_24H,
      reservationKey,
    };

  } catch (err) {
    console.error(
      "[VelocityEngine] Lua eval error:",
      err instanceof Error ? err.message : err,
    );
    if (proposedMicroUsdc > VELOCITY_FAIL_CLOSED_THRESHOLD) {
      return {
        requiresApproval:  false,
        serviceUnavailable: true,
        tenMinTotal:       0n,
        dayTotal:          0n,
        threshold10m:      THRESHOLD_10M,
        threshold24h:      THRESHOLD_24H,
      };
    }
    return {
      requiresApproval: false,
      tenMinTotal:      0n,
      dayTotal:         0n,
      threshold10m:     THRESHOLD_10M,
      threshold24h:     THRESHOLD_24H,
    };
  }
}

/**
 * Remove a velocity reservation from the per-agent windows.
 *
 * Call this when the pipeline execution fails AFTER a successful
 * checkAndReserveVelocity call. This releases the reserved spend so
 * the agent's velocity window accurately reflects actual settlements.
 *
 * Best-effort: never throws. If Redis is unavailable, the reservation
 * expires naturally at the end of the window TTL.
 */
export async function rollbackVelocityReservation(
  agentId:        string,
  reservationKey: string,
): Promise<void> {
  if (!reservationKey) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key10m = `${KEY_10M}${agentId}`;
    const key24h = `${KEY_24H}${agentId}`;
    await Promise.all([
      redis.zrem(key10m, reservationKey),
      redis.zrem(key24h, reservationKey),
    ]);
  } catch (err) {
    console.error(
      "[VelocityEngine] Failed to rollback reservation — window may overcount until expiry:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Record a confirmed outflow into the global 1-hour window and check
 * the mass drain threshold.
 *
 * Call this AFTER successful on-chain settlement when using
 * checkAndReserveVelocity (which already handles per-agent windows).
 * Per-agent windows are already updated atomically by the reservation —
 * do not call recordOutflow() for the per-agent windows again.
 *
 * Best-effort: never throws. Redis errors are logged and swallowed.
 */
export async function recordGlobalOutflow(
  agentId:   string,
  microUsdc: bigint,
): Promise<void> {
  if (microUsdc <= 0n) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    await addToWindow(redis, KEY_GLOBAL, WIN_1H_MS, microUsdc);
  } catch (err) {
    console.error("[VelocityEngine] Failed to record global outflow:", err instanceof Error ? err.message : err);
    return;
  }

  await checkMassDrain(agentId, microUsdc);
}

/**
 * @deprecated Use checkAndReserveVelocity() + rollbackVelocityReservation()
 * + recordGlobalOutflow() instead for atomic multi-region safe operation.
 *
 * Legacy read-only velocity check — does NOT atomically reserve the spend.
 * Retained for backward compatibility; do not use in new code paths.
 */
export async function checkVelocity(
  agentId:           string,
  proposedMicroUsdc: bigint,
): Promise<VelocityResult> {
  return checkAndReserveVelocity(agentId, proposedMicroUsdc);
}

/**
 * @deprecated Use recordGlobalOutflow() when paired with checkAndReserveVelocity().
 *
 * Records confirmed outflow into per-agent AND global windows.
 * Safe to call standalone when not using checkAndReserveVelocity
 * (e.g. historical backfill or legacy integrations), but will double-count
 * per-agent windows if called after checkAndReserveVelocity().
 */
export async function recordOutflow(
  agentId:   string,
  microUsdc: bigint,
): Promise<void> {
  if (microUsdc <= 0n) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    await Promise.all([
      addToWindow(redis, `${KEY_10M}${agentId}`, WIN_10M_MS, microUsdc),
      addToWindow(redis, `${KEY_24H}${agentId}`, WIN_24H_MS, microUsdc),
      addToWindow(redis, KEY_GLOBAL,             WIN_1H_MS,  microUsdc),
    ]);
  } catch (err) {
    console.error("[VelocityEngine] Failed to record outflow:", err instanceof Error ? err.message : err);
    return;
  }

  await checkMassDrain(agentId, microUsdc);
}

/**
 * Check whether the global 1-hour outflow has exceeded the mass drain threshold.
 *
 * Threshold = TVL × MASS_DRAIN_PERCENT / 100
 *
 * If exceeded:
 *   1. Emit MASS_DRAIN_DETECTED security event
 *   2. Set the emergency halt flag (blocks all signing)
 *   3. Store a halt reason in x402:vel:mass-drain
 *
 * Silently skips if VELOCITY_TVL_MICROUSDC is not configured.
 * Fails silently on Redis error — mass drain detection is best-effort.
 */
async function checkMassDrain(triggerAgentId: string, lastSpend: bigint): Promise<void> {
  if (!TVL_MICROUSDC || TVL_MICROUSDC <= 0n) return; // not configured

  const redis = getRedis();
  if (!redis) return;

  try {
    // Check if mass drain halt is already active
    const existing = await redis.get(KEY_DRAIN) as string | null;
    if (existing) return; // already halted — no need to re-emit

    const globalTotal = await getWindowSum(redis, KEY_GLOBAL, WIN_1H_MS);
    const massDrainThreshold = (TVL_MICROUSDC * MASS_DRAIN_PERCENT) / 100n;

    if (globalTotal < massDrainThreshold) return; // below threshold

    const reason =
      `MASS_DRAIN: global 1h outflow ${globalTotal} microUSDC ` +
      `exceeds ${MASS_DRAIN_PERCENT}% of TVL (${massDrainThreshold} microUSDC). ` +
      `Triggered by agent ${triggerAgentId} spend of ${lastSpend} microUSDC. ` +
      `Manual admin override required.`;

    // Set mass drain marker (no TTL — requires manual clear)
    await redis.set(KEY_DRAIN, reason);

    emitSecurityEvent({
      type:    "MASS_DRAIN_DETECTED",
      agentId: triggerAgentId,
      detail: {
        globalTotalMicroUsdc:     globalTotal.toString(),
        massDrainThresholdMicroUsdc: massDrainThreshold.toString(),
        tvlMicroUsdc:             TVL_MICROUSDC.toString(),
        massDrainPercent:         MASS_DRAIN_PERCENT.toString(),
        lastSpendMicroUsdc:       lastSpend.toString(),
      },
      timestamp: new Date().toISOString(),
    });

    // Set the emergency halt flag — blocks all signing immediately
    await setHalt(reason);

    console.error(
      `[VelocityEngine] MASS DRAIN DETECTED — signing halted. ` +
      `Global 1h outflow: ${globalTotal} microUSDC. ` +
      `Threshold: ${massDrainThreshold} microUSDC.`,
    );
  } catch (err) {
    console.error("[VelocityEngine] Mass drain check error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Check whether the mass drain halt is currently active.
 * Separate from the emergency halt flag so operators can distinguish the cause.
 */
export async function getMassDrainStatus(): Promise<{ active: boolean; reason: string | null }> {
  const redis = getRedis();
  if (!redis) return { active: false, reason: null };

  const reason = await redis.get(KEY_DRAIN) as string | null;
  return { active: !!reason, reason };
}

/**
 * Clear the mass drain halt. Call after manual review.
 * Does NOT clear the global emergency halt — that must be cleared separately
 * via POST /api/system/unhalt.
 */
export async function clearMassDrain(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(KEY_DRAIN);
  console.log("[VelocityEngine] Mass drain marker cleared");
}
