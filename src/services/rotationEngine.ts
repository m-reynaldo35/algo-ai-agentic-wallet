import algosdk from "algosdk";
import {
  getAgent,
  updateAgentRecord,
  storeRotationBatch,
  getRotationBatch,
  markAgentRotationDone,
  markAgentRotationFailed,
  getRotationDoneSet,
  acquireRotationLock,
  releaseRotationLock,
  getActiveRotation,
  isHalted,
  setHalt,
  listAgentsByCohort,
  type AgentRecord,
  type RotationBatch,
} from "./agentRegistry.js";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import crypto from "crypto";

/**
 * Rotation Engine — Crash-Safe Cohort Signer Rotation
 *
 * Lifecycle:
 *   1. startRotation()   → creates batch, acquires lock, processes all agents
 *   2. resumeRotation()  → resumes a crashed batch, skips already-done agents
 *   3. rollbackRotation() → re-keys done agents back to old signer
 *
 * Safety properties:
 *   - Idempotent: checks on-chain auth-addr before submitting each rekey txn
 *   - Crash-safe: checkpoints after every sub-batch to Redis
 *   - Distributed lock: prevents concurrent rotations on the same cohort
 *   - Halt-aware: checks x402:halt before each sub-batch
 *   - Adversarial: verifies on-chain state after every confirmation
 *   - Confirmation depth: waits N additional rounds after txn inclusion
 *   - Auto-halt: triggers emergency halt if failure rate > 10% in a sub-batch
 */

// ── Types ─────────────────────────────────────────────────────────

export interface RotationParams {
  cohort: string;
  fromMnemonic: string;     // current (old) signer — signs the rekey txns
  toMnemonic: string;       // new signer — becomes the new auth-addr
  batchSize?: number;       // agents per concurrent sub-batch (default 50)
  minConfirmDepth?: number; // extra rounds to wait after inclusion (default 4)
  dryRun?: boolean;         // simulate without broadcasting
}

interface RekeySubmission {
  agent: AgentRecord;
  txnId: string;
}

interface RekeyOutcome {
  agentId: string;
  success: boolean;
  txnId?: string;
  confirmedRound?: bigint;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE     = 50;
const DEFAULT_CONFIRM_DEPTH  = 4;
const MAX_FAILURE_RATE       = 0.10;  // auto-halt if >10% of a sub-batch fails
const MIN_SIGNER_ALGO        = 500_000; // 0.5 ALGO minimum on new signer before starting

// ── Public: Start a new rotation ─────────────────────────────────

export async function startRotation(params: RotationParams): Promise<string> {
  const {
    cohort,
    fromMnemonic,
    toMnemonic,
    batchSize       = DEFAULT_BATCH_SIZE,
    minConfirmDepth = DEFAULT_CONFIRM_DEPTH,
    dryRun          = false,
  } = params;

  const fromAccount = algosdk.mnemonicToSecretKey(fromMnemonic);
  const toAccount   = algosdk.mnemonicToSecretKey(toMnemonic);
  const fromAddr    = fromAccount.addr.toString();
  const toAddr      = toAccount.addr.toString();

  if (fromAddr === toAddr) {
    throw new Error("fromMnemonic and toMnemonic resolve to the same address — rotation is a no-op");
  }

  // Pre-flight: system halt check
  const haltRecord = await isHalted();
  if (haltRecord) {
    throw new Error(`System is halted: "${haltRecord.reason}". Run clear-halt before starting rotation.`);
  }

  // Pre-flight: new signer balance check
  const algod = getAlgodClient();
  if (!dryRun) {
    const toInfo = await algod.accountInformation(toAddr).do();
    const toBalance = Number(toInfo.amount ?? 0);
    const estimatedFees = batchSize * 2 * 1000; // 2× minimum fee per sub-batch, conservative
    if (toBalance < Math.max(MIN_SIGNER_ALGO, estimatedFees)) {
      throw new Error(
        `New signer ${toAddr} has ${toBalance} microALGO — insufficient. ` +
        `Need at least ${Math.max(MIN_SIGNER_ALGO, estimatedFees)} microALGO.`,
      );
    }
  }

  // Load agents for cohort
  console.log(`[RotationEngine] Loading cohort ${cohort} agents...`);
  const allAgents = await listAgentsByCohort(cohort);
  const eligible  = allAgents.filter((a) => a.status !== "suspended");

  if (eligible.length === 0) {
    throw new Error(`No eligible agents found in cohort ${cohort}`);
  }

  console.log(
    `[RotationEngine] ${eligible.length}/${allAgents.length} eligible ` +
    `(${allAgents.length - eligible.length} suspended)`,
  );

  // Create batch record
  const batchId = `rot-${cohort.toLowerCase()}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const batch: RotationBatch = {
    batchId,
    cohort,
    fromAuthAddr:   fromAddr,
    toAuthAddr:     toAddr,
    totalAgents:    eligible.length,
    processedCount: 0,
    confirmedCount: 0,
    failedCount:    0,
    status:         "pending",
    batchSize,
    minConfirmDepth,
    dryRun,
    startedAt:  new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };

  await storeRotationBatch(batch);

  // Acquire distributed lock (skip for dry run)
  if (!dryRun) {
    const locked = await acquireRotationLock(batchId);
    if (!locked) {
      const active = await getActiveRotation();
      throw new Error(
        `Rotation already running: ${active}. Resume it or wait for completion.`,
      );
    }
  }

  console.log(`[RotationEngine] ══════════════════════════════════════`);
  console.log(`[RotationEngine] Batch:    ${batchId}`);
  console.log(`[RotationEngine] Cohort:   ${cohort}`);
  console.log(`[RotationEngine] Agents:   ${eligible.length}`);
  console.log(`[RotationEngine] From:     ${fromAddr}`);
  console.log(`[RotationEngine] To:       ${toAddr}`);
  console.log(`[RotationEngine] DryRun:   ${dryRun}`);
  console.log(`[RotationEngine] ══════════════════════════════════════`);

  try {
    await runRotation(batchId, eligible, fromAccount, toAccount, algod, batch);
  } finally {
    if (!dryRun) {
      await releaseRotationLock(batchId);
    }
  }

  return batchId;
}

// ── Public: Resume a crashed rotation ────────────────────────────

export async function resumeRotation(
  batchId: string,
  fromMnemonic: string,
  toMnemonic: string,
): Promise<void> {
  const batch = await getRotationBatch(batchId);
  if (!batch)              throw new Error(`Rotation batch not found: ${batchId}`);
  if (batch.status === "completed") throw new Error(`Batch ${batchId} already completed`);

  const fromAccount = algosdk.mnemonicToSecretKey(fromMnemonic);
  const toAccount   = algosdk.mnemonicToSecretKey(toMnemonic);

  if (fromAccount.addr.toString() !== batch.fromAuthAddr) {
    throw new Error("fromMnemonic address does not match batch.fromAuthAddr — wrong key");
  }
  if (toAccount.addr.toString() !== batch.toAuthAddr) {
    throw new Error("toMnemonic address does not match batch.toAuthAddr — wrong key");
  }

  const haltRecord = await isHalted();
  if (haltRecord) {
    throw new Error(`System is halted: "${haltRecord.reason}". Clear halt before resuming.`);
  }

  // Load remaining agents (skip already done)
  const allAgents = await listAgentsByCohort(batch.cohort);
  const doneSet   = new Set(await getRotationDoneSet(batchId));
  const remaining = allAgents.filter(
    (a) => !doneSet.has(a.agentId) && a.status !== "suspended",
  );

  console.log(
    `[RotationEngine] Resuming ${batchId}: ` +
    `${remaining.length} remaining, ${doneSet.size} already done`,
  );

  if (remaining.length === 0) {
    console.log("[RotationEngine] Nothing remaining — marking batch completed");
    batch.status       = "completed";
    batch.completedAt  = new Date().toISOString();
    batch.updatedAt    = new Date().toISOString();
    await storeRotationBatch(batch);
    return;
  }

  if (!batch.dryRun) {
    const locked = await acquireRotationLock(batchId);
    if (!locked) {
      const active = await getActiveRotation();
      if (active !== batchId) {
        throw new Error(`Another rotation is running: ${active}`);
      }
      // Already own the lock — refresh TTL by releasing and re-acquiring
    }
  }

  const algod = getAlgodClient();
  try {
    await runRotation(batchId, remaining, fromAccount, toAccount, algod, batch);
  } finally {
    if (!batch.dryRun) {
      await releaseRotationLock(batchId);
    }
  }
}

// ── Public: Rollback — re-key rotated agents back to old signer ───
//
// "Rollback" on a blockchain means a forward transaction, not a revert.
// We re-key agents that reached "done" back to the original signer.
// Requires the NEW signer key (it is now the auth-addr of those agents).

export async function rollbackRotation(
  batchId: string,
  newMnemonic: string,  // the "to" mnemonic from the original batch
): Promise<void> {
  const batch = await getRotationBatch(batchId);
  if (!batch) throw new Error(`Rotation batch not found: ${batchId}`);

  const newAccount = algosdk.mnemonicToSecretKey(newMnemonic);
  if (newAccount.addr.toString() !== batch.toAuthAddr) {
    throw new Error("newMnemonic does not match batch.toAuthAddr — wrong key for rollback");
  }

  const oldAddr = batch.fromAuthAddr;
  const doneIds = await getRotationDoneSet(batchId);

  if (doneIds.length === 0) {
    console.log("[RotationEngine] Rollback: no agents were successfully rotated — nothing to undo");
    return;
  }

  console.log(
    `[RotationEngine] Rollback ${batchId}: re-keying ${doneIds.length} agents → ${oldAddr}`,
  );

  const algod = getAlgodClient();
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < doneIds.length; i += batch.batchSize) {
    const slice   = doneIds.slice(i, i + batch.batchSize);
    const agents  = (
      await Promise.all(slice.map((id) => getAgent(id)))
    ).filter((a): a is AgentRecord => a !== null);

    const submissions = await Promise.allSettled(
      agents.map((agent) =>
        rekeyOneAgent(agent, newAccount, oldAddr, algod, `rollback-${batchId}`, false),
      ),
    );

    const pending: RekeySubmission[] = [];

    for (let j = 0; j < submissions.length; j++) {
      const s = submissions[j];
      if (s.status === "fulfilled" && s.value.txnId) {
        pending.push({ agent: agents[j], txnId: s.value.txnId });
      } else {
        console.error(`[RotationEngine] Rollback submit failed: ${agents[j].agentId}`);
        failed++;
      }
    }

    const confs = await Promise.allSettled(
      pending.map(({ agent, txnId }) =>
        waitWithDepth(algod, txnId, batch.minConfirmDepth).then(() => agent),
      ),
    );

    for (const conf of confs) {
      if (conf.status === "fulfilled") {
        const agent = conf.value;
        await updateAgentRecord({
          ...agent,
          authAddr:     oldAddr,
          prevAuthAddr: agent.authAddr,
          status:       "active",
          rotationBatchId: undefined,
        });
        ok++;
      } else {
        failed++;
        console.error(`[RotationEngine] Rollback confirmation failed: ${conf.reason}`);
      }
    }

    await sleep(500);
  }

  console.log(`[RotationEngine] Rollback complete: ${ok} ok, ${failed} failed`);

  if (failed > 0) {
    console.error(
      `[RotationEngine] ${failed} agents remain on new signer — ` +
      "run rollback again or investigate individually",
    );
  }
}

// ── Internal: core rotation loop ─────────────────────────────────

async function runRotation(
  batchId: string,
  agents: AgentRecord[],
  fromAccount: algosdk.Account,
  toAccount: algosdk.Account,
  algod: algosdk.Algodv2,
  batch: RotationBatch,
): Promise<void> {
  const toAddr = toAccount.addr.toString();

  // Split into sub-batches
  const subBatches: AgentRecord[][] = [];
  for (let i = 0; i < agents.length; i += batch.batchSize) {
    subBatches.push(agents.slice(i, i + batch.batchSize));
  }

  batch.status    = "running";
  batch.updatedAt = new Date().toISOString();
  await storeRotationBatch(batch);

  console.log(
    `[RotationEngine] ${subBatches.length} sub-batches × ${batch.batchSize} agents`,
  );

  for (let i = 0; i < subBatches.length; i++) {
    // ── Halt check before every sub-batch ─────────────────────
    const halt = await isHalted();
    if (halt) {
      batch.status     = "halted";
      batch.haltReason = `External halt at sub-batch ${i + 1}/${subBatches.length}: ${halt.reason} (region=${halt.region})`;
      batch.updatedAt  = new Date().toISOString();
      await storeRotationBatch(batch);
      console.error(`[RotationEngine] HALTED: ${halt.reason} (region=${halt.region}, setAt=${halt.setAt})`);
      return;
    }

    const sub = subBatches[i];
    console.log(
      `[RotationEngine] Sub-batch ${i + 1}/${subBatches.length} ` +
      `(${sub.length} agents, ${batch.confirmedCount}/${batch.totalAgents} done)`,
    );

    const outcomes = await processSubBatch(
      batchId, sub, fromAccount, toAddr, algod, batch.minConfirmDepth, batch.dryRun,
    );

    const succeeded = outcomes.filter((o) => o.success).length;
    const failed    = outcomes.filter((o) => !o.success).length;

    batch.processedCount += sub.length;
    batch.confirmedCount += succeeded;
    batch.failedCount    += failed;
    batch.updatedAt       = new Date().toISOString();

    for (const o of outcomes.filter((o) => !o.success)) {
      console.error(`[RotationEngine]   FAILED ${o.agentId}: ${o.error}`);
    }

    // Checkpoint to Redis
    await storeRotationBatch(batch);

    console.log(
      `[RotationEngine]   Sub-batch ${i + 1} done: ${succeeded} ok, ${failed} failed`,
    );

    // Auto-halt on high failure rate
    if (!batch.dryRun && failed > 0) {
      const failRate = failed / sub.length;
      if (failRate > MAX_FAILURE_RATE) {
        const reason =
          `Auto-halt: failure rate ${(failRate * 100).toFixed(1)}% > ` +
          `${MAX_FAILURE_RATE * 100}% in sub-batch ${i + 1}`;
        batch.status     = "halted";
        batch.haltReason = reason;
        batch.updatedAt  = new Date().toISOString();
        await storeRotationBatch(batch);
        await setHalt(reason);
        console.error(`[RotationEngine] ${reason}`);
        return;
      }
    }

    // Throttle between sub-batches — Algorand free-tier Algod rate limit
    if (i < subBatches.length - 1 && !batch.dryRun) {
      await sleep(1000);
    }
  }

  // Final verification sweep
  if (!batch.dryRun) {
    await finalVerificationSweep(batch.cohort, toAddr, algod);
  }

  batch.status      = "completed";
  batch.completedAt = new Date().toISOString();
  batch.updatedAt   = new Date().toISOString();
  await storeRotationBatch(batch);

  console.log(`[RotationEngine] ══════════════════════════════════════`);
  console.log(`[RotationEngine] COMPLETED ${batchId}`);
  console.log(`[RotationEngine]   Total:     ${batch.totalAgents}`);
  console.log(`[RotationEngine]   Confirmed: ${batch.confirmedCount}`);
  console.log(`[RotationEngine]   Failed:    ${batch.failedCount}`);
  console.log(`[RotationEngine] ══════════════════════════════════════`);
}

// ── Internal: process one sub-batch ──────────────────────────────

async function processSubBatch(
  batchId: string,
  agents: AgentRecord[],
  fromAccount: algosdk.Account,
  toAddr: string,
  algod: algosdk.Algodv2,
  minConfirmDepth: number,
  dryRun: boolean,
): Promise<RekeyOutcome[]> {
  const outcomes: RekeyOutcome[] = [];

  // Submit all rekey txns in parallel
  const submissions = await Promise.allSettled(
    agents.map((agent) =>
      rekeyOneAgent(agent, fromAccount, toAddr, algod, batchId, dryRun),
    ),
  );

  const pending: RekeySubmission[] = [];

  for (let i = 0; i < submissions.length; i++) {
    const agent = agents[i];
    const s     = submissions[i];

    if (s.status === "rejected") {
      const error = String(s.reason);
      outcomes.push({ agentId: agent.agentId, success: false, error });
      await markAgentRotationFailed(batchId, agent.agentId);
      continue;
    }

    if (s.value.alreadyDone) {
      // Idempotent — was already rekeyed to target on-chain
      outcomes.push({ agentId: agent.agentId, success: true });
      await markAgentRotationDone(batchId, agent.agentId);
      continue;
    }

    if (s.value.error) {
      outcomes.push({ agentId: agent.agentId, success: false, error: s.value.error });
      await markAgentRotationFailed(batchId, agent.agentId);
      continue;
    }

    if (dryRun) {
      outcomes.push({ agentId: agent.agentId, success: true });
      continue;
    }

    pending.push({ agent, txnId: s.value.txnId! });
  }

  if (!pending.length) return outcomes;

  // Wait for all confirmations + depth in parallel
  const confirmations = await Promise.allSettled(
    pending.map(({ txnId }) => waitWithDepth(algod, txnId, minConfirmDepth)),
  );

  for (let i = 0; i < pending.length; i++) {
    const { agent, txnId } = pending[i];
    const conf = confirmations[i];

    if (conf.status === "rejected") {
      const error = `Confirmation failed: ${conf.reason}`;
      outcomes.push({ agentId: agent.agentId, success: false, txnId, error });
      await markAgentRotationFailed(batchId, agent.agentId);
      continue;
    }

    const confirmedRound = conf.value;

    // Adversarial verification: read on-chain auth-addr after confirmation
    try {
      const accountInfo   = await algod.accountInformation(agent.address).do();
      const onChainAuth   = accountInfo.authAddr?.toString() ?? null;

      if (onChainAuth !== toAddr) {
        throw new Error(
          `auth-addr mismatch after confirmation: expected ${toAddr}, got ${onChainAuth}`,
        );
      }

      // Update registry — prevAuthAddr retained for rollback window
      await updateAgentRecord({
        ...agent,
        authAddr:        toAddr,
        prevAuthAddr:    agent.authAddr,
        status:          agent.status === "rotating" ? "active" : agent.status,
        rotationBatchId: undefined,
      });

      await markAgentRotationDone(batchId, agent.agentId);
      outcomes.push({ agentId: agent.agentId, success: true, txnId, confirmedRound });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({ agentId: agent.agentId, success: false, txnId, error });
      await markAgentRotationFailed(batchId, agent.agentId);
    }
  }

  return outcomes;
}

// ── Internal: rekey one agent ─────────────────────────────────────

async function rekeyOneAgent(
  agent: AgentRecord,
  fromAccount: algosdk.Account,
  toAddr: string,
  algod: algosdk.Algodv2,
  batchId: string,
  dryRun: boolean,
): Promise<{ txnId?: string; error?: string; alreadyDone?: boolean }> {
  // Idempotency: read current on-chain auth-addr first
  const accountInfo    = await algod.accountInformation(agent.address).do();
  const currentAuthAddr = accountInfo.authAddr?.toString() ?? null;

  if (currentAuthAddr === toAddr) {
    // Already rekeyed to target — fix registry if stale
    if (agent.authAddr !== toAddr) {
      await updateAgentRecord({
        ...agent,
        authAddr:        toAddr,
        prevAuthAddr:    agent.authAddr,
        rotationBatchId: undefined,
      });
    }
    return { alreadyDone: true };
  }

  if (currentAuthAddr !== fromAccount.addr.toString()) {
    return {
      error:
        `Unexpected auth-addr on-chain: ${currentAuthAddr ?? "(none)"}. ` +
        `Expected old signer ${fromAccount.addr}. ` +
        `Agent may have been rekeyed out-of-band — investigate before proceeding.`,
    };
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would rekey ${agent.address} → authAddr ${toAddr}`);
    return {};
  }

  // Mark agent as rotating in registry
  await updateAgentRecord({
    ...agent,
    status:          "rotating",
    rotationBatchId: batchId,
    prevAuthAddr:    agent.authAddr,
  });

  // Build rekey txn — sender = agent address, rekeyTo = new signer
  // Must be signed by fromAccount (current auth-addr)
  const params = await getSuggestedParams();
  const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          agent.address,
    receiver:        agent.address,
    amount:          0n,
    suggestedParams: params,
    rekeyTo:         algosdk.Address.fromString(toAddr),
    note:            new Uint8Array(
      Buffer.from(`x402:rotation:${batchId}:${agent.agentId}`),
    ),
  });

  const signed      = rekeyTxn.signTxn(fromAccount.sk);
  const { txid }    = await algod.sendRawTransaction(signed).do();

  return { txnId: txid };
}

// ── Internal: confirmation + depth wait ──────────────────────────

async function waitWithDepth(
  algod: algosdk.Algodv2,
  txnId: string,
  depth: number,
): Promise<bigint> {
  // waitForConfirmation: waits up to `waitRounds` rounds for inclusion
  const result         = await algosdk.waitForConfirmation(algod, txnId, 8);
  const confirmedRound = BigInt(result.confirmedRound ?? 0);

  if (depth <= 1) return confirmedRound;

  // Wait for additional rounds to reach the target depth
  const target = confirmedRound + BigInt(depth - 1);
  let status   = await algod.status().do();

  while (BigInt(status.lastRound) < target) {
    status = await algod.statusAfterBlock(Number(status.lastRound)).do();
  }

  return confirmedRound;
}

// ── Internal: final verification sweep ───────────────────────────

async function finalVerificationSweep(
  cohort: string,
  expectedAuthAddr: string,
  algod: algosdk.Algodv2,
): Promise<void> {
  console.log("[RotationEngine] Running final verification sweep...");

  const agents  = await listAgentsByCohort(cohort);
  const active  = agents.filter((a) => a.status !== "suspended");
  let driftCount = 0;

  for (const agent of active) {
    const info          = await algod.accountInformation(agent.address).do();
    const onChainAuth   = info.authAddr?.toString() ?? null;

    if (onChainAuth !== expectedAuthAddr) {
      console.warn(
        `[RotationEngine]   DRIFT: ${agent.agentId} (${agent.address}) ` +
        `has auth-addr ${onChainAuth ?? "(none)"}, expected ${expectedAuthAddr}`,
      );
      driftCount++;
    }

    // Small delay to avoid overwhelming Algod on large cohorts
    await sleep(50);
  }

  if (driftCount > 0) {
    console.warn(
      `[RotationEngine] Final sweep: ${driftCount} agents with drift detected. ` +
      "Run scripts/verify-registry.ts to record drift and remediate.",
    );
  } else {
    console.log(
      `[RotationEngine] Final sweep: all ${active.length} agents verified ✓`,
    );
  }
}

// ── Utility ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
