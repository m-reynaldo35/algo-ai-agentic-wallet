/**
 * Treasury Funder — Atomic MBR Funding for Agent Onboarding
 *
 * Constructs a two-transaction Algorand atomic group:
 *   tx0: USDC transfer  (payer wallet → treasury address)  [unsigned — returned to client]
 *   tx1: ALGO payment   (treasury    → new agent wallet)   [signed by treasury key]
 *
 * The group is atomic: if the user's USDC tx is absent, the treasury ALGO tx
 * is also rejected by the Algorand network. No DEX, no routing contract,
 * no slippage — direct treasury swap using Algorand's native atomic primitive.
 *
 * Flow:
 *   1. Client calls prepareOnboardingGroup(payerAddress, agentAddress)
 *   2. Server returns: unsigned USDC tx (for payer to sign) + treasury-signed ALGO tx
 *   3. Client signs USDC tx with payer wallet (Pera, Defly, etc.)
 *   4. Client calls submitOnboardingGroup(signedUsdcTxB64, signedAlgoTxB64)
 *   5. Server submits both as an atomic group — agent wallet receives ALGO
 *
 * Pricing:
 *   fee = max($0.25, ceil(0.215 ALGO × spot_price × 1.20))
 *   — 20% margin buffer above spot price
 *   — hard floor of $0.25 regardless of ALGO price
 *
 * Environment variables:
 *   ALGO_TREASURY_MNEMONIC   25-word mnemonic of the treasury wallet (required)
 *   ALGO_PRICE_FLOOR_USDC    Fallback ALGO price if oracle is down (default: "0.20")
 */

import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import { config } from "../config.js";
import { getAlgoPriceUsdc } from "./algoPrice.js";

// ALGO to send to each new agent wallet:
//   0.100 ALGO — base MBR
//   0.100 ALGO — USDC ASA opt-in MBR
//   0.001 ALGO — opt-in transaction fee
//   0.001 ALGO — rekey transaction fee
//   0.013 ALGO — gas buffer (~13 future payment fees)
const FUNDING_ALGO_MICRO = 215_000n; // 0.215 ALGO

// 20% margin on top of spot price to absorb short-term volatility
const MARGIN_MULTIPLIER = 1.20;

// Hard floor: never charge less than $0.25 regardless of ALGO price
const PRICE_FLOOR_MICRO = 250_000; // µUSDC

function getTreasuryAccount(): algosdk.Account {
  const mnemonic = process.env.ALGO_TREASURY_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_TREASURY_MNEMONIC not configured");
  return algosdk.mnemonicToSecretKey(mnemonic);
}

export interface OnboardingQuote {
  /** USDC cost of the MBR funding, in micro-USDC */
  feeMicroUsdc: number;
  /** ALGO amount the treasury will send to the agent, in µALGO */
  fundingMicroAlgo: number;
  /** ISO timestamp when this quote expires (90 seconds) */
  expiresAt: string;
  /** Treasury address — the USDC payment destination */
  treasuryAddress: string;
  /** Live ALGO spot price used to compute the fee */
  algoPriceUsdc: number;
}

export interface PreparedOnboarding {
  /** Base64-encoded unsigned USDC transfer tx — payer must sign this */
  unsignedUsdcTxB64: string;
  /** Base64-encoded treasury-signed ALGO funding tx — ready to submit */
  signedAlgoTxB64: string;
  /** Shared group ID for verification (base64) */
  groupIdB64: string;
  /** Quote details for display / confirmation UI */
  quote: OnboardingQuote;
}

export async function getOnboardingQuote(): Promise<OnboardingQuote> {
  const treasury   = getTreasuryAccount();
  const algoPrice  = await getAlgoPriceUsdc();
  const algoAmount = Number(FUNDING_ALGO_MICRO) / 1_000_000;
  const rawCost    = algoAmount * algoPrice * MARGIN_MULTIPLIER;
  const feeMicroUsdc = Math.max(PRICE_FLOOR_MICRO, Math.ceil(rawCost * 1_000_000));

  return {
    feeMicroUsdc,
    fundingMicroAlgo: Number(FUNDING_ALGO_MICRO),
    expiresAt:       new Date(Date.now() + 90_000).toISOString(),
    treasuryAddress: treasury.addr.toString(),
    algoPriceUsdc:   algoPrice,
  };
}

/**
 * Build the atomic onboarding group.
 *
 * Returns the unsigned USDC tx (for the payer to sign) plus the treasury-signed
 * ALGO tx. The caller signs the USDC tx and submits both via submitOnboardingGroup().
 *
 * @param payerAddress  Algorand address that will pay the USDC registration fee
 * @param agentAddress  New agent wallet address that will receive ALGO
 */
export async function prepareOnboardingGroup(
  payerAddress: string,
  agentAddress: string,
): Promise<PreparedOnboarding> {
  // LOW-2: Validate both addresses before touching algosdk — invalid addresses
  // throw deep inside algosdk and return a 500; this surfaces a clean 400.
  if (!algosdk.isValidAddress(payerAddress)) {
    throw new Error(`Invalid payerAddress: ${payerAddress}`);
  }
  if (!algosdk.isValidAddress(agentAddress)) {
    throw new Error(`Invalid agentAddress: ${agentAddress}`);
  }

  const treasury = getTreasuryAccount();
  const quote    = await getOnboardingQuote();
  const params   = await getSuggestedParams();

  // tx0 — USDC from payer to treasury (payer signs this)
  const usdcTx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          payerAddress,
    receiver:        treasury.addr.toString(),
    amount:          BigInt(quote.feeMicroUsdc),
    assetIndex:      BigInt(config.x402.usdcAssetId),
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(`x402:onboarding:usdc:${agentAddress}`)),
  });

  // tx1 — ALGO from treasury to new agent wallet (treasury signs this)
  const algoTx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          treasury.addr.toString(),
    receiver:        agentAddress,
    amount:          BigInt(quote.fundingMicroAlgo),
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(`x402:onboarding:algo:${agentAddress}`)),
  });

  algosdk.assignGroupID([usdcTx, algoTx]);

  const signedAlgoTx = algoTx.signTxn(treasury.sk);
  const groupIdB64   = Buffer.from(algoTx.group!).toString("base64");

  return {
    unsignedUsdcTxB64: Buffer.from(algosdk.encodeUnsignedTransaction(usdcTx)).toString("base64"),
    signedAlgoTxB64:   Buffer.from(signedAlgoTx).toString("base64"),
    groupIdB64,
    quote,
  };
}

/**
 * Submit a completed atomic onboarding group (both transactions signed).
 * Waits for on-chain confirmation and returns the confirmed txid.
 *
 * @param signedUsdcTxB64  Base64-encoded payer-signed USDC transfer
 * @param signedAlgoTxB64  Base64-encoded treasury-signed ALGO payment
 */
export async function submitOnboardingGroup(
  signedUsdcTxB64: string,
  signedAlgoTxB64: string,
): Promise<string> {
  const algod = getAlgodClient();

  const usdcBytes = new Uint8Array(Buffer.from(signedUsdcTxB64, "base64"));
  const algoBytes = new Uint8Array(Buffer.from(signedAlgoTxB64, "base64"));

  // Verify both txns share the same group ID before submitting
  const decodedUsdc = algosdk.decodeSignedTransaction(usdcBytes);
  const decodedAlgo = algosdk.decodeSignedTransaction(algoBytes);
  if (
    !decodedUsdc.txn.group ||
    !decodedAlgo.txn.group ||
    !Buffer.from(decodedUsdc.txn.group).equals(Buffer.from(decodedAlgo.txn.group))
  ) {
    throw new Error("Group ID mismatch — transactions are not from the same atomic group");
  }

  // Algorand expects atomic groups as a single concatenated blob
  const concatenated = new Uint8Array(usdcBytes.length + algoBytes.length);
  concatenated.set(usdcBytes, 0);
  concatenated.set(algoBytes, usdcBytes.length);

  const { txid } = await algod.sendRawTransaction(concatenated).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  return txid;
}
