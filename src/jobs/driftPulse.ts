/**
 * Drift Pulse — Continuous Registry/Chain Reconciliation
 *
 * Every 60 seconds, samples 5% of agents (minimum 1) and compares each
 * agent's registry authAddr against the current on-chain auth-addr returned
 * by algod accountInformation.
 *
 * On mismatch:
 *   1. Emits a DRIFT_DETECTED security event (stdout + Redis ring buffer)
 *   2. Updates the agent status to "orphaned" (blocks signing immediately)
 *   3. Stores a DriftRecord for portal visibility
 *
 * For agents already in "orphaned" or "suspended" status, the drift check is
 * skipped — those agents are already excluded from the signing pipeline.
 *
 * For user-custody agents (custody === "user"), we cannot assert what the
 * auth-addr should be (the user controls it), so they are skipped.
 *
 * The pulse is asymmetric by design: it can detect compromise (auth-addr
 * changed without a recorded custody transition) but does not automatically
 * heal — human review is required before unsuspending an orphaned agent.
 */

import { listAgents, updateAgentStatus, storeDrift, setHalt, type AgentRecord } from "../services/agentRegistry.js";
import { getAlgodClient } from "../network/nodely.js";
import { emitSecurityEvent } from "../services/securityAudit.js";
import { getRedis } from "../services/redis.js";
import { config } from "../config.js";

// ── Policy ─────────────────────────────────────────────────────────

const PULSE_INTERVAL_MS  = 60_000;    // 60-second heartbeat
const SAMPLE_PERCENT     = 5;         // 5% of agent registry per pulse
const MIN_SAMPLE         = 1;         // always check at least 1 agent

// ── Drift anomaly kill-switch policy ───────────────────────────────
//
// If DRIFT_HALT_THRESHOLD or more agents drift within DRIFT_WINDOW_S,
// the system treats this as a systemic compromise rather than isolated
// account issues. The global halt flag is set immediately, freezing all
// autonomous signing until a human operator clears it.
//
// Default: 3 drifted agents in 600s (10 minutes) → global halt.
// Override via env vars to tune for fleet size.
//
// Redis key: x402:drift:anomaly-count   INCR counter, TTL = DRIFT_WINDOW_S

const DRIFT_HALT_THRESHOLD = parseInt(
  process.env.DRIFT_HALT_THRESHOLD ?? "3", 10,
);
const DRIFT_WINDOW_S = parseInt(
  process.env.DRIFT_WINDOW_S ?? "600", 10,  // 10-minute window
);
const DRIFT_ANOMALY_KEY = "x402:drift:anomaly-count";

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start the drift detection pulse.
 *
 * Returns the interval handle so the caller can clear it cleanly on shutdown.
 * First pulse runs after one full interval (not immediately at boot) to give
 * the registry reconciliation (rekeySync) time to complete.
 */
export function startDriftPulse(): ReturnType<typeof setInterval> {
  console.log(
    `[DriftPulse] Starting — 5% agent sample every ${PULSE_INTERVAL_MS / 1000}s`,
  );

  return setInterval(async () => {
    try {
      await runDriftPulse();
    } catch (err) {
      // Never let the pulse crash — it runs forever
      console.error(
        "[DriftPulse] Pulse error:",
        err instanceof Error ? err.message : err,
      );
    }
  }, PULSE_INTERVAL_MS);
}

// ── Core logic ─────────────────────────────────────────────────────

async function runDriftPulse(): Promise<void> {
  const agents = await listAgents(10_000, 0);
  if (agents.length === 0) return;

  // Random sample — at least MIN_SAMPLE, at most 5% of total
  const sampleSize = Math.max(MIN_SAMPLE, Math.floor(agents.length * SAMPLE_PERCENT / 100));

  // Fisher–Yates shuffle (in-place on a copy) then take the front slice
  const pool = [...agents];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, sampleSize);

  // Check sequentially — avoids algod rate limiting from bursting
  for (const agent of sample) {
    await checkAgentDrift(agent);
  }
}

async function checkAgentDrift(agent: AgentRecord): Promise<void> {
  // Skip agents that are already quarantined or user-controlled
  if (agent.status === "orphaned" || agent.status === "suspended") return;
  if ((agent.custody ?? "rocca") === "user") return;

  let onChainAuthAddr: string | null;
  try {
    const accountInfo = await getAlgodClient().accountInformation(agent.address).do();
    onChainAuthAddr   = accountInfo.authAddr?.toString() ?? null;
  } catch (err) {
    // Network error — do not mark as drifted; log and continue
    console.warn(
      `[DriftPulse] Cannot query ${agent.address} (${agent.agentId}):`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  // For Rocca-custody agents: on-chain authAddr must match registry authAddr
  const expectedAuthAddr = agent.authAddr;

  if (onChainAuthAddr === expectedAuthAddr) return; // no drift

  // ── Drift detected ──────────────────────────────────────────────
  console.error(
    `[DriftPulse] DRIFT DETECTED — agent=${agent.agentId} ` +
    `expected=${expectedAuthAddr} on-chain=${onChainAuthAddr ?? "unset"}`,
  );

  emitSecurityEvent({
    type:    "DRIFT_DETECTED",
    agentId: agent.agentId,
    detail: {
      agentAddress:    agent.address,
      expectedAuthAddr,
      onChainAuthAddr,
      previousStatus:  agent.status,
      custodyVersion:  agent.custodyVersion ?? 0,
    },
    timestamp: new Date().toISOString(),
  });

  // Pause the agent immediately — blocks signing in Step 8 of the signing service
  try {
    await updateAgentStatus(agent.agentId, "orphaned");
  } catch (updateErr) {
    console.error(
      `[DriftPulse] Failed to orphan agent ${agent.agentId}:`,
      updateErr instanceof Error ? updateErr.message : updateErr,
    );
  }

  // ── Drift anomaly kill switch ────────────────────────────────────
  // Track drift events in a sliding window. If DRIFT_HALT_THRESHOLD or
  // more agents drift within DRIFT_WINDOW_S, this is a systemic attack —
  // freeze all autonomous signing immediately.
  await checkDriftAnomaly(agent.agentId);

  // Store a drift record for portal visibility and recovery workflow (below)
  try {
    // USDC opt-in status — best-effort, default false if lookup fails
    let usdcOptedIn = false;
    let microAlgoBalance = 0;
    try {
      const info = await getAlgodClient().accountInformation(agent.address).do();
      microAlgoBalance = Number(info.amount ?? 0);
      const usdcAssetId = config.x402.usdcAssetId;
      usdcOptedIn = (info.assets ?? []).some(
        (a: { assetId?: number | bigint }) => Number(a.assetId) === usdcAssetId,
      );
    } catch { /* best-effort */ }

    await storeDrift({
      agentId:         agent.agentId,
      address:         agent.address,
      expectedAuthAddr,
      actualAuthAddr:  onChainAuthAddr,
      usdcOptedIn,
      microAlgoBalance,
      detectedAt:      new Date().toISOString(),
    });
  } catch (driftErr) {
    console.error(
      `[DriftPulse] Failed to store drift record for ${agent.agentId}:`,
      driftErr instanceof Error ? driftErr.message : driftErr,
    );
  }
}

// ── Drift anomaly kill switch ─────────────────────────────────────
//
// Increments a Redis counter each time any agent drifts.
// On first increment, sets TTL = DRIFT_WINDOW_S so the counter auto-expires.
// If the count reaches DRIFT_HALT_THRESHOLD within the window, triggers
// global emergency halt — all autonomous signing stops immediately.
//
// This fires AFTER the individual agent is already orphaned, so even a
// single compromised agent has been blocked before the anomaly check runs.

async function checkDriftAnomaly(triggerAgentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return; // no Redis — anomaly tracking unavailable (warn at boot)

  try {
    // Atomic increment — get back the new count
    const count = (await redis.incr(DRIFT_ANOMALY_KEY)) as number;

    // Set TTL on the first increment only — subsequent INCRs extend no TTL
    // so the window is anchored to the first drift event in this batch.
    if (count === 1) {
      await redis.expire(DRIFT_ANOMALY_KEY, DRIFT_WINDOW_S);
    }

    console.warn(
      `[DriftPulse] Drift anomaly counter: ${count}/${DRIFT_HALT_THRESHOLD} ` +
      `in ${DRIFT_WINDOW_S}s window (trigger=${triggerAgentId})`,
    );

    if (count >= DRIFT_HALT_THRESHOLD) {
      const reason =
        `DRIFT_ANOMALY: ${count} agents drifted within the last ${DRIFT_WINDOW_S}s. ` +
        `Last trigger: ${triggerAgentId}. ` +
        `Systemic compromise suspected — all autonomous signing halted. ` +
        `Run verify-registry and review drift records before unhalting.`;

      emitSecurityEvent({
        type:    "SECURITY_ALERT",
        agentId: triggerAgentId,
        detail: {
          event:             "DRIFT_ANOMALY_HALT",
          driftCount:        count,
          threshold:         DRIFT_HALT_THRESHOLD,
          windowSeconds:     DRIFT_WINDOW_S,
        },
        timestamp: new Date().toISOString(),
      });

      // Set the global emergency halt — blocks signing service immediately
      await setHalt(reason);

      console.error(
        `[DriftPulse] KILL SWITCH ACTIVATED — ${count} drifted agents ` +
        `in ${DRIFT_WINDOW_S}s window exceeds threshold of ${DRIFT_HALT_THRESHOLD}. ` +
        "All autonomous signing halted. Manual admin review required.",
      );
    }
  } catch (err) {
    // Best-effort — never block the drift pulse for anomaly tracking errors
    console.error(
      "[DriftPulse] Anomaly kill-switch check failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
