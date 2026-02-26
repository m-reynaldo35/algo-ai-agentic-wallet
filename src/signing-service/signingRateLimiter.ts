import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Signing-specific rate limiter — enforced at the signing boundary,
 * independent of the API-layer rate limiter on the main server.
 *
 * Two tiers:
 *   Per-agent:  10 signing requests / 60 s  (prevents a single agent from
 *               overwhelming the signer or burning its ALGO fee budget)
 *   Global:     500 signing requests / 60 s  (protects the signing process
 *               regardless of how many agents are active)
 *
 * Falls back to a conservative in-memory token bucket when Redis is
 * unavailable (e.g. cold start). This is fail-closed: the in-memory
 * bucket is per-process, so in a multi-instance deployment it is not
 * globally consistent — Redis is required for production correctness.
 */

const AGENT_MAX        = parseInt(process.env.SIGNING_RATE_AGENT_MAX  ?? "10",  10);
const AGENT_WINDOW     = `${process.env.SIGNING_RATE_AGENT_WINDOW_S   ?? "60"} s` as `${number} s`;
const GLOBAL_MAX       = parseInt(process.env.SIGNING_RATE_GLOBAL_MAX ?? "500", 10);
const GLOBAL_WINDOW    = `${process.env.SIGNING_RATE_GLOBAL_WINDOW_S  ?? "60"} s` as `${number} s`;

// In-memory fallback
const _fallback = new Map<string, { tokens: number; lastRefill: number }>();
const FALLBACK_MAX    = 5;
const FALLBACK_WIN_MS = 60_000;

function fallbackCheck(key: string): boolean {
  const now = Date.now();
  let b = _fallback.get(key);
  if (!b || now - b.lastRefill > FALLBACK_WIN_MS) {
    b = { tokens: FALLBACK_MAX, lastRefill: now };
  }
  if (b.tokens <= 0) { _fallback.set(key, b); return false; }
  b.tokens--;
  _fallback.set(key, b);
  return true;
}

let _agentLimiter:  Ratelimit | null = null;
let _globalLimiter: Ratelimit | null = null;
let _ready = false;

function init(): boolean {
  if (_ready) return true;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  const redis = new Redis({ url, token });
  _agentLimiter  = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(AGENT_MAX,  AGENT_WINDOW),  prefix: "x402:signing-rl:agent"  });
  _globalLimiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(GLOBAL_MAX, GLOBAL_WINDOW), prefix: "x402:signing-rl:global" });
  _ready = true;
  return true;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export async function checkSigningRateLimit(agentId: string): Promise<RateLimitResult> {
  if (!init()) {
    // Fallback: in-memory per-agent check only
    const allowed = fallbackCheck(`agent:${agentId}`) && fallbackCheck("global");
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: "Rate limit exceeded (in-memory fallback)" };
  }

  try {
    // Global check first — cheapest rejection
    const global = await _globalLimiter!.limit("global");
    if (!global.success) {
      return {
        allowed: false,
        reason:  `Global signing rate limit exceeded (${GLOBAL_MAX}/${GLOBAL_WINDOW})`,
        retryAfterMs: Math.max(0, global.reset - Date.now()),
      };
    }

    // Per-agent check
    const agent = await _agentLimiter!.limit(agentId);
    if (!agent.success) {
      return {
        allowed: false,
        reason:  `Per-agent signing rate limit exceeded (${AGENT_MAX}/${AGENT_WINDOW}) for ${agentId}`,
        retryAfterMs: Math.max(0, agent.reset - Date.now()),
      };
    }

    return { allowed: true };
  } catch {
    // Redis failure — fail-open with in-memory fallback
    const allowed = fallbackCheck(`agent:${agentId}`);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: "Rate limit exceeded (Redis unavailable, in-memory fallback)" };
  }
}
