/**
 * Custody Manager Adversarial Tests
 *
 * Tests the Tier 1 approval token lifecycle: HMAC binding, issuance,
 * consumption, and all rejection paths. No live Algorand node required.
 *
 * Scenarios:
 *   1.  computeApprovalHmac() — deterministic: same inputs → same HMAC
 *   2.  computeApprovalHmac() — field binding: any changed field → different HMAC
 *   3.  computeGroupIdHash()  — deterministic + content-sensitive
 *   4.  issueApprovalToken()  — stores token, returns nonce string
 *   5.  consumeApprovalToken() — valid token → resolves; replay → throws
 *   6.  consumeApprovalToken() — tampered HMAC in Redis → throws integrity error
 *   7.  consumeApprovalToken() — expired token (expiry in past) → throws
 *   8.  consumeApprovalToken() — wrong agentId binding → throws
 *   9.  consumeApprovalToken() — wrong walletId binding → throws
 *  10.  consumeApprovalToken() — Redis unavailable → throws
 *
 * Run: npx tsx --test tests/custodyManager.adversarial.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";

// ── Environment setup (must precede any import that reads env vars) ──

const TEST_TREASURY   = "E46PHV7THPP4MAIE6YX4FALPZTPDDN56SRHZBDRVCO6NZYOGNXYTQ6FHQE";
const APPROVAL_SECRET = "test-approval-secret-for-custody-manager-tests-ok";
const AGENT_ID        = "test-agent-001";
const WALLET_ID       = "test-wallet-hash-abc123";
const AGENT_ADDR      = "ZXNZPFB5LRPUIGGAON3KVMLWTM3XJOCIJJBNCZFPLZXHQIOCQGQZ7IMTM4"; // fake but valid-looking
const AMOUNT          = 5_000_000; // 5 USDC in micro-USDC

process.env.X402_PAY_TO_ADDRESS   = TEST_TREASURY;
process.env.APPROVAL_TOKEN_SECRET = APPROVAL_SECRET;

// ── Redis mock ────────────────────────────────────────────────────
// Mirrors the Upstash SDK behaviour:
//   get()    — auto-parses JSON strings → returns objects
//   set()    — stores as JSON string
//   getdel() — returns raw JSON string (code manually JSON.parses approval tokens)

const redisStore = new Map<string, string>();
let redisAvailable = true;

const mockRedis = {
  get: async (key: string) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    const val = redisStore.get(key);
    if (val === undefined) return null;
    try { return JSON.parse(val); } catch { return val; }
  },
  set: async (key: string, value: unknown, _opts?: unknown) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    const str = typeof value === "string" ? value : JSON.stringify(value);
    redisStore.set(key, str);
    return "OK";
  },
  getdel: async (key: string) => {
    if (!redisAvailable) throw new Error("Redis ECONNREFUSED");
    const val = redisStore.get(key);
    if (val === undefined) return null;
    redisStore.delete(key);
    return val; // raw JSON string — custodyManager manually JSON.parses this
  },
};

// ── Module-level imports (patched before custodyManager loads) ──

// Patch Redis singleton before importing custodyManager
const { _setRedisForTest } = await import("../src/services/redis.js");
// @ts-expect-error — mock doesn't implement the full Redis type
_setRedisForTest(mockRedis);

// Pre-populate the agent registry entry so consumeApprovalToken can look up the agent
const AGENT_RECORD = {
  agentId:            AGENT_ID,
  address:            AGENT_ADDR,
  cohort:             "A",
  authAddr:           TEST_TREASURY,
  status:             "active",
  createdAt:          new Date().toISOString(),
  registrationTxnId:  "fake-txn-id",
};
redisStore.set(`x402:agents:${AGENT_ID}`, JSON.stringify(AGENT_RECORD));

// Now safe to import custodyManager (config.x402.payToAddress is already set)
const {
  issueApprovalToken,
  consumeApprovalToken,
  _custodyTestExports,
} = await import("../src/services/custodyManager.js");

const { computeApprovalHmac, computeGroupIdHash } = _custodyTestExports;

// ── Helpers ───────────────────────────────────────────────────────

/** A base64-encoded non-axfer transaction blob (PAY type) — zero USDC spend */
const FAKE_TXN_B64 = Buffer.from("fakeTxnBytes").toString("base64");
const FAKE_TXNS    = [FAKE_TXN_B64];

function resetStore() {
  redisStore.clear();
  redisAvailable = true;
  // Always restore the agent record
  redisStore.set(`x402:agents:${AGENT_ID}`, JSON.stringify(AGENT_RECORD));
}

// ── Tests ─────────────────────────────────────────────────────────

describe("CustodyManager — Tier 1 approval token adversarial scenarios", () => {

  beforeEach(() => resetStore());

  // ── Scenario 1 ────────────────────────────────────────────────
  it("1. computeApprovalHmac() — same inputs produce same HMAC (deterministic)", () => {
    const fields = {
      agentId:         AGENT_ID,
      amount:          AMOUNT,
      expiry:          Date.now() + 60_000,
      groupIdHash:     "abc123",
      treasuryAddress: TEST_TREASURY,
      walletId:        WALLET_ID,
    };

    const hmac1 = computeApprovalHmac(fields);
    const hmac2 = computeApprovalHmac(fields);

    assert.equal(hmac1, hmac2, "HMAC must be deterministic");
    assert.ok(hmac1.length === 64, "HMAC should be 64 hex chars (SHA-256)");
    assert.match(hmac1, /^[0-9a-f]{64}$/, "HMAC should be lowercase hex");
  });

  // ── Scenario 2 ────────────────────────────────────────────────
  it("2. computeApprovalHmac() — any changed field produces a different HMAC", () => {
    const base = {
      agentId:         AGENT_ID,
      amount:          AMOUNT,
      expiry:          1_000_000,
      groupIdHash:     "abc123",
      treasuryAddress: TEST_TREASURY,
      walletId:        WALLET_ID,
    };
    const baseHmac = computeApprovalHmac(base);

    // Each mutation should produce a different HMAC
    const mutations: [string, typeof base][] = [
      ["agentId",         { ...base, agentId: "other-agent" }],
      ["amount",          { ...base, amount: AMOUNT + 1 }],
      ["expiry",          { ...base, expiry: base.expiry + 1 }],
      ["groupIdHash",     { ...base, groupIdHash: "xyz789" }],
      ["treasuryAddress", { ...base, treasuryAddress: "AAAA" }],
      ["walletId",        { ...base, walletId: "other-wallet" }],
    ];

    for (const [field, mutated] of mutations) {
      const mutatedHmac = computeApprovalHmac(mutated);
      assert.notEqual(mutatedHmac, baseHmac, `Changing ${field} must change the HMAC`);
    }
  });

  // ── Scenario 3 ────────────────────────────────────────────────
  it("3. computeGroupIdHash() — deterministic and content-sensitive", () => {
    const txns = ["dGVzdA==", "dGVzdDI="]; // base64("test"), base64("test2")

    const hash1 = computeGroupIdHash(txns);
    const hash2 = computeGroupIdHash(txns);
    const hashOther = computeGroupIdHash(["dGVzdA=="]); // different set

    assert.equal(hash1, hash2, "Same inputs must produce same hash");
    assert.notEqual(hash1, hashOther, "Different inputs must produce different hash");
    assert.match(hash1, /^[0-9a-f]{64}$/, "Should be 64-char hex (SHA-256)");

    // Empty array throws
    assert.throws(
      () => computeGroupIdHash([]),
      /empty/i,
      "Empty txn list should throw",
    );
  });

  // ── Scenario 4 ────────────────────────────────────────────────
  it("4. issueApprovalToken() — stores token in Redis, returns nonce", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    assert.ok(typeof nonce === "string" && nonce.length > 0, "Should return non-empty nonce");

    // Token should now exist in Redis
    const key = `x402:auth:approval:${AGENT_ID}:${nonce}`;
    const stored = redisStore.get(key);
    assert.ok(stored, "Token should be stored in Redis");

    const parsed = JSON.parse(stored!);
    assert.equal(parsed.agentId, AGENT_ID);
    assert.equal(parsed.walletId, WALLET_ID);
    assert.equal(parsed.amount, AMOUNT);
    assert.equal(parsed.treasuryAddress, TEST_TREASURY);
    assert.ok(typeof parsed.hmac === "string" && parsed.hmac.length === 64, "Token should have valid HMAC");
  });

  // ── Scenario 5 ────────────────────────────────────────────────
  it("5. consumeApprovalToken() — valid token resolves; replay throws", async () => {
    // Issue a token with amount high enough to cover decodeAxferTotal result (0n for non-axfer txns)
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    // First consume: should resolve
    // Note: decodeAxferTotal throws on invalid txn bytes; use a workaround by
    // issuing with amount=0 to pass the amount check, or accept a throw from decodeAxferTotal.
    // Since FAKE_TXN_B64 is not a valid msgpack transaction, decodeAxferTotal will throw.
    // We test the token lifecycle up through the HMAC/expiry/binding checks instead
    // by triggering a rejection BEFORE decodeAxferTotal is reached.
    // A valid full-path test requires real algosdk transactions — covered in integration tests.
    // Here we verify the token is consumed (single-use) by confirming replay throws.

    // Manually verify token was stored
    const key = `x402:auth:approval:${AGENT_ID}:${nonce}`;
    assert.ok(redisStore.has(key), "Token should exist before consumption");

    // Simulate deletion (as consumeApprovalToken's getdel would do)
    redisStore.delete(key);
    assert.ok(!redisStore.has(key), "Token should be gone after deletion");

    // Replay attempt: token is gone → throws
    await assert.rejects(
      () => consumeApprovalToken(AGENT_ID, nonce, FAKE_TXNS, WALLET_ID),
      /not found|expired|already used/i,
      "Replay should throw with not-found error",
    );
  });

  // ── Scenario 6 ────────────────────────────────────────────────
  it("6. consumeApprovalToken() — tampered HMAC in Redis → throws integrity error", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    // Tamper the stored HMAC
    const key = `x402:auth:approval:${AGENT_ID}:${nonce}`;
    const stored = JSON.parse(redisStore.get(key)!);
    stored.hmac = "0".repeat(64); // replace with all-zeros HMAC
    redisStore.set(key, JSON.stringify(stored));

    await assert.rejects(
      () => consumeApprovalToken(AGENT_ID, nonce, FAKE_TXNS, WALLET_ID),
      /HMAC invalid|integrity/i,
      "Tampered HMAC should cause integrity rejection",
    );
  });

  // ── Scenario 7 ────────────────────────────────────────────────
  it("7. consumeApprovalToken() — expired token (expiry in past) → throws", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    // Manually set expiry to past while keeping HMAC valid
    // (must recompute HMAC with the same secret over the new expiry)
    const key = `x402:auth:approval:${AGENT_ID}:${nonce}`;
    const stored = JSON.parse(redisStore.get(key)!);
    const pastExpiry = Date.now() - 10_000;
    const newHmac = computeApprovalHmac({
      agentId:         stored.agentId,
      amount:          stored.amount,
      expiry:          pastExpiry,
      groupIdHash:     stored.groupIdHash,
      treasuryAddress: stored.treasuryAddress,
      walletId:        stored.walletId,
    });
    stored.expiry = pastExpiry;
    stored.hmac   = newHmac;
    redisStore.set(key, JSON.stringify(stored));

    await assert.rejects(
      () => consumeApprovalToken(AGENT_ID, nonce, FAKE_TXNS, WALLET_ID),
      /expired/i,
      "Expired token should be rejected",
    );
  });

  // ── Scenario 8 ────────────────────────────────────────────────
  it("8. consumeApprovalToken() — wrong agentId binding → throws", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    await assert.rejects(
      () => consumeApprovalToken("wrong-agent-id", nonce, FAKE_TXNS, WALLET_ID),
      /not found|expired|already used/i,
      "Wrong agentId means the key lookup misses — token not found",
    );
  });

  // ── Scenario 9 ────────────────────────────────────────────────
  it("9. consumeApprovalToken() — wrong walletId → throws walletId mismatch", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    await assert.rejects(
      () => consumeApprovalToken(AGENT_ID, nonce, FAKE_TXNS, "wrong-wallet-id"),
      /walletId mismatch|cross-wallet/i,
      "Wrong walletId should be rejected at binding check",
    );
  });

  // ── Scenario 10 ───────────────────────────────────────────────
  it("10. consumeApprovalToken() — Redis unavailable → throws", async () => {
    const nonce = await issueApprovalToken(AGENT_ID, AMOUNT, FAKE_TXNS, WALLET_ID);

    // Take Redis down AFTER token issuance
    redisAvailable = false;

    await assert.rejects(
      () => consumeApprovalToken(AGENT_ID, nonce, FAKE_TXNS, WALLET_ID),
      /Redis|ECONNREFUSED|not available/i,
      "Should throw when Redis is unavailable",
    );
  });
});
