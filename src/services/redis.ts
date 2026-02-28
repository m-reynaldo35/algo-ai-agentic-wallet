import { Redis } from "@upstash/redis";

/**
 * Shared Redis singleton for audit logging, telemetry, and health data.
 * Returns null when UPSTASH credentials are not configured (local dev).
 */
let redis: Redis | null = null;
let checked = false;

export function getRedis(): Redis | null {
  if (checked) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    checked = true;
    console.warn("[Redis] UPSTASH credentials not set — Redis disabled");
    return null;
  }

  redis = new Redis({ url, token });
  checked = true;
  return redis;
}

/** Test-only — replace the Redis singleton with a mock. Never call from production code. */
export function _setRedisForTest(mock: Redis | null): void {
  redis = mock;
  checked = true;
}
