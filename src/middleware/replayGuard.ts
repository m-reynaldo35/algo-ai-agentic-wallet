import { getRedis } from "../services/redis.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Replay Attack Prevention — Stateful Serverless Firewall        │
 * │                                                                 │
 * │  Prevents rogue agents from intercepting and reusing valid      │
 * │  X-PAYMENT signatures via two enforcement mechanisms:           │
 * │                                                                 │
 * │  1. Time Bound:  ΔT = T_current − T_signature ≤ 60 seconds     │
 * │  2. Nonce Cache: Each nonce is single-use, stored in Redis      │
 * │     with automatic TTL expiration. Duplicates are rejected      │
 * │     with HTTP 401.                                              │
 * │                                                                 │
 * │  Uses the shared Railway Redis (TCP, <2ms) via getRedis().      │
 * │  Falls back to in-memory Map when Redis is not configured       │
 * │  (local development).                                           │
 * └─────────────────────────────────────────────────────────────────┘
 */

/** Maximum age of a signature payload in seconds */
const MAX_SIGNATURE_AGE_SECONDS = 60;

/** Redis key prefix to namespace nonces and avoid collisions */
const NONCE_KEY_PREFIX = "x402:nonce:";

// ── In-memory fallback ────────────────────────────────────────────
const localFallbackCache = new Map<string, number>();

// ── Types ────────────────────────────────────────────────────────

export interface ReplayCheckResult {
  valid: boolean;
  error?: string;
}

// ── Core Enforcement ─────────────────────────────────────────────

/**
 * Enforce replay attack prevention on an X-PAYMENT signature payload.
 *
 * Checks:
 *   1. `timestamp` must be present and within 60 seconds of current time
 *   2. `nonce` must be present and never-before-seen in the Redis cache
 *
 * If both checks pass, the nonce is recorded in Redis with a TTL
 * matching the time bound to prevent future reuse. Redis automatically
 * evicts expired nonces — no manual cleanup needed.
 *
 * Falls back to in-memory Map when Redis is not configured.
 *
 * @param timestamp - Unix epoch seconds from the signature payload
 * @param nonce     - Unique string from the signature payload
 * @returns ReplayCheckResult with validity and optional error message
 */
export async function enforceReplayProtection(
  timestamp: number | undefined,
  nonce: string | undefined,
): Promise<ReplayCheckResult> {

  // ── Validate presence ──────────────────────────────────────────
  if (timestamp === undefined || timestamp === null) {
    return { valid: false, error: "Missing timestamp in payment proof" };
  }

  if (!nonce || typeof nonce !== "string" || nonce.length === 0) {
    return { valid: false, error: "Missing or empty nonce in payment proof" };
  }

  if (nonce.length > 256) {
    return { valid: false, error: "Nonce exceeds maximum length of 256 characters" };
  }

  // ── Time Bound: ΔT = T_current − T_signature ≤ 60 ──────────────
  const now = Math.floor(Date.now() / 1000);
  const deltaT = now - timestamp;

  if (deltaT > MAX_SIGNATURE_AGE_SECONDS) {
    return {
      valid: false,
      error: `Signature expired: ΔT=${deltaT}s exceeds ${MAX_SIGNATURE_AGE_SECONDS}s bound`,
    };
  }

  if (deltaT < -5) {
    // Allow 5s of clock skew tolerance for future timestamps
    return {
      valid: false,
      error: `Signature timestamp is in the future: ΔT=${deltaT}s`,
    };
  }

  // ── Nonce Uniqueness Check ──────────────────────────────────────
  const redis = getRedis();

  if (redis) {
    const key = `${NONCE_KEY_PREFIX}${nonce}`;
    // SET key "1" NX EX 60 — atomic set-if-not-exists with 60s TTL.
    // Returns "OK" if the key was set (nonce is fresh).
    // Returns null if the key already exists (replay detected).
    const result = await redis.set(key, "1", { nx: true, ex: MAX_SIGNATURE_AGE_SECONDS });
    if (result === null) {
      return {
        valid: false,
        error: "Signature Replay Detected: nonce has already been used",
      };
    }
    return { valid: true };
  }

  // Fail CLOSED when Redis is unavailable in production.
  // In-memory nonce caches are per-instance and cannot prevent cross-instance
  // replay in multi-region deployments. A Redis outage must not silently
  // degrade replay protection for a financial signing service.
  //
  // Exception: allow the in-memory fallback only when NODE_ENV is not
  // production AND RAILWAY_ENVIRONMENT is not production, so local
  // development still works without Redis.
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  if (isProd) {
    return {
      valid: false,
      error:
        "Replay protection temporarily unavailable — Redis is required in production. " +
        "Retry when the Redis connection is restored.",
    };
  }

  return enforceViaMemory(nonce, now);
}

/**
 * In-memory fallback nonce enforcement (local dev path).
 * Used when Redis credentials are not configured.
 */
function enforceViaMemory(nonce: string, now: number): ReplayCheckResult {
  // Evict stale entries on each check to keep memory bounded
  for (const [key, insertedAt] of localFallbackCache) {
    if (now - insertedAt > MAX_SIGNATURE_AGE_SECONDS * 2) {
      localFallbackCache.delete(key);
    }
  }

  if (localFallbackCache.has(nonce)) {
    return {
      valid: false,
      error: "Signature Replay Detected: nonce has already been used",
    };
  }

  localFallbackCache.set(nonce, now);
  return { valid: true };
}
