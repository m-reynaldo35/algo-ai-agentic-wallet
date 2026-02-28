/**
 * Signing Service Adversarial Tests
 *
 * Tests the internal validation pipeline of the signing microservice:
 * bearer token auth, requestId replay guard, groupId replay guard,
 * and the rate limiter (fallback mode).
 *
 * Scenarios:
 *   1.  verifyBearer() — correct key                          → true
 *   2.  verifyBearer() — wrong key                            → false
 *   3.  verifyBearer() — no Authorization header              → false
 *   4.  verifyBearer() — different-length keys (timing-safe)  → false
 *   5.  checkAndConsumeRequestId() — first use                → true (fresh)
 *   6.  checkAndConsumeRequestId() — replay (same ID)         → false
 *   7.  checkAndConsumeRequestId() — Redis unavailable        → throws (fail-closed)
 *   8.  checkGroupIdNotSeen() — first use                     → true
 *   9.  checkGroupIdNotSeen() — replay (same group)           → false
 *  10.  checkSigningRateLimit() — under limit (fallback mode) → { allowed: true }
 *
 * Run: npx tsx --test tests/signingService.adversarial.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import algosdk from "algosdk";

// ── Environment setup (before any import that reads env vars) ────
// These must be set before server.ts is imported (it reads them at load time).

const TEST_API_KEY = "test-signing-service-api-key-at-least-32-chars";
const { sk: testSk } = algosdk.generateAccount();

process.env.SIGNING_SERVICE_API_KEY = TEST_API_KEY;
process.env.ALGO_SIGNER_MNEMONIC    = algosdk.secretKeyToMnemonic(testSk);
process.env.DEV_SIGNER_ALLOWED      = "true";  // allow mnemonic load outside production
process.env.X402_PAY_TO_ADDRESS     = algosdk.generateAccount().addr.toString();
process.env.PORT                    = "4098";  // test port — server starts but we don't hit it
process.env.USDC_ASSET_ID           = "31566704";

// ── Redis mock ────────────────────────────────────────────────────

const redisStore = new Map<string, string>();
let redisAvailable = true;

const mockRedis = {
  get: async (key: string) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    const val = redisStore.get(key);
    if (val === undefined) return null;
    try { return JSON.parse(val); } catch { return val; }
  },
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    if (opts?.nx && redisStore.has(key)) return null; // nx: only set if not exists
    redisStore.set(key, String(value));
    return "OK";
  },
  getdel: async (key: string) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    const val = redisStore.get(key);
    if (val === undefined) return null;
    redisStore.delete(key);
    return val;
  },
};

// Patch Redis singleton before importing server (server imports redis transitively).
// SIGNER_REDIS_REST_URL is intentionally not set — getSignerRedis() returns null,
// so checkAndConsumeRequestId falls back to getRedis() which returns our mock.
const { _setRedisForTest } = await import("../src/services/redis.js");
// @ts-expect-error — mock doesn't implement the full Redis type
_setRedisForTest(mockRedis);

// Import signing service (triggers server boot — sets up Express, loads signer key, etc.)
const { _signingServiceTestExports } = await import("../src/signing-service/server.js");
const { verifyBearer, checkAndConsumeRequestId, checkGroupIdNotSeen } = _signingServiceTestExports;

// Rate limiter — directly importable (no server.ts dependency)
const { checkSigningRateLimit } = await import("../src/signing-service/signingRateLimiter.js");

// ── Helpers ───────────────────────────────────────────────────────

function resetStore() {
  redisStore.clear();
  redisAvailable = true;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("SigningService — auth, replay guard, rate limit adversarial scenarios", () => {

  beforeEach(() => resetStore());

  // ── Scenario 1 ────────────────────────────────────────────────
  it("1. verifyBearer() — correct key → true", () => {
    const result = verifyBearer(`Bearer ${TEST_API_KEY}`);
    assert.equal(result, true, "Correct key should return true");
  });

  // ── Scenario 2 ────────────────────────────────────────────────
  it("2. verifyBearer() — wrong key → false", () => {
    const result = verifyBearer("Bearer wrong-key-that-does-not-match-at-all-xxxx");
    assert.equal(result, false, "Wrong key should return false");
  });

  // ── Scenario 3 ────────────────────────────────────────────────
  it("3. verifyBearer() — no Authorization header → false", () => {
    assert.equal(verifyBearer(undefined), false, "Missing header should return false");
    assert.equal(verifyBearer(""),        false, "Empty header should return false");
    assert.equal(verifyBearer("Token xyz"), false, "Non-Bearer scheme should return false");
  });

  // ── Scenario 4 ────────────────────────────────────────────────
  it("4. verifyBearer() — different-length key → false (timing-safe comparison)", () => {
    // Shorter key
    assert.equal(verifyBearer("Bearer short"), false);
    // Longer key
    assert.equal(verifyBearer(`Bearer ${TEST_API_KEY}EXTRA`), false);
    // Key with one byte flipped
    const oneOff = TEST_API_KEY.slice(0, -1) + "X";
    assert.equal(verifyBearer(`Bearer ${oneOff}`), false);
  });

  // ── Scenario 5 ────────────────────────────────────────────────
  it("5. checkAndConsumeRequestId() — first use → true (fresh)", async () => {
    const fresh = await checkAndConsumeRequestId("req-unique-id-12345678");
    assert.equal(fresh, true, "First use of a requestId should return true");
  });

  // ── Scenario 6 ────────────────────────────────────────────────
  it("6. checkAndConsumeRequestId() — replay (same ID used twice) → false", async () => {
    const id = "req-replay-test-99887766";

    const first = await checkAndConsumeRequestId(id);
    assert.equal(first, true, "First use should be fresh");

    const second = await checkAndConsumeRequestId(id);
    assert.equal(second, false, "Second use of same ID should be detected as replay");
  });

  // ── Scenario 7 ────────────────────────────────────────────────
  it("7. checkAndConsumeRequestId() — Redis unavailable → throws (fail-closed)", async () => {
    redisAvailable = false;

    await assert.rejects(
      () => checkAndConsumeRequestId("req-redis-down"),
      /Redis|unavailable|ECONNREFUSED/i,
      "Should throw when Redis is unavailable — fail-closed for replay protection",
    );
  });

  // ── Scenario 8 ────────────────────────────────────────────────
  it("8. checkGroupIdNotSeen() — first use → true", async () => {
    const fresh = await checkGroupIdNotSeen("group-id-aabbccdd==");
    assert.equal(fresh, true, "First use of a groupId should return true");
  });

  // ── Scenario 9 ────────────────────────────────────────────────
  it("9. checkGroupIdNotSeen() — replay (same group) → false", async () => {
    const groupId = "group-id-replay-test==";

    const first = await checkGroupIdNotSeen(groupId);
    assert.equal(first, true, "First use should be fresh");

    const second = await checkGroupIdNotSeen(groupId);
    assert.equal(second, false, "Second use should be detected as group replay");
  });

  // ── Scenario 10 ───────────────────────────────────────────────
  it("10. checkSigningRateLimit() — under limit in fallback mode → { allowed: true }", async () => {
    // No UPSTASH_REDIS_REST_URL set → falls back to in-memory token bucket
    // Default fallback: 5 requests per 60s per key
    const result = await checkSigningRateLimit("test-agent-rate-limit");

    assert.equal(result.allowed, true, "Under-limit request should be allowed");
    assert.ok(!result.reason, "No reason should be set when allowed");
  });
});
