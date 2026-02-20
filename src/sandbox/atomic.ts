import algosdk from "algosdk";
import { config } from "../config.js";
import { getAlgodClient } from "../network/nodely.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  UNSIGNED TRANSACTION BLOBS ONLY                                │
 * │                                                                 │
 * │  This module constructs Algorand atomic groups and returns      │
 * │  raw unsigned transaction bytes. Signing is NEVER performed     │
 * │  here. The caller must route these blobs to Rocca Wallet for    │
 * │  FIDO2-authenticated signature via Liquid Auth.                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

export interface TradeParams {
  senderAddress: string;
  receiverAddress: string;
  /** Amount in micro-units of the asset */
  amount: number;
  assetId: number;
}

export interface FeeParams {
  senderAddress: string;
  /** Protocol fee receiver (treasury) */
  feeReceiverAddress: string;
  /** Fee amount in micro-ALGO */
  feeAmount: number;
}

export interface UnsignedAtomicGroup {
  /** Base64-encoded unsigned transaction bytes, one per txn in the group */
  transactions: string[];
  groupId: string;
}

// Algod client centralized via src/network/nodely.ts (Nodely free tier)

/**
 * Construct an atomic group of unsigned Algorand transactions.
 *
 * Group structure:
 *   [0] Asset transfer  — sender pays receiver the trade amount (USDC ASA)
 *   [1] Payment          — sender pays protocol fee in ALGO to treasury
 *
 * Returns raw unsigned blobs. The caller MUST route these to Rocca
 * for FIDO2 signature before submission.
 */
export async function constructAtomicGroup(
  tradeParams: TradeParams,
  feeParams: FeeParams,
): Promise<UnsignedAtomicGroup> {
  const client = getAlgodClient();
  const suggestedParams = await client.getTransactionParams().do();

  // Txn 0: ASA transfer (e.g., USDC payment for the agent action)
  const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: tradeParams.senderAddress,
    receiver: tradeParams.receiverAddress,
    amount: BigInt(tradeParams.amount),
    assetIndex: BigInt(tradeParams.assetId),
    suggestedParams,
  });

  // Txn 1: ALGO fee payment to protocol treasury
  const feePaymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feeParams.senderAddress,
    receiver: feeParams.feeReceiverAddress,
    amount: BigInt(feeParams.feeAmount),
    suggestedParams,
  });

  // Assign group ID — atomically links both transactions
  const group = [assetTransferTxn, feePaymentTxn];
  algosdk.assignGroupID(group);

  const groupId = Buffer.from(group[0].group!).toString("base64");

  // Serialize as unsigned bytes (NOT signed — no private keys here)
  const transactions = group.map((txn) =>
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
  );

  return { transactions, groupId };
}
