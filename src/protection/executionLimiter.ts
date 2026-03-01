/**
 * Execution Rate Limiter — Phase 1.5 Operational Hardening
 *
 * Three protection layers applied to /api/execute before the signing pipeline:
 *
 *   Layer 1 — Burst guard            burst:agent:{address}   5 tx / 10 s
 *   Layer 2 — Per-agent sliding      rate:agent:{address}   20 tx / 60 s
 *   Layer 3 — Global signer sliding  rate:global:signer    200 tx / 60 s
 *
 * Implementation uses raw Upstash Redis sorted sets — no external rate-limit
 * library. Each window is a ZSET keyed by request timestamp (ms), pruned with
 * ZREMRANGEBYSCORE and counted with ZCARD for an accurate rolling count.
 *
 * Rejected requests do NOT consume quota (the ZADD is skipped on rejection),
 * preventing a flood of requests from consuming the window faster.
 *
 * Failure mode: OPEN — if Redis is unavailable, limits are skipped with a
 * warning. Redis is required for production-strength enforcement.
 */

import { getRedis } from "../services/redis.js";
import type { RedisShim } from "../services/redis.js";

// ── Violation codes ────────────────────────────────────────────────

export type LimitViolation =
  | "AGENT_BURST_LIMIT"
  | "AGENT_RATE_LIMIT_EXCEEDED"
  | "GLOBAL_RATE_LIMIT_EXCEEDED";

export interface LimitResult {
  allowed: boolean;
  violation?: LimitViolation;
  /** Milliseconds until the window resets — set on rejection only */
  retryAfterMs?: number;
}

// ── Policy constants (override via env vars) ───────────────────────

const BURST_MAX     = parseInt(process.env.EXEC_BURST_MAX     ?? "5",   10);
const BURST_WIN_S   = parseInt(process.env.EXEC_BURST_WIN_S   ?? "10",  10);
const BURST_WIN_MS  = BURST_WIN_S * 1_000;

const AGENT_MAX     = parseInt(process.env.EXEC_AGENT_MAX     ?? "20",  10);
const AGENT_WIN_S   = parseInt(process.env.EXEC_AGENT_WIN_S   ?? "60",  10);
const AGENT_WIN_MS  = AGENT_WIN_S * 1_000;

const GLOBAL_MAX    = parseInt(process.env.EXEC_GLOBAL_MAX    ?? "200", 10);
const GLOBAL_WIN_S  = parseInt(process.env.EXEC_GLOBAL_WIN_S  ?? "60",  10);
const GLOBAL_WIN_MS = GLOBAL_WIN_S * 1_000;

// ── Core: sliding window via sorted set ───────────────────────────

/**
 * Sliding window rate check using a Redis sorted set.
 *
 * Algorithm:
 *   1. ZREMRANGEBYSCORE — prune entries older than the window
 *   2. ZCARD           — count entries still in the window
 *   3. Reject if count >= maxCount (do NOT add to set on rejection)
 *   4. ZADD            — record this request (score = timestamp ms)
 *   5. EXPIRE          — keep key alive for window duration + 1s buffer
 *
 * The member is `{timestamp}:{random}` to guarantee uniqueness even
 * when two requests arrive within the same millisecond.
 *
 * @returns { allowed, count } — count is AFTER adding the request
 */
async function checkWindow(
  redis: RedisShim,
  key: string,
  windowMs: number,
  maxCount: number,
): Promise<{ allowed: boolean; count: number }> {
  const now         = Date.now();
  const windowStart = now - windowMs;
  const ttlSeconds  = Math.ceil(windowMs / 1_000) + 1;

  // Prune stale entries from the sorted set
  await redis.zremrangebyscore(key, 0, windowStart);

  // Count entries in the current window
  const count = (await redis.zcard(key)) as number;

  if (count >= maxCount) {
    // Reject — do not add this request to the window
    return { allowed: false, count };
  }

  // Accept — record this request
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  await redis.zadd(key, { score: now, member });
  await redis.expire(key, ttlSeconds);

  return { allowed: true, count: count + 1 };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check all three rate limit layers for a given agent address.
 * Returns the first violation found (burst → per-agent → global).
 *
 * Checks in ascending strictness order so the most specific rejection
 * reason is returned first — burst violations are more actionable
 * than generic rate limit messages.
 *
 * @param publicAddress - The agent's on-chain Algorand address
 */
export async function checkExecutionLimits(
  publicAddress: string,
): Promise<LimitResult> {
  const redis = getRedis();

  if (!redis) {
    // Dev mode or transient Redis outage — fail open with a warning
    console.warn("[ExecutionLimiter] Redis unavailable — skipping rate limit checks");
    return { allowed: true };
  }

  try {
    // ── Layer 1: Burst guard (drain loop protection) ─────────────
    // Short window, tight limit. Catches runaway agents before they
    // can exhaust the per-minute allowance.
    const burstKey = `x402:rate:burst:${publicAddress}`;
    const burst = await checkWindow(redis, burstKey, BURST_WIN_MS, BURST_MAX);
    if (!burst.allowed) {
      return {
        allowed:      false,
        violation:    "AGENT_BURST_LIMIT",
        retryAfterMs: BURST_WIN_MS,
      };
    }

    // ── Layer 2: Per-agent sliding window ─────────────────────────
    // Sustained rate cap per agent over a 60-second rolling window.
    const agentKey = `x402:rate:agent:${publicAddress}`;
    const agent = await checkWindow(redis, agentKey, AGENT_WIN_MS, AGENT_MAX);
    if (!agent.allowed) {
      return {
        allowed:      false,
        violation:    "AGENT_RATE_LIMIT_EXCEEDED",
        retryAfterMs: AGENT_WIN_MS,
      };
    }

    // ── Layer 3: Global signer window ─────────────────────────────
    // Protects the master signer from aggregate overload regardless
    // of how many agents are active simultaneously.
    const globalKey = "x402:rate:global:signer";
    const global = await checkWindow(redis, globalKey, GLOBAL_WIN_MS, GLOBAL_MAX);
    if (!global.allowed) {
      return {
        allowed:      false,
        violation:    "GLOBAL_RATE_LIMIT_EXCEEDED",
        retryAfterMs: GLOBAL_WIN_MS,
      };
    }

    return { allowed: true };

  } catch (err) {
    // Redis error — fail open so a Redis blip doesn't halt the service
    console.error(
      "[ExecutionLimiter] Redis error — failing open:",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true };
  }
}
