/**
 * Execution Idempotency — Globally-Atomic Payment Intent & TxId Marking
 *
 * Guarantees that a given payment intent (sandboxId) and confirmed on-chain
 * transaction (txnId) are each processed exactly once across all regions.
 *
 * ── Problem ─────────────────────────────────────────────────────────────
 *
 * The naive pattern of GET → execute → SET is a TOCTOU race:
 *
 *   Instance A (us-east): GET idempotent:abc → null → execute → SET result
 *   Instance B (eu-west): GET idempotent:abc → null → execute → SET result
 *                                                   ↑
 *                                       Both regions executed. Double spend.
 *
 * The signing service's groupId SET NX catches this IF both requests share
 * the same groupId AND the signing service is in the request path. It is
 * not a substitute for idempotency at the intent layer.
 *
 * ── Solution ────────────────────────────────────────────────────────────
 *
 * Atomic reservation via SET NX before execution:
 *
 *   atomicReserve(sandboxId)
 *     → "OK"     — we won the lock; proceed to execute
 *     → "processing" — another instance is executing; caller returns 202
 *     → "completed"  — already done; caller returns cached result
 *
 *   completeReservation(sandboxId, result)
 *     → Replaces the pending marker with the real result (24h TTL)
 *
 *   releaseReservation(sandboxId)
 *     → DEL on pipeline failure; allows the client to retry
 *
 *   markTxIdSettled(txnId, metadata)
 *     → SET NX with 7-day TTL; long-lived evidence that txnId was settled
 *
 * ── Redis Keys ───────────────────────────────────────────────────────────
 *
 *   x402:idempotent:{sandboxId}   pending marker or result JSON   TTL: 300s → 86400s
 *   x402:settled:txid:{txnId}     settlement metadata JSON        TTL: 604800s (7 days)
 *
 * ── Fail Semantics ───────────────────────────────────────────────────────
 *
 * atomicReserve: fails OPEN on Redis error — returns "ok" so signing can
 * proceed. A Redis outage should not halt all payments. The signing service's
 * groupId SET NX remains as a second line of defence.
 *
 * markTxIdSettled: best-effort; never throws. A confirmed Algorand txnId is
 * intrinsically unique on-chain — the marker is defence-in-depth.
 */

import { getRedis } from "./redis.js";

// ── Constants ──────────────────────────────────────────────────────

const PENDING_TTL_S   = 300;       // 5 min — covers the full signing + broadcast window
const RESULT_TTL_S    = 86_400;    // 24 h — idempotent result cache
const TXID_TTL_S      = 604_800;   // 7 days — well beyond Algorand's max txn validity

const IDEMPOTENT_PREFIX = "x402:idempotent:";
const TXID_PREFIX       = "x402:settled:txid:";

// ── Environment ────────────────────────────────────────────────────

const IS_PROD =
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT === "production";

// ── Types ──────────────────────────────────────────────────────────

interface PendingMarker {
  _pending: true;
  reservedAt: number; // Unix ms
  region:     string;
}

export interface ReserveResult {
  /** "ok"          — reservation won; proceed to execute              */
  /** "processing"  — another instance holds the lock; return 202      */
  /** "completed"   — result already cached; return cachedResult        */
  /** "unavailable" — Redis unreachable in production; caller returns 503 */
  status:       "ok" | "processing" | "completed" | "unavailable";
  cachedResult?: unknown;
}

export interface TxIdMetadata {
  agentId:        string;
  sandboxId:      string;
  groupId?:       string;
  confirmedRound?: number;
  settledAt?:     string;
}

// ── Region tag ────────────────────────────────────────────────────

const REGION = process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "default";

// ── TTL extension Lua script ───────────────────────────────────────
//
// Extends the TTL of a pending reservation key without reading or
// overwriting its value. Only operates when the key contains "_pending":true
// so a completed result (which carries its own 24h TTL) is never shortened.
// Uses a substring search rather than JSON decode to avoid cjson dependency.
const EXTEND_PENDING_LUA = `
local val = redis.call('GET', KEYS[1])
if not val then return 0 end
if string.find(val, '"_pending":true', 1, true) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  return 1
end
return 0
`;

// ── Public API ────────────────────────────────────────────────────

/**
 * Atomically reserve a sandboxId execution slot.
 *
 * Uses SET NX to place a pending marker before execution starts.
 * Only one instance across all regions can win this SET NX.
 *
 * Returns:
 *   "ok"          — caller should proceed to execute + call completeReservation()
 *   "processing"  — caller should return 202 (another instance is executing)
 *   "completed"   — caller should return the cachedResult (already done)
 *   "unavailable" — Redis unreachable in production; caller should return 503.
 *                   Availability loss is preferred over silent double-spend risk.
 *                   In development (non-production) Redis errors fail open as before.
 */
export async function atomicReserve(sandboxId: string): Promise<ReserveResult> {
  if (!sandboxId) return { status: "ok" }; // no sandboxId = no deduplication

  const redis = getRedis();
  if (!redis) {
    if (IS_PROD) {
      console.error("[ExecutionIdempotency] Redis unavailable in production — returning 503 (fail-closed)");
      return { status: "unavailable" };
    }
    return { status: "ok" }; // fail open in development
  }

  const key: string = `${IDEMPOTENT_PREFIX}${sandboxId}`;

  try {
    const pending: PendingMarker = { _pending: true, reservedAt: Date.now(), region: REGION };

    // Single atomic command: set if not exists with TTL
    const result = await redis.set(key, JSON.stringify(pending), { nx: true, ex: PENDING_TTL_S });

    if (result === "OK") {
      // We won — proceed to execute
      return { status: "ok" };
    }

    // Key already exists — read it to determine state
    const existing = await redis.get(key) as string | null;
    if (!existing) {
      // Key vanished between SET and GET (TTL expired in the gap — very rare)
      // Retry the reservation once
      const retry = await redis.set(key, JSON.stringify(pending), { nx: true, ex: PENDING_TTL_S });
      if (retry === "OK") return { status: "ok" };
      return { status: "processing" };
    }

    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return { status: "processing" }; }

    if ((parsed as Record<string, unknown>)._pending === true) {
      // Another instance is currently executing
      return { status: "processing" };
    }

    // Completed result — return it
    return { status: "completed", cachedResult: parsed };

  } catch (err) {
    console.error(
      "[ExecutionIdempotency] Redis error in atomicReserve:",
      err instanceof Error ? err.message : err,
    );
    if (IS_PROD) return { status: "unavailable" }; // fail-closed
    return { status: "ok" }; // fail open in development
  }
}

/**
 * Replace the pending reservation with the real execution result.
 *
 * Call after executePipeline() succeeds. Extends TTL to 24h so
 * subsequent retries receive the cached result.
 *
 * Best-effort: never throws.
 */
export async function completeReservation(sandboxId: string, result: unknown): Promise<void> {
  if (!sandboxId) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key = `${IDEMPOTENT_PREFIX}${sandboxId}`;
    await redis.set(key, JSON.stringify(result), { ex: RESULT_TTL_S });
  } catch (err) {
    console.error(
      "[ExecutionIdempotency] Failed to complete reservation:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Release a pending reservation after pipeline failure.
 *
 * Deletes the pending marker so the client can retry. Without this,
 * the slot is held for PENDING_TTL_S (5 min) before auto-expiring.
 *
 * Best-effort: never throws.
 */
export async function releaseReservation(sandboxId: string): Promise<void> {
  if (!sandboxId) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key = `${IDEMPOTENT_PREFIX}${sandboxId}`;
    // Only delete if still pending — don't wipe a completed result
    const current = await redis.get(key) as string | null;
    if (!current) return;

    let parsed: unknown;
    try { parsed = JSON.parse(current); } catch { return; }

    if ((parsed as Record<string, unknown>)._pending === true) {
      await redis.del(key);
    }
  } catch (err) {
    console.error(
      "[ExecutionIdempotency] Failed to release reservation:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mark a confirmed on-chain txnId as settled.
 *
 * Uses SET NX with a 7-day TTL. This provides:
 *   1. Long-lived evidence of settlement (outlives the 24h idempotency cache)
 *   2. Defence-in-depth: if the idempotency key expires and is re-presented,
 *      the txnId record can detect that this settlement already occurred
 *
 * The Algorand blockchain itself guarantees txnId uniqueness. This is an
 * application-layer record for auditability and cross-region consistency.
 *
 * Returns { wasNew: true } if the record was newly created, or
 * { wasNew: false } if the txnId was already in the settled set — indicating
 * a crash-recovery scenario where a previous execution succeeded but
 * completeReservation did not persist the idempotency result. Callers should
 * log this as an anomaly but still treat the settlement as successful.
 *
 * NOTE: All instances share a single authoritative Upstash Redis primary.
 * SET NX is safe under this topology. If region-local Redis replicas are
 * ever introduced, split-brain would require a distributed lock protocol.
 *
 * Best-effort: never throws.
 */
export async function markTxIdSettled(txnId: string, meta: TxIdMetadata): Promise<{ wasNew: boolean }> {
  if (!txnId) return { wasNew: true };

  const redis = getRedis();
  if (!redis) return { wasNew: true };

  try {
    const key = `${TXID_PREFIX}${txnId}`;
    const record = {
      ...meta,
      markedAt: new Date().toISOString(),
      region:   REGION,
    };
    // NX: if this txnId was already marked, do not overwrite.
    // Result is "OK" when newly set, null when key already existed.
    const result = await redis.set(key, JSON.stringify(record), { nx: true, ex: TXID_TTL_S });
    return { wasNew: result === "OK" };
  } catch (err) {
    console.error(
      "[ExecutionIdempotency] Failed to mark txId settled:",
      err instanceof Error ? err.message : err,
    );
    return { wasNew: true }; // unknown — assume new; anomaly already logged
  }
}

/**
 * Look up the settlement record for a confirmed txnId.
 * Returns null if not found (not yet settled or record expired).
 */
export async function getTxIdSettlement(txnId: string): Promise<TxIdMetadata | null> {
  if (!txnId) return null;

  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get(`${TXID_PREFIX}${txnId}`) as string | null;
    if (!raw) return null;
    return JSON.parse(raw) as TxIdMetadata;
  } catch {
    return null;
  }
}

/**
 * Extend the TTL of a pending reservation back to PENDING_TTL_S.
 *
 * Call this at long-running stage boundaries (before signing, before
 * broadcast, and periodically during waitForConfirmation) so that a
 * slow pipeline does not let the pending marker expire and open a
 * structural double-spend window.
 *
 * Only extends keys that still contain "_pending":true — a completed
 * result (which carries a 24h TTL) is never shortened.  Uses a Lua
 * script for atomicity: the check and EXPIRE execute in one round-trip
 * with no TOCTOU gap.
 *
 * Best-effort: never throws.
 */
export async function extendReservationTTL(sandboxId: string): Promise<void> {
  if (!sandboxId) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    const key = `${IDEMPOTENT_PREFIX}${sandboxId}`;
    await (redis as unknown as {
      eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
    }).eval(EXTEND_PENDING_LUA, [key], [PENDING_TTL_S]);
  } catch (err) {
    console.error(
      "[ExecutionIdempotency] Failed to extend reservation TTL:",
      err instanceof Error ? err.message : err,
    );
  }
}
