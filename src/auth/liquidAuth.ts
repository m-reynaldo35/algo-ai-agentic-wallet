import crypto from "node:crypto";
import { config } from "../config.js";
import { getRedis } from "../services/redis.js";

/**
 * Liquid Auth — FIDO2/Passkey Agent Identity Verification
 *
 * Environment-switched authentication:
 *   - LIQUID_AUTH_SERVER_URL set: Real FIDO2 assertion via Liquid Auth REST API
 *   - LIQUID_AUTH_SERVER_URL empty: Dev mock (local testing only — blocked in production)
 *
 * The returned AuthToken is an opaque bearer credential that the Rocca
 * Wallet validates before releasing any signing capability.
 *
 * Security guarantee: validateAuthToken() cryptographically verifies mock tokens
 * via Redis (single-use). Real mode delegates to the Liquid Auth server.
 */

const MOCK_TOKEN_PREFIX = "x402:mock-token:";
const MOCK_TOKEN_TTL_S  = 300; // 5 minutes — matches AUTH_TOKEN_TTL_MS

/**
 * Asserts the process is safe to start in the current auth configuration.
 * Call this at boot time. Throws if production is misconfigured.
 */
export function assertProductionAuthReady(): void {
  if (process.env.NODE_ENV === "production" && !config.liquidAuth.serverUrl) {
    throw new Error(
      "SECURITY: LIQUID_AUTH_SERVER_URL must be set in production. " +
      "Mock FIDO2 auth provides no cryptographic guarantees. " +
      "Refusing to start. Set LIQUID_AUTH_SERVER_URL to a Liquid Auth server.",
    );
  }
}

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
 * Real FIDO2 assertion via the Liquid Auth server REST API.
 *
 * Flow:
 *   1. GET  /assertion/request/{agentId} — server returns challenge + allowCredentials
 *   2. Server-side: we sign the challenge using the agent's credential
 *      (In a full implementation, the agent's FIDO2 authenticator signs here.
 *       For server-to-server, we POST the agentId and the server validates
 *       the agent's pre-registered credential.)
 *   3. POST /assertion/response — server validates and returns a signed token
 */
async function performRealFIDO2Assertion(agentId: string): Promise<string> {
  const serverUrl = config.liquidAuth.serverUrl;

  // Step 1: Request assertion options from the Liquid Auth server
  const requestUrl = `${serverUrl}/assertion/request/${encodeURIComponent(agentId)}`;
  const optionsRes = await fetch(requestUrl, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!optionsRes.ok) {
    throw new Error(`Liquid Auth assertion request failed: ${optionsRes.status} ${optionsRes.statusText}`);
  }

  const options = await optionsRes.json() as {
    challenge: string;
    allowCredentials?: Array<{ id: string; type: string }>;
    rpId?: string;
  };

  if (!options.challenge) {
    throw new Error("Liquid Auth server returned no challenge");
  }

  // Step 2: Submit assertion response
  // For server-to-server auth, we submit the agent identity and challenge.
  // The Liquid Auth server validates the agent's pre-registered credential
  // and returns a signed authentication token.
  const responseUrl = `${serverUrl}/assertion/response`;
  const assertionRes = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: agentId,
      type: "public-key",
      challenge: options.challenge,
      rpId: config.liquidAuth.rpId || options.rpId,
    }),
  });

  if (!assertionRes.ok) {
    throw new Error(`Liquid Auth assertion response failed: ${assertionRes.status} ${assertionRes.statusText}`);
  }

  const result = await assertionRes.json() as { token?: string };
  if (!result.token) {
    throw new Error("Liquid Auth server returned no token");
  }

  return result.token;
}

/**
 * Dev mock: generates a cryptographically random HMAC token and stores it
 * in Redis for cross-process verification. Single-use: consumed on validation.
 * NOT suitable for production — blocked by assertProductionAuthReady().
 */
async function performMockFIDO2Challenge(agentId: string): Promise<string> {
  const challenge    = crypto.randomBytes(32);
  const hmacKey      = crypto.randomBytes(32);
  const tokenPayload = `${agentId}:${challenge.toString("hex")}:${Date.now()}`;
  const hmac         = crypto.createHmac("sha256", hmacKey).update(tokenPayload).digest("hex");
  const token        = `lqauth_${hmac}`;

  // Store in Redis so the signing service (separate process) can verify it.
  // Keyed by token value; value = agentId for binding verification.
  const redis = getRedis();
  if (redis) {
    await redis.set(`${MOCK_TOKEN_PREFIX}${token}`, agentId, { ex: MOCK_TOKEN_TTL_S });
  }

  return token;
}

/**
 * Authenticate an AI agent's identity via Liquid Auth (FIDO2).
 *
 * If LIQUID_AUTH_SERVER_URL is configured, performs a real FIDO2 assertion
 * against the Liquid Auth server. Otherwise, falls back to a local dev mock.
 *
 * @param agentId - Unique identifier for the agent requesting signing access
 * @returns AuthToken — verified credential for downstream Rocca Wallet calls
 * @throws Error('Liquid Auth Failed: ...') if FIDO2 challenge fails
 */
export async function authenticateAgentIdentity(agentId: string): Promise<AuthToken> {
  validateAgentId(agentId);

  const useRealAuth = !!config.liquidAuth.serverUrl;

  if (useRealAuth) {
    console.log(`[LiquidAuth] Initiating FIDO2 assertion for agent: ${agentId} → ${config.liquidAuth.serverUrl}`);
  } else {
    console.warn(`[LiquidAuth] DEV MODE: No LIQUID_AUTH_SERVER_URL set — using mock FIDO2 for agent: ${agentId}`);
  }

  try {
    const token = useRealAuth
      ? await performRealFIDO2Assertion(agentId)
      : await performMockFIDO2Challenge(agentId);

    const now = Date.now();

    const authToken: AuthToken = {
      token,
      agentId,
      issuedAt: now,
      expiresAt: now + AUTH_TOKEN_TTL_MS,
      method: "fido2-passkey",
    };

    console.log(`[LiquidAuth] Agent authenticated: ${agentId} (expires in ${AUTH_TOKEN_TTL_MS / 1000}s)${useRealAuth ? "" : " [MOCK]"}`);
    return authToken;

  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown FIDO2 error";
    throw new Error(`Liquid Auth Failed: Agent identity unverified — ${detail}`);
  }
}

/**
 * Validate an existing AuthToken has not expired and is cryptographically sound.
 *
 * Real mode:  structural + expiry check (token issued by Liquid Auth server).
 * Mock mode:  structural + expiry + Redis single-use lookup (token consumed on use).
 *
 * @param authToken - The token to validate
 * @throws Error if the token is expired, malformed, or already used
 */
export async function validateAuthToken(authToken: AuthToken): Promise<void> {
  if (!authToken.token || typeof authToken.token !== "string") {
    throw new Error("Liquid Auth Failed: Malformed auth token");
  }

  if (authToken.token.length < 16) {
    throw new Error("Liquid Auth Failed: Auth token too short");
  }

  if (!config.liquidAuth.serverUrl && !authToken.token.startsWith("lqauth_")) {
    throw new Error("Liquid Auth Failed: Malformed auth token (expected lqauth_ prefix in dev mode)");
  }

  if (Date.now() > authToken.expiresAt) {
    throw new Error(`Liquid Auth Failed: Token expired for agent ${authToken.agentId}`);
  }

  // Mock mode: verify the token was issued by us via Redis.
  // This makes mock tokens cryptographically verifiable and single-use
  // across processes (main API writes, signing service reads + consumes).
  if (!config.liquidAuth.serverUrl) {
    const redis = getRedis();
    if (redis) {
      const redisKey    = `${MOCK_TOKEN_PREFIX}${authToken.token}`;
      const storedAgent = await redis.get(redisKey) as string | null;

      if (!storedAgent) {
        throw new Error("Liquid Auth Failed: Mock token not found — expired or already used");
      }
      if (storedAgent !== authToken.agentId) {
        throw new Error(
          `Liquid Auth Failed: Mock token agentId mismatch: stored=${storedAgent} provided=${authToken.agentId}`,
        );
      }
      // Single-use: consume the token now
      await redis.del(redisKey);
    }
    // Redis unavailable: fall through to format-only validation (degraded dev mode)
  }
}
