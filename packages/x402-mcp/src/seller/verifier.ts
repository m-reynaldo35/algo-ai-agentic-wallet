/**
 * x402 Payment Verifier — Seller-side
 *
 * Decodes the X-PAYMENT header (a signed MandateContract.pay() application
 * call), verifies the recipient and amount match the seller's expectations,
 * and submits the transaction to Algorand.
 *
 * The AVM enforces mandate caps at execution time — the seller only needs to
 * check that the call targets the right address with enough µUSDC, then submit.
 */

import algosdk from "algosdk";

// ARC-4 method selector for MandateContract.pay(address,uint64)void
const PAY_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("pay(address,uint64)void").getSelector(),
);

export interface VerifyOpts {
  /** Expected recipient — must match the decoded ABI arg */
  payTo: string;
  /** Minimum acceptable payment in µUSDC */
  price: number;
  /** Algod URL (default: Nodely mainnet) */
  algodUrl?: string;
  /** Set to false to skip on-chain submission (verification only) */
  submit?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  /** Algorand transaction ID (only set when submit=true and ok=true) */
  txId?: string;
  /** Sender's Algorand address */
  senderAddr?: string;
  /** Actual payment amount in µUSDC */
  amountMicroUsdc?: bigint;
}

/**
 * Decode, verify, and submit an X-PAYMENT header.
 *
 * Returns { ok: true, txId, senderAddr, amountMicroUsdc } on success,
 * or { ok: false, error } with a human-readable rejection reason.
 */
export async function verifyAndSubmit(
  xPaymentHeader: string,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  // ── Step 1: Decode signed transaction ───────────────────────────
  let signed: algosdk.SignedTransaction;
  try {
    const bytes = new Uint8Array(Buffer.from(xPaymentHeader, "base64"));
    signed = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return { ok: false, error: "Cannot decode X-PAYMENT: invalid base64 or msgpack" };
  }

  const txn = signed.txn;

  // ── Step 2: Must be an application call ─────────────────────────
  if (txn.type !== algosdk.TransactionType.appl) {
    return { ok: false, error: "X-PAYMENT must be an application call (type=appl)" };
  }

  const appCall = txn.applicationCall;
  if (!appCall) {
    return { ok: false, error: "Transaction is missing applicationCall fields" };
  }

  if (Number(appCall.appIndex ?? 0n) === 0) {
    return { ok: false, error: "Application call cannot target app_id 0" };
  }

  // ── Step 3: Verify method selector ──────────────────────────────
  const args = appCall.appArgs ?? [];
  if (args.length < 3) {
    return { ok: false, error: "pay() requires 3 args (selector + recipient + amount)" };
  }
  if (!Buffer.from(args[0]).equals(PAY_SELECTOR)) {
    return { ok: false, error: "Application call is not pay(address,uint64)void" };
  }

  // ── Step 4: Decode ABI args ──────────────────────────────────────
  let recipient: string;
  let amountMicroUsdc: bigint;
  try {
    recipient       = algosdk.encodeAddress(new Uint8Array(args[1]));
    amountMicroUsdc = BigInt("0x" + Buffer.from(args[2]).toString("hex"));
  } catch {
    return { ok: false, error: "Failed to decode pay() ABI arguments" };
  }

  // ── Step 5: Verify payment terms ─────────────────────────────────
  if (recipient !== opts.payTo) {
    return {
      ok:    false,
      error: `Recipient mismatch. Expected ${opts.payTo}, got ${recipient}`,
    };
  }

  if (amountMicroUsdc < BigInt(opts.price)) {
    return {
      ok:    false,
      error: `Amount too low. Expected >= ${opts.price} µUSDC, got ${amountMicroUsdc}`,
    };
  }

  const senderAddr = txn.sender.toString();

  // ── Step 6: Submit ────────────────────────────────────────────────
  if (opts.submit === false) {
    return { ok: true, senderAddr, amountMicroUsdc };
  }

  const algodUrl = opts.algodUrl ?? "https://mainnet-api.4160.nodely.dev";
  try {
    const algod  = new algosdk.Algodv2("", algodUrl, "");
    const txBytes = new Uint8Array(Buffer.from(xPaymentHeader, "base64"));
    const result  = await algod.sendRawTransaction(txBytes).do();
    return {
      ok:             true,
      txId:           String(result.txid ?? ""),
      senderAddr,
      amountMicroUsdc,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Transaction submission failed: ${msg}` };
  }
}
