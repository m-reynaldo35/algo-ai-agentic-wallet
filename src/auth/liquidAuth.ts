import crypto from "node:crypto";

/**
 * Liquid Auth — FIDO2/Passkey Agent Identity Verification
 *
 * Authenticates an AI agent's identity using the Liquid Auth protocol.
 * In production, this integrates with the Liquid Auth FIDO2 server to
 * perform a full WebAuthn challenge-response flow. The agent must prove
 * possession of a registered passkey bound to its agentId.
 *
 * The returned AuthToken is an opaque bearer credential that the Rocca
 * Wallet SDK validates before releasing any signing capability.
 *
 * Flow:
 *   Agent → requestChallenge(agentId) → FIDO2 Server
 *   FIDO2 Server → challenge nonce → Agent
 *   Agent → sign(challenge, passkey) → FIDO2 Server
 *   FIDO2 Server → verify → AuthToken
 */

export interface AuthToken {
  /** Opaque token string for downstream validation */
  token: string;
  /** The authenticated agent identity */
  agentId: string;
  /** Token issuance timestamp (ms since epoch) */
  issuedAt: number;
  /** Token expiry timestamp (ms since epoch) — 5 minute window */
  expiresAt: number;
  /** Authentication method used */
  method: "fido2-passkey";
}

// ── Token TTL ───────────────────────────────────────────────────
const AUTH_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validate that an agentId meets minimum format requirements.
 */
function validateAgentId(agentId: string): void {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("Liquid Auth Failed: agentId must be a non-empty string");
  }
  if (agentId.length < 3 || agentId.length > 128) {
    throw new Error("Liquid Auth Failed: agentId must be 3-128 characters");
  }
}

/**
 * Simulate a FIDO2 challenge-response exchange with the Liquid Auth server.
 *
 * Production replacement:
 *   1. POST /liquid-auth/challenge { agentId } → { challenge: Uint8Array }
 *   2. Agent signs challenge with its registered FIDO2 passkey
 *   3. POST /liquid-auth/verify { agentId, signature, authenticatorData }
 *   4. Server returns signed AuthToken JWT
 *
 * Local mock: generates a cryptographically random challenge, simulates
 * verification, and returns a locally-signed HMAC token.
 */
async function performFIDO2Challenge(agentId: string): Promise<string> {
  // Generate a 32-byte challenge nonce
  const challenge = crypto.randomBytes(32);

  // In production: the agent would sign this challenge with its
  // registered FIDO2 passkey and return the WebAuthn assertion.
  // Here we simulate successful verification.
  const challengeHex = challenge.toString("hex");

  // Produce an HMAC-based token binding the agentId to this session.
  // Production: replaced by a JWT signed by the Liquid Auth server's
  // RSA/EC key, verifiable by Rocca Wallet's public key.
  const hmacKey = crypto.randomBytes(32);
  const tokenPayload = `${agentId}:${challengeHex}:${Date.now()}`;
  const hmac = crypto.createHmac("sha256", hmacKey).update(tokenPayload).digest("hex");

  return `lqauth_${hmac}`;
}

/**
 * Authenticate an AI agent's identity via Liquid Auth (FIDO2).
 *
 * @param agentId - Unique identifier for the agent requesting signing access
 * @returns AuthToken — verified credential for downstream Rocca Wallet calls
 * @throws Error('Liquid Auth Failed: ...') if FIDO2 challenge fails
 */
export async function authenticateAgentIdentity(agentId: string): Promise<AuthToken> {
  validateAgentId(agentId);

  console.log(`[LiquidAuth] Initiating FIDO2 challenge for agent: ${agentId}`);

  try {
    const token = await performFIDO2Challenge(agentId);
    const now = Date.now();

    const authToken: AuthToken = {
      token,
      agentId,
      issuedAt: now,
      expiresAt: now + AUTH_TOKEN_TTL_MS,
      method: "fido2-passkey",
    };

    console.log(`[LiquidAuth] Agent authenticated: ${agentId} (expires in ${AUTH_TOKEN_TTL_MS / 1000}s)`);
    return authToken;

  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown FIDO2 error";
    throw new Error(`Liquid Auth Failed: Agent identity unverified — ${detail}`);
  }
}

/**
 * Validate an existing AuthToken has not expired and is structurally sound.
 *
 * @param authToken - The token to validate
 * @throws Error if the token is expired or malformed
 */
export function validateAuthToken(authToken: AuthToken): void {
  if (!authToken.token || !authToken.token.startsWith("lqauth_")) {
    throw new Error("Liquid Auth Failed: Malformed auth token");
  }
  if (Date.now() > authToken.expiresAt) {
    throw new Error(`Liquid Auth Failed: Token expired for agent ${authToken.agentId}`);
  }
}
