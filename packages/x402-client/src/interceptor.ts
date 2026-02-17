import algosdk from "algosdk";
import crypto from "crypto";
import type { PayJson, X402PaymentProof } from "./types.js";

/**
 * x402 Interceptor — Automatic Payment Handshake
 *
 * Wraps any HTTP request to an x402-gated endpoint. If the server
 * bounces with 402 Payment Required, the interceptor:
 *   1. Parses the pay+json terms
 *   2. Builds an Algorand atomic group (toll payment)
 *   3. Signs the groupId with the agent's Ed25519 key
 *   4. Retries the original request with the X-PAYMENT proof header
 *
 * The caller never sees the 402 — it's fully absorbed.
 */

// ── Core Interceptor ───────────────────────────────────────────

export async function requestWithPayment(
  url: string,
  init: RequestInit,
  privateKey: Uint8Array,
  senderAddress: string,
): Promise<Response> {
  // First attempt — expect 402 on gated endpoints
  const firstResponse = await fetch(url, init);

  if (firstResponse.status !== 402) {
    return firstResponse;
  }

  // ── Parse 402 terms ────────────────────────────────────────
  const payJson: PayJson = await firstResponse.json();

  if (payJson.version !== "x402-v1") {
    throw new X402Error(`Unsupported x402 version: ${payJson.version}`);
  }

  if (new Date(payJson.expires).getTime() < Date.now()) {
    throw new X402Error("402 offer has expired before proof could be built");
  }

  // ── Build atomic toll group ────────────────────────────────
  const proof = await buildPaymentProof(payJson, privateKey, senderAddress);

  // ── Encode X-PAYMENT header ────────────────────────────────
  const headerValue = Buffer.from(JSON.stringify(proof)).toString("base64");

  // ── Retry with proof ───────────────────────────────────────
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("X-PAYMENT", headerValue);

  return fetch(url, { ...init, headers: retryHeaders });
}

// ── Proof Builder ──────────────────────────────────────────────

async function buildPaymentProof(
  payJson: PayJson,
  privateKey: Uint8Array,
  senderAddress: string,
): Promise<X402PaymentProof> {
  // Fetch suggested params from the network
  const algodUrl = resolveAlgodUrl(payJson.network.chain);
  const algod = new algosdk.Algodv2("", algodUrl, "");
  const suggestedParams = await algod.getTransactionParams().do();

  // Build the x402 toll transaction (ASA transfer → treasury)
  const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: senderAddress,
    receiver: payJson.payment.payTo,
    amount: BigInt(payJson.payment.amount),
    assetIndex: BigInt(payJson.payment.asset.id),
    suggestedParams,
    note: new Uint8Array(Buffer.from(payJson.memo)),
  });

  // Assign atomic group ID (SHA-512/256)
  const txns = [tollTxn];
  algosdk.assignGroupID(txns);

  const groupIdBytes = txns[0].group!;
  const groupId = Buffer.from(groupIdBytes).toString("base64");

  // Sign the transaction
  const signedTxn = tollTxn.signTxn(privateKey);

  // Sign the groupId bytes for the Ed25519 proof
  const signature = algosdk.signBytes(groupIdBytes, privateKey);

  return {
    groupId,
    transactions: [Buffer.from(signedTxn).toString("base64")],
    senderAddr: senderAddress,
    signature: Buffer.from(signature).toString("base64"),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: crypto.randomUUID(),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function resolveAlgodUrl(chain: string): string {
  switch (chain) {
    case "mainnet":
      return "https://mainnet-api.4160.nodely.dev";
    case "testnet":
      return "https://testnet-api.4160.nodely.dev";
    default:
      return "https://testnet-api.4160.nodely.dev";
  }
}

// ── Error Class ────────────────────────────────────────────────

export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402Error";
  }
}
