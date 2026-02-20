import algosdk from "algosdk";
import { config } from "../config.js";
import { getAlgodClient } from "./nodely.js";
import { Sentry } from "../lib/sentry.js";

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

// Algod client centralized via src/network/nodely.ts (Nodely free tier)

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

  // ── Submit + confirm inside a Sentry L1 Finality span ────────
  // Module 1: measures exact ms from broadcast to Algorand round
  // finality. Emits a Protocol Latency Warning if > 4500 ms.
  const { txid, confirmedRound } = await Sentry.startSpan(
    {
      name: "L1 Finality Check",
      op: "algorand.finality",
      attributes: {
        "algorand.network": config.algorand.network,
        "algorand.txn_count": signedGroup.length,
        "algorand.confirmation_rounds": CONFIRMATION_ROUNDS,
      },
    },
    async (span) => {
      const broadcastStart = Date.now();

      const { txid } = await client.sendRawTransaction(concatenated).do();
      console.log(`[Broadcaster] Submitted — txId: ${txid}`);
      span.setAttribute("algorand.txid", txid);

      console.log(`[Broadcaster] Awaiting confirmation (up to ${CONFIRMATION_ROUNDS} rounds)...`);
      const confirmation = await algosdk.waitForConfirmation(client, txid, CONFIRMATION_ROUNDS);

      const finalityMs = Date.now() - broadcastStart;
      const confirmedRound = Number(confirmation.confirmedRound ?? 0);

      span.setAttribute("algorand.finality_ms", finalityMs);
      span.setAttribute("algorand.confirmed_round", confirmedRound);
      span.setAttribute("blockchain_consensus", "finalized");

      console.log(`[Broadcaster] Confirmed in round ${confirmedRound} (${finalityMs}ms)`);

      // Protocol Latency Warning — Algorand's threshold is ~3.3s; 4.5s signals degraded conditions
      if (finalityMs > 4500) {
        Sentry.captureMessage(
          `Protocol Latency Warning: L1 finality took ${finalityMs}ms (threshold: 4500ms)`,
          {
            level: "warning",
            tags: {
              "algorand.txid": txid,
              "algorand.finality_ms": String(finalityMs),
              "algorand.confirmed_round": String(confirmedRound),
              blockchain_consensus: "finalized",
            },
          },
        );
      }

      return { txid, confirmedRound };
    },
  );

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
