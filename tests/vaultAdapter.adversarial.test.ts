/**
 * Vault Adapter Adversarial Tests
 *
 * Tests VaultTransitAdapter and the getSignerAdapter() factory with
 * mocked fetch — no live Vault or Algorand node required.
 *
 * Scenarios:
 *   1.  getPublicAddress() — Vault returns 32-byte raw key          → valid Algorand address
 *   2.  getPublicAddress() — Vault returns 44-byte ASN.1 DER key   → strips header, valid addr
 *   3.  getPublicAddress() — called twice                           → cached, single fetch
 *   4.  getPublicAddress() — Vault returns HTTP 403                 → throws with status
 *   5.  signRawBytes()     — Vault returns vault:v1:<base64(64b)>   → 64-byte Uint8Array
 *   6.  signRawBytes()     — malformed signature (no colon prefix)  → throws format error
 *   7.  signRawBytes()     — signature decodes to wrong length      → throws length error
 *   8.  healthCheck()      — Vault reachable                        → resolves
 *   9.  getSignerAdapter() — all three Vault env vars set           → VaultTransitAdapter
 *  10.  getSignerAdapter() — Vault vars absent                      → EnvMnemonicAdapter
 *
 * Run: npx tsx --test tests/vaultAdapter.adversarial.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import { VaultTransitAdapter }                      from "../src/signer/adapters/vaultTransitAdapter.js";
import { getSignerAdapter, _resetAdapterForTest }   from "../src/signer/adapters/signerAdapter.js";
import { EnvMnemonicAdapter }                       from "../src/signer/adapters/envMnemonicAdapter.js";

// ── Fetch mock ────────────────────────────────────────────────────

type MockHandler = (url: string, init?: RequestInit) => Promise<Response>;
let _mockFetch: MockHandler | null = null;

// Intercept global.fetch for the duration of tests
const _originalFetch = global.fetch;

function installFetch(handler: MockHandler): void {
  _mockFetch = handler;
}

// @ts-expect-error — override global fetch for testing
global.fetch = async (url: string, init?: RequestInit) => {
  if (!_mockFetch) throw new Error("fetch called but no mock installed");
  return _mockFetch(url, init);
};

// ── Helpers ───────────────────────────────────────────────────────

/** Build a Response with JSON body */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A known 32-byte test public key (all 0x01 bytes for determinism) */
const RAW_PK_32 = Buffer.alloc(32, 0x01);

/** A 44-byte ASN.1 DER-wrapped Ed25519 public key (12-byte header + 32-byte key) */
const ASN1_HEADER = Buffer.alloc(12, 0x30); // fake header
const DER_PK_44  = Buffer.concat([ASN1_HEADER, RAW_PK_32]);

/** A valid 64-byte Ed25519 signature (all 0x02 bytes for determinism) */
const SIG_64 = Buffer.alloc(64, 0x02);

/** Vault key endpoint response for a 32-byte raw public key */
function vaultKeyResp(pubKeyBuf: Buffer) {
  return {
    data: {
      keys: {
        "1": { public_key: pubKeyBuf.toString("base64") },
      },
    },
  };
}

/** Vault sign endpoint response */
function vaultSignResp(sigBuf: Buffer) {
  return {
    data: { signature: `vault:v1:${sigBuf.toString("base64")}` },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("VaultTransitAdapter — adversarial scenarios", () => {

  afterEach(() => {
    _mockFetch = null;
    _resetAdapterForTest();
    // Clean up Vault-specific env vars after factory tests
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_TRANSIT_KEY;
  });

  // ── Scenario 1 ────────────────────────────────────────────────
  it("1. getPublicAddress() — Vault returns 32-byte raw key → valid Algorand address", async () => {
    installFetch(async () => jsonResponse(vaultKeyResp(RAW_PK_32)));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");
    const addr = await adapter.getPublicAddress();

    assert.ok(addr.length === 58, `Expected 58-char Algorand address, got length ${addr.length}: ${addr}`);
    assert.match(addr, /^[A-Z2-7]+$/, "Address should be base32 uppercase");
  });

  // ── Scenario 2 ────────────────────────────────────────────────
  it("2. getPublicAddress() — Vault returns 44-byte ASN.1 DER key → strips header, valid addr", async () => {
    installFetch(async () => jsonResponse(vaultKeyResp(DER_PK_44)));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");
    const addr = await adapter.getPublicAddress();

    // Should produce the same address as the raw 32-byte key (same underlying bytes)
    const adapterRaw = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");
    installFetch(async () => jsonResponse(vaultKeyResp(RAW_PK_32)));
    const addrRaw = await adapterRaw.getPublicAddress();

    assert.equal(addr, addrRaw, "DER-wrapped and raw keys with same 32 bytes should produce same address");
  });

  // ── Scenario 3 ────────────────────────────────────────────────
  it("3. getPublicAddress() — called twice → fetches Vault only once (cached)", async () => {
    let callCount = 0;
    installFetch(async () => {
      callCount++;
      return jsonResponse(vaultKeyResp(RAW_PK_32));
    });

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");
    const addr1 = await adapter.getPublicAddress();
    const addr2 = await adapter.getPublicAddress();

    assert.equal(callCount, 1, "Vault should be queried only once");
    assert.equal(addr1, addr2, "Both calls should return the same address");
  });

  // ── Scenario 4 ────────────────────────────────────────────────
  it("4. getPublicAddress() — Vault returns HTTP 403 → throws with status in message", async () => {
    installFetch(async () => new Response(JSON.stringify({ errors: ["permission denied"] }), { status: 403 }));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "bad-token", "algo-signer");

    await assert.rejects(
      () => adapter.getPublicAddress(),
      (err: Error) => {
        assert.ok(err.message.includes("403"), `Expected 403 in error message, got: ${err.message}`);
        return true;
      },
    );
  });

  // ── Scenario 5 ────────────────────────────────────────────────
  it("5. signRawBytes() — Vault returns vault:v1:<base64(64 bytes)> → 64-byte Uint8Array", async () => {
    let callIdx = 0;
    installFetch(async () => {
      // First call: getPublicAddress (from caching setup), second: sign
      callIdx++;
      if (callIdx === 1) return jsonResponse(vaultKeyResp(RAW_PK_32));
      return jsonResponse(vaultSignResp(SIG_64));
    });

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");
    await adapter.getPublicAddress(); // prime the public key cache

    installFetch(async () => jsonResponse(vaultSignResp(SIG_64)));
    const sig = await adapter.signRawBytes(new Uint8Array(32));

    assert.ok(sig instanceof Uint8Array, "Should return Uint8Array");
    assert.equal(sig.length, 64, "Signature must be 64 bytes");
    assert.deepEqual(sig, new Uint8Array(SIG_64), "Signature bytes must match mock");
  });

  // ── Scenario 6 ────────────────────────────────────────────────
  it("6. signRawBytes() — signature ends with colon (empty base64 part) → throws format error", async () => {
    // The adapter splits on ":" and pops the last segment.
    // "vault:v1:" ends with ":" so .pop() returns "" (falsy) → throws format error.
    installFetch(async () => jsonResponse({
      data: { signature: "vault:v1:" }, // empty base64 segment after last colon
    }));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");

    await assert.rejects(
      () => adapter.signRawBytes(new Uint8Array(32)),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes("format") || err.message.toLowerCase().includes("unexpected"),
          `Expected format error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  // ── Scenario 7 ────────────────────────────────────────────────
  it("7. signRawBytes() — signature decodes to wrong length → throws length error", async () => {
    const shortSig = Buffer.alloc(32, 0x02); // only 32 bytes, not 64
    installFetch(async () => jsonResponse({
      data: { signature: `vault:v1:${shortSig.toString("base64")}` },
    }));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");

    await assert.rejects(
      () => adapter.signRawBytes(new Uint8Array(32)),
      (err: Error) => {
        assert.ok(
          err.message.includes("64") || err.message.toLowerCase().includes("length"),
          `Expected length error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  // ── Scenario 8 ────────────────────────────────────────────────
  it("8. healthCheck() — Vault reachable → resolves without throwing", async () => {
    installFetch(async () => jsonResponse(vaultKeyResp(RAW_PK_32)));

    const adapter = new VaultTransitAdapter("https://vault.test:8200", "test-token", "algo-signer");

    await assert.doesNotReject(
      () => adapter.healthCheck(),
      "healthCheck should resolve when Vault is reachable",
    );
  });

  // ── Scenario 9 ────────────────────────────────────────────────
  it("9. getSignerAdapter() — all three Vault env vars set → returns VaultTransitAdapter", () => {
    process.env.VAULT_ADDR         = "https://vault.test:8200";
    process.env.VAULT_TOKEN        = "test-vault-token";
    process.env.VAULT_TRANSIT_KEY  = "algo-signer";

    const adapter = getSignerAdapter();

    assert.ok(
      adapter instanceof VaultTransitAdapter,
      "Factory should select VaultTransitAdapter when all Vault env vars are set",
    );
  });

  // ── Scenario 10 ───────────────────────────────────────────────
  it("10. getSignerAdapter() — Vault vars absent → returns EnvMnemonicAdapter", () => {
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_TRANSIT_KEY;

    const adapter = getSignerAdapter();

    assert.ok(
      adapter instanceof EnvMnemonicAdapter,
      "Factory should fall back to EnvMnemonicAdapter when Vault vars are absent",
    );
  });
});
