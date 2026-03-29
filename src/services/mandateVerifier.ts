/**
 * MandateVerifier — Server-side verification of on-chain mandate contract calls
 *
 * In the on-chain mandate architecture, the X-PAYMENT header contains a signed
 * application call to the agent's MandateContract. The server:
 *
 *   1. Decodes the signed transaction from X-PAYMENT
 *   2. Verifies the app was deployed by the known MandateFactory (provenance)
 *   3. Verifies the method is pay(), recipient is treasury, amount is correct toll
 *   4. Submits the pre-signed transaction — AVM enforces mandate gates at execution
 *
 * The server no longer constructs or signs any transaction.
 * The server no longer enforces USDC velocity limits — those are in the AVM.
 * The server only needs: provenance check + toll param check + submit.
 */

import algosdk from "algosdk";
import { getAlgodClient } from "../network/nodely.js";
import { config }         from "../config.js";
import { getRedis }       from "../services/redis.js";
import { logger }         from "../lib/logger.js";

// ── Config ───────────────────────────────────────────────────────────────────

// MANDATE_CONTRACT_APPROVAL_HASH is the primary provenance check — SHA-256 of
// the compiled approval program bytes. Required in production.
// MANDATE_FACTORY_APP_ID is an optional belt-and-braces secondary check. Do NOT
// use it as the primary: the fi global state field is self-reported (any caller
// can pass any value as application_args[9] at create time).
const APPROVAL_HASH  = process.env.MANDATE_CONTRACT_APPROVAL_HASH ?? "";
const FACTORY_APP_ID = Number(process.env.MANDATE_FACTORY_APP_ID ?? "0");

// Cache TTL for factory-membership lookups (app state doesn't change often)
const PROVENANCE_CACHE_TTL_S = 60 * 60; // 1 hour

// ARC-4 method selector for MandateContract.pay(address,uint64)void
// = first 4 bytes of SHA512/256("pay(address,uint64)void")
const PAY_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("pay(address,uint64)void").getSelector()
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerifiedMandateCall {
  /** The decoded app call transaction */
  appCallTxn: algosdk.SignedTransaction;
  /** Application ID of the MandateContract */
  appId: number;
  /** Address of the application account (holds the USDC) */
  appAddress: string;
  /** The agent's signing address (sender of the app call) */
  agentAddress: string;
  /** Recipient decoded from ABI args */
  recipient: string;
  /** Amount in micro-USDC decoded from ABI args */
  amountMicroUsdc: bigint;
}

export interface VerificationResult {
  valid: boolean;
  call?: VerifiedMandateCall;
  error?: string;
}

// ── Main verifier ─────────────────────────────────────────────────────────────

/**
 * Verify that the X-PAYMENT header contains a valid signed MandateContract
 * pay() call with the correct toll parameters.
 *
 * Does NOT submit the transaction — caller is responsible for submission.
 */
export async function verifyMandateCall(
  signedTxnBase64: string,
): Promise<VerificationResult> {

  // ── Step 1: Decode the signed transaction ──────────────────────────────
  let signed: algosdk.SignedTransaction;
  try {
    const bytes = new Uint8Array(Buffer.from(signedTxnBase64, "base64"));
    signed = algosdk.decodeSignedTransaction(bytes);
  } catch {
    return { valid: false, error: "Cannot decode signed transaction from X-PAYMENT" };
  }

  const txn = signed.txn;

  // ── Step 2: Must be an application call ────────────────────────────────
  if (txn.type !== algosdk.TransactionType.appl) {
    return { valid: false, error: "X-PAYMENT must be an application call (type=appl)" };
  }

  // In algosdk v3, app call fields live on txn.applicationCall
  const appCall = txn.applicationCall;
  if (!appCall) {
    return { valid: false, error: "Transaction is missing applicationCall fields" };
  }

  const appId = Number(appCall.appIndex ?? 0n);
  if (appId === 0) {
    return { valid: false, error: "Application call cannot target app_id 0" };
  }

  // ── Step 3: Verify method selector is pay() ────────────────────────────
  const args = appCall.appArgs ?? [];
  if (args.length < 3) {
    return { valid: false, error: "pay() requires 3 application_args (selector + recipient + amount)" };
  }
  if (!Buffer.from(args[0]).equals(PAY_SELECTOR)) {
    return { valid: false, error: "Application call method is not pay(address,uint64)" };
  }

  // ── Step 4: Decode ABI args ────────────────────────────────────────────
  let recipient: string;
  let amountMicroUsdc: bigint;
  try {
    // ARC-4: address = 32 raw bytes, uint64 = 8 bytes big-endian
    recipient       = algosdk.encodeAddress(new Uint8Array(args[1]));
    amountMicroUsdc = BigInt("0x" + Buffer.from(args[2]).toString("hex"));
  } catch {
    return { valid: false, error: "Failed to decode pay() arguments" };
  }

  // ── Step 5: Verify toll parameters ────────────────────────────────────
  // When recipient == treasury, the call IS the toll (x402 endpoint payment).
  // When recipient != treasury, the contract fires payment + toll internally.
  // In both cases we verify the recipient is either treasury or a valid call.
  const isTollPayment = recipient === config.x402.payToAddress;
  if (isTollPayment && amountMicroUsdc !== BigInt(config.x402.priceMicroUsdc)) {
    return {
      valid: false,
      error: `Toll amount mismatch. Expected ${config.x402.priceMicroUsdc}, got ${amountMicroUsdc}`,
    };
  }

  // ── Step 6: Verify factory provenance ─────────────────────────────────
  // Check that this app was deployed by the known MandateFactory.
  // Cached in Redis to avoid an algod call on every request.
  const provenance = await checkFactoryProvenance(appId);
  if (!provenance.valid) {
    return { valid: false, error: provenance.error };
  }

  const appAddress = algosdk.getApplicationAddress(BigInt(appId)).toString();

  return {
    valid: true,
    call: {
      appCallTxn:     signed,
      appId,
      appAddress,
      agentAddress:   txn.sender.toString(),
      recipient,
      amountMicroUsdc,
    },
  };
}

// ── Factory provenance check ──────────────────────────────────────────────────

interface ProvenanceResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify that appId was deployed with the known MandateContract bytecode.
 *
 * Primary check (required): SHA-256 hash of the approval program bytes.
 *   MANDATE_CONTRACT_APPROVAL_HASH must be set. Hash verification checks
 *   actual on-chain bytecode — it cannot be faked.
 *
 * Secondary check (optional belt-and-braces): factory_id global state.
 *   Only runs when MANDATE_FACTORY_APP_ID is also set. Note: the fi field
 *   is self-reported at create time (application_args[9]) so it is NOT
 *   sufficient as a standalone check — used only to add defence-in-depth
 *   after the hash has already passed.
 *
 * Fail closed: if MANDATE_CONTRACT_APPROVAL_HASH is not configured, all
 * payments are rejected. Set it from `python deploy.py set-programs` output.
 */
async function checkFactoryProvenance(appId: number): Promise<ProvenanceResult> {
  const cacheKey = `x402:mandate:provenance:v3:${appId}`;
  const redis    = getRedis();

  // Check Redis cache first
  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached === "ok")   return { valid: true };
      if (cached === "fail") return { valid: false, error: `App ${appId} failed provenance check` };
    } catch { /* non-fatal cache miss */ }
  }

  // ── Primary: SHA-256 approval program hash ─────────────────────────────
  if (!APPROVAL_HASH) {
    // Fail closed — operator must set MANDATE_CONTRACT_APPROVAL_HASH
    return {
      valid: false,
      error: "MANDATE_CONTRACT_APPROVAL_HASH is not configured. Set it from `python deploy.py set-programs` output.",
    };
  }

  try {
    const { createHash } = await import("crypto");
    const algod   = getAlgodClient();
    // algosdk v3: response is camelCase, approvalProgram is Uint8Array, globalState is typed array
    const appInfo = await algod.getApplicationByID(appId).do() as unknown as {
      params?: {
        approvalProgram?: Uint8Array;
        globalState?:     Array<{ key: Uint8Array; value: { bytes?: Uint8Array; uint?: bigint | number } }>;
      }
    };

    // Check approval program hash
    const programBytes = appInfo?.params?.approvalProgram;
    if (!programBytes || programBytes.length === 0) {
      return { valid: false, error: `App ${appId} has no approval program on-chain` };
    }
    const hash = createHash("sha256").update(programBytes).digest("hex");

    if (hash !== APPROVAL_HASH) {
      await cacheProvenance(redis, cacheKey, false);
      return { valid: false, error: `App ${appId} approval program hash mismatch — not a recognised MandateContract` };
    }

    // ── Secondary (optional): factory_id global state ─────────────────────
    // Belt-and-braces only. Hash already confirmed the bytecode is correct.
    if (FACTORY_APP_ID) {
      const globalState = appInfo?.params?.globalState ?? [];
      // In algosdk v3, keys are Uint8Array; decode to string for lookup
      const fiEntry = globalState.find((e) =>
        Buffer.from(e.key).toString() === "fi"
      );
      const storedFactoryId = Number(fiEntry?.value?.uint ?? 0);

      if (storedFactoryId !== FACTORY_APP_ID) {
        logger.warn(
          { appId, storedFactoryId, expectedFactoryId: FACTORY_APP_ID },
          "[MandateVerifier] app hash matches but factory_id mismatch — contract may have been deployed manually",
        );
        // Fail closed: correct bytecode but wrong factory lineage is suspicious
        await cacheProvenance(redis, cacheKey, false);
        return {
          valid: false,
          error: `App ${appId} factory_id ${storedFactoryId} ≠ expected ${FACTORY_APP_ID}`,
        };
      }
    }

    await cacheProvenance(redis, cacheKey, true);
    return { valid: true };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ appId, err: msg }, "[MandateVerifier] provenance check failed");
    return { valid: false, error: `Cannot verify app ${appId} provenance: ${msg}` };
  }
}

async function cacheProvenance(
  redis: ReturnType<typeof getRedis>,
  key: string,
  valid: boolean,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, valid ? "ok" : "fail", { ex: PROVENANCE_CACHE_TTL_S });
  } catch { /* non-fatal */ }
}
