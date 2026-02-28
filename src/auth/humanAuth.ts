/**
 * Human Governance Authentication — Liquid Auth (Algorand wallet QR)
 *
 * Operators prove ownership of an Algorand account by scanning a QR code
 * with their wallet app (Pera, Defly, or any wallet implementing
 * algosdk.signBytes). No browser extension, hardware key, or biometric
 * device required.
 *
 * Flow:
 *   1. POST /api/agents/:agentId/auth/liquid-challenge
 *      └─ issueAlgorandChallenge() → sessionId + QR payload
 *
 *   2. Wallet app scans QR → calls POST .../auth/liquid-sign
 *      └─ submitAlgorandSignature() → verifies Ed25519 sig, marks session verified
 *
 *   3. Frontend polls GET .../auth/liquid-status/:sessionId until "verified"
 *
 *   4. Frontend uses sessionId in mandate create/revoke / address registration
 *      └─ consumeVerifiedSession() → atomically GETDEL, returns verified address
 *
 * Cryptography:
 *   - Challenge = SHA-256(nonce + ":" + intent + ":" + agentId)  [32 bytes]
 *   - Wallet signs via algosdk.signBytes(challenge, sk)           ["MX" prefix + ed25519]
 *   - Backend verifies via algosdk.verifyBytes(challenge, sig, addr)
 *   - Session is single-use (GETDEL on consumption), 5-minute TTL
 *
 * WebAuthn (device passkeys) is handled separately in mandateService.ts via
 * @simplewebauthn/server. Both paths produce a verified ownerWalletId.
 */

import { randomUUID, randomBytes, createHash } from "node:crypto";
import algosdk                                  from "algosdk";
import { getRedis }                             from "../services/redis.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SESSION_PREFIX = "x402:liquid-session:";
const SESSION_TTL_S  = 300; // 5 minutes

// ── Types ──────────────────────────────────────────────────────────────────

export type LiquidAuthIntent =
  | "register"        // operator registering their address for an agent
  | "mandate-create"  // authorising a new mandate
  | "mandate-revoke"; // revoking an existing mandate

export interface LiquidAuthSession {
  sessionId:  string;
  agentId:    string;
  intent:     LiquidAuthIntent;
  /** Raw SHA-256 digest as hex — wallet signs this (with algosdk's "MX" prefix) */
  challengeHex: string;
  /** The nonce component used to construct the challenge */
  nonce:      string;
  status:     "pending" | "verified";
  /** Verified Algorand address — set only after submitAlgorandSignature() */
  address?:   string;
  expiresAt:  number; // ms epoch
}

/**
 * The JSON object encoded into the QR code shown to the operator.
 * Wallet apps parse this, display the intent, and sign challengeBase64.
 */
export interface QRPayload {
  type:          "algorand-liquid-auth";
  version:       1;
  sessionId:     string;
  agentId:       string;
  intent:        LiquidAuthIntent;
  /** base64-encoded challenge bytes — pass directly to algosdk.signBytes() */
  challengeBase64: string;
  /**
   * URL the wallet POSTs the signature to.
   * Body: { sessionId, address, signatureBase64 }
   */
  callbackUrl:   string;
  /** Human-readable context for the wallet's approval prompt */
  description:   string;
  expiresAt:     number; // ms epoch
}

// ── Session helpers ────────────────────────────────────────────────────────

function parseSession(raw: unknown): LiquidAuthSession {
  if (typeof raw === "string") return JSON.parse(raw) as LiquidAuthSession;
  if (raw && typeof raw === "object") return raw as LiquidAuthSession;
  throw new Error("Corrupt session record");
}

function intentDescription(intent: LiquidAuthIntent, agentId: string): string {
  switch (intent) {
    case "register":        return `Register as owner of agent ${agentId}`;
    case "mandate-create":  return `Authorize new spending mandate for agent ${agentId}`;
    case "mandate-revoke":  return `Revoke spending mandate for agent ${agentId}`;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Issue a Liquid Auth challenge for a governance operation.
 *
 * The challenge is SHA-256(nonce + ":" + intent + ":" + agentId).
 * The wallet signs this with algosdk.signBytes (adds "MX" prefix automatically).
 *
 * @param agentId — The agent being governed
 * @param intent  — The governance operation being authorised
 * @param baseUrl — API base URL (used to build callbackUrl for the QR)
 * @returns sessionId, QR payload object, and expiry timestamp
 */
export async function issueAlgorandChallenge(
  agentId: string,
  intent:  LiquidAuthIntent,
  baseUrl: string = "https://api.ai-agentic-wallet.com",
): Promise<{ sessionId: string; qrPayload: QRPayload; expiresAt: number }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const sessionId    = randomUUID();
  const nonce        = randomBytes(16).toString("hex");
  const preimage     = `${nonce}:${intent}:${agentId}`;
  const challengeBuf = createHash("sha256").update(preimage).digest();
  const challengeHex = challengeBuf.toString("hex");
  const challengeB64 = challengeBuf.toString("base64");
  const expiresAt    = Date.now() + SESSION_TTL_S * 1_000;

  const session: LiquidAuthSession = {
    sessionId,
    agentId,
    intent,
    challengeHex,
    nonce,
    status:    "pending",
    expiresAt,
  };

  await redis.set(
    `${SESSION_PREFIX}${sessionId}`,
    JSON.stringify(session),
    { ex: SESSION_TTL_S },
  );

  const callbackUrl =
    `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/auth/liquid-sign`;

  const qrPayload: QRPayload = {
    type:            "algorand-liquid-auth",
    version:         1,
    sessionId,
    agentId,
    intent,
    challengeBase64: challengeB64,
    callbackUrl,
    description:     intentDescription(intent, agentId),
    expiresAt,
  };

  console.log(`[LiquidAuth] Challenge issued: agent=${agentId} intent=${intent} session=${sessionId}`);
  return { sessionId, qrPayload, expiresAt };
}

/**
 * Called by the wallet app after the user approves the signing prompt.
 *
 * Verifies the Ed25519 signature using algosdk.verifyBytes (which handles the
 * "MX" anti-replay prefix). Marks the session as "verified" with the address.
 *
 * Idempotent — if the wallet retries after a network hiccup, returns ok again.
 *
 * @param sessionId       — From the QR payload
 * @param address         — Algorand address that signed (from the wallet)
 * @param signatureBase64 — base64 of the 64-byte Ed25519 signature
 */
export async function submitAlgorandSignature(
  sessionId:       string,
  address:         string,
  signatureBase64: string,
): Promise<{ ok: true; agentId: string }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.get(`${SESSION_PREFIX}${sessionId}`) as unknown;
  if (!raw) throw new Error("Session not found — expired or invalid sessionId");

  const session = parseSession(raw);

  if (session.status === "verified") {
    // Idempotent — wallet retried after network issue
    return { ok: true, agentId: session.agentId };
  }

  if (Date.now() > session.expiresAt) {
    throw new Error("Session expired — request a new QR code");
  }

  // Validate address format before verification
  if (!algosdk.isValidAddress(address)) {
    throw new Error(`Invalid Algorand address: ${address}`);
  }

  // Reconstruct challenge bytes from the stored hex
  const challengeBytes  = Buffer.from(session.challengeHex, "hex");
  const signatureBytes  = Buffer.from(signatureBase64, "base64");

  // algosdk.verifyBytes prepends "MX" before verify — must match signBytes behaviour
  let valid: boolean;
  try {
    valid = algosdk.verifyBytes(challengeBytes, signatureBytes, address);
  } catch (err) {
    throw new Error(
      `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!valid) {
    throw new Error("Invalid signature — the provided address did not sign this challenge");
  }

  // Persist the verified session (keep remaining TTL)
  const remainingTtl = Math.max(Math.ceil((session.expiresAt - Date.now()) / 1_000), 1);
  const verified: LiquidAuthSession = { ...session, status: "verified", address };

  await redis.set(
    `${SESSION_PREFIX}${sessionId}`,
    JSON.stringify(verified),
    { ex: remainingTtl },
  );

  console.log(`[LiquidAuth] Session verified: agent=${session.agentId} address=${address}`);
  return { ok: true, agentId: session.agentId };
}

/**
 * Non-consuming status poll. Called by the frontend every ~2 seconds.
 *
 * @returns Session status, or null if the session has expired/not found
 */
export async function getLiquidAuthStatus(
  sessionId: string,
): Promise<{ status: "pending" | "verified"; address?: string } | null> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.get(`${SESSION_PREFIX}${sessionId}`) as unknown;
  if (!raw) return null;

  const session = parseSession(raw);
  return { status: session.status, address: session.address };
}

/**
 * Atomically consume a verified Liquid Auth session.
 *
 * Uses GETDEL — single-use, replay-protected. Call this from mandate
 * create/revoke and address registration operations.
 *
 * @param sessionId       — From the QR flow
 * @param expectedAgentId — Must match the session's agentId (prevents cross-agent replay)
 * @param expectedIntent  — Must match the session's intent (prevents cross-operation replay)
 * @returns The verified Algorand address
 * @throws If not found, not verified, expired, agentId mismatch, or intent mismatch
 */
export async function consumeVerifiedSession(
  sessionId:      string,
  expectedAgentId: string,
  expectedIntent:  LiquidAuthIntent,
): Promise<{ address: string }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.getdel(`${SESSION_PREFIX}${sessionId}`) as unknown;
  if (!raw) throw new Error("Liquid Auth session not found — expired or already used");

  const session = parseSession(raw);

  if (session.status !== "verified") {
    throw new Error("Liquid Auth session pending — wallet has not signed yet");
  }
  if (Date.now() > session.expiresAt) {
    throw new Error("Liquid Auth session expired");
  }
  if (session.agentId !== expectedAgentId) {
    throw new Error("Liquid Auth session agentId mismatch — cross-agent replay denied");
  }
  if (session.intent !== expectedIntent) {
    throw new Error(
      `Liquid Auth session intent mismatch — expected "${expectedIntent}", got "${session.intent}"`,
    );
  }
  if (!session.address) {
    throw new Error("Liquid Auth session missing verified address");
  }

  return { address: session.address };
}
