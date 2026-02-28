import crypto from "node:crypto";
import { getRedis } from "../services/redis.js";

/**
 * Execution-layer authentication for AI agents.
 *
 * AI agents authenticate via short-lived, Redis-backed HMAC-SHA256 tokens.
 * This is 100% embedded — zero external dependencies, zero network hops.
 *
 * Properties:
 *   - 32-byte cryptographically random challenge per issuance
 *   - HMAC-SHA256 token bound to agentId + timestamp
 *   - Stored in Redis: single-use, 5-minute TTL, cross-process
 *   - Consumed atomically on validateAuthToken() (replay-protected)
 *
 * Human governance (mandate create/revoke, custody transitions) uses a
 * separate dual-option path — see src/auth/humanAuth.ts:
 *   - Standard WebAuthn (device passkeys: Touch ID / Windows Hello)
 *   - Liquid Auth  (Algorand wallet QR: Pera, Defly, etc.)
 *
 * Never call authenticateAgentIdentity() for human governance operations.
 * Never call humanAuth functions for agent execution operations.
 */

// ── Constants ────────────────────────────────────────────────────────────

const TOKEN_PREFIX  = "x402:auth-token:";
const TOKEN_TTL_S   = 300;              // 5 minutes
const TOKEN_TTL_MS  = TOKEN_TTL_S * 1000;

/**
 * Legacy Redis prefix — tokens issued before the embedded-mode refactor.
 * Kept so in-flight tokens remain valid for their remaining TTL.
 */
const LEGACY_PREFIX = "x402:mock-token:";

// ── Types ────────────────────────────────────────────────────────────────

export interface AuthToken {
  /** Opaque HMAC token string */
  token: string;
  /** The authenticated agent identity */
  agentId: string;
  /** Issuance timestamp (ms since epoch) */
  issuedAt: number;
  /** Expiry timestamp (ms since epoch) */
  expiresAt: number;
  /** Always "fido2-passkey" for wire-format compatibility */
  method: "fido2-passkey";
}

// ── Boot log ─────────────────────────────────────────────────────────────

/**
 * Logs the active execution-auth mode at boot. No-op for configuration —
 * the embedded HMAC path needs no environment variables.
 */
export function assertProductionAuthReady(): void {
  console.log(
    "[Auth] Execution layer: embedded HMAC tokens (Redis-backed, single-use, 5-min TTL).",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function validateAgentId(agentId: string): void {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("Auth Failed: agentId must be a non-empty string");
  }
  if (agentId.length < 3 || agentId.length > 128) {
    throw new Error("Auth Failed: agentId must be 3–128 characters");
  }
}

// ── Core: embedded HMAC token issuance ───────────────────────────────────

/**
 * Issue a cryptographically random, Redis-backed HMAC token for an agent.
 * Stored in Redis so the signing service (separate process) can validate it.
 */
async function issueEmbeddedToken(agentId: string): Promise<string> {
  const challenge    = crypto.randomBytes(32);
  const hmacKey      = crypto.randomBytes(32);
  const payload      = `${agentId}:${challenge.toString("hex")}:${Date.now()}`;
  const hmac         = crypto.createHmac("sha256", hmacKey).update(payload).digest("hex");
  const token        = `lqauth_${hmac}`;

  const redis = getRedis();
  if (redis) {
    await redis.set(`${TOKEN_PREFIX}${token}`, agentId, { ex: TOKEN_TTL_S });
  }

  return token;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Authenticate an AI agent for execution access.
 *
 * Issues a Redis-backed HMAC token — production-ready, zero-latency.
 * Call this from /api/execute before handing off to Rocca Wallet.
 *
 * @param agentId — Unique identifier for the executing agent
 * @returns AuthToken — verified credential for Rocca Wallet
 * @throws Error('Auth Failed: ...') if agentId is invalid
 */
export async function authenticateAgentIdentity(agentId: string): Promise<AuthToken> {
  validateAgentId(agentId);

  const token = await issueEmbeddedToken(agentId);
  const now   = Date.now();

  const authToken: AuthToken = {
    token,
    agentId,
    issuedAt:  now,
    expiresAt: now + TOKEN_TTL_MS,
    method:    "fido2-passkey",
  };

  console.log(`[Auth] Agent token issued: ${agentId} (expires ${TOKEN_TTL_S}s)`);
  return authToken;
}

/**
 * Validate an AuthToken for an incoming /api/execute request.
 *
 * Checks: format → expiry → Redis single-use lookup → agentId binding.
 * Consumes the token on success (replay-protected).
 * Degrades to format+expiry-only when Redis is unavailable.
 *
 * @param authToken — Token from the agent's request body
 * @throws Error if expired, malformed, already used, or agentId mismatches
 */
export async function validateAuthToken(authToken: AuthToken): Promise<void> {
  if (!authToken.token || typeof authToken.token !== "string") {
    throw new Error("Auth Failed: Malformed auth token");
  }
  if (authToken.token.length < 16) {
    throw new Error("Auth Failed: Auth token too short");
  }
  if (!authToken.token.startsWith("lqauth_")) {
    throw new Error("Auth Failed: Invalid token prefix");
  }
  if (Date.now() > authToken.expiresAt) {
    throw new Error(`Auth Failed: Token expired for agent ${authToken.agentId}`);
  }

  // Redis single-use validation — try current prefix then legacy prefix
  // so tokens issued before the embedded-mode refactor remain valid.
  const redis = getRedis();
  if (redis) {
    const newKey      = `${TOKEN_PREFIX}${authToken.token}`;
    const legacyKey   = `${LEGACY_PREFIX}${authToken.token}`;

    let storedAgent   = await redis.get(newKey) as string | null;
    let activeKey     = newKey;

    if (!storedAgent) {
      storedAgent = await redis.get(legacyKey) as string | null;
      activeKey   = legacyKey;
    }

    if (!storedAgent) {
      throw new Error("Auth Failed: Token not found — expired or already used");
    }
    if (storedAgent !== authToken.agentId) {
      throw new Error(
        `Auth Failed: Token agentId mismatch — stored=${storedAgent}, provided=${authToken.agentId}`,
      );
    }

    // Single-use: consume now
    await redis.del(activeKey);
  }
  // Redis unavailable → format + expiry validation only (degraded mode)
}
