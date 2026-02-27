/**
 * Treasury Outflow Guard — Global Daily Signing Cap
 *
 * Tracks cumulative ALGO and USDC signed by the signing service across
 * ALL agents within a rolling UTC calendar day. If either daily cap is
 * reached, signing is immediately halted system-wide.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Attack scenario this guard blocks:                             │
 * │                                                                 │
 * │  1,000 agents each within their $100 / 24h mandate limit        │
 * │  = $100,000 total drain without this guard                      │
 * │  = hard-stopped at TREASURY_DAILY_CAP_USDC with this guard      │
 * │                                                                 │
 * │  This is a SECOND LINE of defence. The per-agent velocity       │
 * │  windows in velocityEngine.ts prevent individual agents from     │
 * │  overspending. This guard prevents the AGGREGATE of all agents   │
 * │  from exceeding a global ceiling even when each is under limit.  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Atomicity guarantee                                            │
 * │                                                                 │
 * │  Uses a Lua script for atomic INCRBY+check+DECRBY (rollback).   │
 * │  The script runs entirely on the Redis server in a single       │
 * │  round-trip — no check-then-act race between concurrent         │
 * │  multi-region instances.                                        │
 * │                                                                 │
 * │  If INCRBY pushes either counter past its cap:                  │
 * │    → both keys are decremented back (rollback inside Lua)       │
 * │    → pre-increment totals are returned for the error message    │
 * │    → setHalt() is called to block all further signing           │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Rollback:
 *   checkAndRecordOutflow() returns a `reservationKey` on success.
 *   If the downstream pipeline fails (signing or broadcast), call
 *   rollbackOutflow(reservationKey) to release the reservation so
 *   the cap accurately reflects actual settled volume.
 *
 * Redis keys (UTC day boundary, TTL 48 hours):
 *   x402:treasury:outflow:algo:{YYYY-MM-DD}  microALGO signed today
 *   x402:treasury:outflow:usdc:{YYYY-MM-DD}  microUSDC signed today
 *
 * Environment variables:
 *   TREASURY_DAILY_CAP_ALGO   Max microALGO to sign per UTC day
 *                             Default: 10_000_000_000 (10,000 ALGO)
 *   TREASURY_DAILY_CAP_USDC   Max microUSDC to sign per UTC day
 *                             Default: 50_000_000_000 ($50,000 USDC)
 *
 * Failure mode:
 *   - Redis unavailable + amount ≤ fail-closed threshold → FAIL OPEN (warning)
 *   - Redis unavailable + amount > fail-closed threshold → FAIL CLOSED (503)
 *   - Redis error during check → FAIL OPEN (logs error)
 *
 * Module 1 — Treasury Hardening
 */

import { getRedis } from "../services/redis.js";
import { setHalt }   from "../services/agentRegistry.js";
import { emitSecurityEvent } from "../services/securityAudit.js";

// ── Policy constants ───────────────────────────────────────────────

const ALGO_MICRO = 1_000_000n;
const USDC_MICRO = 1_000_000n;

const DAILY_CAP_ALGO = BigInt(
  process.env.TREASURY_DAILY_CAP_ALGO ?? String(10_000n * ALGO_MICRO), // 10,000 ALGO
);
const DAILY_CAP_USDC = BigInt(
  process.env.TREASURY_DAILY_CAP_USDC ?? String(50_000n * USDC_MICRO), // $50,000
);

// Consistent with velocityEngine.ts: above this amount, fail closed when Redis is down.
const FAIL_CLOSED_THRESHOLD_USDC = BigInt(
  process.env.VELOCITY_FAIL_CLOSED_THRESHOLD_MICROUSDC ?? "1000000", // $1.00
);

// 48h TTL keeps the key alive for post-day diagnostics
const DAY_TTL_S = 48 * 60 * 60;

// ── Redis key helpers ──────────────────────────────────────────────

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function algoKey(): string { return `x402:treasury:outflow:algo:${utcDay()}`; }
function usdcKey(): string { return `x402:treasury:outflow:usdc:${utcDay()}`; }

// ── Atomic Lua script ──────────────────────────────────────────────
//
// Executes entirely on the Redis server — no round-trips between
// check and write. Prevents multi-region concurrent requests from
// both passing the cap check before either increments the counter.
//
// Algorithm:
//   1. INCRBY both keys by proposed amounts
//   2. EXPIRE both keys (refreshes TTL idempotently)
//   3. Check if either new total exceeds its cap
//   4. If exceeded → DECRBY both keys (atomic rollback), return rejection
//   5. If ok → return success with pre-increment totals
//
// Arguments:
//   KEYS[1]  aKey       ALGO counter key
//   KEYS[2]  uKey       USDC counter key
//   ARGV[1]  microAlgo  proposed ALGO spend (integer string, may be "0")
//   ARGV[2]  microUsdc  proposed USDC spend (integer string, may be "0")
//   ARGV[3]  capAlgo    daily ALGO cap (integer string)
//   ARGV[4]  capUsdc    daily USDC cap (integer string)
//   ARGV[5]  ttl        key TTL in seconds
//
// Returns: [rejected, prevAlgo, prevUsdc, exceededAlgo, exceededUsdc]
//   rejected:      0 = admitted, 1 = rejected and rolled back
//   prevAlgo/Usdc: totals BEFORE this spend (for error messages / monitoring)
//   exceededAlgo:  1 if ALGO was the trigger, 0 otherwise
//   exceededUsdc:  1 if USDC was the trigger, 0 otherwise
//
// Note: Lua numbers are 64-bit doubles. microUSDC/microALGO values up to
// ~$90T or 90B ALGO fit safely within Number.MAX_SAFE_INTEGER (2^53).
const OUTFLOW_LUA = `
local aKey     = KEYS[1]
local uKey     = KEYS[2]
local mAlgo    = tonumber(ARGV[1])
local mUsdc    = tonumber(ARGV[2])
local capAlgo  = tonumber(ARGV[3])
local capUsdc  = tonumber(ARGV[4])
local ttl      = tonumber(ARGV[5])

-- Increment both counters atomically, then check caps
local newAlgo = 0
local newUsdc = 0

if mAlgo > 0 then
  newAlgo = redis.call('INCRBY', aKey, mAlgo)
  redis.call('EXPIRE', aKey, ttl)
else
  local v = redis.call('GET', aKey)
  newAlgo = v and tonumber(v) or 0
end

if mUsdc > 0 then
  newUsdc = redis.call('INCRBY', uKey, mUsdc)
  redis.call('EXPIRE', uKey, ttl)
else
  local v = redis.call('GET', uKey)
  newUsdc = v and tonumber(v) or 0
end

-- Pre-increment totals (for error message detail)
local prevAlgo = newAlgo - mAlgo
local prevUsdc = newUsdc - mUsdc

local exceededAlgo = (mAlgo > 0 and newAlgo > capAlgo) and 1 or 0
local exceededUsdc = (mUsdc > 0 and newUsdc > capUsdc) and 1 or 0

if exceededAlgo == 1 or exceededUsdc == 1 then
  -- Atomic rollback — undo both increments
  if mAlgo > 0 then redis.call('DECRBY', aKey, mAlgo) end
  if mUsdc > 0 then redis.call('DECRBY', uKey, mUsdc) end
  return {1, prevAlgo, prevUsdc, exceededAlgo, exceededUsdc}
end

return {0, prevAlgo, prevUsdc, 0, 0}
`;

// ── Public types ───────────────────────────────────────────────────

export interface OutflowCheckResult {
  allowed: boolean;
  /** Set when Redis is unreachable and amount exceeds the fail-closed threshold. */
  serviceUnavailable?: boolean;
  /** Today's ALGO signed BEFORE this proposed batch (microALGO). */
  todayAlgo: bigint;
  /** Today's USDC signed BEFORE this proposed batch (microUSDC). */
  todayUsdc: bigint;
  capAlgo: bigint;
  capUsdc: bigint;
  /**
   * Opaque key returned on success. Pass to rollbackOutflow() if the
   * downstream pipeline fails so the cap accurately reflects actual
   * settled volume — mirrors velocityEngine's reservationKey pattern.
   * Undefined when `allowed: false`.
   */
  reservationKey?: string;
}

// ── Core check + record (atomic) ───────────────────────────────────

/**
 * Atomically check whether the proposed signing batch would breach
 * either daily cap, and if not, record the outflow in the same
 * Redis round-trip via Lua.
 *
 * Mathematical loss bound:
 *   worst-case daily loss = min(hot_wallet_balance, DAILY_CAP)
 *
 * Concurrency guarantee:
 *   The Lua script prevents the check-then-act race between concurrent
 *   multi-region instances. If two requests race: both INCRBY, one sees
 *   the total exceed the cap, rolls back atomically. The other proceeds.
 *
 * Call BEFORE signing. On `allowed: false`, abort the pipeline and log
 * the reason — the system halt is already set internally on cap breach.
 *
 * @param microAlgo  Total microALGO in this signing batch (sum of all pay txns)
 * @param microUsdc  Total microUSDC in this signing batch (sum of all axfer txns)
 */
export async function checkAndRecordOutflow(
  microAlgo: bigint,
  microUsdc: bigint,
): Promise<OutflowCheckResult> {
  const redis = getRedis();

  if (!redis) {
    if (microUsdc > FAIL_CLOSED_THRESHOLD_USDC) {
      console.error(
        `[TreasuryOutflowGuard] Redis unavailable — failing closed ` +
        `(proposed ${microUsdc} microUSDC > fail-closed threshold ${FAIL_CLOSED_THRESHOLD_USDC})`,
      );
      return { allowed: false, serviceUnavailable: true, todayAlgo: 0n, todayUsdc: 0n, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC };
    }
    console.warn("[TreasuryOutflowGuard] Redis unavailable — skipping daily cap check");
    return { allowed: true, todayAlgo: 0n, todayUsdc: 0n, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC };
  }

  const aKey = algoKey();
  const uKey = usdcKey();

  try {
    const result = await (redis as unknown as {
      eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
    }).eval(OUTFLOW_LUA, [aKey, uKey], [
      Number(microAlgo),
      Number(microUsdc),
      Number(DAILY_CAP_ALGO),
      Number(DAILY_CAP_USDC),
      DAY_TTL_S,
    ]);

    const [rejectedInt, prevAlgoNum, prevUsdcNum, exceededAlgoInt, exceededUsdcInt] =
      result as [number, number, number, number, number];

    const todayAlgo     = BigInt(Math.round(prevAlgoNum));
    const todayUsdc     = BigInt(Math.round(prevUsdcNum));
    const rejected      = rejectedInt === 1;
    const exceededAlgo  = exceededAlgoInt === 1;
    const exceededUsdc  = exceededUsdcInt === 1;

    if (rejected) {
      const reason =
        `DAILY_CAP_BREACH: ` +
        (exceededAlgo ? `ALGO today=${todayAlgo}+proposed=${microAlgo} > cap=${DAILY_CAP_ALGO} microALGO. ` : "") +
        (exceededUsdc ? `USDC today=${todayUsdc}+proposed=${microUsdc} > cap=${DAILY_CAP_USDC} microUSDC. ` : "") +
        `Manual admin override (POST /api/system/unhalt) required.`;

      emitSecurityEvent({
        type:    "DAILY_CAP_BREACH",
        agentId: "treasury-guard",
        detail: {
          todayAlgo:    todayAlgo.toString(),
          todayUsdc:    todayUsdc.toString(),
          proposedAlgo: microAlgo.toString(),
          proposedUsdc: microUsdc.toString(),
          capAlgo:      DAILY_CAP_ALGO.toString(),
          capUsdc:      DAILY_CAP_USDC.toString(),
          exceededAlgo,
          exceededUsdc,
        },
        timestamp: new Date().toISOString(),
      });

      // Auto-halt — blocks all signing across all regions immediately
      await setHalt(reason);
      console.error(`[TreasuryOutflowGuard] DAILY CAP BREACHED — signing halted: ${reason}`);

      return { allowed: false, todayAlgo, todayUsdc, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC };
    }

    // Admitted — return a reservation key for potential rollback
    const reservationKey = `${aKey}:${microAlgo}|${uKey}:${microUsdc}`;

    // Fire-and-forget: increment running totals for the on-chain monitor (Module 9).
    // These counters (x402:guardian:authorized:algo/usdc) are compared against
    // Algorand Indexer outflows to detect signing key compromise.
    // No TTL — running totals reset only by admin on incident.
    if (microAlgo > 0n) {
      redis.incrby("x402:guardian:authorized:algo", Number(microAlgo)).catch(() => {});
    }
    if (microUsdc > 0n) {
      redis.incrby("x402:guardian:authorized:usdc", Number(microUsdc)).catch(() => {});
    }

    return { allowed: true, todayAlgo, todayUsdc, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC, reservationKey };

  } catch (err) {
    // Redis error — fail open so a transient Redis issue doesn't halt all signing
    console.error("[TreasuryOutflowGuard] Lua eval error — failing open:", err instanceof Error ? err.message : err);
    return { allowed: true, todayAlgo: 0n, todayUsdc: 0n, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC };
  }
}

// ── Rollback ───────────────────────────────────────────────────────

/**
 * Release a previously admitted outflow reservation.
 *
 * Call when the downstream pipeline fails AFTER a successful
 * checkAndRecordOutflow() — mirrors rollbackVelocityReservation()
 * in velocityEngine.ts. This ensures the daily cap tracks actual
 * settled volume rather than attempted volume.
 *
 * Best-effort: never throws. If Redis is unavailable the counters
 * will overcount until the day key expires (48h TTL).
 *
 * @param reservationKey  The `reservationKey` from OutflowCheckResult
 */
export async function rollbackOutflow(reservationKey: string | undefined): Promise<void> {
  if (!reservationKey) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    // reservationKey format: "{aKey}:{microAlgo}|{uKey}:{microUsdc}"
    const [algoPart, usdcPart] = reservationKey.split("|");
    const [aKey, microAlgoStr] = algoPart.split(/:(?=\d)/);  // split on last colon before digits
    const [uKey, microUsdcStr] = usdcPart.split(/:(?=\d)/);

    const microAlgo = BigInt(microAlgoStr ?? "0");
    const microUsdc = BigInt(microUsdcStr ?? "0");

    const ops: Promise<unknown>[] = [];
    if (microAlgo > 0n) ops.push(redis.decrby(aKey, Number(microAlgo)));
    if (microUsdc > 0n) ops.push(redis.decrby(uKey, Number(microUsdc)));
    await Promise.all(ops);

  } catch (err) {
    console.error(
      "[TreasuryOutflowGuard] Rollback failed — daily cap may overcount until key expires:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Summary ────────────────────────────────────────────────────────

/**
 * Today's outflow summary for admin / dashboard endpoints.
 * Safe to call at any time; returns zeros if Redis is unavailable.
 */
export async function getDailyOutflowSummary(): Promise<{
  todayAlgo: bigint;
  todayUsdc: bigint;
  capAlgo: bigint;
  capUsdc: bigint;
  algoUtilizationPct: number;
  usdcUtilizationPct: number;
}> {
  const redis = getRedis();
  if (!redis) {
    return {
      todayAlgo: 0n, todayUsdc: 0n,
      capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC,
      algoUtilizationPct: 0, usdcUtilizationPct: 0,
    };
  }
  try {
    const [rawAlgo, rawUsdc] = await Promise.all([
      redis.get(algoKey()) as Promise<string | null>,
      redis.get(usdcKey()) as Promise<string | null>,
    ]);
    const todayAlgo = rawAlgo ? BigInt(rawAlgo) : 0n;
    const todayUsdc = rawUsdc ? BigInt(rawUsdc) : 0n;
    return {
      todayAlgo,
      todayUsdc,
      capAlgo: DAILY_CAP_ALGO,
      capUsdc: DAILY_CAP_USDC,
      algoUtilizationPct: DAILY_CAP_ALGO > 0n ? Number((todayAlgo * 10000n) / DAILY_CAP_ALGO) / 100 : 0,
      usdcUtilizationPct: DAILY_CAP_USDC > 0n ? Number((todayUsdc * 10000n) / DAILY_CAP_USDC) / 100 : 0,
    };
  } catch {
    return { todayAlgo: 0n, todayUsdc: 0n, capAlgo: DAILY_CAP_ALGO, capUsdc: DAILY_CAP_USDC, algoUtilizationPct: 0, usdcUtilizationPct: 0 };
  }
}
