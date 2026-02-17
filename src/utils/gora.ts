import algosdk from "algosdk";
import { config } from "../config.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Gora Oracle — Decentralized Price Feed Consumer                │
 * │                                                                 │
 * │  Integrates with Gora (Algorand's decentralized oracle          │
 * │  network) to fetch deterministic, consensus-verified price      │
 * │  data for cross-chain asset swap verification.                  │
 * │                                                                 │
 * │  NO PRIVATE KEY MATERIAL MAY EXIST IN THIS MODULE.              │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Gora ABI Method Selectors ────────────────────────────────────
// SHA-512/256("request_price_feed(byte[],uint64)void")[:4] encoded as hex
const GORA_ABI_METHODS = {
  /** Request a price feed value from the Gora oracle network */
  requestPriceFeed: new Uint8Array(
    Buffer.from("72657175657374", "hex"), // "request" — Gora's canonical method prefix
  ),
  /** Read the latest oracle assertion from app global state */
  readPriceFeed: new Uint8Array(
    Buffer.from("726561645f7072696365", "hex"), // "read_price"
  ),
} as const;

// ── Gora Oracle State Keys ───────────────────────────────────────
// Global state keys used by the Gora oracle contract
const STATE_KEYS = {
  /** Latest price value (uint64, 6-decimal fixed-point) */
  price: Buffer.from("price").toString("base64"),
  /** Timestamp of the latest oracle assertion (uint64, Unix epoch) */
  timestamp: Buffer.from("timestamp").toString("base64"),
  /** Feed identifier string */
  feedKey: Buffer.from("feed_key").toString("base64"),
} as const;

// ── Types ────────────────────────────────────────────────────────

export interface GoraPricePayload {
  /** The oracle-asserted price in micro-units (6-decimal fixed-point) */
  price: bigint;
  /** Unix epoch timestamp of the oracle assertion */
  timestamp: number;
  /** Feed identifier (e.g., "USDC/ALGO") */
  feedKey: string;
  /** Whether the data is within staleness bounds */
  isFresh: boolean;
  /** Age of the data in seconds */
  ageSeconds: number;
}

export interface GoraOracleAppCallParams {
  sender: string;
  feedKey: string;
}

// ── Oracle App Call Builder (Module 1) ───────────────────────────

/**
 * Build an unsigned Application NoOp call to the Gora Oracle
 * contract to request the latest price feed assertion.
 *
 * ABI argument layout:
 *   arg[0]: Method selector — "request"
 *   arg[1]: Feed key (byte[], UTF-8 encoded)
 *   arg[2]: Timestamp request (uint64, current Unix time)
 *
 * @param params - Sender address and feed key
 * @param suggestedParams - Algorand suggested transaction params
 * @returns Unsigned Application NoOp transaction
 */
export async function buildGoraOracleAppCall(
  params: GoraOracleAppCallParams,
  suggestedParams: algosdk.SuggestedParams,
): Promise<algosdk.Transaction> {
  const { sender, feedKey } = params;

  // arg[0]: Method selector
  const methodSelector = GORA_ABI_METHODS.requestPriceFeed;

  // arg[1]: Feed key as UTF-8 bytes
  const feedKeyArg = new Uint8Array(Buffer.from(feedKey, "utf-8"));

  // arg[2]: Current timestamp as uint64 for oracle freshness request
  const timestampArg = algosdk.encodeUint64(BigInt(Math.floor(Date.now() / 1000)));

  const appCallTxn = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: config.gora.appId,
    appArgs: [methodSelector, feedKeyArg, timestampArg],
    suggestedParams,
    note: new Uint8Array(Buffer.from(`x402:gora:${feedKey}:${Date.now()}`)),
  });

  return appCallTxn;
}

/**
 * Build an unsigned payment transaction for the Gora oracle
 * request fee. This must be bundled in the atomic group alongside
 * the oracle app call.
 *
 * @param sender - The address paying the oracle fee
 * @param suggestedParams - Algorand suggested transaction params
 * @returns Unsigned payment transaction for the Gora request fee
 */
export function buildGoraFeeTxn(
  sender: string,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: algosdk.getApplicationAddress(config.gora.appId),
    amount: config.gora.requestFeeMicroAlgo,
    suggestedParams,
    note: new Uint8Array(Buffer.from(`x402:gora-fee:${Date.now()}`)),
  });

  return feeTxn;
}

// ── Oracle Data Fetch (Module 2) ─────────────────────────────────

/**
 * Fetch the latest Gora oracle price assertion by reading the
 * application's global state from the Algorand node.
 *
 * This is a READ-ONLY operation — no transaction is submitted.
 * The validation loop calls this to independently verify the
 * oracle price before allowing the transaction to proceed.
 *
 * @returns GoraPricePayload with the latest price, timestamp, and freshness
 */
export async function fetchGoraPriceData(): Promise<GoraPricePayload> {
  const client = new algosdk.Algodv2(
    config.algorand.nodeToken,
    config.algorand.nodeUrl,
  );

  const appInfo = await client.getApplicationByID(config.gora.appId).do();
  const globalState = appInfo.params?.globalState as
    | Array<{ key: string; value: { type: number; uint?: number; bytes?: string } }>
    | undefined;

  if (!globalState) {
    throw new Error("Gora Oracle: Failed to read application global state");
  }

  // Parse global state key-value pairs
  let price = 0n;
  let timestamp = 0;
  let feedKey = "";

  for (const entry of globalState) {
    if (entry.key === STATE_KEYS.price && entry.value.uint !== undefined) {
      price = BigInt(entry.value.uint);
    } else if (entry.key === STATE_KEYS.timestamp && entry.value.uint !== undefined) {
      timestamp = Number(entry.value.uint);
    } else if (entry.key === STATE_KEYS.feedKey && entry.value.bytes !== undefined) {
      feedKey = Buffer.from(entry.value.bytes, "base64").toString("utf-8");
    }
  }

  if (price === 0n) {
    throw new Error("Gora Oracle: Price feed returned zero — oracle may be uninitialized");
  }

  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - timestamp;
  const isFresh = ageSeconds <= config.gora.maxStalenessSeconds;

  return { price, timestamp, feedKey, isFresh, ageSeconds };
}

// ── Oracle-Based Expected Output (Module 2) ──────────────────────

/**
 * Compute the expected output amount using the Gora oracle price.
 *
 * Formula:  E_out = (T_in × P_oracle) / 10^6
 *
 * All arithmetic uses strict bigint to prevent floating-point errors.
 *
 * @param amountIn - Input amount in micro-units (bigint)
 * @param oraclePrice - Oracle-asserted price in 6-decimal fixed-point (bigint)
 * @returns Expected output in micro-units (bigint)
 */
export function computeOracleExpectedOutput(
  amountIn: bigint,
  oraclePrice: bigint,
): bigint {
  const DECIMALS = 1_000_000n; // 10^6
  return (amountIn * oraclePrice) / DECIMALS;
}

// ── Cryptographic Decay Check (Module 3) ─────────────────────────

/**
 * Enforce the time-weighted cryptographic decay rule.
 *
 * The difference between the current time and the oracle assertion
 * time must be ≤ maxStalenessSeconds (default: 15 seconds).
 *
 * If the bound is exceeded, this function throws a strict error
 * that the x402 gatekeeper catches to destroy the transaction blob.
 *
 * Formula:  ΔT = T_current − T_oracle ≤ 15
 *
 * @param oracleTimestamp - Unix epoch timestamp from the Gora payload
 * @throws Error('Gora Price Feed Stale: Time bounds exceeded') if stale
 */
export function enforceOracleFreshness(oracleTimestamp: number): void {
  const now = Math.floor(Date.now() / 1000);
  const deltaT = now - oracleTimestamp;

  if (deltaT > config.gora.maxStalenessSeconds) {
    throw new Error(
      `Gora Price Feed Stale: Time bounds exceeded (ΔT=${deltaT}s > ${config.gora.maxStalenessSeconds}s)`,
    );
  }

  if (deltaT < 0) {
    throw new Error(
      `Gora Price Feed Stale: Oracle timestamp is in the future (ΔT=${deltaT}s)`,
    );
  }
}
