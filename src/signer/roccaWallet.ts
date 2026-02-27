import algosdk from "algosdk";
import { validateAuthToken, type AuthToken } from "../auth/liquidAuth.js";
import { getAgent, assignCohort } from "../services/agentRegistry.js";
import { checkAndRecordOutflow } from "../protection/treasuryOutflowGuard.js";
import { checkRecipients } from "../protection/recipientAnomalyDetector.js";
import { config } from "../config.js";
import { getSignerAdapter } from "./adapters/signerAdapter.js";

/**
 * Rocca Wallet — Environment-Switched Ed25519 Signing Module
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SIGNING BOUNDARY                                               │
 * │                                                                 │
 * │  This is the ONLY module in the entire codebase where private   │
 * │  key material exists.                                           │
 * │                                                                 │
 * │  Mode selection (via ALGO_SIGNER_MNEMONIC env var):             │
 * │                                                                 │
 * │  ┌─ PRODUCTION ──────────────────────────────────────────────┐  │
 * │  │ ALGO_SIGNER_MNEMONIC set → persistent, funded signer.    │  │
 * │  │ Uses algosdk.mnemonicToSecretKey() for server-side        │  │
 * │  │ signing with a known, fundable address.                   │  │
 * │  └──────────────────────────────────────────────────────────┘  │
 * │                                                                 │
 * │  ┌─ DEV ────────────────────────────────────────────────────┐  │
 * │  │ No mnemonic → ephemeral algosdk.generateAccount().       │  │
 * │  │ Generated fresh per process, NEVER persisted.            │  │
 * │  └──────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────────┘
 */

export interface SignedGroupResult {
  /** Array of signed transaction blobs ready for network submission */
  signedTransactions: Uint8Array[];
  /** The Algorand address that signed */
  signerAddress: string;
  /** Number of transactions signed */
  txnCount: number;
  /**
   * Opaque key for the treasury outflow reservation made during signing.
   * Pass to rollbackOutflow() if the broadcast stage fails so the daily
   * cap tracks actual settled volume rather than attempted volume.
   */
  outflowReservationKey?: string;
}

// ── Signing via adapter (HSM-ready) ───────────────────────────────
//
// getSignerAdapter() selects the correct backend at runtime:
//   VAULT_ADDR + VAULT_TOKEN + VAULT_TRANSIT_KEY set → HashiCorp Vault Transit
//   ALGO_SIGNER_MNEMONIC set                        → env-var mnemonic (default)
//   Neither                                         → ephemeral dev account
//
// See src/signer/adapters/ for adapter implementations.

/**
 * Sign an array of unsigned transaction blobs via the active signer adapter.
 *
 * Uses algosdk v3 APIs:
 *   txn.bytesToSign()              — raw bytes to send to external signer / HSM
 *   txn.attachSignature(addr, sig) — attach 64-byte raw signature and encode
 */
async function signBlobs(
  unsignedBlobs: Uint8Array[],
): Promise<{ signedBlobs: Uint8Array[]; signerAddr: string }> {
  const adapter = getSignerAdapter();
  const signerAddr = await adapter.getPublicAddress();
  const signedBlobs: Uint8Array[] = [];

  for (const blob of unsignedBlobs) {
    const txn = algosdk.decodeUnsignedTransaction(blob);
    const bytesToSign = txn.bytesToSign();
    const rawSig = await adapter.signRawBytes(bytesToSign);
    const signedTxn = txn.attachSignature(signerAddr, rawSig);
    signedBlobs.push(signedTxn);
  }

  return { signedBlobs, signerAddr };
}

/**
 * Sign an atomic group of unsigned transaction blobs via Rocca Wallet.
 *
 * Pre-conditions:
 *   1. authToken must be a valid, non-expired Liquid Auth credential
 *   2. unsignedBlobs must be algosdk.encodeUnsignedTransaction() output
 *   3. All blobs must share the same group ID (atomic binding)
 *   4. agentId must match a registered agent in the registry
 *
 * Post-conditions:
 *   1. Returns signed blobs in the same order as input
 *   2. All blobs signed by the cohort signer key for the agent's cohort
 *   3. Ready for submission via algod.sendRawTransaction()
 *
 * @param unsignedBlobs - Array of raw unsigned transaction bytes
 * @param authToken     - Verified Liquid Auth credential
 * @param agentId       - Registered agent identifier (used for cohort routing)
 * @returns SignedGroupResult with signed blobs ready for broadcast
 */
export async function signAtomicGroup(
  unsignedBlobs: Uint8Array[],
  authToken: AuthToken,
  agentId: string,
): Promise<SignedGroupResult> {

  // ── Gate 0: Emergency halt check ──────────────────────────────
  // Checked before any signing — if the system is halted (e.g. during
  // a signer rotation or security incident), refuse all signing requests.
  const haltRecord = await import("../services/agentRegistry.js")
    .then((m) => m.isHalted());
  if (haltRecord) {
    throw new Error(`RoccaWallet: Signing halted — ${haltRecord.reason} (region=${haltRecord.region})`);
  }

  // ── Gate 1: Validate Liquid Auth token ────────────────────────
  await validateAuthToken(authToken);
  console.log(`[RoccaWallet] Auth token verified for agent: ${authToken.agentId}`);

  // ── Gate 2: Cohort routing ─────────────────────────────────────
  // Look up the agent in the registry to confirm it's registered and
  // determine which cohort signer key controls its account.
  // Phase 1: single cohort "A" → uses ALGO_SIGNER_MNEMONIC key.
  // Phase 2+: cohortIndex = sha256(agentId) % totalCohorts → separate key per cohort.
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`RoccaWallet: Agent not registered: ${agentId}`);
  }

  const cohort = assignCohort(agentId);
  console.log(`[RoccaWallet] Agent ${agentId} → cohort ${cohort} | on-chain addr: ${agent.address}`);

  // ── Gate 3: Validate input blobs ──────────────────────────────
  if (!unsignedBlobs.length) {
    throw new Error("RoccaWallet: No transaction blobs provided");
  }

  // ── Gate 4: Verify atomic group integrity before signing ──────
  // Decode all transactions and verify they share a common group ID.
  // While decoding, also accumulate outflow amounts and non-treasury
  // recipients for Gates 5 and 6.
  let expectedGroupId: Uint8Array | undefined;
  let totalMicroAlgo = 0n;
  let totalMicroUsdc = 0n;
  const nonTreasuryRecipients: string[] = [];
  const usdcAssetId = BigInt(config.x402.usdcAssetId);
  const treasuryAddr = config.x402.payToAddress;

  for (let i = 0; i < unsignedBlobs.length; i++) {
    const txn = algosdk.decodeUnsignedTransaction(unsignedBlobs[i]);
    const groupId = txn.group;

    if (!groupId) {
      throw new Error(`RoccaWallet: Transaction [${i}] is missing a group ID — refusing to sign ungrouped transactions`);
    }

    if (!expectedGroupId) {
      expectedGroupId = groupId;
    } else {
      const expected = Buffer.from(expectedGroupId);
      const actual = Buffer.from(groupId);
      if (!expected.equals(actual)) {
        throw new Error(`RoccaWallet: Transaction [${i}] has mismatched group ID — atomic integrity violated`);
      }
    }

    // Accumulate outflow amounts and non-treasury recipients
    if (txn.type === algosdk.TransactionType.pay && txn.payment) {
      totalMicroAlgo += txn.payment.amount;
      const receiver = txn.payment.receiver.toString();
      if (receiver !== treasuryAddr) nonTreasuryRecipients.push(receiver);
    } else if (txn.type === algosdk.TransactionType.axfer && txn.assetTransfer) {
      if (txn.assetTransfer.assetIndex === usdcAssetId && txn.assetTransfer.amount > 0n) {
        totalMicroUsdc += txn.assetTransfer.amount;
      }
      const receiver = txn.assetTransfer.receiver.toString();
      if (receiver !== treasuryAddr) nonTreasuryRecipients.push(receiver);
    }
  }

  console.log(`[RoccaWallet] Group integrity verified: ${unsignedBlobs.length} txns, groupId=${Buffer.from(expectedGroupId!).toString("base64").slice(0, 12)}...`);

  // ── Gate 5: Global daily treasury outflow cap ──────────────────
  // Blocks signing if cumulative ALGO or USDC signed today exceeds
  // the configured daily ceiling. Auto-halts the system on breach.
  const outflowResult = await checkAndRecordOutflow(totalMicroAlgo, totalMicroUsdc);
  if (!outflowResult.allowed) {
    if (outflowResult.serviceUnavailable) {
      throw new Error(`RoccaWallet: Treasury outflow guard unavailable — Redis is down and spend exceeds fail-closed threshold`);
    }
    throw new Error(
      `RoccaWallet: Global daily signing cap exceeded — ` +
      `ALGO: ${outflowResult.todayAlgo}/${outflowResult.capAlgo} microALGO, ` +
      `USDC: ${outflowResult.todayUsdc}/${outflowResult.capUsdc} microUSDC. ` +
      `Signing halted. Admin override required.`,
    );
  }

  // ── Gate 6: Recipient anomaly detection ────────────────────────
  // Flags non-treasury recipients that are new, high-value, or match
  // a scattershot drain pattern. Best-effort: never blocks signing.
  if (nonTreasuryRecipients.length > 0) {
    checkRecipients(nonTreasuryRecipients, totalMicroAlgo, totalMicroUsdc, agentId).catch(
      (err) => console.error("[RoccaWallet] Recipient anomaly check error:", err instanceof Error ? err.message : err),
    );
  }

  // ── Sign via adapter (env mnemonic, Vault Transit, or future HSM) ─
  const { signedBlobs, signerAddr } = await signBlobs(unsignedBlobs);

  console.log(`[RoccaWallet] Atomic group signed by: ${signerAddr}`);

  return {
    signedTransactions: signedBlobs,
    signerAddress: signerAddr,
    txnCount: signedBlobs.length,
    outflowReservationKey: outflowResult.reservationKey,
  };
}
