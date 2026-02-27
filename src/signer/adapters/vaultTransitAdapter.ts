/**
 * Vault Transit Adapter — HashiCorp Vault Transit Engine Backend
 *
 * The private key NEVER leaves Vault. The signing service sends raw
 * transaction bytes to Vault for Ed25519 signing and receives only the
 * 64-byte signature back. This is the recommended production backend
 * for Phase 2+ deployments.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Why Vault Transit for Algorand?                                │
 * │                                                                 │
 * │  • Vault Transit natively supports Ed25519 (same curve as       │
 * │    Algorand). No ECDSA shim or algorithm translation needed.    │
 * │                                                                 │
 * │  • The key is created once inside Vault and never exported.     │
 * │    Even a full compromise of the signing service process        │
 * │    cannot extract the raw private key bytes.                    │
 * │                                                                 │
 * │  • Vault audit logs every signing operation — mandatory for     │
 * │    compliance (SOC 2, PCI-DSS, ISO 27001).                      │
 * │                                                                 │
 * │  • Key rotation is a single Vault API call; no rekey on-chain.  │
 * │    Vault's key versioning supports rotating to a new key while   │
 * │    keeping old versions for verification.                       │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Setup (one-time):
 *   vault secrets enable transit
 *   vault write -f transit/keys/algo-signer type=ed25519
 *   vault write transit/keys/algo-signer/config exportable=false allow_plaintext_backup=false
 *
 * Environment variables:
 *   VAULT_ADDR          HashiCorp Vault address   e.g. https://vault.internal:8200
 *   VAULT_TOKEN         Vault token with transit/sign/{key} policy
 *   VAULT_TRANSIT_KEY   Transit key name           e.g. algo-signer
 *   VAULT_NAMESPACE     (optional) Vault Enterprise namespace
 *
 * The Algorand address is derived from the public key returned by
 * POST /v1/transit/keys/{key-name} at init time.
 *
 * Signing flow:
 *   1. POST /v1/transit/sign/{key-name}
 *      Body: { "input": "<base64url(bytesToSign)>", "prehashed": false }
 *   2. Response: { "data": { "signature": "vault:v1:<base64(sig64)>" } }
 *   3. Strip "vault:v1:" prefix, base64-decode → 64-byte raw signature
 *   4. txn.attachSignature(addr, sig64) → signed transaction bytes
 *
 * Module 3 — Treasury Hardening (HSM Adapter Layer)
 */

import algosdk from "algosdk";
import type { SignerAdapter } from "./signerAdapter.js";

export class VaultTransitAdapter implements SignerAdapter {
  private readonly vaultAddr:  string;
  private readonly vaultToken: string;
  private readonly keyName:    string;
  private readonly namespace?: string;

  private _publicAddress: string | null = null;

  constructor(vaultAddr: string, vaultToken: string, keyName: string) {
    this.vaultAddr  = vaultAddr.replace(/\/$/, ""); // strip trailing slash
    this.vaultToken = vaultToken;
    this.keyName    = keyName;
    this.namespace  = process.env.VAULT_NAMESPACE;
  }

  // ── Common fetch helper ──────────────────────────────────────────

  private async vaultFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "X-Vault-Token": this.vaultToken,
      "Content-Type":  "application/json",
    };
    if (this.namespace) headers["X-Vault-Namespace"] = this.namespace;

    const res = await fetch(`${this.vaultAddr}/v1/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Vault ${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${body}`);
    }

    return res;
  }

  // ── Public interface ─────────────────────────────────────────────

  async getPublicAddress(): Promise<string> {
    if (this._publicAddress) return this._publicAddress;

    // Fetch public key from Vault Transit key metadata
    const res  = await this.vaultFetch(`transit/keys/${this.keyName}`);
    const data = await res.json() as { data: { keys: Record<string, { public_key: string }> } };

    // Latest key version — use the highest version number
    const keys    = data.data.keys;
    const version = Math.max(...Object.keys(keys).map(Number));
    const pubKeyB64 = keys[version]?.public_key;

    if (!pubKeyB64) {
      throw new Error(`VaultTransitAdapter: No public key found for key "${this.keyName}" version ${version}`);
    }

    // Vault returns Ed25519 public key as base64-encoded 32-byte DER-wrapped key.
    // For Ed25519 keys, Vault wraps in a 44-byte ASN.1 SubjectPublicKeyInfo structure.
    // The raw 32-byte public key is the last 32 bytes.
    const pubKeyRaw = Buffer.from(pubKeyB64, "base64");
    const rawBytes  = pubKeyRaw.length === 32
      ? pubKeyRaw
      : pubKeyRaw.slice(pubKeyRaw.length - 32); // strip ASN.1 header if present

    // Convert raw Ed25519 public key bytes to Algorand address
    this._publicAddress = algosdk.encodeAddress(new Uint8Array(rawBytes));
    console.log(`[VaultTransitAdapter] Algorand address: ${this._publicAddress} (key=${this.keyName} v${version})`);
    return this._publicAddress;
  }

  async signRawBytes(bytesToSign: Uint8Array): Promise<Uint8Array> {
    // Vault Transit expects base64url-encoded input
    const inputB64 = Buffer.from(bytesToSign).toString("base64");

    const res = await this.vaultFetch(`transit/sign/${this.keyName}`, {
      method: "POST",
      body:   JSON.stringify({ input: inputB64, prehashed: false }),
    });

    const data = await res.json() as { data: { signature: string } };
    const vaultSig = data.data.signature; // "vault:v1:<base64(sig)>"

    // Strip the "vault:v1:" prefix
    const sigB64 = vaultSig.split(":").pop();
    if (!sigB64) {
      throw new Error(`VaultTransitAdapter: Unexpected signature format: ${vaultSig}`);
    }

    const sigBytes = Buffer.from(sigB64, "base64");
    if (sigBytes.length !== 64) {
      throw new Error(`VaultTransitAdapter: Expected 64-byte signature, got ${sigBytes.length} bytes`);
    }

    return new Uint8Array(sigBytes);
  }

  async healthCheck(): Promise<void> {
    // Verify Vault is reachable and the transit key exists
    await this.getPublicAddress();
    console.log(`[VaultTransitAdapter] Health check passed — Vault reachable, key "${this.keyName}" exists`);
  }
}
