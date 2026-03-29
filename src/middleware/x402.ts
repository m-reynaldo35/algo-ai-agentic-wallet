import type { Request, Response, NextFunction } from "express";
import algosdk from "algosdk";
import { config } from "../config.js";
import { enforceReplayProtection } from "./replayGuard.js";

/**
 * x402 Payment Required middleware — dual-format support.
 *
 * Supports two X-PAYMENT formats:
 *
 * ── Mandate format (Sprint O, on-chain AVM) ──
 *   X-PAYMENT = base64(msgpack(SignedTransaction))
 *   A real signed MandateContract.pay() application call.
 *   Full verification (method selector, toll, provenance, AVM submission)
 *   is handled downstream by x402Settle.
 *   The paywall only decodes the transaction and extracts senderAddr.
 *
 * ── Legacy format (pre-Sprint O, Rocca custodial agents) ──
 *   X-PAYMENT = base64(JSON({groupId, senderAddr, signature, ...}))
 *   Ed25519 signature over groupId, with optional nonce+timestamp replay guard.
 *   Full verification done here; no x402Settle required.
 *
 * On failure → HTTP 402 with application/pay+json body per x402 standard.
 */

// ── pay+json response schema ──────────────────────────────────────

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

// ── Legacy JSON proof schema ──────────────────────────────────────

interface X402PaymentProof {
  groupId: string;
  transactions?: string[];
  senderAddr: string;
  signature: string;
  timestamp?: number;
  nonce?: string;
}

const ALGO_ADDR_RE = /^[A-Z2-7]{58}$/;

function parsePaymentHeader(raw: string): X402PaymentProof | null {
  if (raw.length > 1_000_000) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    const txns = decoded.transactions;
    const txnsValid = txns === undefined || txns === null || (
      Array.isArray(txns) &&
      txns.length <= 16 &&
      txns.every((t: unknown) => typeof t === "string" && t.length > 0 && t.length < 20_000)
    );
    if (
      typeof decoded.groupId === "string" &&
      decoded.groupId.length >= 32 &&
      decoded.groupId.length <= 128 &&
      txnsValid &&
      typeof decoded.senderAddr === "string" &&
      ALGO_ADDR_RE.test(decoded.senderAddr) &&
      typeof decoded.signature === "string" &&
      decoded.signature.length >= 64 &&
      decoded.signature.length <= 256
    ) {
      return decoded as X402PaymentProof;
    }
    return null;
  } catch {
    return null;
  }
}

function verifySignature(proof: X402PaymentProof): boolean {
  try {
    const message   = Buffer.from(proof.groupId, "base64");
    const signature = new Uint8Array(Buffer.from(proof.signature, "base64"));
    return algosdk.verifyBytes(message, signature, proof.senderAddr);
  } catch {
    return false;
  }
}

function verifyGroupIntegrity(proof: X402PaymentProof): boolean {
  if (!proof.transactions || proof.transactions.length === 0) return true;
  try {
    const claimedGroupId = Buffer.from(proof.groupId, "base64");
    for (const txnB64 of proof.transactions) {
      const txnBytes = new Uint8Array(Buffer.from(txnB64, "base64"));
      const decoded  = algosdk.decodeSignedTransaction(txnBytes);
      const txnGroupId = decoded.txn.group;
      if (!txnGroupId) return false;
      if (!Buffer.from(txnGroupId).equals(claimedGroupId)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Middleware ────────────────────────────────────────────────────

export async function x402Paywall(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const paymentHeader = req.header("X-PAYMENT");

  // ── Header presence ─────────────────────────────────────────────
  if (!paymentHeader) {
    reject402(
      res,
      req.path,
      "Missing X-PAYMENT header. For mandate-architecture agents: include a signed MandateContract.pay() application call.",
    );
    return;
  }

  // ── Try mandate format first ────────────────────────────────────
  // base64(msgpack(SignedTransaction)) — a real signed Algorand app call.
  // If decoding succeeds we extract senderAddr and let x402Settle do the rest.
  try {
    const bytes  = new Uint8Array(Buffer.from(paymentHeader, "base64"));
    const signed = algosdk.decodeSignedTransaction(bytes);

    req.x402 = {
      paymentProof: paymentHeader,
      verified:     false,  // x402Settle performs full verification
      senderAddr:   signed.txn.sender.toString(),
    };
    return next();
  } catch {
    // Not a valid SignedTransaction — fall through to legacy JSON path
  }

  // ── Legacy JSON proof format ────────────────────────────────────
  // base64(JSON({groupId, senderAddr, signature, ...}))
  const proof = parsePaymentHeader(paymentHeader);
  if (!proof) {
    reject402(
      res,
      req.path,
      "Malformed X-PAYMENT. Expected base64(msgpack(SignedTransaction)) for mandate agents, " +
      "or base64(JSON({groupId, senderAddr, signature})) for legacy agents.",
    );
    return;
  }

  if (!verifySignature(proof)) {
    reject402(res, req.path, "Invalid signature. The groupId must be signed by the sender's ed25519 key.");
    return;
  }

  if (!verifyGroupIntegrity(proof)) {
    reject402(res, req.path, "Group integrity failure. Transaction group IDs do not match the claimed groupId.");
    return;
  }

  const replayCheck = await enforceReplayProtection(proof.timestamp, proof.nonce);
  if (!replayCheck.valid) {
    res.status(401).json({
      error:  "Unauthorized: Signature Replay Detected",
      detail: replayCheck.error,
    });
    return;
  }

  req.x402 = {
    paymentProof: paymentHeader,
    verified:     true,
    senderAddr:   proof.senderAddr,
    groupId:      proof.groupId,
  };

  next();
}

// ── Express Request augmentation ─────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      x402?: {
        /** Raw X-PAYMENT header value */
        paymentProof: string;
        /**
         * true  = legacy JSON proof fully verified (ed25519 + replay guard)
         * false = mandate format decoded; full verification in x402Settle
         */
        verified: boolean;
        /** Algorand address of the payer — extracted from proof or txn.sender */
        senderAddr?: string;
        /** groupId from legacy JSON proof — absent for mandate format */
        groupId?: string;
        /** On-chain txId of the confirmed mandate transaction — set by x402Settle */
        settlementJobId?: string;
        /** agentId resolved from senderAddr — set by x402Settle */
        settlementAgentId?: string;
      };
    }
  }
}
