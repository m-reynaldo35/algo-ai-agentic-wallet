import { Redis as IORedis } from "ioredis";

/**
 * Thin compatibility shim over ioredis that exposes the same method
 * signatures as @upstash/redis so all existing call sites work without
 * modification.
 *
 * Key behavioural differences from raw ioredis that this shim bridges:
 *   - get() / rpop()  → auto-JSON-parses (Upstash did this automatically)
 *   - set()           → accepts options object { nx, ex, px }
 *   - zadd()          → accepts { score, member } object (Upstash style)
 *   - zrange()        → accepts { byScore, rev } options object
 *   - scan()          → accepts { match, count } options object
 *   - eval()          → (script, keys[], args[]) → ioredis format internally
 *   - hset()          → accepts plain Record<string, string> object
 *   - sismember()     → returns 0 | 1 (callers use === 1 to check)
 */
export class RedisShim {
  readonly _ioredis: IORedis;

  constructor(url: string) {
    this._ioredis = new IORedis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    this._ioredis.on("error", (err: Error) => {
      console.error("[Redis] Connection error:", err.message);
    });
  }

  // ── Core string ops ─────────────────────────────────────────────

  /** Get a value. Auto-parses JSON (mirrors Upstash behaviour). */
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this._ioredis.get(key);
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
  }

  /**
   * GET then DEL atomically. Auto-parses JSON on the result.
   * Redis GETDEL — requires Redis 6.2+.
   */
  async getdel<T = unknown>(key: string): Promise<T | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (this._ioredis as any).getdel(key) as string | null;
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
  }

  /** Set a value with optional NX / EX / PX flags. */
  async set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number; px?: number; keepttl?: boolean },
  ): Promise<string | null> {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (!opts || Object.keys(opts).length === 0) {
      return this._ioredis.set(key, s);
    }
    const setArgs: (string | number)[] = [];
    if (opts.ex !== undefined)  { setArgs.push("EX", opts.ex); }
    else if (opts.px !== undefined) { setArgs.push("PX", opts.px); }
    else if (opts.keepttl)      { setArgs.push("KEEPTTL"); }
    if (opts.nx) { setArgs.push("NX"); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this._ioredis as any).set(key, s, ...setArgs) as Promise<string | null>;
  }

  async del(...keys: string[]): Promise<number> {
    return this._ioredis.del(...keys);
  }

  /** KEYS pattern — not recommended for large keyspaces; use scan() instead. */
  async keys(pattern: string): Promise<string[]> {
    return this._ioredis.keys(pattern);
  }

  async incr(key: string): Promise<number> {
    return this._ioredis.incr(key);
  }

  async incrby(key: string, increment: number): Promise<number> {
    return this._ioredis.incrby(key, increment);
  }

  async decrby(key: string, decrement: number): Promise<number> {
    return this._ioredis.decrby(key, decrement);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this._ioredis.expire(key, seconds);
  }

  // ── Lists ────────────────────────────────────────────────────────

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this._ioredis.lpush(key, ...values);
  }

  /** RPOP with optional auto-JSON-parse. */
  async rpop<T = string>(key: string): Promise<T | null> {
    const raw = await this._ioredis.rpop(key);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
  }

  async llen(key: string): Promise<number> {
    return this._ioredis.llen(key);
  }

  // ── Pub/Sub ─────────────────────────────────────────────────────

  async publish(channel: string, message: string): Promise<number> {
    return this._ioredis.publish(channel, message);
  }

  // ── Sorted sets ─────────────────────────────────────────────────

  /**
   * ZADD — Upstash-style: zadd(key, { score, member }).
   * Converts to ioredis format internally.
   */
  async zadd(
    key: string,
    entry: { score: number; member: string },
  ): Promise<number> {
    return this._ioredis.zadd(key, entry.score, entry.member) as Promise<number>;
  }

  /**
   * ZRANGE — Upstash-style options object.
   *   { rev: true }          → ZREVRANGE (by index, reversed)
   *   { byScore: true }      → ZRANGEBYSCORE (min, max)
   *   { byScore, rev: true } → ZREVRANGEBYSCORE (max, min)
   *   (no opts)              → ZRANGE (by index)
   */
  async zrange(
    key: string,
    start: number | string,
    stop: number | string,
    opts?: { byScore?: boolean; rev?: boolean },
  ): Promise<string[]> {
    if (opts?.byScore) {
      if (opts.rev) {
        return this._ioredis.zrevrangebyscore(key, stop, start);
      }
      return this._ioredis.zrangebyscore(key, start, stop);
    }
    if (opts?.rev) {
      return this._ioredis.zrevrange(key, start as number, stop as number);
    }
    return this._ioredis.zrange(key, start as number, stop as number);
  }

  async zcard(key: string): Promise<number> {
    return this._ioredis.zcard(key);
  }

  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    return this._ioredis.zcount(key, min, max);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return this._ioredis.zrem(key, ...members);
  }

  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    return this._ioredis.zremrangebyscore(key, min, max);
  }

  async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    return this._ioredis.zremrangebyrank(key, start, stop);
  }

  // ── Sets ─────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this._ioredis.sadd(key, ...members);
  }

  async sismember(key: string, member: string): Promise<0 | 1> {
    return this._ioredis.sismember(key, member) as Promise<0 | 1>;
  }

  async smembers(key: string): Promise<string[]> {
    return this._ioredis.smembers(key);
  }

  // ── Hashes ──────────────────────────────────────────────────────

  async hget(key: string, field: string): Promise<string | null> {
    return this._ioredis.hget(key, field);
  }

  /** HSET — Upstash-style object: hset(key, { field: value, ... }). */
  async hset(key: string, obj: Record<string, string>): Promise<number> {
    const pairs: string[] = [];
    for (const [f, v] of Object.entries(obj)) { pairs.push(f, v); }
    return this._ioredis.hset(key, ...pairs);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const result = await this._ioredis.hgetall(key);
    if (!result || Object.keys(result).length === 0) return null;
    return result;
  }

  // ── Cursor scan ─────────────────────────────────────────────────

  /** SCAN — Upstash-style: scan(cursor, { match, count }). */
  async scan(
    cursor: number,
    opts?: { match?: string; count?: number },
  ): Promise<[string, string[]]> {
    const args: (string | number)[] = [String(cursor)];
    if (opts?.match) { args.push("MATCH", opts.match); }
    if (opts?.count) { args.push("COUNT", opts.count); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this._ioredis as any).scan(...args) as Promise<[string, string[]]>;
  }

  // ── Lua eval ────────────────────────────────────────────────────

  /**
   * EVAL — Upstash-style: eval(script, keys[], args[]).
   * Converts to ioredis format: eval(script, numKeys, ...keys, ...args).
   */
  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    return this._ioredis.eval(script, keys.length, ...keys, ...args.map(String));
  }
}

// ── Singleton factory ────────────────────────────────────────────

let redis: RedisShim | null = null;
let checked = false;

/**
 * Shared Redis singleton.
 *
 * Connection priority:
 *   1. REDIS_PRIVATE_URL  — Railway internal network (lowest latency, <2ms)
 *   2. REDIS_URL          — Railway public URL / local dev
 *   3. UPSTASH_REDIS_REST_URL + TOKEN — legacy Upstash HTTP REST fallback
 *
 * Returns null when no credentials are set (local dev without Redis).
 */
export function getRedis(): RedisShim | null {
  if (checked) return redis;

  const privateUrl = process.env.REDIS_PRIVATE_URL;
  const publicUrl  = process.env.REDIS_URL;

  const url = privateUrl || publicUrl;

  if (url) {
    redis = new RedisShim(url);
    checked = true;
    const label = privateUrl ? "REDIS_PRIVATE_URL (Railway internal)" : "REDIS_URL";
    console.log(`[Redis] Connected via ${label}`);
    return redis;
  }

  // Legacy Upstash fallback — HTTP REST, higher latency.
  // Used while deploying Railway Redis to existing services.
  const upstashUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Redis: UpstashRedis } = require("@upstash/redis");
      redis = new UpstashRedis({ url: upstashUrl, token: upstashToken }) as unknown as RedisShim;
      checked = true;
      console.warn("[Redis] Using legacy Upstash HTTP client — switch to REDIS_PRIVATE_URL for lower latency");
      return redis;
    } catch {
      console.error("[Redis] @upstash/redis not available for legacy fallback");
    }
  }

  checked = true;
  console.warn("[Redis] No Redis credentials configured — Redis disabled");
  return null;
}

/** Test-only — replace the Redis singleton with a mock. Never call from production code. */
export function _setRedisForTest(mock: RedisShim | null): void {
  redis = mock;
  checked = true;
}
