import algosdk from "algosdk";
import { config } from "../config.js";
import type { SandboxExport } from "../services/transaction.js";

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
 */

const TREASURY_ADDRESS = config.x402.payToAddress;
const USDC_ASSET_ID = BigInt(config.x402.usdcAssetId);

export interface ValidationResult {
  valid: boolean;
  rules: {
    tollVerified: boolean;
    signerVerified: boolean;
  };
  errors: string[];
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

  // ── Verdict ───────────────────────────────────────────────────
  const valid = tollVerified && signerVerified && errors.length === 0;

  const result: ValidationResult = {
    valid,
    rules: { tollVerified, signerVerified },
    errors,
  };

  if (!valid) {
    console.error(`[Validation] FAILED:`, errors);
    throw new Error(
      `Validation Loop Failed: Cryptographic criteria not met — ${errors.join("; ")}`,
    );
  }

  console.log(`[Validation] PASSED: toll=${tollVerified}, signer=${signerVerified}`);
  return result;
}
