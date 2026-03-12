import { getRedis } from "./redis.js";
import crypto, { randomUUID } from "crypto";

// ── Instance identity (for halt audit trail) ──────────────────────
const HALT_INSTANCE_ID = randomUUID();
const HALT_REGION      = process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "default";

/**
 * Agent Registry — Redis-backed store for rekeyed agent accounts.
 *
 * Redis Schema:
 *   x402:agents:{agentId}              → AgentRecord (JSON)
 *   x402:agent-addr:{address}          → agentId  (reverse index)
 *   x402:rotation:{batchId}            → RotationBatch (JSON)
 *   x402:rotation:{batchId}:done       → Set<agentId>  (confirmed)
 *   x402:rotation:{batchId}:failed     → Set<agentId>  (failed)
 *   x402:rotation:active               → batchId  (distributed lock, 6h TTL)
 *   x402:drift:{agentId}               → DriftRecord (JSON)
 *   x402:halt                          → HaltRecord (JSON)  (emergency halt flag)
 */

// ── Agent State Machine ───────────────────────────────────────────
//
//  pending    → registered   on-chain fund+optin+rekey confirmed
//  pending    → orphaned     timeout without on-chain confirmation
//  registered → active       first successful settlement
//  active     → active       each subsequent settlement
//  registered → rotating     rotation batch started
//  active     → rotating     rotation batch started
//  rotating   → active       rekey confirmed + registry updated
//  rotating   → orphaned     rekey failed + max retries exceeded
//  any        → suspended    admin action
//  any        → orphaned     drift detected by verify-registry
//  orphaned   → active       orphan recovery completed
//  suspended  → active       admin action (unsuspend)

export interface AgentRecord {
  agentId: string;
  /** Permanent on-chain Algorand address */
  address: string;
  /** Cohort assignment — determines which signer key controls this agent */
  cohort: string;
  /** auth-addr on-chain — the Rocca signer address authorised to sign */
  authAddr: string;
  /** Optional platform tag */
  platform?: string;
  /** ISO timestamp of initial registration */
  createdAt: string;
  /** txnId of the fund+optin+rekey atomic group */
  registrationTxnId: string;
  status: "registered" | "active" | "rotating" | "suspended" | "orphaned";
  // ── Rotation tracking ─────────────────────────────────────────
  /** Active rotation batchId when status === "rotating" */
  rotationBatchId?: string;
  /** Previous authAddr — retained during rotation for rollback */
  prevAuthAddr?: string;
  // ── Audit ─────────────────────────────────────────────────────
  lastSettlementAt?: string;
  // ── Drift detection ───────────────────────────────────────────
  driftDetectedAt?: string;
  // ── Custody model ─────────────────────────────────────────────
  /**
   * FIDO2 credential ID hash of the wallet that owns this agent.
   * Set at agent registration, immutable thereafter.
   * Prevents lateral ownership transfer through API compromise —
   * only the wallet that created the agent may initiate rekey.
   * Optional for backward compatibility with pre-custody agents.
   */
  ownerWalletId?: string;
  /**
   * Current custody mode.
   *   "rocca" — Rocca signer holds auth-addr (full or semi-custodial).
   *   "user"  — User's own key holds auth-addr (user-sovereign).
   * Defaults to "rocca" for all existing agents (field absent on legacy records).
   *
   * Invariant: custody === "rocca" ↔ authAddr === Rocca signer address.
   * Asserted at boot and enforced by the signing service Step 11.
   */
  custody?: "rocca" | "user";
  /**
   * Monotonic counter incremented on every custody transition.
   * Rekey challenges are bound to this version — stale challenge
   * artifacts cannot be replayed against a later transition state.
   * Defaults to 0 for existing agents (field absent on legacy records).
   */
  custodyVersion?: number;
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
}

// ── Rotation Batch ────────────────────────────────────────────────

export interface RotationBatch {
  batchId: string;
  cohort: string;
  fromAuthAddr: string;
  toAuthAddr: string;
  totalAgents: number;
  processedCount: number;
  confirmedCount: number;
  failedCount: number;
  status: "pending" | "running" | "paused" | "completed" | "halted";
  batchSize: number;
  /** Algorand rounds to wait after txn inclusion before marking confirmed */
  minConfirmDepth: number;
  dryRun: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  haltReason?: string;
}

// ── Drift Record ──────────────────────────────────────────────────

export interface DriftRecord {
  agentId: string;
  address: string;
  expectedAuthAddr: string;
  /** null = account not rekeyed at all */
  actualAuthAddr: string | null;
  usdcOptedIn: boolean;
  microAlgoBalance: number;
  detectedAt: string;
  resolvedAt?: string;
}

// ── Redis Key Constants ───────────────────────────────────────────

const AGENTS_PREFIX    = "x402:agents:";
const ADDR_IDX_PREFIX  = "x402:agent-addr:";
const ROTATION_PREFIX  = "x402:rotation:";
const ROTATION_ACTIVE  = "x402:rotation:active";   // distributed lock
const DRIFT_PREFIX     = "x402:drift:";
const HALT_KEY         = "x402:halt";
const OWNER_PREFIX     = "x402:owner:";
const CLAIM_PREFIX     = "x402:claim:";
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

  const ops: Promise<unknown>[] = [
    redis.set(`${AGENTS_PREFIX}${record.agentId}`, JSON.stringify(record)),
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

  // @upstash/redis auto-deserialises JSON on read — get<T>() returns the
  // parsed object directly. Do NOT JSON.parse() the result.
  return redis.get<AgentRecord>(`${AGENTS_PREFIX}${agentId}`);
}

export async function getAgentByAddress(address: string): Promise<AgentRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const agentId = await redis.get(`${ADDR_IDX_PREFIX}${address}`) as string | null;
  if (!agentId) return null;

  return getAgent(agentId);
}

/** Full record replace — use for rotation/drift updates that touch multiple fields */
export async function updateAgentRecord(record: AgentRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  const ops: Promise<unknown>[] = [
    redis.set(`${AGENTS_PREFIX}${record.agentId}`, JSON.stringify(record)),
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
  await redis.set(`${AGENTS_PREFIX}${agentId}`, JSON.stringify(record));
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
            await Promise.all([
              redis.set(`${AGENTS_PREFIX}${r.agentId}`, JSON.stringify(updated)),
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

  await Promise.all([
    redis.set(`${AGENTS_PREFIX}${agentId}`, JSON.stringify(agent)),
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

  await Promise.all([
    redis.set(`${AGENTS_PREFIX}${agentId}`, JSON.stringify(agent)),
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

// ── Rotation Batch CRUD ───────────────────────────────────────────

export async function storeRotationBatch(batch: RotationBatch): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  await redis.set(`${ROTATION_PREFIX}${batch.batchId}`, JSON.stringify(batch));
}

export async function getRotationBatch(batchId: string): Promise<RotationBatch | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get<RotationBatch>(`${ROTATION_PREFIX}${batchId}`);
}

export async function markAgentRotationDone(batchId: string, agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  await redis.sadd(`${ROTATION_PREFIX}${batchId}:done`, agentId);
}

export async function markAgentRotationFailed(batchId: string, agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  await redis.sadd(`${ROTATION_PREFIX}${batchId}:failed`, agentId);
}

export async function isAgentRotationDone(batchId: string, agentId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const result = await redis.sismember(`${ROTATION_PREFIX}${batchId}:done`, agentId);
  return result === 1;
}

export async function getRotationDoneSet(batchId: string): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  return redis.smembers(`${ROTATION_PREFIX}${batchId}:done`) as Promise<string[]>;
}

// ── Distributed Rotation Lock ─────────────────────────────────────
// Prevents two rotation processes from running concurrently.
// TTL = 6 hours — maximum expected rotation window for 100k agents.

export async function acquireRotationLock(batchId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  const result = await redis.set(ROTATION_ACTIVE, batchId, { nx: true, ex: 21600 });
  return result === "OK";
}

export async function releaseRotationLock(batchId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  // Only release if we own it — prevents releasing another process's lock
  const current = await redis.get(ROTATION_ACTIVE) as string | null;
  if (current === batchId) {
    await redis.del(ROTATION_ACTIVE);
  }
}

export async function getActiveRotation(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get(ROTATION_ACTIVE) as Promise<string | null>;
}

// ── Emergency Halt ────────────────────────────────────────────────
// Setting the halt key causes all signing operations and rotation
// sub-batches to abort immediately. Clear it when safe to resume.

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

// ── Drift Records ─────────────────────────────────────────────────

export async function storeDrift(record: DriftRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");
  await redis.set(`${DRIFT_PREFIX}${record.agentId}`, JSON.stringify(record));
}

export async function getDrift(agentId: string): Promise<DriftRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get<DriftRecord>(`${DRIFT_PREFIX}${agentId}`);
}

export async function listDrifts(): Promise<DriftRecord[]> {
  const redis = getRedis();
  if (!redis) return [];
  const keys = await redis.keys(`${DRIFT_PREFIX}*`);
  if (!keys.length) return [];
  const raws = await Promise.all(keys.map((k) => redis.get<DriftRecord>(k)));
  return raws.filter((r): r is DriftRecord => r !== null);
}

export async function resolveDrift(agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const existing = await getDrift(agentId);
  if (existing) {
    existing.resolvedAt = new Date().toISOString();
    await redis.set(`${DRIFT_PREFIX}${agentId}`, JSON.stringify(existing));
  }
}

// ── Custody Invariant ─────────────────────────────────────────────
//
// The custody field and authAddr must be consistent at all times:
//   custody === "rocca"  →  authAddr === Rocca signer address
//   custody === "user"   →  authAddr !== Rocca signer address
//
// This is checked at boot. Any violation means the registry has drifted
// from the on-chain state — fail fast rather than sign on behalf of an
// account we no longer control (or one the user now fully owns).

export async function assertCustodyInvariant(
  roccaSignerAddress: string,
): Promise<void> {
  const agents     = await listAgents(10_000, 0);
  const violations: string[] = [];

  for (const agent of agents) {
    const custody = agent.custody ?? "rocca"; // legacy agents default to "rocca"

    if (custody === "rocca" && agent.authAddr !== roccaSignerAddress) {
      violations.push(
        `${agent.agentId}: custody=rocca but authAddr=${agent.authAddr}`,
      );
    }
    if (custody === "user" && agent.authAddr === roccaSignerAddress) {
      violations.push(
        `${agent.agentId}: custody=user but authAddr is Rocca signer`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `[CustodyInvariant] ${violations.length} violation(s) detected:\n` +
      violations.join("\n"),
    );
  }
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
const PENDING_TTL_S        = 86_400; // 24 hours

export interface PendingAgentRecord {
  agentId:      string;
  address:      string;
  /** Base64-encoded 64-byte Algorand secret key — deleted after activation */
  secretKeyB64: string;
  platform?:    string;
  /** Algorand address of the owner who initiated creation */
  ownerAddress?: string;
  createdAt:    string;
}

export async function storePendingAgent(record: PendingAgentRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available — cannot store pending agent");
  const ops: Promise<unknown>[] = [
    redis.set(
      `${PENDING_PREFIX}${record.agentId}`,
      JSON.stringify(record),
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
  return redis.get<PendingAgentRecord>(`${PENDING_PREFIX}${agentId}`);
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
