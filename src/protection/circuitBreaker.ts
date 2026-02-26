/**
 * Signer Circuit Breaker — Phase 1.5 Operational Hardening
 *
 * Protects against RPC failure loops, network instability amplification,
 * and Railway autoscaling feedback under Algod outages.
 *
 * State machine:
 *   CLOSED  — normal operation; failures increment a decaying counter
 *   OPEN    — all signing blocked for the cooldown period
 *   Reset   — any successful submission clears all state immediately
 *
 * Redis keys:
 *   circuit:signer:failures  — INCR counter with TTL = window (60 s)
 *   circuit:signer:open      — presence flag; SET with TTL = cooldown (60 s)
 *
 * Failure mode: CLOSED — if Redis is unavailable, the circuit never trips.
 * This is intentional: a Redis outage should not block an otherwise
 * healthy signing pipeline. The logging will reveal the Redis issue.
 *
 * The two keys decay independently:
 *   - `failures` auto-expires after the measurement window
 *   - `open` auto-expires after the cooldown period
 *   - `recordSuccess()` DELs both immediately for faster recovery
 */

import { getRedis } from "../services/redis.js";

// ── Region isolation ───────────────────────────────────────────────
// Each region maintains its own circuit breaker state so that an algod
// outage in one region does not trip the circuit in healthy regions.
// RAILWAY_REGION is injected by the platform; FLY_REGION is the Fly.io
// equivalent. Falls back to "default" for single-instance deployments.
const REGION = process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "default";

// ── Policy constants ───────────────────────────────────────────────

const FAILURE_KEY   = `x402:circuit:${REGION}:signer:failures`;
const OPEN_KEY      = `x402:circuit:${REGION}:signer:open`;

const FAILURE_MAX   = parseInt(process.env.CIRCUIT_FAILURE_MAX  ?? "10", 10);
const WINDOW_S      = parseInt(process.env.CIRCUIT_WINDOW_S     ?? "60", 10);
const COOLDOWN_S    = parseInt(process.env.CIRCUIT_COOLDOWN_S   ?? "60", 10);

// ── Types ──────────────────────────────────────────────────────────

export interface CircuitState {
  /** true = circuit is open, all signing blocked */
  open: boolean;
  /** number of failures recorded in the current window */
  failureCount: number;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check whether the circuit breaker is currently open.
 *
 * Call this BEFORE the rate limiter checks in /api/execute so that
 * a tripped circuit produces a 503 before quota is consumed.
 *
 * Fails CLOSED on Redis error — never blocks requests when the
 * circuit infrastructure is itself unavailable.
 */
export async function isCircuitOpen(): Promise<CircuitState> {
  const redis = getRedis();
  if (!redis) return { open: false, failureCount: 0 };

  try {
    const openFlag = await redis.get(OPEN_KEY) as string | null;
    if (openFlag) {
      const countStr = await redis.get(FAILURE_KEY) as string | null;
      return {
        open:         true,
        failureCount: parseInt(countStr ?? "0", 10),
      };
    }
    return { open: false, failureCount: 0 };
  } catch {
    // Fail closed — Redis error should not block signing
    return { open: false, failureCount: 0 };
  }
}

/**
 * Record a signing or broadcast failure.
 *
 * Increments the failure counter. On the first increment, sets the
 * measurement window TTL. If the counter reaches FAILURE_MAX, trips
 * the circuit by setting the open flag with a cooldown TTL.
 *
 * Only call this for Stage 3 (sign) and Stage 4 (broadcast) failures —
 * not for validation or auth failures, which do not indicate RPC issues.
 *
 * @param reason - Human-readable failure description (for logging only)
 */
export async function recordFailure(reason: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    // Increment — get back the new count
    const count = (await redis.incr(FAILURE_KEY)) as number;

    // Set the measurement window TTL on the first failure
    if (count === 1) {
      await redis.expire(FAILURE_KEY, WINDOW_S);
    }

    console.warn(
      `[CircuitBreaker] Failure ${count}/${FAILURE_MAX}: ${reason}`,
    );

    if (count >= FAILURE_MAX) {
      // Trip the circuit — block all signing for the cooldown period
      await redis.set(OPEN_KEY, "1", { ex: COOLDOWN_S });
      console.error(
        `[CircuitBreaker] CIRCUIT OPEN — ${count} failures in ${WINDOW_S}s window. ` +
        `All signing blocked for ${COOLDOWN_S}s. Reason: ${reason}`,
      );
    }
  } catch (err) {
    console.error(
      "[CircuitBreaker] Redis error recording failure:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Record a successful signing submission.
 *
 * Clears both the failure counter and the open flag immediately,
 * regardless of their TTLs. This allows the service to recover
 * as soon as the underlying issue is resolved.
 */
export async function recordSuccess(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.del(FAILURE_KEY);
    await redis.del(OPEN_KEY);
  } catch (err) {
    console.error(
      "[CircuitBreaker] Redis error recording success:",
      err instanceof Error ? err.message : err,
    );
  }
}
