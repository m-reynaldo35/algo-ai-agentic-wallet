import { getRedis, hmacSign, hmacVerify, HmacIntegrityError } from "./redis.js";
import crypto, { randomUUID } from "crypto";

// ── Instance identity (for halt audit trail) ──────────────────────
const HALT_INSTANCE_ID = randomUUID();
const HALT_REGION      = process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "default";

/**
 * Agent Registry — Redis-backed store for mandate-architecture agent accounts.
 *
 * Redis Schema:
 *   x402:agents:{agentId}              → AgentRecord (JSON)
 *   x402:agent-addr:{address}          → agentId  (reverse index)
 *   x402:halt                          → HaltRecord (JSON)  (emergency halt flag)
 */

// ── Agent State Machine ───────────────────────────────────────────
//
//  pending    → registered   registration confirmed
//  pending    → orphaned     timeout without confirmation
//  registered → active       first successful settlement or funding
//  active     → active       each subsequent settlement
//  any        → suspended    admin action
//  any        → orphaned     anomaly detected
//  orphaned   → active       orphan recovery completed
//  suspended  → active       admin action (unsuspend)

export interface AgentRecord {
  agentId: string;
  /** Permanent on-chain Algorand address */
  address: string;
  /** Cohort assignment */
  cohort: string;
  /** Optional platform tag */
  platform?: string;
  /** ISO timestamp of initial registration */
  createdAt: string;
  /** txnId of the registration transaction */
  registrationTxnId: string;
  status: "registered" | "active" | "suspended" | "orphaned";
  // ── Audit ─────────────────────────────────────────────────────
  lastSettlementAt?: string;
  // ── Ownership ─────────────────────────────────────────────────
  /**
   * FIDO2 credential ID hash of the wallet that owns this agent.
   * Set at agent registration, immutable thereafter.
   */
  ownerWalletId?: string;
  // ── WebAuthn / FIDO2 ──────────────────────────────────────────
  /**
   * Base64url-encoded COSE public key from the agent owner's FIDO2 device.
   * Set once via PATCH /api/agents/:agentId/webauthn-pubkey; immutable
   * once set (to prevent lateral ownership transfer via API compromise).
   */
  webauthnPublicKey?: string;
  /**
   * Base64url credential ID from the agent owner's FIDO2 device.
   * Stored alongside webauthnPublicKey so login challenges can populate
   * allowCredentials, directing the browser to the correct authenticator.
   */
  webauthnCredentialId?: string;
  /**
   * Monotonic WebAuthn signature counter — anti-replay for FIDO2 assertions.
   * Server increments on every successful WebAuthn assertion. If the device
   * sends a counter lower than this value, the assertion is rejected.
   */
  webauthnCounter?: number;
  // ── Ownership ──────────────────────────────────────────────────
  /**
   * Algorand address of the human owner who created or claimed this agent.
   * Set at creation time or via /api/agents/:id/claim.
   * Optional for backward compatibility with pre-Sprint-N agents.
   */
  ownerAddress?: string;
  /** ISO timestamp of when ownerAddress was first set. */
  ownerLinkedAt?: string;
  // ── Mandate contract (Sprint O, non-custodial AVM architecture) ──
  /**
   * Algorand application ID of the agent's MandateContract.
   * Set at registration for non-custodial mandate-architecture agents.
   * Absent for legacy Rocca custodial agents.
   */
  mandateAppId?: number;
  /**
   * True when the server's operator wallet is the MandateContract master wallet.
   * Set for agents created via POST /api/agents/create-mandate.
   * Allows operator-only contract methods (update_mandate, halt, etc.) to be
   * called server-side. opt_in_usdc() is permissionless and does not require this.
   */
  mandateOperatorMaster?: boolean;
}


// ── Redis Key Constants ───────────────────────────────────────────

const AGENTS_PREFIX    = "x402:agents:";
const ADDR_IDX_PREFIX  = "x402:agent-addr:";
const HALT_KEY         = "x402:halt";
const OWNER_PREFIX       = "x402:owner:";
const WAUTH_OWNER_PREFIX = "x402:wauth-owner:";  // WebAuthn ownerWalletId → agentId set
const CLAIM_PREFIX       = "x402:claim:";
const CLAIM_TTL_S      = 300; // 5-minute claim challenge TTL

// ── Cohort Assignment ─────────────────────────────────────────────
// Phase 1: single cohort. Phase 2+: sha256(agentId) % totalCohorts.
export function assignCohort(_agentId: string): string {
  return "A";
}

// ── Validation ────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9_\-:.@]{3,128}$/;

export function validateAgentId(agentId: string): void {
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    throw new Error(
      "Invalid agentId: must be 3–128 chars, alphanumeric + _-:.@",
    );
  }
}

// ── Agent CRUD ────────────────────────────────────────────────────

export async function storeAgent(record: AgentRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available — cannot store agent record");

  const key     = `${AGENTS_PREFIX}${record.agentId}`;
  const payload = JSON.stringify(record);
  const ops: Promise<unknown>[] = [
    redis.set(key, hmacSign(payload)),
    redis.set(`${ADDR_IDX_PREFIX}${record.address}`, record.agentId),
  ];

  if (record.ownerAddress) {
    ops.push(redis.sadd(`${OWNER_PREFIX}${record.ownerAddress}`, record.agentId));
  }

  await Promise.all(ops);
}

export async function getAgent(agentId: string): Promise<AgentRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = `${AGENTS_PREFIX}${agentId}`;
  // RedisShim auto-parses JSON — if HMAC is active the envelope is an object;
  // stringify it back so hmacVerify can unwrap it.
  const raw = await redis.get<unknown>(key);
  if (raw === null) return null;

  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const payload = hmacVerify(rawStr, key);
    return typeof payload === "string" ? JSON.parse(payload) as AgentRecord : payload as unknown as AgentRecord;
  } catch (err) {
    if (err instanceof HmacIntegrityError) {
      console.error(`[AgentRegistry] HMAC integrity violation for agent ${agentId} — treating as missing`);
      // Emit async so we don't block the caller
      import("./securityAudit.js").then(({ emitSecurityEvent }) => {
        emitSecurityEvent({ type: "SECURITY_ALERT", agentId, detail: { error: "REDIS_INTEGRITY_VIOLATION", key }, timestamp: new Date().toISOString() });
      }).catch(() => {});
      return null;
    }
    throw err;
  }
}

export async function getAgentByAddress(address: string): Promise<AgentRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const agentId = await redis.get(`${ADDR_IDX_PREFIX}${address}`) as string | null;
  if (!agentId) return null;

  return getAgent(agentId);
}

/** Full record replace — use for updates that touch multiple fields */
export async function updateAgentRecord(record: AgentRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  const key     = `${AGENTS_PREFIX}${record.agentId}`;
  const payload = JSON.stringify(record);
  const ops: Promise<unknown>[] = [
    redis.set(key, hmacSign(payload)),
  ];
  if (record.ownerAddress) {
    ops.push(redis.sadd(`${OWNER_PREFIX}${record.ownerAddress}`, record.agentId));
  }
  await Promise.all(ops);
}

export async function updateAgentStatus(
  agentId: string,
  status: AgentRecord["status"],
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const record = await getAgent(agentId);
  if (!record) throw new Error(`Agent not found: ${agentId}`);

  record.status = status;
  const key = `${AGENTS_PREFIX}${agentId}`;
  await redis.set(key, hmacSign(JSON.stringify(record)));
}

export async function listAgents(limit = 50, offset = 0): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const keys = await redis.keys(`${AGENTS_PREFIX}*`);
  const page = keys.slice(offset, offset + limit);

  if (!page.length) return [];

  const raws = await Promise.all(page.map((k) => redis.get<AgentRecord>(k)));
  return raws.filter((r): r is AgentRecord => r !== null);
}

/**
 * Load all agents in a given cohort.
 * At 100k+ agents: replace redis.keys() scan with a sorted set index keyed by cohort.
 */
/**
 * Cursor-based scan over all agents — single O(N) pass using SCAN instead
 * of KEYS. Use this in background jobs (gas station, guardian) instead of
 * calling listAgents() in a loop, which issues a full KEYS scan per page.
 */
export async function scanAllAgents(): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const agents: AgentRecord[] = [];
  let cursor = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `${AGENTS_PREFIX}*`,
      count: 100,
    });
    cursor = parseInt(nextCursor, 10);

    if (keys.length > 0) {
      const raws = await Promise.all(keys.map((k) => redis.get<AgentRecord>(k)));
      for (const r of raws) {
        if (r !== null) agents.push(r);
      }
    }
  } while (cursor !== 0);

  return agents;
}

export async function listAgentsByCohort(cohort: string): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const keys = await redis.keys(`${AGENTS_PREFIX}*`);
  if (!keys.length) return [];

  const raws = await Promise.all(keys.map((k) => redis.get<AgentRecord>(k)));
  return raws.filter((r): r is AgentRecord => r !== null && r.cohort === cohort);
}

/**
 * List all agents owned by a given Algorand address.
 * Uses the secondary owner index (x402:owner:{address}).
 *
 * On first call per owner, performs a one-time lazy migration: scans all agent
 * records for any that have ownerWalletId === ownerAddress but no ownerAddress
 * set (created before the portfolio model). Backfills ownerAddress + index so
 * subsequent calls are O(1).
 */
export async function listAgentsByOwner(ownerAddress: string): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const migrationKey = `x402:owner-migrated:${ownerAddress}`;
  const migrated = await redis.get<string>(migrationKey);

  if (!migrated) {
    // One-time scan: find agents registered with this wallet via ownerWalletId
    // but not yet in the owner index (pre-portfolio agents)
    const allKeys = await redis.keys(`${AGENTS_PREFIX}*`);
    if (allKeys.length > 0) {
      const allRecords = await Promise.all(allKeys.map((k) => redis.get<AgentRecord>(k)));
      const toMigrate = (allRecords.filter(Boolean) as AgentRecord[]).filter(
        (r) => r.ownerWalletId === ownerAddress && !r.ownerAddress,
      );
      if (toMigrate.length > 0) {
        await Promise.all(
          toMigrate.map(async (r) => {
            const updated: AgentRecord = { ...r, ownerAddress };
            const mKey = `${AGENTS_PREFIX}${r.agentId}`;
          await Promise.all([
              redis.set(mKey, hmacSign(JSON.stringify(updated))),
              redis.sadd(`${OWNER_PREFIX}${ownerAddress}`, r.agentId),
            ]);
          }),
        );
      }
    }
    await redis.set(migrationKey, "1");
  }

  const agentIds = await redis.smembers(`${OWNER_PREFIX}${ownerAddress}`);
  if (!agentIds.length) return [];

  const raws = await Promise.all(agentIds.map((id) => getAgent(id)));
  return raws.filter((r): r is AgentRecord => r !== null);
}

/**
 * List all agents registered with a given WebAuthn ownerWalletId
 * (format: "webauthn:credentialId"). Uses a secondary Redis set index
 * maintained by indexWebAuthnOwner(). Falls back to a one-time full scan
 * to backfill the index for agents registered before this index existed.
 */
export async function listAgentsByWebAuthnOwner(ownerWalletId: string): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const indexKey     = `${WAUTH_OWNER_PREFIX}${ownerWalletId}`;
  const migrationKey = `${WAUTH_OWNER_PREFIX}migrated:${ownerWalletId}`;

  const migrated = await redis.get(migrationKey) as string | null;
  if (!migrated) {
    // One-time scan: find all agents with this ownerWalletId and backfill the index
    const all = await scanAllAgents();
    const matches = all.filter((r) => r.ownerWalletId === ownerWalletId);
    if (matches.length > 0) {
      await Promise.all([
        ...matches.map((r) => redis.sadd(indexKey, r.agentId)),
        redis.set(migrationKey, "1"),
      ]);
    } else {
      await redis.set(migrationKey, "1");
    }
  }

  const agentIds = await redis.smembers(indexKey) as string[];
  if (!agentIds.length) return [];

  const raws = await Promise.all(agentIds.map((id) => getAgent(id)));
  return raws.filter((r): r is AgentRecord => r !== null);
}

/**
 * Add an agentId to the WebAuthn owner index for a given ownerWalletId.
 * Called whenever a WebAuthn credential is registered for an agent.
 */
export async function indexWebAuthnOwner(ownerWalletId: string, agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const indexKey     = `${WAUTH_OWNER_PREFIX}${ownerWalletId}`;
  const migrationKey = `${WAUTH_OWNER_PREFIX}migrated:${ownerWalletId}`;
  await Promise.all([
    redis.sadd(indexKey, agentId),
    redis.set(migrationKey, "1"),  // mark as migrated so scan is skipped
  ]);
}

/**
 * Claim ownership of an orphan agent (one with no ownerAddress).
 * The caller must have already verified the signature via the claim challenge.
 */
export async function claimAgentOwnership(agentId: string, ownerAddress: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (agent.ownerAddress) throw new Error(`Agent ${agentId} is already owned`);

  agent.ownerAddress = ownerAddress;
  agent.ownerLinkedAt = new Date().toISOString();

  const key = `${AGENTS_PREFIX}${agentId}`;
  await Promise.all([
    redis.set(key, hmacSign(JSON.stringify(agent))),
    redis.sadd(`${OWNER_PREFIX}${ownerAddress}`, agentId),
  ]);
}

/**
 * Transfer ownership of an agent from one Algorand address to another.
 * The caller must have verified the from-address owns the agent.
 */
export async function transferAgentOwnership(
  agentId: string,
  fromAddress: string,
  toAddress: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (agent.ownerAddress !== fromAddress) {
    throw new Error(`Not authorised: ${fromAddress} does not own agent ${agentId}`);
  }

  const prev = agent.ownerAddress;
  agent.ownerAddress = toAddress;
  agent.ownerLinkedAt = new Date().toISOString();

  const key = `${AGENTS_PREFIX}${agentId}`;
  await Promise.all([
    redis.set(key, hmacSign(JSON.stringify(agent))),
    redis.srem(`${OWNER_PREFIX}${prev}`, agentId),
    redis.sadd(`${OWNER_PREFIX}${toAddress}`, agentId),
  ]);
}

/** Store a one-time claim challenge (5-min TTL) */
export async function storeClaimChallenge(
  challengeId: string,
  payload: { agentId: string; ownerAddress: string; challengeB64: string },
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  await redis.set(`${CLAIM_PREFIX}${challengeId}`, JSON.stringify(payload), { ex: CLAIM_TTL_S });
}

/** Consume (GETDEL) a claim challenge — single-use */
export async function consumeClaimChallenge(
  challengeId: string,
): Promise<{ agentId: string; ownerAddress: string; challengeB64: string } | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.getdel<{ agentId: string; ownerAddress: string; challengeB64: string }>(
    `${CLAIM_PREFIX}${challengeId}`,
  );
}


// ── Emergency Halt ────────────────────────────────────────────────
// Setting the halt key causes all signing operations to abort immediately.
// Clear it when safe to resume.

/**
 * Structured halt record stored in Redis.
 * Provides a full audit trail for post-incident investigation:
 * which region set the halt, when, and why.
 */
export interface HaltRecord {
  reason:     string;
  setAt:      string; // ISO 8601
  region:     string; // RAILWAY_REGION / FLY_REGION / "default"
  instanceId: string; // UUID stable per-process
}

export async function setHalt(reason: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const record: HaltRecord = {
    reason,
    setAt:      new Date().toISOString(),
    region:     HALT_REGION,
    instanceId: HALT_INSTANCE_ID,
  };

  // NX flag: do not overwrite an existing halt — the first halt wins.
  // This prevents a concurrent mass drain in a second region from
  // overwriting the halt reason set by the first region.
  const result = await redis.set(HALT_KEY, JSON.stringify(record), { nx: true });
  if (result === null) {
    // Halt was already set by another instance — log but do not overwrite
    console.error(`[HALT] Halt already active; additional trigger from region=${HALT_REGION}: ${reason}`);
  } else {
    console.error(`[HALT] Emergency halt set by region=${HALT_REGION} instance=${HALT_INSTANCE_ID}: ${reason}`);
  }
}

export async function clearHalt(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(HALT_KEY);
  console.log(`[HALT] Emergency halt cleared by region=${HALT_REGION} instance=${HALT_INSTANCE_ID}`);
}

/**
 * Returns the active HaltRecord if halted, or null if not halted.
 *
 * Backward-compatible: if the stored value is a plain string (pre-migration
 * halt), wraps it in a HaltRecord with unknown region/instanceId so callers
 * don't need to handle both shapes.
 */
export async function isHalted(): Promise<HaltRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const raw = await redis.get(HALT_KEY) as unknown;
  if (!raw) return null;

  // Upstash REST client auto-deserialises JSON, so `raw` may already be a
  // parsed HaltRecord object rather than a JSON string. Handle both shapes.
  if (typeof raw === "object") {
    return raw as HaltRecord;
  }

  // Handle plain-string halt records written before this migration
  if (typeof raw === "string") {
    if (raw[0] === "{") {
      try {
        return JSON.parse(raw) as HaltRecord;
      } catch {
        // fall through to plain-string wrap
      }
    }
    return { reason: raw, setAt: "unknown", region: "unknown", instanceId: "unknown" };
  }

  return null;
}

// Re-export crypto for consumers that need UUID generation
export { crypto };

// ── Pending Agent (pre-activation) ────────────────────────────────
//
// When a user calls POST /api/agents/create, the server generates a keypair
// and stores a pending record here (24h TTL).  The activation poller watches
// for an ALGO deposit ≥ 500 000 µALGO and then performs the on-chain
// USDC opt-in + rekey automatically, using the stored secret key.
// The record (and the secret key) is deleted immediately after activation.

const PENDING_PREFIX       = "x402:pending:";
const PENDING_OWNER_PREFIX = "x402:pending-owner:";
const PENDING_TTL_S        = 4 * 3_600; // 4 hours (S.7: reduced from 24h)

// ── Pending agent key encryption (S.7) ─────────────────────────────────
// Secret keys are encrypted at rest using AES-256-GCM with a key derived
// from REDIS_HMAC_SECRET. When REDIS_HMAC_SECRET is not set, keys are
// stored plaintext (backward compatible for dev, warn in prod).

function getPendingEncKey(): Buffer | null {
  const secret = process.env.REDIS_HMAC_SECRET;
  if (!secret) return null;
  // Derive a 32-byte AES key from the HMAC secret using SHA-256
  return crypto.createHash("sha256").update(secret).update("pending-agent-key-v1").digest();
}

function encryptSecretKey(plaintext: string): string {
  const encKey = getPendingEncKey();
  if (!encKey) return plaintext; // dev: plaintext fallback
  const iv         = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher     = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  // Format: base64(iv + authTag + ciphertext) prefixed with "enc:"
  const envelope   = Buffer.concat([iv, authTag, encrypted]);
  return `enc:${envelope.toString("base64")}`;
}

function decryptSecretKey(stored: string): string {
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext
  const encKey = getPendingEncKey();
  if (!encKey) {
    throw new Error("REDIS_HMAC_SECRET not set — cannot decrypt pending agent key");
  }
  const envelope  = Buffer.from(stored.slice(4), "base64");
  const iv        = envelope.subarray(0, 12);
  const authTag   = envelope.subarray(12, 28);
  const encrypted = envelope.subarray(28);
  const decipher  = crypto.createDecipheriv("aes-256-gcm", encKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export interface PendingAgentRecord {
  agentId:        string;
  address:        string;
  /** Base64-encoded 64-byte Algorand secret key — deleted after activation */
  secretKeyB64:   string;
  platform?:      string;
  /** Algorand address of the owner who initiated creation */
  ownerAddress?:  string;
  /** WebAuthn ownerWalletId if agent was created by a passkey-authenticated user */
  ownerWalletId?: string;
  createdAt:      string;
}

export async function storePendingAgent(record: PendingAgentRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available — cannot store pending agent");
  // S.7: Encrypt the secret key before storing
  const stored: PendingAgentRecord = {
    ...record,
    secretKeyB64: encryptSecretKey(record.secretKeyB64),
  };
  const ops: Promise<unknown>[] = [
    redis.set(
      `${PENDING_PREFIX}${record.agentId}`,
      JSON.stringify(stored),
      { ex: PENDING_TTL_S },
    ),
  ];
  if (record.ownerAddress) {
    ops.push(redis.sadd(`${PENDING_OWNER_PREFIX}${record.ownerAddress}`, record.agentId));
  }
  await Promise.all(ops);
}

export interface PendingAgentSummary {
  agentId:   string;
  address:   string;
  status:    "pending";
  createdAt: string;
  platform?: string;
}

/**
 * List pending (not-yet-activated) agents for a given owner.
 * Uses the secondary pending-owner index (x402:pending-owner:{address}).
 * Stale index entries (agent expired/activated) are silently skipped.
 */
export async function listPendingAgentsByOwner(ownerAddress: string): Promise<PendingAgentSummary[]> {
  const redis = getRedis();
  if (!redis) return [];

  const agentIds = await redis.smembers(`${PENDING_OWNER_PREFIX}${ownerAddress}`);
  if (!agentIds.length) return [];

  const records = await Promise.all(agentIds.map((id) => getPendingAgent(id)));
  const results: PendingAgentSummary[] = [];
  for (const r of records) {
    if (r !== null) {
      results.push({
        agentId:   r.agentId,
        address:   r.address,
        status:    "pending",
        createdAt: r.createdAt,
        platform:  r.platform,
      });
    }
  }
  return results;
}

export async function getPendingAgent(agentId: string): Promise<PendingAgentRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const record = await redis.get<PendingAgentRecord>(`${PENDING_PREFIX}${agentId}`);
  if (!record) return null;
  // S.7: Decrypt secret key on read
  try {
    return { ...record, secretKeyB64: decryptSecretKey(record.secretKeyB64) };
  } catch (err) {
    console.error(`[AgentRegistry] Failed to decrypt pending agent key for ${agentId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function deletePendingAgent(agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`${PENDING_PREFIX}${agentId}`);
}

export async function scanAllPendingAgents(): Promise<PendingAgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const records: PendingAgentRecord[] = [];
  let cursor = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `${PENDING_PREFIX}*`,
      count: 100,
    });
    cursor = parseInt(nextCursor, 10);

    if (keys.length > 0) {
      const raws = await Promise.all(keys.map((k) => redis.get<PendingAgentRecord>(k)));
      for (const r of raws) {
        if (r !== null) records.push(r);
      }
    }
  } while (cursor !== 0);

  return records;
}

// ── Active agent count (S.6 — rate limit fairness) ────────────────────
let _agentCountCache: number | null = null;
let _agentCountExpiry = 0;
const AGENT_COUNT_TTL_MS = 60_000;

/**
 * Return the count of active agents. Cached for 60s to avoid full KEYS scan
 * on every rate-limit check. Used by executionLimiter for per-agent fairness.
 */
export async function activeAgentCount(): Promise<number> {
  const now = Date.now();
  if (_agentCountCache !== null && now < _agentCountExpiry) return _agentCountCache;

  const redis = getRedis();
  if (!redis) return 1;

  const keys = await redis.keys(`${AGENTS_PREFIX}*`);
  // Only count active agents — suspended/orphaned don't need quota
  const raws = await Promise.all(keys.map((k) => redis.get<AgentRecord>(k)));
  const count = raws.filter((r): r is AgentRecord => r?.status === "active").length;

  _agentCountCache = Math.max(count, 1);
  _agentCountExpiry = now + AGENT_COUNT_TTL_MS;
  return _agentCountCache;
}

/**
 * Link all agents owned by a WebAuthn passkey account to an Algorand address index.
 * After linking, users can log in with their Algorand wallet to recover access.
 */
export async function linkAlgorandRecovery(
  webauthnOwnerWalletId: string,
  algorandAddress:       string,
): Promise<number> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const agents = await listAgentsByWebAuthnOwner(webauthnOwnerWalletId);
  if (!agents.length) return 0;

  await Promise.all(
    agents.map((a) => redis.sadd(`${OWNER_PREFIX}${algorandAddress}`, a.agentId)),
  );
  return agents.length;
}
