import algosdk from "algosdk";
import { validateAuthToken, type AuthToken } from "../auth/liquidAuth.js";

/**
 * Rocca Wallet — Seedless Ed25519 Signing Module
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SIGNING BOUNDARY                                               │
 * │                                                                 │
 * │  This is the ONLY module in the entire codebase where private   │
 * │  key material exists. In production, the Rocca Wallet SDK       │
 * │  manages keys in a secure enclave — keys never leave the        │
 * │  device/HSM. The SDK exposes only a sign(blob) → signature      │
 * │  interface, with key generation and storage handled internally. │
 * │                                                                 │
 * │  LOCAL DEV ONLY: We use an algosdk ephemeral account to         │
 * │  simulate the Rocca signing interface. This account is          │
 * │  generated fresh per process and NEVER persisted.               │
 * │                                                                 │
 * │  Production: Replace mockRoccaSign() with the Rocca SDK call.   │
 * └─────────────────────────────────────────────────────────────────┘
 */

export interface SignedGroupResult {
  /** Array of signed transaction blobs ready for network submission */
  signedTransactions: Uint8Array[];
  /** The Algorand address that signed */
  signerAddress: string;
  /** Number of transactions signed */
  txnCount: number;
}

// ── Local Dev: Ephemeral Signing Account ────────────────────────
// This exists ONLY for local testing. In production, Rocca Wallet
// manages keys internally — no mnemonic/secret key is ever exposed.
let ephemeralAccount: algosdk.Account | null = null;

function getEphemeralAccount(): algosdk.Account {
  if (!ephemeralAccount) {
    ephemeralAccount = algosdk.generateAccount();
    console.log(`[RoccaWallet] DEV MODE: Ephemeral signer created: ${ephemeralAccount.addr}`);
    console.log(`[RoccaWallet] WARNING: This is a mock signer. Replace with Rocca SDK for production.`);
  }
  return ephemeralAccount;
}

/**
 * Simulate the Rocca Wallet seedless signing interface.
 *
 * Production replacement (Rocca SDK):
 *   const rocca = await RoccaWallet.connect(authToken);
 *   const signed = await rocca.signTransactions(unsignedBlobs);
 *   return signed;
 *
 * The Rocca SDK:
 *   1. Validates the Liquid Auth token with its internal verifier
 *   2. Derives the Ed25519 keypair from the user's FIDO2 credential
 *      inside a secure enclave (TEE/HSM)
 *   3. Signs each transaction blob
 *   4. Returns signed blobs — the private key never leaves the enclave
 */
async function mockRoccaSign(
  unsignedBlobs: Uint8Array[],
  _authToken: string,
): Promise<{ signedBlobs: Uint8Array[]; signerAddr: string }> {
  const account = getEphemeralAccount();
  const signedBlobs: Uint8Array[] = [];

  for (const blob of unsignedBlobs) {
    // Decode the unsigned transaction
    const txn = algosdk.decodeUnsignedTransaction(blob);

    // Sign with the ephemeral account
    // Production: Rocca SDK handles this internally via secure enclave
    const signedTxn = txn.signTxn(account.sk);
    signedBlobs.push(signedTxn);
  }

  return { signedBlobs, signerAddr: account.addr.toString() };
}

/**
 * Sign an atomic group of unsigned transaction blobs via Rocca Wallet.
 *
 * Pre-conditions:
 *   1. authToken must be a valid, non-expired Liquid Auth credential
 *   2. unsignedBlobs must be algosdk.encodeUnsignedTransaction() output
 *   3. All blobs must share the same group ID (atomic binding)
 *
 * Post-conditions:
 *   1. Returns signed blobs in the same order as input
 *   2. All blobs signed by the same Ed25519 key
 *   3. Ready for submission via algod.sendRawTransaction()
 *
 * @param unsignedBlobs - Array of raw unsigned transaction bytes
 * @param authToken     - Verified Liquid Auth credential
 * @returns SignedGroupResult with signed blobs ready for broadcast
 */
export async function signAtomicGroup(
  unsignedBlobs: Uint8Array[],
  authToken: AuthToken,
): Promise<SignedGroupResult> {

  // ── Gate 1: Validate Liquid Auth token ────────────────────────
  validateAuthToken(authToken);
  console.log(`[RoccaWallet] Auth token verified for agent: ${authToken.agentId}`);

  // ── Gate 2: Validate input blobs ──────────────────────────────
  if (!unsignedBlobs.length) {
    throw new Error("RoccaWallet: No transaction blobs provided");
  }

  // ── Gate 3: Verify atomic group integrity before signing ──────
  // Decode all transactions and verify they share a common group ID.
  // This prevents signing a malformed or tampered group.
  let expectedGroupId: Uint8Array | undefined;

  for (let i = 0; i < unsignedBlobs.length; i++) {
    const txn = algosdk.decodeUnsignedTransaction(unsignedBlobs[i]);
    const groupId = txn.group;

    if (!groupId) {
      throw new Error(`RoccaWallet: Transaction [${i}] is missing a group ID — refusing to sign ungrouped transactions`);
    }

    if (!expectedGroupId) {
      expectedGroupId = groupId;
    } else {
      const expected = Buffer.from(expectedGroupId);
      const actual = Buffer.from(groupId);
      if (!expected.equals(actual)) {
        throw new Error(`RoccaWallet: Transaction [${i}] has mismatched group ID — atomic integrity violated`);
      }
    }
  }

  console.log(`[RoccaWallet] Group integrity verified: ${unsignedBlobs.length} txns, groupId=${Buffer.from(expectedGroupId!).toString("base64").slice(0, 12)}...`);

  // ── Sign via Rocca (mock in dev, SDK in production) ───────────
  const { signedBlobs, signerAddr } = await mockRoccaSign(unsignedBlobs, authToken.token);

  console.log(`[RoccaWallet] Atomic group signed by: ${signerAddr}`);

  return {
    signedTransactions: signedBlobs,
    signerAddress: signerAddr,
    txnCount: signedBlobs.length,
  };
}
