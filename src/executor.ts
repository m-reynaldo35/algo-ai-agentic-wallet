import { validateSandboxExport } from "./middleware/validation.js";
import { authenticateAgentIdentity } from "./auth/liquidAuth.js";
import { signAtomicGroup } from "./signer/roccaWallet.js";
import { executeSettlement, type SettlementResult } from "./network/broadcaster.js";
import { logSettlementSuccess, logExecutionFailure, type OracleContext } from "./services/audit.js";
import { config } from "./config.js";
import type { SandboxExport } from "./services/transaction.js";
import { Sentry } from "./lib/sentry.js";

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
  /** Whether the full pipeline completed successfully */
  success: boolean;
  /** Which stage failed, if any */
  failedStage?: "validation" | "auth" | "sign" | "broadcast";
  /** Error message if failed */
  error?: string;
  /** The agent that executed this pipeline */
  agentId: string;
  /** The sandbox that produced the unsigned group */
  sandboxId: string;
  /** Settlement details (only present on success) */
  settlement?: SettlementResult;
}

/**
 * Execute the full settlement pipeline:
 *   1.   Validate sandbox export (toll, signer, group integrity)
 *   2.   Authenticate agent via Liquid Auth (FIDO2)
 *   3.   Sign atomic group via Rocca Wallet (seedless Ed25519)
 *   4.   Broadcast signed group to Algorand network
 *
 * @param sandboxExport - Sealed envelope from the VibeKit sandbox
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
  // Gora oracle price bounds, and oracle data freshness.
  console.log(`\n[Executor] Stage 1/4: Validating sandbox export...`);
  let oracleContext: OracleContext | undefined;
  try {
    const validationResult = await validateSandboxExport(sandboxExport);
    oracleContext = validationResult.oracleContext;

    if (oracleContext) {
      console.log(`[Executor]   Oracle: ${oracleContext.assetPair} @ ${oracleContext.goraConsensusPrice} (δ=${oracleContext.slippageDelta}bips)`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown validation error";
    console.error(`[Executor] ABORT at Stage 1 (validation): ${error}`);
    logExecutionFailure(agentId, "validation", error, oracleContext);
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
    logExecutionFailure(agentId, "auth", error, oracleContext);
    return {
      success: false,
      failedStage: "auth",
      error,
      agentId,
      sandboxId,
    };
  }

  // ── Stage 3: Rocca Wallet — Seedless Signing ──────────────────
  console.log(`[Executor] Stage 3/4: Signing atomic group via Rocca Wallet...`);
  let signedGroup;
  try {
    const unsignedBlobs = atomicGroup.transactions.map(
      (b64) => new Uint8Array(Buffer.from(b64, "base64")),
    );

    signedGroup = await signAtomicGroup(unsignedBlobs, authToken);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown signing error";
    console.error(`[Executor] ABORT at Stage 3 (sign): ${error}`);
    logExecutionFailure(agentId, "sign", error, oracleContext);
    return {
      success: false,
      failedStage: "sign",
      error,
      agentId,
      sandboxId,
    };
  }

  // ── Stage 4: Broadcaster — On-Chain Settlement ────────────────
  // The broadcast stage is where TEAL LogicSig policy breaches
  // surface. When an agent's delegated Smart Signature rejects a
  // transaction (fee too high, wrong type, amount exceeds cap),
  // the Algod node returns "logic eval failed" or "rejected by logic".
  // We trap these specifically and classify them as POLICY_BREACH.
  console.log(`[Executor] Stage 4/4: Broadcasting to ${routing.network}...`);
  let settlement;
  try {
    settlement = await executeSettlement(signedGroup.signedTransactions);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown broadcast error";
    const errorLower = error.toLowerCase();
    const isPolicyBreach = errorLower.includes("logic eval failed") || errorLower.includes("rejected by logic");

    if (isPolicyBreach) {
      console.error(`[Executor] TEAL POLICY BREACH at Stage 4 (broadcast): ${error}`);
      console.error(`[Executor]   Agent ${agentId} exceeded LogicSig spending bounds.`);
      console.error(`[Executor]   The AVM rejected the transaction at Layer 1 consensus.`);
    } else {
      console.error(`[Executor] ABORT at Stage 4 (broadcast): ${error}`);
    }

    Sentry.setTag("blockchain_consensus", "rejected");
    logExecutionFailure(agentId, "broadcast", error, oracleContext);
    return {
      success: false,
      failedStage: "broadcast",
      error: isPolicyBreach
        ? `POLICY_BREACH: ${error}`
        : error,
      agentId,
      sandboxId,
    };
  }

  // ── Success ───────────────────────────────────────────────────
  console.log(`\n[Executor] ═══════════════════════════════════════════`);
  console.log(`[Executor] SETTLEMENT CONFIRMED`);
  console.log(`[Executor]   TxnID:  ${settlement.txnId}`);
  console.log(`[Executor]   Round:  ${settlement.confirmedRound}`);
  console.log(`[Executor]   Group:  ${settlement.groupId}`);
  console.log(`[Executor] ═══════════════════════════════════════════\n`);

  logSettlementSuccess(
    settlement.txnId,
    agentId,
    config.x402.priceMicroUsdc,
    settlement.groupId,
    oracleContext,
  );

  return {
    success: true,
    agentId,
    sandboxId,
    settlement,
  };
}
