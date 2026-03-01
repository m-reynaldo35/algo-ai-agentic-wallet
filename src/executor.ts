import { validateSandboxExport } from "./middleware/validation.js";
import { authenticateAgentIdentity } from "./auth/liquidAuth.js";
import { signAtomicGroup } from "./signer/roccaWallet.js";
import { callSigningService } from "./signing-service/client.js";
import type { SettlementResult } from "./network/broadcaster.js";
import { logExecutionFailure } from "./services/audit.js";
import { extendReservationTTL } from "./services/executionIdempotency.js";
import type { SandboxExport } from "./services/transaction.js";
import { Sentry } from "./lib/sentry.js";
import { createJob } from "./queue/jobStore.js";
import { enqueueJob } from "./queue/settlementQueue.js";

/**
 * Master Executor — End-to-End Settlement Pipeline
 *
 * Orchestrates the complete flow from sandbox export to on-chain settlement:
 *
 *   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 *   │  SandboxExport│────▶│  Validation  │────▶│  Liquid Auth │────▶│ Rocca Wallet │────▶│  Broadcaster │
 *   │  (unsigned)   │     │  (gatekeeper)│     │  (FIDO2)     │     │  (sign)      │     │  (on-chain)  │
 *   └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
 *
 * Abort semantics: If ANY stage fails, the entire pipeline aborts safely.
 * No partial signing, no partial submission. The atomic group either
 * settles completely or not at all.
 */

export interface ExecutionResult {
  /** Whether the pipeline accepted the request */
  success: boolean;
  /** Which stage failed, if any */
  failedStage?: "validation" | "auth" | "sign" | "broadcast";
  /** Error message if failed */
  error?: string;
  /** The agent that executed this pipeline */
  agentId: string;
  /** The sandbox that produced the unsigned group */
  sandboxId: string;
  /**
   * Present when success=true.
   * queued=true  → async path: settlement is in the worker queue (jobId is set).
   * queued=false → sync path: settlement already confirmed (settlement is set).
   */
  queued?: boolean;
  jobId?: string;
  /** Settlement details — only present on synchronous confirmation */
  settlement?: SettlementResult;
}

/**
 * Execute the full settlement pipeline:
 *   1.   Validate sandbox export (toll, signer, group integrity)
 *   2.   Authenticate agent via Liquid Auth (FIDO2)
 *   3.   Sign atomic group via Rocca Wallet (seedless Ed25519)
 *   4.   Broadcast signed group to Algorand network
 *
 * @param sandboxExport - Sealed envelope from the local sandbox
 * @param agentId       - Unique identifier for the requesting agent
 * @returns ExecutionResult with settlement details or failure info
 */
export async function executePipeline(
  sandboxExport: SandboxExport,
  agentId: string,
): Promise<ExecutionResult> {
  const { sandboxId, atomicGroup, routing, slippage } = sandboxExport;

  console.log(`\n[Executor] ═══════════════════════════════════════════`);
  console.log(`[Executor] Pipeline initiated`);
  console.log(`[Executor]   Agent:    ${agentId}`);
  console.log(`[Executor]   Sandbox:  ${sandboxId}`);
  console.log(`[Executor]   Signer:   ${routing.requiredSigner}`);
  console.log(`[Executor]   Bridge:   algorand → ${routing.bridgeDestination}`);
  console.log(`[Executor]   Txns:     ${atomicGroup.txnCount}`);
  console.log(`[Executor]   Slippage: ${slippage.toleranceBips}bips (min: ${slippage.minAmountOut})`);
  console.log(`[Executor] ═══════════════════════════════════════════\n`);

  for (const line of atomicGroup.manifest) {
    console.log(`[Executor]   ${line}`);
  }

  // ── Stage 1: Validation Gatekeeper ────────────────────────────
  // Runs BEFORE any auth or signing. Decodes the unsigned blobs
  // and mathematically verifies toll amount, receiver, signer,
  // and group integrity.
  console.log(`\n[Executor] Stage 1/4: Validating sandbox export...`);
  try {
    await validateSandboxExport(sandboxExport);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown validation error";
    console.error(`[Executor] ABORT at Stage 1 (validation): ${error}`);
    logExecutionFailure(agentId, "validation", error);
    return {
      success: false,
      failedStage: "validation",
      error,
      agentId,
      sandboxId,
    };
  }

  // ── Stage 2: Liquid Auth — FIDO2 Agent Authentication ─────────
  console.log(`[Executor] Stage 2/4: Authenticating agent via Liquid Auth...`);
  let authToken;
  try {
    authToken = await authenticateAgentIdentity(agentId);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown auth error";
    console.error(`[Executor] ABORT at Stage 2 (auth): ${error}`);
    logExecutionFailure(agentId, "auth", error);
    return {
      success: false,
      failedStage: "auth",
      error,
      agentId,
      sandboxId,
    };
  }

  // ── Stage 3: Sign ─────────────────────────────────────────────
  // PRODUCTION: SIGNING_SERVICE_URL set → call isolated signing microservice
  // DEV:        SIGNING_SERVICE_URL absent → direct call (key in same process)
  const signingMode = process.env.SIGNING_SERVICE_URL ? "microservice" : "direct";
  console.log(`[Executor] Stage 3/4: Signing atomic group (${signingMode})...`);

  // Extend the pending reservation TTL before entering the signing stage.
  // Signing via a remote microservice can take several seconds; without this
  // a slow signer could let the 5-min pending marker expire and open a
  // double-spend window for a concurrent request.
  await extendReservationTTL(sandboxId);

  let signedGroup;
  let outflowReservationKey: string | undefined;
  try {
    const unsignedBlobs = atomicGroup.transactions.map(
      (b64) => new Uint8Array(Buffer.from(b64, "base64")),
    );

    if (process.env.SIGNING_SERVICE_URL) {
      signedGroup = await callSigningService(unsignedBlobs, authToken, agentId);
    } else {
      const result = await signAtomicGroup(unsignedBlobs, authToken, agentId);
      outflowReservationKey = result.outflowReservationKey;
      signedGroup = result;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown signing error";
    console.error(`[Executor] ABORT at Stage 3 (sign): ${error}`);
    logExecutionFailure(agentId, "sign", error);
    return {
      success: false,
      failedStage: "sign",
      error,
      agentId,
      sandboxId,
    };
  }

  // ── Stage 4: Enqueue for async settlement ────────────────────
  // Signed transactions are handed off to the worker queue. The HTTP
  // request returns immediately with a jobId — no blocking on-chain wait.
  // The worker broadcasts, waits for confirmation, and updates the job.
  console.log(`[Executor] Stage 4/4: Enqueueing signed group for async settlement...`);

  try {
    const job = await createJob({
      agentId,
      sandboxId,
      signedTransactions: signedGroup.signedTransactions.map((t) =>
        Buffer.from(t).toString("base64"),
      ),
      outflowReservationKey,
      network: routing.network,
    });

    await enqueueJob(job.jobId);

    console.log(`[Executor] ✓ Queued  jobId=${job.jobId}  agent=${agentId}`);

    return {
      success: true,
      queued:  true,
      jobId:   job.jobId,
      agentId,
      sandboxId,
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : "Queue error";
    console.error(`[Executor] ABORT at Stage 4 (enqueue): ${error}`);
    Sentry.captureException(err);
    logExecutionFailure(agentId, "broadcast", error);
    return {
      success: false,
      failedStage: "broadcast",
      error,
      agentId,
      sandboxId,
    };
  }
}
