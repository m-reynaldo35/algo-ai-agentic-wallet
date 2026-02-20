import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getRedis } from "../services/redis.js";

// ── In-memory fallback rate limiter (used when Redis is unavailable) ──
// Token bucket per IP: 30 requests per 10-second window.
const _fallbackBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const FALLBACK_MAX = 30;
const FALLBACK_WINDOW_MS = 10_000;

function fallbackCheck(identifier: string): { limited: boolean } {
  const now = Date.now();
  let bucket = _fallbackBuckets.get(identifier);
  if (!bucket || now - bucket.lastRefill > FALLBACK_WINDOW_MS) {
    bucket = { tokens: FALLBACK_MAX, lastRefill: now };
  }
  if (bucket.tokens <= 0) {
    _fallbackBuckets.set(identifier, bucket);
    return { limited: true };
  }
  bucket.tokens--;
  _fallbackBuckets.set(identifier, bucket);
  return { limited: false };
}

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Edge-Level Rate Limiting — Upstash Sliding Window              │
 * │                                                                 │
 * │  Two tiers:                                                     │
 * │    - IP limiter: anonymous requests (default 30 req / 10s)      │
 * │    - Platform limiter: authenticated agents (default 100 / 10s) │
 * │                                                                 │
 * │  All limits are env-configurable for production tuning.         │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Config from env ─────────────────────────────────────────────
const IP_MAX = parseInt(process.env.RATE_LIMIT_IP_MAX || "30", 10);
const IP_WINDOW = `${process.env.RATE_LIMIT_IP_WINDOW || "10"} s`;
const PLATFORM_MAX = parseInt(process.env.RATE_LIMIT_PLATFORM_MAX || "100", 10);
const PLATFORM_WINDOW = `${process.env.RATE_LIMIT_PLATFORM_WINDOW || "10"} s`;

// ── Rate Limiters (lazy initialization) ─────────────────────────

let ipLimiter: Ratelimit | null = null;
let platformLimiter: Ratelimit | null = null;
let available: boolean | null = null;

function initLimiters(): boolean {
  if (available === false) return false;

  if (available === true) return true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    available = false;
    console.warn("[RateLimiter] UPSTASH credentials not set — rate limiting disabled");
    return false;
  }

  const redis = new Redis({ url, token });

  ipLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(IP_MAX, IP_WINDOW as `${number} s`),
    prefix: "x402:ratelimit:ip",
  });

  platformLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(PLATFORM_MAX, PLATFORM_WINDOW as `${number} s`),
    prefix: "x402:ratelimit:platform",
  });

  available = true;
  return true;
}

/**
 * Resolve the rate limit identifier and select the appropriate limiter.
 *
 * Priority:
 *   1. x-api-key header → SHA-256 hash → Redis index lookup → platform limiter
 *      (authenticated; only valid active keys get platform-level throughput)
 *   2. IP fallback → IP limiter
 *
 * Note: The unauthenticated X-Platform-Id tier has been removed — it allowed
 * any caller to bypass IP-level rate limits with a fabricated header value.
 */
async function resolveLimiter(req: Request): Promise<{ limiter: Ratelimit; identifier: string } | null> {
  if (!initLimiters()) return null;

  // ── Tier 1: Authenticated API key ────────────────────────────
  const rawApiKey = req.header("x-api-key");
  if (rawApiKey && platformLimiter) {
    const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
    const redis = getRedis();
    if (redis) {
      try {
        const indexEntry = await redis.get(`x402:api-key-index:${keyHash}`) as string | null;
        if (indexEntry) {
          // Valid active key — increment usage counter fire-and-forget
          const API_KEYS_HASH = "x402:api-keys";
          redis.hget(API_KEYS_HASH, indexEntry).then((raw) => {
            if (typeof raw === "string") {
              try {
                const entry = JSON.parse(raw);
                entry.usageCount = (entry.usageCount ?? 0) + 1;
                redis.hset(API_KEYS_HASH, { [indexEntry]: JSON.stringify(entry) }).catch(() => {});
              } catch { /* ignore */ }
            }
          }).catch(() => {});

          return { limiter: platformLimiter, identifier: `apikey:${keyHash.slice(0, 16)}` };
        }
      } catch { /* Redis error — fall through */ }
    }
  }

  // ── Tier 2: IP fallback ──────────────────────────────────────
  const forwarded = req.header("X-Forwarded-For");
  const ip = forwarded ? forwarded.split(",")[0].trim() : req.ip || "unknown";

  return { limiter: ipLimiter!, identifier: `ip:${ip}` };
}

// ── Middleware ────────────────────────────────────────────────────

export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = await resolveLimiter(req);

  // If Redis is not configured, pass through (local dev)
  if (!resolved) {
    next();
    return;
  }

  const { limiter, identifier } = resolved;

  try {
    const result = await limiter.limit(identifier);

    // Set standard rate limit headers
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", result.reset);

    if (!result.success) {
      const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);

      // Log 429 to Redis events (fire-and-forget)
      const redis = getRedis();
      if (redis) {
        const entry = {
          event: "rate.limit",
          identifier,
          path: req.path,
          timestamp: new Date().toISOString(),
        };
        redis
          .zadd("x402:events", { score: Date.now(), member: JSON.stringify(entry) })
          .then(() => redis.zremrangebyrank("x402:events", 0, -1001))
          .catch(() => {});
      }

      res.status(429).json({
        error: "Too Many Requests",
        detail: `Rate limit exceeded for ${identifier}. Try again in ${retryAfter}s.`,
        limit: result.limit,
        remaining: 0,
        resetAt: new Date(result.reset).toISOString(),
      });
      return;
    }

    next();
  } catch (err) {
    // Redis failure — fall back to in-memory token bucket (fail-closed semantics)
    console.warn(`[RateLimiter] Redis error (using in-memory fallback): ${err instanceof Error ? err.message : err}`);
    const identifier = req.ip || req.socket.remoteAddress || "unknown";
    const { limited } = fallbackCheck(identifier);
    if (limited) {
      res.status(429).json({ error: "Too Many Requests (fallback limiter)" });
      return;
    }
    next();
  }
}
