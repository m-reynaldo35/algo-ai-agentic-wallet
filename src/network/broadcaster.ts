import algosdk from "algosdk";
import { config } from "../config.js";

/**
 * Network Broadcaster — Algorand Atomic Group Submission
 *
 * Submits a fully-signed atomic group to the Algorand network and
 * waits for block confirmation (sub-3s finality).
 *
 * The broadcaster is the final stage in the pipeline:
 *   VibeKit Sandbox (unsigned) → Rocca Wallet (signed) → Broadcaster (on-chain)
 */

export interface SettlementResult {
  /** Whether the settlement was confirmed on-chain */
  confirmed: boolean;
  /** The confirmed round (block number) */
  confirmedRound: number;
  /** Transaction ID of the first transaction in the group */
  txnId: string;
  /** Group ID (base64) */
  groupId: string;
  /** Number of transactions in the group */
  txnCount: number;
  /** ISO timestamp of confirmation */
  settledAt: string;
}

const CONFIRMATION_ROUNDS = 4;

function getAlgodClient(): algosdk.Algodv2 {
  return new algosdk.Algodv2(
    config.algorand.nodeToken,
    config.algorand.nodeUrl,
  );
}

/**
 * Submit a signed atomic group to the Algorand network and wait
 * for on-chain confirmation.
 *
 * @param signedGroup - Array of signed transaction blobs (output of Rocca signAtomicGroup)
 * @returns SettlementResult with confirmed round and txn ID
 * @throws Error if submission or confirmation fails
 */
export async function executeSettlement(
  signedGroup: Uint8Array[],
): Promise<SettlementResult> {
  if (!signedGroup.length) {
    throw new Error("Broadcaster: No signed transactions to submit");
  }

  const client = getAlgodClient();

  console.log(`[Broadcaster] Submitting atomic group: ${signedGroup.length} txns`);

  // ── Concatenate signed blobs for group submission ─────────────
  // Algorand requires atomic groups to be submitted as a single
  // concatenated byte array via sendRawTransaction.
  const totalLength = signedGroup.reduce((sum, blob) => sum + blob.length, 0);
  const concatenated = new Uint8Array(totalLength);
  let offset = 0;
  for (const blob of signedGroup) {
    concatenated.set(blob, offset);
    offset += blob.length;
  }

  // ── Submit to network ─────────────────────────────────────────
  const { txid } = await client.sendRawTransaction(concatenated).do();
  console.log(`[Broadcaster] Submitted — txId: ${txid}`);

  // ── Wait for confirmation ─────────────────────────────────────
  // Algorand's sub-3s finality means this typically resolves in
  // a single block. We wait up to CONFIRMATION_ROUNDS for safety.
  console.log(`[Broadcaster] Awaiting confirmation (up to ${CONFIRMATION_ROUNDS} rounds)...`);
  const confirmation = await algosdk.waitForConfirmation(client, txid, CONFIRMATION_ROUNDS);

  const confirmedRound = Number(confirmation.confirmedRound ?? 0);
  console.log(`[Broadcaster] Confirmed in round ${confirmedRound}`);

  // ── Extract group ID from the first signed transaction ────────
  const firstDecoded = algosdk.decodeSignedTransaction(signedGroup[0]);
  const groupId = firstDecoded.txn.group
    ? Buffer.from(firstDecoded.txn.group).toString("base64")
    : "unknown";

  return {
    confirmed: true,
    confirmedRound,
    txnId: txid,
    groupId,
    txnCount: signedGroup.length,
    settledAt: new Date().toISOString(),
  };
}
