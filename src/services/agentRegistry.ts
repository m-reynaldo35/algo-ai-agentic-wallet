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
   * Monotonic WebAuthn signature counter — anti-replay for FIDO2 assertions.
   * Server increments on every successful WebAuthn assertion. If the device
   * sends a counter lower than this value, the assertion is rejected.
   */
  webauthnCounter?: number;
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

  await Promise.all([
    redis.set(`${AGENTS_PREFIX}${record.agentId}`, JSON.stringify(record)),
    redis.set(`${ADDR_IDX_PREFIX}${record.address}`, record.agentId),
  ]);
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
  await redis.set(`${AGENTS_PREFIX}${record.agentId}`, JSON.stringify(record));
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
export async function listAgentsByCohort(cohort: string): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const keys = await redis.keys(`${AGENTS_PREFIX}*`);
  if (!keys.length) return [];

  const raws = await Promise.all(keys.map((k) => redis.get<AgentRecord>(k)));
  return raws.filter((r): r is AgentRecord => r !== null && r.cohort === cohort);
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

  const raw = await redis.get(HALT_KEY) as string | null;
  if (!raw) return null;

  // Handle plain-string halt records written before this migration
  if (raw[0] !== "{") {
    return { reason: raw, setAt: "unknown", region: "unknown", instanceId: "unknown" };
  }

  try {
    return JSON.parse(raw) as HaltRecord;
  } catch {
    return { reason: raw, setAt: "unknown", region: "unknown", instanceId: "unknown" };
  }
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
