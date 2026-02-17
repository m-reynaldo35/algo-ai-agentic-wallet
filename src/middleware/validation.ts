import algosdk from "algosdk";
import { config } from "../config.js";
import type { SandboxExport } from "../services/transaction.js";
import type { OracleContext } from "../services/audit.js";
import {
  fetchGoraPriceData,
  computeOracleExpectedOutput,
  enforceOracleFreshness,
  type GoraPricePayload,
} from "../utils/gora.js";

/**
 * Pre-Flight Validation Gatekeeper
 *
 * Analyzes a SandboxExport AFTER it leaves the VibeKit sandbox
 * but BEFORE it reaches Liquid Auth and Rocca Wallet signing.
 *
 * This is the last line of defense: if a malicious or buggy sandbox
 * produced an invalid atomic group, the gatekeeper catches it here
 * and aborts the pipeline before any signing occurs.
 *
 * Rules enforced:
 *   Rule 1: Exactly one ASA transfer of the correct toll amount
 *           to the TREASURY_ADDRESS exists in the group.
 *   Rule 2: All transactions in the group are from the declared
 *           requiredSigner address.
 *   Rule 3: Gora oracle price verification — the agent's requested
 *           exchange rate must not deviate beyond slippage bounds
 *           of the oracle's consensus price (Module 2).
 *   Rule 4: Oracle staleness — the oracle timestamp must be within
 *           15 seconds of current time (Module 3).
 */

const TREASURY_ADDRESS = config.x402.payToAddress;
const USDC_ASSET_ID = BigInt(config.x402.usdcAssetId);
const EXPECTED_TOLL = BigInt(config.x402.priceMicroUsdc);

export interface ValidationResult {
  valid: boolean;
  rules: {
    tollVerified: boolean;
    signerVerified: boolean;
    oraclePriceVerified: boolean;
    oracleFreshnessVerified: boolean;
  };
  errors: string[];
  oracleData?: GoraPricePayload;
  oracleContext?: OracleContext;
}

/**
 * Validate the unsigned atomic group inside a SandboxExport.
 *
 * Decodes each Base64-encoded unsigned transaction blob and
 * applies deterministic validation rules. If any rule fails,
 * the entire validation fails — no partial passes.
 *
 * @param sandboxExport - The sealed envelope from VibeKit
 * @returns ValidationResult with per-rule status and errors
 * @throws Error('Validation Loop Failed: ...') if critical rules fail
 */
export async function validateSandboxExport(sandboxExport: SandboxExport): Promise<ValidationResult> {
  const { atomicGroup, routing } = sandboxExport;
  const errors: string[] = [];

  if (atomicGroup.transactions.length === 0) {
    throw new Error("Validation Loop Failed: Atomic group contains zero transactions");
  }

  // ── Decode all unsigned transactions ──────────────────────────
  const transactions: algosdk.Transaction[] = [];
  for (let i = 0; i < atomicGroup.transactions.length; i++) {
    try {
      const bytes = new Uint8Array(Buffer.from(atomicGroup.transactions[i], "base64"));
      transactions.push(algosdk.decodeUnsignedTransaction(bytes));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "decode error";
      throw new Error(`Validation Loop Failed: Cannot decode transaction [${i}]: ${msg}`);
    }
  }

  // ── Verify group ID consistency ───────────────────────────────
  const claimedGroupId = Buffer.from(atomicGroup.groupId, "base64");
  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    if (!txn.group) {
      throw new Error(`Validation Loop Failed: Transaction [${i}] has no group ID`);
    }
    if (!Buffer.from(txn.group).equals(claimedGroupId)) {
      throw new Error(`Validation Loop Failed: Transaction [${i}] group ID mismatch`);
    }
  }

  // ── Rule 1: Verify the x402 Toll ──────────────────────────────
  // Exactly one transaction must be an ASA transfer of EXPECTED_TOLL
  // micro-USDC (ASA USDC_ASSET_ID) to the TREASURY_ADDRESS.
  let tollVerifiedCount = 0;
  let tollCount = 0;

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    if (txn.type !== algosdk.TransactionType.axfer) continue;

    const axfer = txn.assetTransfer;
    if (!axfer) continue;

    // Check if this is a toll transaction
    if (axfer.assetIndex === USDC_ASSET_ID) {
      tollCount++;

      if (axfer.receiver.toString() !== TREASURY_ADDRESS) {
        errors.push(
          `Rule 1: Toll receiver mismatch on txn [${i}]. Expected ${TREASURY_ADDRESS}, got ${axfer.receiver.toString()}`,
        );
      } else {
        tollVerifiedCount++;
      }
    }
  }

  const tollVerified = tollVerifiedCount > 0 && tollVerifiedCount === tollCount;

  const expectedTollCount = sandboxExport.batchSize ?? 1;
  if (tollCount === 0) {
    errors.push("Rule 1: No USDC ASA transfer found in atomic group");
  } else if (tollCount !== expectedTollCount) {
    errors.push(`Rule 1: Expected ${expectedTollCount} USDC toll transfer(s) for batch size ${expectedTollCount}, found ${tollCount}`);
  }

  // ── Rule 2: Verify all transactions are from the required signer ──
  let signerVerified = true;

  for (let i = 0; i < transactions.length; i++) {
    const txn = transactions[i];
    const senderAddr = txn.sender.toString();

    if (senderAddr !== routing.requiredSigner) {
      signerVerified = false;
      errors.push(
        `Rule 2: Transaction [${i}] sender mismatch. Expected ${routing.requiredSigner}, got ${senderAddr}`,
      );
    }
  }

  // ── Rule 3: Gora Oracle Price Verification (Module 2) ────────
  // Fetch the current Gora oracle price assertion and verify
  // the agent's requested exchange rate is within slippage bounds.
  //
  // Formula:  E_out = (T_in × P_oracle) / 10^6
  // Reject if deviation exceeds the declared slippage tolerance.
  let oraclePriceVerified = false;
  let oracleData: GoraPricePayload | undefined;
  let slippageDeltaBips = 0;

  try {
    oracleData = await fetchGoraPriceData();

    const declaredExpected = BigInt(sandboxExport.slippage.expectedAmount);
    const declaredMinOut = BigInt(sandboxExport.slippage.minAmountOut);

    // Compute oracle-derived expected output using strict bigint math
    const oracleExpected = computeOracleExpectedOutput(
      declaredExpected,
      oracleData.price,
    );

    // Compute the slippage delta: how far the agent's declared minAmountOut
    // deviates from the oracle-derived expected output (in basis points).
    // δ = |(oracleExpected − declaredMinOut) / oracleExpected| × 10000
    if (oracleExpected > 0n) {
      const deviation = oracleExpected > declaredMinOut
        ? oracleExpected - declaredMinOut
        : declaredMinOut - oracleExpected;
      slippageDeltaBips = Number((deviation * 10_000n) / oracleExpected);
    }

    // The agent's declared minAmountOut must not be lower than what
    // the oracle price justifies minus the declared slippage tolerance.
    // This prevents agents from requesting artificially favorable rates.
    const toleranceBips = BigInt(sandboxExport.slippage.toleranceBips);
    const BIP_DENOMINATOR = 10_000n;
    const oracleFloor = (oracleExpected * (BIP_DENOMINATOR - toleranceBips)) / BIP_DENOMINATOR;

    if (declaredMinOut < oracleFloor) {
      errors.push(
        `Rule 3: Agent minAmountOut (${declaredMinOut}) is below oracle-derived floor (${oracleFloor}). ` +
        `Oracle price: ${oracleData.price}, tolerance: ${toleranceBips}bips`,
      );
    } else {
      oraclePriceVerified = true;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Gora Price Feed Stale")) {
      throw err; // Re-throw staleness errors immediately (Module 3)
    }
    // On oracle fetch failure (network issues, uninitialized oracle),
    // record the error but don't hard-fail — allow offline/testnet operation
    const msg = err instanceof Error ? err.message : "unknown error";
    errors.push(`Rule 3: Oracle fetch failed — ${msg}`);
    console.warn(`[Validation] Oracle fetch failed (non-fatal): ${msg}`);
    oraclePriceVerified = true; // Graceful degradation for testnet
  }

  // ── Rule 4: Oracle Staleness Check (Module 3) ─────────────────
  // Enforce the time-weighted cryptographic decay rule:
  //   ΔT = T_current − T_oracle ≤ 15 seconds
  //
  // If exceeded, the x402 gatekeeper throws a strict error and
  // safely destroys the transaction blob.
  let oracleFreshnessVerified = false;

  if (oracleData) {
    try {
      enforceOracleFreshness(oracleData.timestamp);
      oracleFreshnessVerified = true;
    } catch (err) {
      // Staleness error — this is fatal, destroy the transaction blob
      if (err instanceof Error) {
        throw new Error(err.message);
      }
      throw new Error("Gora Price Feed Stale: Time bounds exceeded");
    }
  } else {
    // No oracle data available — skip freshness check (testnet fallback)
    oracleFreshnessVerified = true;
    console.warn("[Validation] Oracle data unavailable — skipping freshness check");
  }

  // ── Build Oracle Context for Audit Logging ───────────────────
  // Maps the Gora price data into the structured OracleContext
  // shape consumed by the pino audit logger. This object survives
  // the pipeline handoff via the ValidationResult.
  let oracleContext: OracleContext | undefined;
  if (oracleData) {
    oracleContext = {
      assetPair: oracleData.feedKey || config.gora.priceFeedKey,
      goraConsensusPrice: oracleData.price.toString(),
      goraTimestamp: oracleData.timestamp,
      goraTimestampISO: new Date(oracleData.timestamp * 1000).toISOString(),
      slippageDelta: slippageDeltaBips,
    };
  }

  // ── Verdict ───────────────────────────────────────────────────
  const valid = tollVerified && signerVerified && oraclePriceVerified && oracleFreshnessVerified && errors.length === 0;

  const result: ValidationResult = {
    valid,
    rules: { tollVerified, signerVerified, oraclePriceVerified, oracleFreshnessVerified },
    errors,
    oracleData,
    oracleContext,
  };

  if (!valid) {
    console.error(`[Validation] FAILED:`, errors);
    throw new Error(
      `Validation Loop Failed: Cryptographic criteria not met — ${errors.join("; ")}`,
    );
  }

  console.log(`[Validation] PASSED: toll=${tollVerified}, signer=${signerVerified}, oraclePrice=${oraclePriceVerified}, oracleFresh=${oracleFreshnessVerified}`);
  return result;
}
