import { getRedis } from "./redis.js";
import crypto from "crypto";

/**
 * Agent Registry — Redis-backed store for rekeyed agent accounts.
 *
 * Schema:
 *   x402:agents:{agentId}       → AgentRecord (JSON)
 *   x402:agent-addr:{address}   → agentId      (reverse index)
 */

export interface AgentRecord {
  agentId: string;
  /** On-chain Algorand address — permanent public identity */
  address: string;
  /** Cohort assignment — determines which signer key controls this agent */
  cohort: string;
  /** auth-addr on-chain — the Rocca signer address authorised to sign */
  authAddr: string;
  /** Optional platform tag for grouping/billing */
  platform?: string;
  /** ISO timestamp of registration */
  createdAt: string;
  /** txnId of the fund+optin+rekey atomic group */
  registrationTxnId: string;
  status: "registered" | "active" | "suspended";
}

const AGENTS_PREFIX    = "x402:agents:";
const ADDR_IDX_PREFIX  = "x402:agent-addr:";

// ── Cohort Assignment ────────────────────────────────────────────
// Phase 1: single cohort. Phase 2+: sha256(agentId) % totalCohorts.
export function assignCohort(_agentId: string): string {
  return "A";
}

// ── Validation ───────────────────────────────────────────────────
const AGENT_ID_RE = /^[a-zA-Z0-9_\-:.@]{3,128}$/;

export function validateAgentId(agentId: string): void {
  if (!agentId || !AGENT_ID_RE.test(agentId)) {
    throw new Error(
      "Invalid agentId: must be 3–128 chars, alphanumeric + _-:.@",
    );
  }
}

// ── CRUD ─────────────────────────────────────────────────────────

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

  const raw = await redis.get(`${AGENTS_PREFIX}${agentId}`) as string | null;
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AgentRecord;
  } catch {
    return null;
  }
}

export async function getAgentByAddress(address: string): Promise<AgentRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const agentId = await redis.get(`${ADDR_IDX_PREFIX}${address}`) as string | null;
  if (!agentId) return null;

  return getAgent(agentId);
}

export async function listAgents(limit = 50, offset = 0): Promise<AgentRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  // Scan the agents keyspace — suitable for moderate scale.
  // At very high agent counts (>100k), replace with a sorted set index.
  const keys = await redis.keys(`${AGENTS_PREFIX}*`);
  const page = keys.slice(offset, offset + limit);

  if (!page.length) return [];

  const raws = await Promise.all(page.map((k) => redis.get(k)));
  return raws
    .filter((r): r is string => typeof r === "string")
    .map((r) => { try { return JSON.parse(r) as AgentRecord; } catch { return null; } })
    .filter((r): r is AgentRecord => r !== null);
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
