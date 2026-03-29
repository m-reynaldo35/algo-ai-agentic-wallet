import algosdk from "algosdk";
import crypto from "crypto";
import type { PayJson } from "./types.js";
import { X402ErrorCode } from "./types.js";

/**
 * x402 Interceptor — On-Chain Mandate Payment Handshake
 *
 * Wraps any HTTP request to an x402-gated endpoint. If the server
 * bounces with 402 Payment Required, the interceptor:
 *   1. Parses the pay+json terms
 *   2. Builds a MandateContract.pay() application call transaction
 *   3. Signs it with the agent's own Ed25519 key
 *   4. Retries the original request with the signed txn in X-PAYMENT
 *
 * Under this architecture:
 *   - The agent holds its own private key (non-custodial)
 *   - Mandate gates (velocity, caps, whitelist) are enforced by the AVM
 *   - The server decodes, verifies provenance, and submits — does not sign
 *   - Replay protection is provided by Algorand transaction validity windows
 *
 * The caller never sees the 402 — it's fully absorbed.
 */

// ── ARC-4 helpers ───────────────────────────────────────────────

/** ARC-4 method selector for MandateContract.pay(address,uint64)void */
const PAY_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("pay(address,uint64)void").getSelector(),
);

// ── Typed Error Class ───────────────────────────────────────────

export class X402Error extends Error {
  readonly code: X402ErrorCode;

  constructor(message: string, code: X402ErrorCode = X402ErrorCode.UNKNOWN) {
    super(message);
    this.name = "X402Error";
    this.code = code;
  }

  /** Returns true if the error is a mandate gate breach (AVM rejected) */
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
 *
 * @param mandateAppId - The MandateContract application ID for this agent.
 *                       Obtained when the agent's contract was deployed via MandateFactory.
 * @param maxRetries   - Number of times to retry transient failures (default 2)
 */
export async function requestWithPayment(
  url: string,
  init: RequestInit,
  privateKey: Uint8Array,
  senderAddress: string,
  mandateAppId: number,
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
          "402 offer has expired before payment could be built",
          X402ErrorCode.OFFER_EXPIRED,
        );
      }

      // ── Build and sign MandateContract.pay() call ────────────
      const signedTxnBase64 = await buildMandatePayCall(
        payJson,
        privateKey,
        senderAddress,
        mandateAppId,
      );

      // ── Retry original request with signed transaction ────────
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("X-PAYMENT", signedTxnBase64);

      const retryResponse = await fetch(url, { ...init, headers: retryHeaders });

      // Classify 402 responses on the retry as mandate rejections (AVM gate fired)
      if (retryResponse.status === 402) {
        let detail = "Mandate contract rejected payment";
        try {
          const body = await retryResponse.clone().json() as { error?: string };
          if (body.error) detail = body.error;
        } catch { /* ignore parse errors */ }
        throw new X402Error(detail, X402ErrorCode.POLICY_BREACH);
      }

      return retryResponse;

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

// ── Mandate Pay Call Builder ────────────────────────────────────

/**
 * Build and sign a MandateContract.pay(treasury, amount) application call.
 *
 * The signed transaction bytes are returned as base64. The server decodes
 * the transaction, verifies the method selector and toll parameters, checks
 * factory provenance, then submits. The AVM enforces all mandate gates
 * (velocity windows, per-tx cap, daily cap, recipient whitelist) at execution.
 *
 * X-PAYMENT = base64(msgpack(SignedTransaction))
 */
async function buildMandatePayCall(
  payJson: PayJson,
  privateKey: Uint8Array,
  senderAddress: string,
  mandateAppId: number,
): Promise<string> {
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

  // ARC-4 encoding:
  //   arg[0] = method selector (4 bytes)
  //   arg[1] = recipient address (32 raw bytes — decoded from base32 Algorand address)
  //   arg[2] = amount in micro-USDC (uint64 big-endian 8 bytes)
  const treasuryBytes = algosdk.decodeAddress(payJson.payment.payTo).publicKey;
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64BE(BigInt(payJson.payment.amount));

  // AVM fires 2 inner asset transfers — budget outer + 2 inner txn fees.
  // In algosdk v3, flatFee and fee are properties on suggestedParams.
  //
  // Tighten the validity window to 15 rounds (~53s). Algorand's default is
  // ~1000 rounds (~3500s) which would be a wide replay window. 15 rounds
  // matches the old nonce-guard expiry and limits the replay surface to
  // the settlement latency + reasonable clock skew.
  const sp = {
    ...suggestedParams,
    fee:       3_000n,
    flatFee:   true,
    lastValid: BigInt(suggestedParams.firstValid) + 15n,
  };

  // MandateContract.pay() fires inner asset transfers — the outer txn must
  // declare the USDC ASA so the AVM can resolve it in the inner transactions.
  const usdcAsaId = payJson.network.chain === "mainnet" ? 31_566_704 : 10_458_941;

  // The AVM reads treasury from contract global state ("tr") and sets it as
  // AssetReceiver in the inner axfer. That account must be declared in the
  // outer txn's accounts array or the AVM will reject with "unavailable Account".
  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender:          senderAddress,
    appIndex:        mandateAppId,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [PAY_SELECTOR, treasuryBytes, amountBuf],
    accounts:        [payJson.payment.payTo],
    foreignAssets:   [usdcAsaId],
    suggestedParams: sp,
  });

  // Agent signs the application call with their own key.
  // This is a standard Algorand transaction — not a phantom groupId signature.
  const signedTxn = txn.signTxn(privateKey);

  return Buffer.from(signedTxn).toString("base64");
}

// ── Gas Status Helpers ─────────────────────────────────────────

export type AgentGasStatus = "ok" | "low" | "critical";

export interface AgentGasInfo {
  /** "ok" | "low" | "critical" — from X-Agent-Gas-Status header */
  status: AgentGasStatus;
  /** Estimated remaining fee transactions — from X-Agent-Gas-Remaining header */
  remaining: number;
  /** MandateContract application ID — from X-Agent-Contract-Id header */
  contractId?: number;
}

/**
 * Parse gas advisory headers from a successful payment response.
 * Returns null if the server did not include gas headers (e.g. on error paths).
 */
export function parseGasInfo(response: Response): AgentGasInfo | null {
  const status     = response.headers.get("X-Agent-Gas-Status") as AgentGasStatus | null;
  const remaining  = response.headers.get("X-Agent-Gas-Remaining");
  const contractId = response.headers.get("X-Agent-Contract-Id");
  if (!status) return null;
  return {
    status,
    remaining:  remaining  !== null ? parseInt(remaining, 10)  : 0,
    contractId: contractId !== null ? parseInt(contractId, 10) : undefined,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function resolveAlgodUrl(chain: string): string {
  const override = typeof process !== "undefined" && process.env?.ALGO_CLIENT_NODE_URL;
  if (override) return override;
  switch (chain) {
    case "mainnet":
      return "https://mainnet-api.4160.nodely.dev";
    case "testnet":
      return "https://testnet-api.4160.nodely.dev";
    default:
      return "https://testnet-api.4160.nodely.dev";
  }
}

// Re-export for consumers that reference the old phantom proof type.
// The X402PaymentProof shape is no longer sent by this interceptor but
// kept for reference and any external tooling that parses it.
export type { X402PaymentProof } from "./types.js";
