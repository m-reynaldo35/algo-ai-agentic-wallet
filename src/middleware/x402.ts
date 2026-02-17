import type { Request, Response, NextFunction } from "express";
import algosdk from "algosdk";
import { config } from "../config.js";
import { enforceReplayProtection } from "./replayGuard.js";

/**
 * x402 Payment Required middleware — Phase 2: Cryptographic Enforcement.
 *
 * Parses the `X-PAYMENT` header as a JSON payload containing:
 *   - groupId:      Base64 atomic group ID
 *   - transactions: Base64[] of signed transaction bytes
 *   - senderAddr:   Algorand address of the payer
 *   - signature:    Base64 ed25519 signature over the groupId by senderAddr
 *
 * Verification steps:
 *   1. Header presence check
 *   2. JSON structure validation
 *   3. Ed25519 signature verification against the sender's public key
 *   4. Group ID integrity check (all txns share the claimed groupId)
 *
 * On failure → HTTP 402 with `application/pay+json` body per x402 standard.
 */

// ── x402 Payment Proof Schema ──────────────────────────────────
interface X402PaymentProof {
  groupId: string;
  transactions: string[];
  senderAddr: string;
  signature: string;
  /** Unix epoch seconds — enforced within 60s time bound */
  timestamp?: number;
  /** Number Used Once — prevents signature replay */
  nonce?: string;
}

// ── application/pay+json response schema ────────────────────────
interface PayJsonResponse {
  version: "x402-v1";
  status: 402;
  network: {
    protocol: "algorand";
    chain: string;
  };
  payment: {
    asset: {
      type: "ASA";
      id: number;
      symbol: string;
      decimals: number;
    };
    amount: string;
    payTo: string;
  };
  expires: string;
  memo: string;
  error?: string;
}

function buildPayJson(endpoint: string, error?: string): PayJsonResponse {
  const expiry = new Date(Date.now() + 5 * 60 * 1000); // 5-minute window
  return {
    version: "x402-v1",
    status: 402,
    network: {
      protocol: "algorand",
      chain: config.algorand.network,
    },
    payment: {
      asset: {
        type: "ASA",
        id: config.x402.usdcAssetId,
        symbol: "USDC",
        decimals: 6,
      },
      amount: config.x402.priceMicroUsdc.toString(),
      payTo: config.x402.payToAddress,
    },
    expires: expiry.toISOString(),
    memo: `x402:${endpoint}:${Date.now()}`,
    ...(error ? { error } : {}),
  };
}

function reject402(res: Response, endpoint: string, reason: string): void {
  res.status(402).contentType("application/pay+json").json(buildPayJson(endpoint, reason));
}

/**
 * Parse and structurally validate the X-PAYMENT header JSON.
 */
function parsePaymentHeader(raw: string): X402PaymentProof | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    if (
      typeof decoded.groupId === "string" &&
      Array.isArray(decoded.transactions) &&
      decoded.transactions.every((t: unknown) => typeof t === "string") &&
      typeof decoded.senderAddr === "string" &&
      typeof decoded.signature === "string"
    ) {
      return decoded as X402PaymentProof;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify ed25519 signature: the sender signed the groupId bytes
 * with the private key corresponding to their Algorand address.
 */
function verifySignature(proof: X402PaymentProof): boolean {
  try {
    const message = Buffer.from(proof.groupId, "base64");
    const signature = new Uint8Array(Buffer.from(proof.signature, "base64"));

    // algosdk v3: verifyBytes accepts address string directly
    return algosdk.verifyBytes(message, signature, proof.senderAddr);
  } catch {
    return false;
  }
}

/**
 * Verify that every signed transaction in the group references the claimed groupId.
 */
function verifyGroupIntegrity(proof: X402PaymentProof): boolean {
  try {
    const claimedGroupId = Buffer.from(proof.groupId, "base64");

    for (const txnB64 of proof.transactions) {
      const txnBytes = new Uint8Array(Buffer.from(txnB64, "base64"));
      // Decode the signed transaction to inspect the inner txn's group field
      const decoded = algosdk.decodeSignedTransaction(txnBytes);
      const txnGroupId = decoded.txn.group;
      if (!txnGroupId) return false;

      const groupBytes = Buffer.from(txnGroupId);
      if (!groupBytes.equals(claimedGroupId)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Middleware ──────────────────────────────────────────────────
export async function x402Paywall(req: Request, res: Response, next: NextFunction): Promise<void> {
  const paymentHeader = req.header("X-PAYMENT");

  // Step 1: Header presence
  if (!paymentHeader) {
    reject402(res, req.path, "Missing X-PAYMENT header. Submit a signed Algorand atomic group proof.");
    return;
  }

  // Step 2: Structural validation
  const proof = parsePaymentHeader(paymentHeader);
  if (!proof) {
    reject402(res, req.path, "Malformed X-PAYMENT payload. Expected Base64-encoded JSON with {groupId, transactions, senderAddr, signature}.");
    return;
  }

  // Step 3: Ed25519 signature verification
  if (!verifySignature(proof)) {
    reject402(res, req.path, "Invalid signature. The groupId must be signed by the sender's ed25519 key.");
    return;
  }

  // Step 4: Atomic group integrity
  if (!verifyGroupIntegrity(proof)) {
    reject402(res, req.path, "Group integrity failure. Transaction group IDs do not match the claimed groupId.");
    return;
  }

  // Step 5: Replay attack prevention — time bound + nonce uniqueness (Redis-backed)
  const replayCheck = await enforceReplayProtection(proof.timestamp, proof.nonce);
  if (!replayCheck.valid) {
    res.status(401).json({
      error: `Unauthorized: Signature Replay Detected`,
      detail: replayCheck.error,
    });
    return;
  }

  // Attach verified proof to request
  req.x402 = {
    paymentProof: paymentHeader,
    verified: true,
    senderAddr: proof.senderAddr,
    groupId: proof.groupId,
  };

  next();
}

// ── Express Request augmentation ────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      x402?: {
        paymentProof: string;
        verified: boolean;
        senderAddr?: string;
        groupId?: string;
      };
    }
  }
}
