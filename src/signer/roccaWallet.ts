import algosdk from "algosdk";
import { validateAuthToken, type AuthToken } from "../auth/liquidAuth.js";
import { getAgent, assignCohort } from "../services/agentRegistry.js";

/**
 * Rocca Wallet — Environment-Switched Ed25519 Signing Module
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  SIGNING BOUNDARY                                               │
 * │                                                                 │
 * │  This is the ONLY module in the entire codebase where private   │
 * │  key material exists.                                           │
 * │                                                                 │
 * │  Mode selection (via ALGO_SIGNER_MNEMONIC env var):             │
 * │                                                                 │
 * │  ┌─ PRODUCTION ──────────────────────────────────────────────┐  │
 * │  │ ALGO_SIGNER_MNEMONIC set → persistent, funded signer.    │  │
 * │  │ Uses algosdk.mnemonicToSecretKey() for server-side        │  │
 * │  │ signing with a known, fundable address.                   │  │
 * │  └──────────────────────────────────────────────────────────┘  │
 * │                                                                 │
 * │  ┌─ DEV ────────────────────────────────────────────────────┐  │
 * │  │ No mnemonic → ephemeral algosdk.generateAccount().       │  │
 * │  │ Generated fresh per process, NEVER persisted.            │  │
 * │  └──────────────────────────────────────────────────────────┘  │
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

// ── Signer Account (lazy-initialized) ────────────────────────────

let _signerAccount: algosdk.Account | null = null;

function getSignerAccount(): algosdk.Account {
  if (_signerAccount) return _signerAccount;

  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;

  if (mnemonic) {
    _signerAccount = algosdk.mnemonicToSecretKey(mnemonic);
    console.log(`[RoccaWallet] Persistent signer loaded: ${_signerAccount.addr}`);
    console.log(`[RoccaWallet] Ensure this address is funded before broadcasting transactions.`);
  } else {
    _signerAccount = algosdk.generateAccount();
    console.warn(`[RoccaWallet] DEV MODE: Ephemeral signer created: ${_signerAccount.addr}`);
    console.warn(`[RoccaWallet] Set ALGO_SIGNER_MNEMONIC for a persistent, funded signer.`);
  }

  return _signerAccount;
}

/**
 * Sign an array of unsigned transaction blobs.
 * Uses the environment-selected signer account.
 */
function signBlobs(
  unsignedBlobs: Uint8Array[],
): { signedBlobs: Uint8Array[]; signerAddr: string } {
  const account = getSignerAccount();
  const signedBlobs: Uint8Array[] = [];

  for (const blob of unsignedBlobs) {
    const txn = algosdk.decodeUnsignedTransaction(blob);
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
 *   4. agentId must match a registered agent in the registry
 *
 * Post-conditions:
 *   1. Returns signed blobs in the same order as input
 *   2. All blobs signed by the cohort signer key for the agent's cohort
 *   3. Ready for submission via algod.sendRawTransaction()
 *
 * @param unsignedBlobs - Array of raw unsigned transaction bytes
 * @param authToken     - Verified Liquid Auth credential
 * @param agentId       - Registered agent identifier (used for cohort routing)
 * @returns SignedGroupResult with signed blobs ready for broadcast
 */
export async function signAtomicGroup(
  unsignedBlobs: Uint8Array[],
  authToken: AuthToken,
  agentId: string,
): Promise<SignedGroupResult> {

  // ── Gate 0: Emergency halt check ──────────────────────────────
  // Checked before any signing — if the system is halted (e.g. during
  // a signer rotation or security incident), refuse all signing requests.
  const haltRecord = await import("../services/agentRegistry.js")
    .then((m) => m.isHalted());
  if (haltRecord) {
    throw new Error(`RoccaWallet: Signing halted — ${haltRecord.reason} (region=${haltRecord.region})`);
  }

  // ── Gate 1: Validate Liquid Auth token ────────────────────────
  await validateAuthToken(authToken);
  console.log(`[RoccaWallet] Auth token verified for agent: ${authToken.agentId}`);

  // ── Gate 2: Cohort routing ─────────────────────────────────────
  // Look up the agent in the registry to confirm it's registered and
  // determine which cohort signer key controls its account.
  // Phase 1: single cohort "A" → uses ALGO_SIGNER_MNEMONIC key.
  // Phase 2+: cohortIndex = sha256(agentId) % totalCohorts → separate key per cohort.
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`RoccaWallet: Agent not registered: ${agentId}`);
  }

  const cohort = assignCohort(agentId);
  console.log(`[RoccaWallet] Agent ${agentId} → cohort ${cohort} | on-chain addr: ${agent.address}`);

  // ── Gate 3: Validate input blobs ──────────────────────────────
  if (!unsignedBlobs.length) {
    throw new Error("RoccaWallet: No transaction blobs provided");
  }

  // ── Gate 4: Verify atomic group integrity before signing ──────
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

  // ── Sign via environment-selected signer ───────────────────────
  const { signedBlobs, signerAddr } = signBlobs(unsignedBlobs);

  console.log(`[RoccaWallet] Atomic group signed by: ${signerAddr}`);

  return {
    signedTransactions: signedBlobs,
    signerAddress: signerAddr,
    txnCount: signedBlobs.length,
  };
}
