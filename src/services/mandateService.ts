/**
 * Mandate Service — FIDO2-Gated AP2 Mandate Lifecycle
 *
 * This file handles the FIDO2-aware operations:
 *   - PATCH /api/agents/:agentId/webauthn-pubkey  (register credential)
 *   - POST  /api/agents/:agentId/mandate/create   (FIDO2 required)
 *   - POST  /api/agents/:agentId/mandate/:id/revoke (FIDO2 required)
 *   - GET   /api/agents/:agentId/mandates          (list active)
 *
 * ARCHITECTURAL RULE: This file may import @simplewebauthn/server.
 * mandateEngine.ts must NEVER import from here or from WebAuthn.
 *
 * Security properties:
 *   - All mandates are HMAC-SHA256 signed before Redis write
 *   - WebAuthn challenges are single-use (GETDEL on consume)
 *   - ownerWalletId binding is enforced before credential lookup
 *   - counter is checked and updated on every assertion (anti-replay)
 */

import { randomUUID }                          from "node:crypto";
import { createHmac, timingSafeEqual }         from "node:crypto";
import { createHash }                          from "node:crypto";
import algosdk                                 from "algosdk";
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
}                                              from "@simplewebauthn/server";
import {
  isoBase64URL,
}                                              from "@simplewebauthn/server/helpers";
import { getRedis }                            from "./redis.js";
import { getAgent, updateAgentRecord }         from "./agentRegistry.js";
import { emitSecurityEvent }                   from "./securityAudit.js";
import type { Mandate, RecurringConfig }       from "../types/mandate.js";

// ── Redis key constants ───────────────────────────────────────────

const MANDATE_PREFIX      = "x402:mandate:";           // {agentId}:{mandateId} → JSON
const MANDATE_IDX_PREFIX  = "x402:mandate:index:";     // {agentId} → ZSET score=expiresAt
const MANDATE_CHAL_PREFIX = "x402:mandate:chal:";      // {agentId} → challenge (NX EX 300)
const RECUR_PREFIX        = "x402:mandate:recurring:"; // {mandateId} → nextExecution ms

const CHALLENGE_TTL_S = 300; // 5 minutes

// ── Key registry ──────────────────────────────────────────────────
//
// Key lifecycle:
//   active      — signs new mandates; used for verification
//   retired     — verify-only; no new mandates signed with it; emit MANDATE_RETIRED_KEY on eval
//   absent      — fully removed; verification throws → mandate blocked (fail-closed)
//
// Rotation procedure:
//   1. Generate new secret:  openssl rand -hex 32
//   2. Add  MANDATE_SECRET_v2=<new>  to environment
//   3. Set  MANDATE_SECRET_KID=v2
//   4. Keep MANDATE_SECRET_v1 (or MANDATE_SECRET) in env → retired (verify-only)
//   5. After all v1 mandates expire or are re-issued, remove MANDATE_SECRET_v1

export type KeyStatus = "active" | "retired";

interface KeyEntry {
  secret: Buffer;
  status: KeyStatus;
}

// Module-level singleton — built once on first use.
// Call resetKeyRegistry() in tests when env vars change between test cases.
let _keyRegistry: Map<string, KeyEntry> | null = null;

/** Reset the registry cache. Use only in tests when mutating env vars between cases. */
export function resetKeyRegistry(): void {
  _keyRegistry = null;
}

function getKeyRegistry(): Map<string, KeyEntry> {
  if (_keyRegistry) return _keyRegistry;
  _keyRegistry = buildKeyRegistry();
  return _keyRegistry;
}

function buildKeyRegistry(): Map<string, KeyEntry> {
  const currentKid = process.env.MANDATE_SECRET_KID ?? "v1";
  const registry   = new Map<string, KeyEntry>();

  // Scan all MANDATE_SECRET_<kid> env vars
  for (const [envKey, value] of Object.entries(process.env)) {
    const m = envKey.match(/^MANDATE_SECRET_(.+)$/);
    if (!m || !value || value.length < 32) continue;
    const kid = m[1];
    registry.set(kid, {
      secret: Buffer.from(value, "utf8"),
      status: kid === currentKid ? "active" : "retired",
    });
  }

  // Legacy: bare MANDATE_SECRET (no suffix) → treated as kid="v1"
  if (!registry.has("v1")) {
    const legacy = process.env.MANDATE_SECRET;
    if (legacy && legacy.length >= 32) {
      registry.set("v1", {
        secret: Buffer.from(legacy, "utf8"),
        status: currentKid === "v1" ? "active" : "retired",
      });
    }
  }

  // Invariant: exactly one active key, and it must be the current kid
  const activeKids = [...registry.keys()].filter(
    (k) => registry.get(k)!.status === "active",
  );

  if (activeKids.length === 0) {
    throw new Error(
      `No active signing key. Set MANDATE_SECRET_${currentKid} (≥ 32 chars) ` +
      `and MANDATE_SECRET_KID=${currentKid}. Generate: openssl rand -hex 32`,
    );
  }
  if (activeKids.length > 1) {
    throw new Error(
      `Multiple active signing keys detected (${activeKids.join(", ")}). ` +
      `Only the key matching MANDATE_SECRET_KID may be active.`,
    );
  }
  if (activeKids[0] !== currentKid) {
    throw new Error(
      `Active key kid="${activeKids[0]}" does not match MANDATE_SECRET_KID="${currentKid}".`,
    );
  }

  return registry;
}

/**
 * Return the secret for a kid.
 * - active or retired → Buffer (verification permitted)
 * - absent → throws (mandate blocked; operator removed key from registry)
 */
function getMandateSecret(kid: string): Buffer {
  const entry = getKeyRegistry().get(kid);
  if (!entry) {
    throw new Error(
      `kid="${kid}" is not in the key registry — mandate blocked. ` +
      `The signing key has been fully retired. Revoke this mandate and issue a new one.`,
    );
  }
  return entry.secret;
}

/**
 * Status of a kid in the registry. Returns null if the kid is not registered
 * (meaning verification would throw → mandate blocked).
 * Consumed by mandateEngine to emit MANDATE_RETIRED_KEY events.
 */
export function getKeyStatus(kid: string): KeyStatus | null {
  return getKeyRegistry().get(kid)?.status ?? null;
}

/** The kid that signs new mandates. Always "active" in the registry. */
function getCurrentKid(): string {
  return process.env.MANDATE_SECRET_KID ?? "v1";
}

/**
 * Compute HMAC-SHA256 over the canonical mandate fields.
 * Fields serialised with sorted keys for deterministic output.
 * kid is included in the canonical payload so it cannot be changed without
 * invalidating the MAC, and selects which versioned secret to sign with.
 */
export function computeMandateHmac(fields: {
  mandateId:          string;
  agentId:            string;
  ownerWalletId:      string;
  kid:                string;
  maxPerTx?:          string;
  maxPer10Min?:       string;
  maxPerDay?:         string;
  allowedRecipients?: string[];
  recurring?:         RecurringConfig;
  expiresAt?:         number;
  status:             string;
  version:            number;
  createdAt:          number;
}): string {
  const payload = JSON.stringify({
    agentId:            fields.agentId,
    allowedRecipients:  fields.allowedRecipients ?? [],
    createdAt:          fields.createdAt,
    expiresAt:          fields.expiresAt ?? null,
    kid:                fields.kid,
    mandateId:          fields.mandateId,
    maxPerDay:          fields.maxPerDay ?? null,
    maxPer10Min:        fields.maxPer10Min ?? null,
    maxPerTx:           fields.maxPerTx ?? null,
    ownerWalletId:      fields.ownerWalletId,
    recurring:          fields.recurring ?? null,
    status:             fields.status,
    version:            fields.version,
  });
  return createHmac("sha256", getMandateSecret(fields.kid))
    .update(payload)
    .digest("hex");
}

function verifyMandateHmac(mandate: Mandate): boolean {
  const expected = computeMandateHmac(mandate);
  const stored   = mandate.hmac ?? "";
  const expBuf   = Buffer.from(expected, "hex");
  const storedBuf = Buffer.from(stored, "hex");
  if (expBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(expBuf, storedBuf);
}

// ── WebAuthn config ───────────────────────────────────────────────

function getWebAuthnConfig(): { rpId: string; origin: string } {
  const rpId   = process.env.FIDO2_RP_ID ?? process.env.LIQUID_AUTH_RP_ID ?? "localhost";
  const origin = process.env.WEBAUTHN_ORIGIN ?? `https://${rpId}`;
  return { rpId, origin };
}

// ── Challenge lifecycle ────────────────────────────────────────────

/**
 * Issue a single-use WebAuthn challenge for mandate operations.
 * Returns the challenge bytes (base64url) for the client to include
 * in its credential request.
 */
export async function issueMandateChallenge(agentId: string): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const challengeBytes = new Uint8Array(32);
  const challenge = isoBase64URL.fromBuffer(
    Buffer.from(crypto.getRandomValues(challengeBytes)),
  );

  const result = await redis.set(
    `${MANDATE_CHAL_PREFIX}${agentId}`,
    challenge,
    { nx: true, ex: CHALLENGE_TTL_S },
  );

  if (result !== "OK") {
    // Overwrite existing challenge (client re-requested)
    await redis.set(
      `${MANDATE_CHAL_PREFIX}${agentId}`,
      challenge,
      { ex: CHALLENGE_TTL_S },
    );
  }

  return challenge;
}

/**
 * Atomically consume the challenge. Returns challenge string or throws if not found.
 */
async function consumeMandateChallenge(agentId: string): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  const challenge = await redis.getdel(`${MANDATE_CHAL_PREFIX}${agentId}`) as string | null;
  if (!challenge) throw new Error("No active WebAuthn challenge — expired or not issued");
  return challenge;
}

// ── Credential registration ────────────────────────────────────────

/**
 * Register a WebAuthn public key for an agent.
 *
 * The public key is stored as the base64url-encoded COSE public key.
 * Once set, it is immutable — a second call with a different key fails.
 * Counter is initialised to 0.
 */
export async function registerWebAuthnCredential(
  agentId:       string,
  ownerWalletId: string,
  credentialId:  string,   // base64url credential ID
  publicKeyCose: string,   // base64url COSE public key
  counter:       number,
): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  // ownerWalletId binding: if already set, must match
  if (agent.ownerWalletId && agent.ownerWalletId !== ownerWalletId) {
    throw new Error("ownerWalletId mismatch — lateral ownership transfer denied");
  }

  // Public key immutability: once set, reject different key
  if (
    agent.webauthnPublicKey &&
    agent.webauthnPublicKey !== publicKeyCose
  ) {
    throw new Error(
      "WebAuthn public key already registered for this agent. " +
      "Revoke existing mandates and contact support to rotate the credential.",
    );
  }

  const updated = {
    ...agent,
    ownerWalletId:     ownerWalletId,
    webauthnPublicKey: publicKeyCose,
    webauthnCounter:   counter,
  };

  await updateAgentRecord(updated);
}

// ── Mandate CRUD ───────────────────────────────────────────────────

export interface CreateMandateInput {
  ownerWalletId:      string;
  maxPerTx?:          string;
  maxPer10Min?:       string;
  maxPerDay?:         string;
  allowedRecipients?: string[];
  recurring?:         { amount: string; intervalSeconds: number };
  expiresAt?:         number;
  webauthnAssertion:  AuthenticationResponseJSON;
}

/**
 * Create a new mandate. FIDO2 assertion required.
 *
 * Steps:
 *   1. Load agent; verify ownerWalletId binding
 *   2. Check webauthnPublicKey is registered
 *   3. Validate constraint rules
 *   4. Reconstruct canonical JSON = challenge the client signed
 *   5. Verify WebAuthn assertion
 *   6. Update counter (anti-replay)
 *   7. Compute HMAC, store in Redis, add to index
 *   8. Emit MANDATE_CREATED
 */
export async function createMandate(
  agentId: string,
  input:   CreateMandateInput,
): Promise<Omit<Mandate, "hmac">> {
  // ── Step 0: Validate constraint rules (fast, no I/O) ──────────
  // Done first so invalid inputs are rejected before any Redis/DB call.
  validateMandateConstraints(input);

  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  // ── Step 1: Load agent + ownerWalletId check ──────────────────
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  if (!agent.ownerWalletId || !agent.webauthnPublicKey) {
    throw new Error(
      "No WebAuthn credential registered for this agent. " +
      "Call PATCH /api/agents/:agentId/webauthn-pubkey first.",
    );
  }

  if (agent.ownerWalletId !== input.ownerWalletId) {
    throw new Error("ownerWalletId mismatch — not the registered owner of this agent");
  }

  // ── Step 3: Consume single-use nonce + bind to canonical payload ─
  // The client must call POST /mandate/challenge first to get the nonce,
  // then sign SHA256(nonce ":" canonical-payload-json) with their FIDO2 device.
  // GETDEL makes the nonce single-use; 300s TTL prevents stale reuse.
  const nonce = await consumeMandateChallenge(agentId);
  const canonicalJson = JSON.stringify(buildCanonicalPayload(agentId, input));
  const expectedChallenge = isoBase64URL.fromBuffer(
    createHash("sha256").update(`${nonce}:${canonicalJson}`).digest(),
  );

  // ── Step 4: Verify WebAuthn assertion ─────────────────────────
  const { rpId, origin } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response:            input.webauthnAssertion,
      expectedChallenge,
      expectedOrigin:      origin,
      expectedRPID:        rpId,
      credential: {
        id:        input.webauthnAssertion.id,
        publicKey: isoBase64URL.toBuffer(agent.webauthnPublicKey),
        counter:   agent.webauthnCounter ?? 0,
      },
    });
  } catch (err) {
    throw new Error(
      `WebAuthn assertion verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!verification.verified) {
    throw new Error("WebAuthn assertion not verified");
  }

  // ── Step 5: Update counter ────────────────────────────────────
  const newCounter = verification.authenticationInfo.newCounter;
  await updateAgentRecord({
    ...agent,
    webauthnCounter: newCounter,
  });

  // ── Step 6: Build mandate ─────────────────────────────────────
  const mandateId = randomUUID();
  const now       = Date.now();

  const recurring: RecurringConfig | undefined = input.recurring
    ? {
        amount:          input.recurring.amount,
        intervalSeconds: input.recurring.intervalSeconds,
        nextExecution:   now, // eligible immediately on first tick
      }
    : undefined;

  const mandate: Mandate = {
    mandateId,
    agentId,
    ownerWalletId:      input.ownerWalletId,
    maxPerTx:           input.maxPerTx,
    maxPer10Min:        input.maxPer10Min,
    maxPerDay:          input.maxPerDay,
    allowedRecipients:  input.allowedRecipients,
    recurring,
    expiresAt:          input.expiresAt,
    status:             "active",
    version:            1,
    createdAt:          now,
    kid:                getCurrentKid(),
    hmac:               "",   // filled below
  };

  mandate.hmac = computeMandateHmac(mandate);

  // ── Step 7: Store in Redis ────────────────────────────────────
  const ttlSeconds = input.expiresAt
    ? Math.ceil((input.expiresAt - now) / 1_000)
    : undefined;

  const setOpts = ttlSeconds && ttlSeconds > 0 ? { ex: ttlSeconds } : {};

  await Promise.all([
    redis.set(
      `${MANDATE_PREFIX}${agentId}:${mandateId}`,
      JSON.stringify(mandate),
      setOpts,
    ),
    redis.zadd(
      `${MANDATE_IDX_PREFIX}${agentId}`,
      { score: input.expiresAt ?? Number.MAX_SAFE_INTEGER, member: mandateId },
    ),
  ]);

  // Recurring schedule
  if (recurring) {
    await redis.set(
      `${RECUR_PREFIX}${mandateId}`,
      String(recurring.nextExecution),
    );
  }

  // ── Step 8: Emit event ────────────────────────────────────────
  emitSecurityEvent({
    type:    "MANDATE_CREATED",
    agentId,
    walletId: input.ownerWalletId,
    detail: {
      mandateId,
      maxPerTx:    input.maxPerTx ?? null,
      maxPer10Min: input.maxPer10Min ?? null,
      maxPerDay:   input.maxPerDay ?? null,
      hasRecurring: !!recurring,
      expiresAt:   input.expiresAt ?? null,
    },
    timestamp: new Date().toISOString(),
  });

  const { hmac: _hmac, ...publicMandate } = mandate;
  return publicMandate;
}

// ── Mandate revocation ─────────────────────────────────────────────

export interface RevokeMandateInput {
  ownerWalletId:     string;
  webauthnAssertion: AuthenticationResponseJSON;
}

/**
 * Revoke a mandate. FIDO2 assertion required.
 * Challenge = SHA256(mandateId + "revoke").
 * Mandate is marked "revoked" but not deleted (preserved for audit).
 */
export async function revokeMandate(
  agentId:   string,
  mandateId: string,
  input:     RevokeMandateInput,
): Promise<{ mandateId: string; status: "revoked" }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  // Load agent
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (!agent.webauthnPublicKey) {
    throw new Error("No WebAuthn credential registered for this agent");
  }
  if (agent.ownerWalletId !== input.ownerWalletId) {
    throw new Error("ownerWalletId mismatch");
  }

  // Load mandate
  const raw = await redis.get(`${MANDATE_PREFIX}${agentId}:${mandateId}`) as string | null;
  if (!raw) throw new Error(`Mandate not found: ${mandateId}`);
  let mandate: Mandate;
  try { mandate = JSON.parse(raw) as Mandate; }
  catch { throw new Error("Corrupt mandate record"); }

  if (!verifyMandateHmac(mandate)) {
    throw new Error("Mandate HMAC invalid — record integrity compromised");
  }

  if (mandate.status === "revoked") {
    return { mandateId, status: "revoked" };
  }

  // Consume single-use nonce + bind to revoke intent.
  // Client signs SHA256(nonce ":" mandateId ":revoke") after calling /mandate/challenge.
  const nonce = await consumeMandateChallenge(agentId);
  const expectedChallenge = isoBase64URL.fromBuffer(
    createHash("sha256").update(`${nonce}:${mandateId}:revoke`).digest(),
  );

  const { rpId, origin } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response:         input.webauthnAssertion,
      expectedChallenge,
      expectedOrigin:   origin,
      expectedRPID:     rpId,
      credential: {
        id:        input.webauthnAssertion.id,
        publicKey: isoBase64URL.toBuffer(agent.webauthnPublicKey),
        counter:   agent.webauthnCounter ?? 0,
      },
    });
  } catch (err) {
    throw new Error(
      `WebAuthn assertion verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!verification.verified) throw new Error("WebAuthn assertion not verified");

  // Update counter
  await updateAgentRecord({
    ...agent,
    webauthnCounter: verification.authenticationInfo.newCounter,
  });

  // Mark revoked — kid preserved from original so HMAC verifies against same key version.
  const updatedMandate: Mandate = {
    ...mandate,
    status:  "revoked",
    version: mandate.version + 1,
    hmac:    "",
  };
  updatedMandate.hmac = computeMandateHmac(updatedMandate);

  const remainingTtlMs = mandate.expiresAt ? mandate.expiresAt - Date.now() : undefined;
  const setOpts = remainingTtlMs && remainingTtlMs > 0
    ? { ex: Math.ceil(remainingTtlMs / 1_000) }
    : {};

  await redis.set(
    `${MANDATE_PREFIX}${agentId}:${mandateId}`,
    JSON.stringify(updatedMandate),
    setOpts,
  );

  // Remove from recurring schedule
  await redis.del(`${RECUR_PREFIX}${mandateId}`);

  emitSecurityEvent({
    type:    "MANDATE_REVOKED",
    agentId,
    walletId: input.ownerWalletId,
    detail: { mandateId },
    timestamp: new Date().toISOString(),
  });

  return { mandateId, status: "revoked" };
}

// ── List mandates ──────────────────────────────────────────────────

/**
 * List active mandates for an agent (not revoked, not expired).
 * Returns mandate records without the HMAC field.
 */
export async function listMandates(agentId: string): Promise<Omit<Mandate, "hmac">[]> {
  const redis = getRedis();
  if (!redis) return [];

  const now = Date.now();

  // Prune expired members from the index
  await redis.zremrangebyscore(
    `${MANDATE_IDX_PREFIX}${agentId}`,
    0,
    now - 1,
  );

  const mandateIds = await redis.zrange(
    `${MANDATE_IDX_PREFIX}${agentId}`,
    0,
    -1,
  ) as string[];

  if (!mandateIds.length) return [];

  const raws = await Promise.all(
    mandateIds.map((id) =>
      redis.get(`${MANDATE_PREFIX}${agentId}:${id}`) as Promise<string | null>,
    ),
  );

  const results: Omit<Mandate, "hmac">[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const m = JSON.parse(raw) as Mandate;
      if (m.status === "revoked") continue;
      if (m.expiresAt && m.expiresAt < now) continue;
      const { hmac: _hmac, ...pub } = m;
      results.push(pub);
    } catch { /* skip malformed */ }
  }

  return results;
}

// ── Constraint validation ──────────────────────────────────────────

function validateMandateConstraints(input: {
  maxPerTx?:          string;
  maxPer10Min?:       string;
  maxPerDay?:         string;
  allowedRecipients?: string[];
  recurring?:         { amount: string; intervalSeconds: number };
  expiresAt?:         number;
}): void {
  const toBig = (s: string | undefined): bigint | null =>
    s ? BigInt(s) : null;

  const perTx   = toBig(input.maxPerTx);
  const per10m  = toBig(input.maxPer10Min);
  const perDay  = toBig(input.maxPerDay);

  // Ordering: maxPerTx ≤ maxPer10Min ≤ maxPerDay
  if (perTx !== null && per10m !== null && perTx > per10m) {
    throw new Error("maxPerTx must be ≤ maxPer10Min");
  }
  if (per10m !== null && perDay !== null && per10m > perDay) {
    throw new Error("maxPer10Min must be ≤ maxPerDay");
  }
  if (perTx !== null && perDay !== null && perTx > perDay) {
    throw new Error("maxPerTx must be ≤ maxPerDay");
  }

  // Recurring constraints
  if (input.recurring) {
    if (input.recurring.intervalSeconds < 60) {
      throw new Error("recurring.intervalSeconds must be ≥ 60");
    }
    const recurAmount = BigInt(input.recurring.amount);
    if (perTx !== null && recurAmount > perTx) {
      throw new Error("recurring.amount must be ≤ maxPerTx");
    }
  }

  // expiresAt must be in the future
  if (input.expiresAt !== undefined && input.expiresAt <= Date.now()) {
    throw new Error("expiresAt must be in the future");
  }

  // allowedRecipients must be valid Algorand addresses
  if (input.allowedRecipients) {
    for (const addr of input.allowedRecipients) {
      if (!algosdk.isValidAddress(addr)) {
        throw new Error(`Invalid Algorand address in allowedRecipients: ${addr}`);
      }
    }
  }
}

// ── Canonical payload builder ──────────────────────────────────────

function buildCanonicalPayload(
  agentId: string,
  input: {
    ownerWalletId:      string;
    maxPerTx?:          string;
    maxPer10Min?:       string;
    maxPerDay?:         string;
    allowedRecipients?: string[];
    recurring?:         { amount: string; intervalSeconds: number };
    expiresAt?:         number;
  },
): Record<string, unknown> {
  // Sorted keys — must match client implementation exactly
  return {
    agentId,
    allowedRecipients:  input.allowedRecipients ?? [],
    expiresAt:          input.expiresAt ?? null,
    maxPerDay:          input.maxPerDay ?? null,
    maxPer10Min:        input.maxPer10Min ?? null,
    maxPerTx:           input.maxPerTx ?? null,
    ownerWalletId:      input.ownerWalletId,
    recurring:          input.recurring ?? null,
  };
}

// ── Direct mandate loader (used by mandateEngine — no HMAC check here) ──

/**
 * Load a raw mandate from Redis (including hmac field).
 * Callers must verify HMAC themselves.
 */
export async function loadRawMandate(
  agentId:   string,
  mandateId: string,
): Promise<Mandate | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(`${MANDATE_PREFIX}${agentId}:${mandateId}`) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as Mandate; }
  catch { return null; }
}

/**
 * Persist an updated mandate (used by mandateEngine after rolling window increment).
 */
export async function saveMandate(mandate: Mandate): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  const remainingTtlMs = mandate.expiresAt ? mandate.expiresAt - Date.now() : undefined;
  const setOpts = remainingTtlMs && remainingTtlMs > 0
    ? { ex: Math.ceil(remainingTtlMs / 1_000) }
    : {};
  await redis.set(
    `${MANDATE_PREFIX}${mandate.agentId}:${mandate.mandateId}`,
    JSON.stringify(mandate),
    setOpts,
  );
}

export { verifyMandateHmac, RECUR_PREFIX };
