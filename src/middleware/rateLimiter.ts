import type { Request, Response, NextFunction } from "express";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Edge-Level Rate Limiting — Upstash Sliding Window              │
 * │                                                                 │
 * │  Protects the API compute layer from DDoS and aggregator spam   │
 * │  BEFORE traffic reaches x402 signature verification or the      │
 * │  execution pipeline. Uses Upstash Redis for globally consistent │
 * │  rate state across all serverless instances.                    │
 * │                                                                 │
 * │  Algorithm: Sliding Window — 50 requests per 10 seconds per     │
 * │  identifier (IP or X-Platform-Id header).                       │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Rate Limiter (lazy initialization) ───────────────────────────

let ratelimit: Ratelimit | null = null;
let available: boolean | null = null;

function getRateLimiter(): Ratelimit | null {
  if (available === false) return null;

  if (ratelimit === null) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      available = false;
      console.warn("[RateLimiter] UPSTASH credentials not set — rate limiting disabled");
      return null;
    }

    ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(50, "10 s"),
      prefix: "x402:ratelimit",
    });
    available = true;
  }

  return ratelimit;
}

/**
 * Resolve the rate limit identifier from the request.
 * Priority: X-Platform-Id header > X-Forwarded-For > socket IP.
 */
function resolveIdentifier(req: Request): string {
  const platformId = req.header("X-Platform-Id");
  if (platformId) return `platform:${platformId}`;

  const forwarded = req.header("X-Forwarded-For");
  if (forwarded) return `ip:${forwarded.split(",")[0].trim()}`;

  return `ip:${req.ip || "unknown"}`;
}

// ── Middleware ────────────────────────────────────────────────────

export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const limiter = getRateLimiter();

  // If Redis is not configured, pass through (local dev)
  if (!limiter) {
    next();
    return;
  }

  const identifier = resolveIdentifier(req);

  try {
    const result = await limiter.limit(identifier);

    // Set standard rate limit headers
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", result.reset);

    if (!result.success) {
      const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);
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
    // On Redis failure, fail open — don't block legitimate traffic
    console.warn(`[RateLimiter] Redis error (failing open): ${err instanceof Error ? err.message : err}`);
    next();
  }
}
