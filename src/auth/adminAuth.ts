/**
 * Admin Portal Authentication
 *
 * Standalone auth for the x402 admin portal — no agent record required.
 *
 * Two paths:
 *   1. Liquid Auth — Algorand wallet QR (Pera, Defly). Address verified
 *      and checked against ADMIN_WALLET_ADDRESSES env var by the portal.
 *
 *   2. WebAuthn — device passkey. Single credential stored in Redis.
 *      If no credential exists: registration is allowed (TOFU bootstrap).
 *      After first credential is set, new ones require an existing session.
 *
 * All sessions are single-use (GETDEL on consumption).
 */

import { randomUUID, randomBytes, createHash } from "node:crypto";
import algosdk from "algosdk";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { getRedis } from "../services/redis.js";

// ── Redis keys ────────────────────────────────────────────────────────────

const LIQUID_PREFIX             = "x402:admin:liquid:";          // {sessionId} → JSON
const LIQUID_TTL_S              = 300;                            // 5 minutes — pending session
const LIQUID_POST_VERIFY_TTL_S  = 60;                             // 60s max after wallet signs
const WEBAUTHN_REG_CHAL_KEY     = "x402:admin:webauthn:reg-chal";
const WEBAUTHN_LOGIN_CHAL_KEY   = "x402:admin:webauthn:login-chal";
const WEBAUTHN_CRED_KEY         = "x402:admin:webauthn:cred";    // single JSON record
const WEBAUTHN_TTL_S            = 300;

// ── Types ─────────────────────────────────────────────────────────────────

interface AdminLiquidSession {
  sessionId:    string;
  challengeHex: string;
  nonce:        string;
  /** Unix seconds — baked into the challenge hash for replay prevention */
  issuedAt:     number;
  /** Application domain — baked into the challenge hash for cross-deployment replay prevention */
  domain:       string;
  status:       "pending" | "verified";
  address?:     string;
  expiresAt:    number; // ms epoch
}

interface AdminWebAuthnCred {
  credentialId: string;
  publicKey:    string; // base64url COSE public key
  counter:      number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseSession(raw: unknown): AdminLiquidSession {
  if (typeof raw === "string") return JSON.parse(raw) as AdminLiquidSession;
  if (raw && typeof raw === "object") return raw as AdminLiquidSession;
  throw new Error("Corrupt admin liquid session");
}

function parseCred(raw: unknown): AdminWebAuthnCred | null {
  if (!raw) return null;
  if (typeof raw === "string") return JSON.parse(raw) as AdminWebAuthnCred;
  if (raw && typeof raw === "object") return raw as AdminWebAuthnCred;
  return null;
}

function getWebAuthnConfig(): { rpId: string; origins: string[] } {
  const rpId = process.env.FIDO2_RP_ID ?? process.env.LIQUID_AUTH_RP_ID ?? "localhost";
  const rawOrigins = process.env.WEBAUTHN_ORIGIN
    ?? (rpId === "localhost"
      ? "http://localhost:3000,http://localhost:3001,https://localhost:3000,https://localhost"
      : `https://${rpId}`);
  const origins = rawOrigins.split(",").map((s) => s.trim()).filter(Boolean);
  return { rpId, origins };
}

// ── Liquid Auth — Issue challenge ─────────────────────────────────────────

export async function issueAdminLiquidChallenge(
  baseUrl: string = "https://api.ai-agentic-wallet.com",
): Promise<{ sessionId: string; qrPayload: object; expiresAt: number }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  // Domain is baked into the signed bytes to prevent cross-deployment replay.
  // An admin session signed for "api.example.com" cannot be consumed on "api.other.com".
  const domain    = process.env.X402_APP_ID || new URL(baseUrl).hostname;
  const issuedAt  = Math.floor(Date.now() / 1_000); // Unix seconds
  const sessionId = randomUUID();
  const nonce     = randomBytes(32).toString("hex"); // 256-bit entropy

  // Preimage binds: purpose · domain · timestamp · nonce
  // algosdk.signBytes prepends "MX" before Ed25519 signing,
  // so this cannot be confused with a raw Algorand transaction.
  const preimage = `x402-admin-login:${domain}:${issuedAt}:${nonce}`;
  const challengeBuf = createHash("sha256").update(preimage).digest();
  const expiresAt    = Date.now() + LIQUID_TTL_S * 1_000;

  const session: AdminLiquidSession = {
    sessionId,
    challengeHex: challengeBuf.toString("hex"),
    nonce,
    issuedAt,
    domain,
    status:       "pending",
    expiresAt,
  };

  await redis.set(`${LIQUID_PREFIX}${sessionId}`, JSON.stringify(session), { ex: LIQUID_TTL_S });

  const qrPayload = {
    type:            "algorand-liquid-auth",
    version:         1,
    sessionId,
    agentId:         "x402-admin",
    intent:          "admin-login",
    challengeBase64: challengeBuf.toString("base64"),
    callbackUrl:     `${baseUrl}/api/admin/auth/liquid-sign`,
    // This description is shown in the wallet signing prompt.
    description:     `Sign to authenticate as x402 Admin at ${domain}. Do not sign if you did not request this.`,
    expiresAt,
  };

  console.log(`[AdminAuth] Liquid challenge issued: session=${sessionId} domain=${domain}`);
  return { sessionId, qrPayload, expiresAt };
}

// ── Liquid Auth — Wallet callback (no auth required) ─────────────────────

export async function submitAdminLiquidSignature(
  sessionId:       string,
  address:         string,
  signatureBase64: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.get(`${LIQUID_PREFIX}${sessionId}`) as unknown;
  if (!raw) throw new Error("Session not found — expired or invalid");

  const session = parseSession(raw);
  if (session.status === "verified") return; // idempotent

  if (Date.now() > session.expiresAt) throw new Error("Session expired");
  if (!algosdk.isValidAddress(address)) throw new Error(`Invalid Algorand address: ${address}`);

  const challengeBytes = Buffer.from(session.challengeHex, "hex");
  const signatureBytes = Buffer.from(signatureBase64, "base64");

  let valid: boolean;
  try {
    valid = algosdk.verifyBytes(challengeBytes, signatureBytes, address);
  } catch (err) {
    throw new Error(`Signature error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!valid) throw new Error("Invalid signature — address did not sign this challenge");

  // After signature is accepted, shrink the TTL to LIQUID_POST_VERIFY_TTL_S (60s).
  // The frontend detects "verified" within one poll cycle (~2s) and calls consume.
  // The short window minimises the risk if a sessionId is intercepted post-sign.
  // consume() uses GETDEL — single-use, atomic.
  const postVerifyTtl = Math.min(
    LIQUID_POST_VERIFY_TTL_S,
    Math.max(Math.ceil((session.expiresAt - Date.now()) / 1_000), 1),
  );
  await redis.set(
    `${LIQUID_PREFIX}${sessionId}`,
    JSON.stringify({ ...session, status: "verified", address }),
    { ex: postVerifyTtl },
  );

  console.log(`[AdminAuth] Liquid session verified: address=${address} ttl=${postVerifyTtl}s`);
}

// ── Liquid Auth — Status poll ─────────────────────────────────────────────

export async function getAdminLiquidStatus(
  sessionId: string,
): Promise<{ status: "pending" | "verified" } | null> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.get(`${LIQUID_PREFIX}${sessionId}`) as unknown;
  if (!raw) return null;

  const session = parseSession(raw);
  return { status: session.status };
}

// ── Liquid Auth — Consume session (portal calls this on verified) ──────────

export async function consumeAdminLiquidSession(
  sessionId: string,
): Promise<{ address: string }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const raw = await redis.getdel(`${LIQUID_PREFIX}${sessionId}`) as unknown;
  if (!raw) throw new Error("Admin session not found — expired or already used");

  const session = parseSession(raw);
  if (session.status !== "verified") throw new Error("Session not yet verified");
  if (Date.now() > session.expiresAt) throw new Error("Session expired");
  if (!session.address) throw new Error("Session missing verified address");

  return { address: session.address };
}

// ── WebAuthn — Registration challenge ────────────────────────────────────

export async function issueAdminWebAuthnRegChallenge(): Promise<{
  challenge:       string;
  userId:          string;
  rpId:            string;
  rpName:          string;
  userName:        string;
  userDisplayName: string;
  hasCredentials:  boolean;
}> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = isoBase64URL.fromBuffer(Buffer.from(challengeBytes));

  await redis.set(WEBAUTHN_REG_CHAL_KEY, challenge, { ex: WEBAUTHN_TTL_S });

  const { rpId } = getWebAuthnConfig();
  const existing = parseCred(await redis.get(WEBAUTHN_CRED_KEY) as unknown);

  return {
    challenge,
    userId:          isoBase64URL.fromBuffer(Buffer.from("x402-admin")),
    rpId,
    rpName:          "x402 Admin Portal",
    userName:        "admin",
    userDisplayName: "x402 Admin",
    hasCredentials:  !!existing,
  };
}

// ── WebAuthn — Verify registration ───────────────────────────────────────

export async function verifyAndRegisterAdminWebAuthn(
  response: RegistrationResponseJSON,
): Promise<{ credentialId: string }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const challenge = await redis.getdel(WEBAUTHN_REG_CHAL_KEY) as string | null;
  if (!challenge) throw new Error("No active registration challenge");

  const { rpId, origins } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge:       challenge,
      expectedOrigin:          origins,
      expectedRPID:            rpId,
      requireUserVerification: false,
    });
  } catch (err) {
    throw new Error(`WebAuthn registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("WebAuthn registration not verified");
  }

  const { id: credentialID, publicKey, counter } = verification.registrationInfo.credential;
  const cred: AdminWebAuthnCred = {
    credentialId: credentialID,
    publicKey:    isoBase64URL.fromBuffer(Buffer.from(publicKey)),
    counter,
  };

  await redis.set(WEBAUTHN_CRED_KEY, JSON.stringify(cred));
  console.log(`[AdminAuth] WebAuthn credential registered: credId=${credentialID.slice(0, 16)}…`);
  return { credentialId: credentialID };
}

// ── WebAuthn — Login challenge ────────────────────────────────────────────

export async function issueAdminWebAuthnLoginChallenge(): Promise<{
  challenge:        string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
  hasCredentials:   boolean;
  rpId:             string;
}> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = isoBase64URL.fromBuffer(Buffer.from(challengeBytes));

  await redis.set(WEBAUTHN_LOGIN_CHAL_KEY, challenge, { ex: WEBAUTHN_TTL_S });

  const { rpId } = getWebAuthnConfig();
  const existing = parseCred(await redis.get(WEBAUTHN_CRED_KEY) as unknown);

  return {
    challenge,
    allowCredentials: existing
      ? [{ id: existing.credentialId, type: "public-key" as const }]
      : [],
    hasCredentials: !!existing,
    rpId,
  };
}

// ── WebAuthn — Verify login assertion ─────────────────────────────────────

export async function verifyAdminWebAuthnLoginAssertion(
  assertion: AuthenticationResponseJSON,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const challenge = await redis.getdel(WEBAUTHN_LOGIN_CHAL_KEY) as string | null;
  if (!challenge) throw new Error("No active login challenge — call login-challenge first");

  const existing = parseCred(await redis.get(WEBAUTHN_CRED_KEY) as unknown);
  if (!existing) throw new Error("No admin WebAuthn credential registered");
  if (existing.credentialId !== assertion.id) throw new Error("Credential not recognized");

  const { rpId, origins } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response:              assertion,
      expectedChallenge:     challenge,
      expectedOrigin:        origins,
      expectedRPID:          rpId,
      requireUserVerification: false,
      credential: {
        id:        existing.credentialId,
        publicKey: new Uint8Array(isoBase64URL.toBuffer(existing.publicKey)),
        counter:   existing.counter,
      },
    });
  } catch (err) {
    throw new Error(`WebAuthn login failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!verification.verified) throw new Error("WebAuthn login not verified");

  // Update counter (anti-replay)
  const updated: AdminWebAuthnCred = {
    ...existing,
    counter: verification.authenticationInfo.newCounter,
  };
  await redis.set(WEBAUTHN_CRED_KEY, JSON.stringify(updated));
}
