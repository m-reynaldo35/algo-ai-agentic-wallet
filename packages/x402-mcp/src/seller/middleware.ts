/**
 * x402express — Express middleware for x402 Algorand payment gating
 *
 * Adds a USDC micropayment requirement to any Express route.
 * Compatible with any buyer using @algo-wallet/x402-client.
 *
 * Usage:
 *
 *   import { x402express } from "@algo-wallet/x402-mcp/seller";
 *
 *   app.post("/api/weather",
 *     x402express({ price: 10_000, payTo: "YOUR_ALGORAND_ADDRESS" }),
 *     (req, res) => {
 *       const { txId, senderAddr } = req.x402Payment!;
 *       res.json({ weather: "sunny", paidBy: senderAddr, txId });
 *     },
 *   );
 *
 * Flow:
 *   1. No X-PAYMENT header  → 402 with payment terms (x402-v1 JSON)
 *   2. Valid X-PAYMENT       → verifies + submits, calls next()
 *   3. Invalid X-PAYMENT     → 402 with error detail
 *
 * Payment info is attached to req.x402Payment for downstream handlers.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyAndSubmit } from "./verifier.js";

// ── Options ─────────────────────────────────────────────────────

export interface X402MiddlewareOptions {
  /** Price in micro-USDC (1 USDC = 1,000,000 µUSDC). e.g. 10_000 = $0.01 */
  price: number;
  /** Your Algorand wallet address — receives the USDC payment */
  payTo: string;
  /** Algorand network. Default: "mainnet" */
  network?: "mainnet" | "testnet";
  /** Override Algod endpoint. Default: Nodely public node */
  algodUrl?: string;
  /** Tool name shown in the 402 response (helps buyers identify the service) */
  name?: string;
  /** Description shown in the 402 response */
  description?: string;
}

// ── 402 pay+json builder ─────────────────────────────────────────

function buildPayJson(
  opts: X402MiddlewareOptions,
  endpoint: string,
  error?: string,
): Record<string, unknown> {
  const chain   = opts.network ?? "mainnet";
  const assetId = chain === "mainnet" ? 31_566_704 : 10_458_941;
  const expires = new Date(Date.now() + 5 * 60 * 1_000).toISOString();

  return {
    version: "x402-v1",
    status:  402,
    network: { protocol: "algorand", chain },
    payment: {
      asset:  { type: "ASA", id: assetId, symbol: "USDC", decimals: 6 },
      amount: String(opts.price),
      payTo:  opts.payTo,
    },
    expires,
    memo: `x402:${endpoint}:${Date.now()}`,
    ...(opts.name        ? { name: opts.name }               : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(error            ? { error }                         : {}),
  };
}

// ── Middleware factory ───────────────────────────────────────────

/**
 * Returns an Express RequestHandler that requires a valid x402 USDC payment.
 * Mount it before your route handler; on success it calls next().
 */
export function x402express(opts: X402MiddlewareOptions): RequestHandler {
  const algodUrl = opts.algodUrl ?? (
    (opts.network ?? "mainnet") === "mainnet"
      ? "https://mainnet-api.4160.nodely.dev"
      : "https://testnet-api.4160.nodely.dev"
  );

  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const xPayment = req.headers["x-payment"] as string | undefined;

    // ── No payment header → return 402 terms ──────────────────────
    if (!xPayment) {
      res
        .status(402)
        .contentType("application/pay+json")
        .json(buildPayJson(opts, req.path));
      return;
    }

    // ── Verify + submit ────────────────────────────────────────────
    const result = await verifyAndSubmit(xPayment, {
      payTo:    opts.payTo,
      price:    opts.price,
      algodUrl,
    });

    if (!result.ok) {
      res
        .status(402)
        .contentType("application/pay+json")
        .json(buildPayJson(opts, req.path, result.error));
      return;
    }

    // Attach payment metadata for downstream handlers
    (req as X402Request).x402Payment = {
      txId:            result.txId,
      senderAddr:      result.senderAddr,
      amountMicroUsdc: result.amountMicroUsdc,
    };

    next();
  };
}

// ── Express Request augmentation ─────────────────────────────────

export interface X402PaymentInfo {
  /** Algorand transaction ID (broadcast, not yet confirmed) */
  txId?:            string;
  /** Payer's Algorand address */
  senderAddr?:      string;
  /** Actual payment amount in µUSDC */
  amountMicroUsdc?: bigint;
}

export type X402Request = Request & { x402Payment?: X402PaymentInfo };

declare global {
  namespace Express {
    interface Request {
      /** Populated by x402express() middleware on successful payment */
      x402Payment?: X402PaymentInfo;
    }
  }
}
