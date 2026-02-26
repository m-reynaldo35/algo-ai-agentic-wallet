/**
 * Multi-Sig Emergency Halt — 2-of-3 Admin Veto
 *
 * Replaces the single-key HALT_OVERRIDE_KEY mechanism with a threshold
 * multi-signature scheme that prevents insider threats and single points
 * of compromise from triggering or lifting an emergency halt.
 *
 * Admin keys: Algorand addresses (Ed25519, base58).
 * Signature verification uses algosdk.verifyBytes() — the standard
 * Algorand proof-of-key-control primitive, already used in the custody
 * rekey challenge flow.
 *
 * Signed message format (per admin, ASCII):
 *   "x402:multisig-halt:{action}:{unix_timestamp_seconds}:{sha256hex(reason)}"
 *
 * Validation rules:
 *   1. timestamp within ±5 minutes of server time (replay window)
 *   2. action must be exactly "halt" or "unhalt"
 *   3. reason ≤ 256 characters
 *   4. Each submitted signature is verified with algosdk.verifyBytes()
 *      against the registered admin key at the specified keyIndex (1–3)
 *   5. HALT_ADMIN_MIN_SIGS (default: 2) unique valid signatures required
 *      (deduplicated by key index — one admin cannot double-vote)
 *
 * Environment variables:
 *   HALT_ADMIN_PUBKEY_1   Algorand address of admin key 1
 *   HALT_ADMIN_PUBKEY_2   Algorand address of admin key 2
 *   HALT_ADMIN_PUBKEY_3   Algorand address of admin key 3
 *   HALT_ADMIN_MIN_SIGS   Min valid signatures required (default: 2)
 *
 * Module 8 — Multi-Sig Emergency Veto
 */

import algosdk from "algosdk";
import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export type HaltAction = "halt" | "unhalt";

export interface HaltSignature {
  /** Which registered admin key (1 | 2 | 3) signed this */
  keyIndex: 1 | 2 | 3;
  /** Base64-encoded Ed25519 signature */
  sig: string;
}

// ── Policy config ──────────────────────────────────────────────────

const TIMESTAMP_WINDOW_S = 300; // ±5 minutes
const MAX_REASON_LEN     = 256;
const DEFAULT_MIN_SIGS   = 2;

// ── Helpers ────────────────────────────────────────────────────────

function getAdminKeys(): Record<1 | 2 | 3, string | undefined> {
  return {
    1: process.env.HALT_ADMIN_PUBKEY_1,
    2: process.env.HALT_ADMIN_PUBKEY_2,
    3: process.env.HALT_ADMIN_PUBKEY_3,
  };
}

function getMinSigs(): number {
  const n = parseInt(process.env.HALT_ADMIN_MIN_SIGS ?? String(DEFAULT_MIN_SIGS), 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_MIN_SIGS;
  return n;
}

/**
 * Construct the canonical signed message for a halt/unhalt action.
 *
 * "x402:multisig-halt:{action}:{timestamp}:{sha256hex(reason)}"
 *
 * The reason is hashed so the message length is bounded and the
 * signature covers the exact reason string without truncation risk.
 */
function buildSignedMessage(
  action:    HaltAction,
  timestamp: number,
  reason:    string,
): Uint8Array {
  const reasonHash = createHash("sha256").update(reason).digest("hex");
  const msg        = `x402:multisig-halt:${action}:${timestamp}:${reasonHash}`;
  return Buffer.from(msg, "utf8");
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Verify a multi-signature halt/unhalt request.
 *
 * Throws on any failure — callers catch and return 400/403.
 * Returns the count of valid signers on success.
 *
 * @param action     - "halt" or "unhalt"
 * @param reason     - Human-readable reason (max 256 chars)
 * @param timestamp  - Unix seconds at signing time
 * @param signatures - Array of { keyIndex, sig } from admin signers
 * @returns          - Number of valid admin signatures accepted
 */
export function verifyMultiSigHalt(
  action:     HaltAction,
  reason:     string,
  timestamp:  number,
  signatures: HaltSignature[],
): number {
  // ── Validation ────────────────────────────────────────────────
  if (action !== "halt" && action !== "unhalt") {
    throw new Error(`Invalid action "${action}" — must be "halt" or "unhalt"`);
  }
  if (reason.length > MAX_REASON_LEN) {
    throw new Error(`reason exceeds ${MAX_REASON_LEN} characters`);
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Error("signatures array is empty");
  }

  // ── Timestamp replay window ───────────────────────────────────
  const nowS  = Math.floor(Date.now() / 1_000);
  const delta = Math.abs(nowS - timestamp);
  if (delta > TIMESTAMP_WINDOW_S) {
    throw new Error(
      `timestamp out of window: delta=${delta}s, max=${TIMESTAMP_WINDOW_S}s. ` +
      "Use the current Unix timestamp (in seconds).",
    );
  }

  // ── Build canonical message ───────────────────────────────────
  const messageBytes = buildSignedMessage(action, timestamp, reason);

  // ── Verify each signature ─────────────────────────────────────
  const adminKeys  = getAdminKeys();
  const minSigs    = getMinSigs();
  const validIdxs  = new Set<number>(); // deduplicated by keyIndex

  for (const { keyIndex, sig } of signatures) {
    if (keyIndex !== 1 && keyIndex !== 2 && keyIndex !== 3) {
      // Skip unknown key indexes silently — don't abort on one bad entry
      continue;
    }
    if (validIdxs.has(keyIndex)) {
      // Deduplicate — one admin cannot double-vote
      continue;
    }

    const pubkey = adminKeys[keyIndex];
    if (!pubkey) {
      // Key not configured — skip
      continue;
    }
    if (!algosdk.isValidAddress(pubkey)) {
      console.warn(`[MultiSigHalt] HALT_ADMIN_PUBKEY_${keyIndex} is not a valid Algorand address`);
      continue;
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = new Uint8Array(Buffer.from(sig, "base64"));
    } catch {
      continue; // malformed base64 — skip this entry
    }

    try {
      const valid = algosdk.verifyBytes(messageBytes, sigBytes, pubkey);
      if (valid) {
        validIdxs.add(keyIndex);
      }
    } catch {
      // verifyBytes can throw on malformed inputs — treat as invalid
      continue;
    }
  }

  if (validIdxs.size < minSigs) {
    throw new Error(
      `Insufficient valid signatures: ${validIdxs.size} provided, ${minSigs} required. ` +
      "Each admin must sign the canonical message with their registered Algorand key.",
    );
  }

  return validIdxs.size;
}

/**
 * Check whether multi-sig halt is configured (any admin key set).
 * Used to skip the check at boot rather than failing silently in prod.
 */
export function isMultiSigConfigured(): boolean {
  const keys = getAdminKeys();
  return !!(keys[1] || keys[2] || keys[3]);
}
