/**
 * Signer Adapter — HSM-Ready Signing Abstraction
 *
 * Decouples the signing operation from the key storage backend so the
 * key material can live in:
 *   - An environment variable (dev / Phase 1 production)
 *   - HashiCorp Vault Transit Engine (soft HSM, recommended for production)
 *   - AWS CloudHSM / Google Cloud KMS / Azure Key Vault (future phases)
 *
 * All adapters share the same interface so the upper signing layer
 * (`roccaWallet.ts`) never needs to know which backend is active.
 *
 * Selection (first match wins):
 *   1. VAULT_ADDR + VAULT_TOKEN + VAULT_TRANSIT_KEY   → VaultTransitAdapter
 *   2. ALGO_SIGNER_MNEMONIC                            → EnvMnemonicAdapter
 *   3. (neither)                                       → EnvMnemonicAdapter (ephemeral dev key)
 *
 * Key operations use algosdk v3 APIs:
 *   txn.bytesToSign()              — raw bytes the adapter must sign
 *   txn.attachSignature(addr, sig) — attach 64-byte raw Ed25519 signature
 *
 * Module 3 — Treasury Hardening (HSM Adapter Layer)
 */

import { EnvMnemonicAdapter } from "./envMnemonicAdapter.js";
import { VaultTransitAdapter } from "./vaultTransitAdapter.js";

// ── Interface ──────────────────────────────────────────────────────

export interface SignerAdapter {
  /**
   * Return the Algorand address corresponding to the managed signing key.
   * Cached after first call — never queries the backend repeatedly.
   */
  getPublicAddress(): Promise<string>;

  /**
   * Sign `bytesToSign` (from `txn.bytesToSign()`) and return the raw
   * 64-byte Ed25519 signature. The caller is responsible for attaching
   * the signature to the transaction via `txn.attachSignature(addr, sig)`.
   *
   * @param bytesToSign - "TX" prefix + msgpack-encoded transaction body
   * @returns 64-byte raw Ed25519 signature
   */
  signRawBytes(bytesToSign: Uint8Array): Promise<Uint8Array>;

  /**
   * Verify the adapter is healthy and the backend is reachable.
   * Called at boot to fail fast on misconfiguration.
   * Throws a descriptive error if the adapter cannot operate.
   */
  healthCheck(): Promise<void>;
}

// ── Factory ────────────────────────────────────────────────────────

let _adapter: SignerAdapter | null = null;

/**
 * Return the lazily-initialised signer adapter for this process.
 *
 * Adapter selection:
 *   - VAULT_ADDR + VAULT_TOKEN + VAULT_TRANSIT_KEY → VaultTransitAdapter
 *   - Otherwise → EnvMnemonicAdapter (mnemonic or ephemeral dev key)
 *
 * The adapter is initialised once and cached for the process lifetime.
 */
export function getSignerAdapter(): SignerAdapter {
  if (_adapter) return _adapter;

  const vaultAddr  = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const vaultKey   = process.env.VAULT_TRANSIT_KEY;

  if (vaultAddr && vaultToken && vaultKey) {
    _adapter = new VaultTransitAdapter(vaultAddr, vaultToken, vaultKey);
    console.log(`[SignerAdapter] Backend: Vault Transit (${vaultAddr}, key=${vaultKey})`);
  } else {
    _adapter = new EnvMnemonicAdapter();
    // Mode ("persistent" vs "ephemeral") is logged by EnvMnemonicAdapter
  }

  return _adapter;
}

/** Reset the adapter singleton — for testing only. */
export function _resetAdapterForTest(): void {
  _adapter = null;
}
