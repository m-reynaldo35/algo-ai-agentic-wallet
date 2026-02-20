import algosdk from "algosdk";
import crypto from "crypto";
import type { PayJson, X402PaymentProof } from "./types.js";
import { X402ErrorCode } from "./types.js";

/**
 * x402 Interceptor — Automatic Payment Handshake with Retry
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

// ── Typed Error Class ───────────────────────────────────────────

export class X402Error extends Error {
  readonly code: X402ErrorCode;

  constructor(message: string, code: X402ErrorCode = X402ErrorCode.UNKNOWN) {
    super(message);
    this.name = "X402Error";
    this.code = code;
  }

  /** Returns true if the error is a TEAL policy breach (agent overspend) */
  isPolicyBreach(): boolean {
    return this.code === X402ErrorCode.POLICY_BREACH;
  }

  /** Returns true if the error is likely transient (retry may succeed) */
  isRetryable(): boolean {
    return (
      this.code === X402ErrorCode.NETWORK_ERROR ||
      this.code === X402ErrorCode.UNKNOWN
    );
  }
}

// ── Core Interceptor ───────────────────────────────────────────

/**
 * Make an HTTP request, transparently absorbing any 402 challenge.
 * @param maxRetries - Number of times to retry transient failures (default 2)
 */
export async function requestWithPayment(
  url: string,
  init: RequestInit,
  privateKey: Uint8Array,
  senderAddress: string,
  maxRetries = 2,
): Promise<Response> {
  let lastError: X402Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1000ms, ...
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }

    try {
      const firstResponse = await fetch(url, init);

      if (firstResponse.status !== 402) {
        return firstResponse;
      }

      // ── Parse 402 terms ──────────────────────────────────────
      let payJson: PayJson;
      try {
        payJson = await firstResponse.json() as PayJson;
      } catch {
        throw new X402Error("Failed to parse 402 pay+json body", X402ErrorCode.UNKNOWN);
      }

      if (payJson.version !== "x402-v1") {
        throw new X402Error(
          `Unsupported x402 version: ${payJson.version}`,
          X402ErrorCode.UNSUPPORTED_VERSION,
        );
      }

      if (new Date(payJson.expires).getTime() < Date.now()) {
        throw new X402Error(
          "402 offer has expired before proof could be built",
          X402ErrorCode.OFFER_EXPIRED,
        );
      }

      // ── Build atomic toll proof ──────────────────────────────
      const proof = await buildPaymentProof(payJson, privateKey, senderAddress);

      // ── Retry original request with proof ────────────────────
      const headerValue = Buffer.from(JSON.stringify(proof)).toString("base64");
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("X-PAYMENT", headerValue);

      return fetch(url, { ...init, headers: retryHeaders });

    } catch (err) {
      if (err instanceof X402Error) {
        // Non-retryable errors bail immediately
        if (!err.isRetryable()) throw err;
        lastError = err;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new X402Error(msg, X402ErrorCode.NETWORK_ERROR);
      }
    }
  }

  throw lastError ?? new X402Error("Max retries exceeded", X402ErrorCode.NETWORK_ERROR);
}

// ── Proof Builder ──────────────────────────────────────────────

async function buildPaymentProof(
  payJson: PayJson,
  privateKey: Uint8Array,
  senderAddress: string,
): Promise<X402PaymentProof> {
  const algodUrl = resolveAlgodUrl(payJson.network.chain);

  let suggestedParams: algosdk.SuggestedParams;
  try {
    const algod = new algosdk.Algodv2("", algodUrl, "");
    suggestedParams = await algod.getTransactionParams().do();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new X402Error(
      `Failed to fetch Algorand params from ${algodUrl}: ${msg}`,
      X402ErrorCode.NETWORK_ERROR,
    );
  }

  const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: senderAddress,
    receiver: payJson.payment.payTo,
    amount: BigInt(payJson.payment.amount),
    assetIndex: BigInt(payJson.payment.asset.id),
    suggestedParams,
    note: new Uint8Array(Buffer.from(payJson.memo)),
  });

  const txns = [tollTxn];
  algosdk.assignGroupID(txns);

  const groupIdBytes = txns[0].group!;
  const groupId = Buffer.from(groupIdBytes).toString("base64");
  const signedTxn = tollTxn.signTxn(privateKey);
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
