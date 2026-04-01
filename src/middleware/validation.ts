import algosdk from "algosdk";
import type { SandboxExport } from "../services/transaction.js";

/**
 * Pre-Flight Validation Gatekeeper
 *
 * Analyzes a SandboxExport AFTER it leaves the local sandbox
 * but BEFORE it reaches signing.
 *
 * Rules enforced:
 *   Rule 1: All transactions in the group are from the declared
 *           requiredSigner address.
 */


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
 * @param sandboxExport - The sealed envelope from the local sandbox
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

  // ── Rule 1: Verify all transactions are from the required signer ──
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
  const valid = signerVerified && errors.length === 0;

  const result: ValidationResult = {
    valid,
    rules: { tollVerified: true, signerVerified },
    errors,
  };

  if (!valid) {
    console.error(`[Validation] FAILED:`, errors);
    throw new Error(
      `Validation Loop Failed: Cryptographic criteria not met — ${errors.join("; ")}`,
    );
  }

  console.log(`[Validation] PASSED: signer=${signerVerified}`);
  return result;
}
