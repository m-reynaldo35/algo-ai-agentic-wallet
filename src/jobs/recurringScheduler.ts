/**
 * Recurring Scheduler — Autonomous Mandate Payment Executor
 *
 * Runs on a 30-second interval. On each tick:
 *   1. Scans x402:mandate:recurring:* for due mandates
 *   2. For each due mandate, acquires an idempotency lock (NX EX 25)
 *   3. Builds and executes the atomic transaction group
 *   4. Evaluates via mandateEngine (same path as /api/execute — no bypass)
 *   5. On success: updates nextExecution, emits RECURRING_EXECUTED
 *   6. On failure: emits RECURRING_FAILED, does NOT retry until next tick
 *
 * Pattern mirrors src/jobs/driftPulse.ts.
 */

import { getRedis }            from "../services/redis.js";
import { getAgent }            from "../services/agentRegistry.js";
import { loadRawMandate }      from "../services/mandateService.js";
import { evaluateMandate }     from "../services/mandateEngine.js";
import { executePipeline }     from "../executor.js";
import { constructAtomicGroup } from "../services/transaction.js";
import { emitSecurityEvent }   from "../services/securityAudit.js";

// ── Policy ─────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 30_000;   // 30-second heartbeat
const LOCK_TTL_S       = 25;       // idempotency lock — shorter than tick interval

const RECUR_PATTERN = "x402:mandate:recurring:";
const LOCK_PREFIX   = "x402:mandate:recurring-lock:";

// ── Public API ─────────────────────────────────────────────────────

export function startRecurringScheduler(): ReturnType<typeof setInterval> {
  console.log(
    `[RecurringScheduler] Starting — 30s tick for due recurring mandates`,
  );

  return setInterval(async () => {
    try {
      await runSchedulerTick();
    } catch (err) {
      console.error(
        "[RecurringScheduler] Tick error:",
        err instanceof Error ? err.message : err,
      );
    }
  }, TICK_INTERVAL_MS);
}

// ── Core logic ─────────────────────────────────────────────────────

async function runSchedulerTick(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const now = Date.now();

  // Scan all recurring schedule keys
  let cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      { match: `${RECUR_PATTERN}*`, count: 100 },
    ) as [number | string, string[]];

    cursor = Number(nextCursor);

    for (const key of keys) {
      try {
        await processMandateKey(key, now);
      } catch (err) {
        console.error(
          `[RecurringScheduler] Error processing ${key}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } while (cursor !== 0);
}

async function processMandateKey(key: string, now: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  // Extract mandateId from key: x402:mandate:recurring:{mandateId}
  const mandateId = key.slice(RECUR_PATTERN.length);
  if (!mandateId) return;

  // Check nextExecution
  const nextExecStr = await redis.get(key) as string | null;
  if (!nextExecStr) return;

  const nextExec = Number(nextExecStr);
  if (now < nextExec) return; // not yet due

  // ── Idempotency lock — NX EX 25 ──────────────────────────────
  const lockKey = `${LOCK_PREFIX}${mandateId}`;
  const locked  = await redis.set(lockKey, "1", { nx: true, ex: LOCK_TTL_S });
  if (locked !== "OK") return; // another tick is already running this mandate

  try {
    await executeRecurringMandate(mandateId, now);
  } finally {
    await redis.del(lockKey);
  }
}

async function executeRecurringMandate(mandateId: string, now: number): Promise<void> {
  // We need to find which agent owns this mandate.
  // The recurring key only has mandateId; scan x402:mandate:*:mandateId
  const redis = getRedis();
  if (!redis) return;

  // Find the mandate by scanning agent mandate keys
  const candidateKeys = await redis.keys(`x402:mandate:*:${mandateId}`) as string[];
  if (!candidateKeys.length) {
    console.warn(`[RecurringScheduler] Mandate ${mandateId} not found in registry`);
    return;
  }

  // Extract agentId from the first matching key: x402:mandate:{agentId}:{mandateId}
  const key = candidateKeys[0];
  const parts = key.split(":");
  // key format: x402:mandate:{agentId}:{mandateId}
  // parts: ["x402", "mandate", agentId, mandateId]
  const agentId = parts[2];
  if (!agentId) return;

  const mandate = await loadRawMandate(agentId, mandateId);
  if (!mandate || mandate.status === "revoked") return;
  if (mandate.expiresAt && mandate.expiresAt < now) return;
  if (!mandate.recurring) return;

  // Load agent; skip if not operable
  const agent = await getAgent(agentId);
  if (!agent) return;
  if (agent.status === "suspended" || agent.status === "orphaned") {
    console.warn(
      `[RecurringScheduler] Agent ${agentId} is ${agent.status} — skipping mandate ${mandateId}`,
    );
    return;
  }

  // Determine destination: first allowedRecipient or skip if none specified
  const destination = mandate.allowedRecipients?.[0];
  if (!destination) {
    console.warn(
      `[RecurringScheduler] Mandate ${mandateId} has no allowedRecipients — cannot determine destination`,
    );
    return;
  }

  const amountMicroUsdc = BigInt(mandate.recurring.amount);

  try {
    // Build unsigned atomic group
    const sandboxExport = await constructAtomicGroup(
      agent.address,
      Number(amountMicroUsdc),
      "algorand",
      destination,
    );

    const txnBlobs = (sandboxExport?.atomicGroup?.transactions ?? []) as string[];

    // Evaluate via mandate engine — same path as /api/execute, no bypass
    const evalResult = await evaluateMandate(agentId, mandateId, txnBlobs);

    if (!evalResult.allowed) {
      emitSecurityEvent({
        type:    "RECURRING_FAILED",
        agentId,
        detail: {
          mandateId,
          reason:   evalResult.code,
          message:  evalResult.message,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Execute settlement pipeline
    const result = await executePipeline(sandboxExport, agentId);

    if (!result.success) {
      emitSecurityEvent({
        type:    "RECURRING_FAILED",
        agentId,
        detail: {
          mandateId,
          reason:      "PIPELINE_FAILED",
          failedStage: result.failedStage,
          error:       result.error,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    emitSecurityEvent({
      type:    "RECURRING_EXECUTED",
      agentId,
      detail: {
        mandateId,
        amountMicroUsdc: mandate.recurring.amount,
        destination,
        txnId:           result.settlement?.txnId ?? "unknown",
      },
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    emitSecurityEvent({
      type:    "RECURRING_FAILED",
      agentId,
      detail: {
        mandateId,
        reason:  "EXCEPTION",
        error:   err instanceof Error ? err.message : String(err),
      },
      timestamp: new Date().toISOString(),
    });
  }
}
