/**
 * Custody Manager — transitions between Rocca custody and user custody.
 *
 * Rekey-to-user flow (Tier 2):
 *   1. issueRekeyChallenge()    — 32-byte challenge bound to agentId + destination + custodyVersion
 *   2. verifyRekeyChallenge()   — user proves control of destination by signing challenge
 *   3. executeRekey()           — construct unsigned txn → admin-sign → broadcast → update registry
 *
 * Re-custody flow (Tier 2 → Rocca):
 *   1. executeRecustody()       — validate user-submitted signed rekey txn, broadcast, update registry
 *
 * Tier 1 approval signal:
 *   issueApprovalToken()   — single-use token bound to agentId + amount + groupIdHash
 *   consumeApprovalToken() — validate and consume (single-use, 60s TTL)
 *
 * Security properties:
 *   - Challenge bound to custodyVersion: stale artifacts cannot replay across transitions
 *   - In-progress lock per agent: no concurrent rekey for same agent
 *   - Registry update is POST-confirmation only: failed txns cannot desync the registry
 *   - Re-custody validates structure strictly: Rocca is not a blind relay
 *   - Tier 1 token binds groupId hash + amount: replay on different txn is blocked
 */

import algosdk from "algosdk";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getRedis } from "./redis.js";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import { getAgent, updateAgentRecord, type AgentRecord } from "./agentRegistry.js";
import { config } from "../config.js";

// ── Redis Key Constants ───────────────────────────────────────────

const REKEY_CHALLENGE_PREFIX   = "x402:auth:rekey-chal:";    // TTL: 300s
const REKEY_IN_PROGRESS_PREFIX = "x402:rekey-in-progress:";  // TTL: 600s
const TIER1_APPROVAL_PREFIX    = "x402:auth:approval:";      // TTL: 60s
const CUSTODY_AUDIT_KEY        = "x402:custody-audit";       // ZSET, no TTL

const CHALLENGE_TTL_S   = 300;   // 5 minutes — matches FIDO2 challenge window
const IN_PROGRESS_TTL_S = 90;    // 90s — Algorand confirms in ≤8 rounds (~40s); 90s covers sign+broadcast+confirmation
const APPROVAL_TTL_S    = 60;    // 1 minute — tight window for Tier 1 approval
const MAX_AUDIT_ENTRIES = 5_000;
const CONFIRM_MAX_ROUNDS = 8;    // ~40 seconds at 5s/round

// ── Types ─────────────────────────────────────────────────────────

interface ChallengeRecord {
  agentId:            string;
  destinationAddress: string;
  custodyVersion:     number;
  challenge:          string; // 32 random bytes, base64
  issuedAt:           string;
}

export interface RekeyResult {
  txid:           string;
  agentId:        string;
  fromAuthAddr:   string;
  toAuthAddr:     string;
  custody:        "user";
  custodyVersion: number;
}

export interface RecustodyResult {
  txid:           string;
  agentId:        string;
  fromAuthAddr:   string;
  toAuthAddr:     string;
  custody:        "rocca";
  custodyVersion: number;
}

interface CustodyAuditEvent {
  type:           "rekey_to_user" | "recustody_to_rocca";
  agentId:        string;
  ownerWalletId?: string;
  fromAuthAddr:   string;
  toAuthAddr:     string;
  txid:           string;
  custodyVersion: number;
  timestamp:      string;
}

// ── Internal Helpers ──────────────────────────────────────────────

async function writeCustodyAudit(event: CustodyAuditEvent): Promise<void> {
  // Stdout — always visible in Railway log drain
  console.log("[CustodyAudit]", JSON.stringify(event));

  // Redis ring buffer — best-effort
  const redis = getRedis();
  if (!redis) return;
  const score  = Date.now();
  const member = JSON.stringify(event);
  redis
    .zadd(CUSTODY_AUDIT_KEY, { score, member })
    .then(() => redis.zremrangebyrank(CUSTODY_AUDIT_KEY, 0, -(MAX_AUDIT_ENTRIES + 1)))
    .catch(() => {});
}

async function waitForConfirmation(txid: string): Promise<void> {
  const client = getAlgodClient();
  const status = await client.status().do();
  let round    = Number(status.lastRound ?? 0);
  const cutoff = round + CONFIRM_MAX_ROUNDS;

  while (round <= cutoff) {
    try {
      const info = await client.pendingTransactionInformation(txid).do();
      if (info.confirmedRound && Number(info.confirmedRound) > 0) return;
      if (info.poolError) throw new Error(`Pool rejected txn ${txid}: ${info.poolError}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Pool rejected")) throw err;
    }
    const next = await client.statusAfterBlock(round).do();
    round = Number(next.lastRound ?? round + 1);
  }
  throw new Error(`Txn ${txid} not confirmed within ${CONFIRM_MAX_ROUNDS} rounds`);
}

async function callAdminSignRekey(params: {
  agentId:            string;
  destinationAddress: string;
  custodyVersion:     number;
  unsignedTxnBase64:  string;
}): Promise<string> {
  const url    = process.env.SIGNING_SERVICE_URL?.replace(/\/$/, "");
  const apiKey = process.env.SIGNING_SERVICE_API_KEY;
  if (!url)    throw new Error("SIGNING_SERVICE_URL not configured");
  if (!apiKey) throw new Error("SIGNING_SERVICE_API_KEY not configured");

  const res = await fetch(`${url}/admin/sign-rekey`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body:    JSON.stringify(params),
    signal:  AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Admin sign-rekey failed (${res.status}): ${err.error ?? "unknown"}`);
  }

  return ((await res.json()) as { signedTxnBase64: string }).signedTxnBase64;
}

// ── Challenge Issuance ────────────────────────────────────────────

/**
 * Issue a rekey challenge for an agent.
 *
 * The challenge is a 32-byte random nonce stored in Redis with metadata
 * binding it to: agentId + destinationAddress + custodyVersion.
 * This prevents the challenge from being reused across agents or against
 * a different transition state (e.g., after a concurrent rekey or rotation).
 *
 * Returns base64-encoded challenge bytes for the client to sign with
 * the destination key to prove control.
 */
export async function issueRekeyChallenge(
  agentId:            string,
  destinationAddress: string,
  requestorWalletId:  string,
): Promise<string> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const custody = agent.custody ?? "rocca";
  if (custody !== "rocca") {
    throw new Error(`Agent ${agentId} is not under Rocca custody — cannot initiate rekey`);
  }
  if (agent.status === "suspended") {
    throw new Error(`Agent ${agentId} is suspended`);
  }
  if (agent.status === "rotating") {
    throw new Error(`Agent ${agentId} has an active signer rotation — cannot rekey during rotation`);
  }
  if (agent.ownerWalletId && agent.ownerWalletId !== requestorWalletId) {
    throw new Error("Rekey denied: requestor wallet does not own this agent");
  }
  if (!algosdk.isValidAddress(destinationAddress)) {
    throw new Error(`Invalid destination address: ${destinationAddress}`);
  }
  if (destinationAddress === agent.address) {
    throw new Error("Destination address cannot be the agent's own address");
  }

  const redis = getRedis();
  if (!redis) throw new Error("Redis not available — cannot issue challenge");

  const challengeB64 = randomBytes(32).toString("base64");
  const record: ChallengeRecord = {
    agentId,
    destinationAddress,
    custodyVersion: agent.custodyVersion ?? 0,
    challenge:      challengeB64,
    issuedAt:       new Date().toISOString(),
  };

  await redis.set(
    `${REKEY_CHALLENGE_PREFIX}${agentId}`,
    JSON.stringify(record),
    { ex: CHALLENGE_TTL_S },
  );

  return challengeB64;
}

// ── Challenge Verification ────────────────────────────────────────

/**
 * Verify that the user signed the challenge with their destination key.
 *
 * Uses algosdk.verifyBytes — the standard Algorand proof-of-key-control
 * primitive (prepends "MX" to the message to prevent transaction forgery).
 *
 * Consumes the challenge on success (single-use).
 */
export async function verifyRekeyChallenge(
  agentId:            string,
  destinationAddress: string,
  signatureBase64:    string,
  custodyVersion:     number,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available — cannot verify challenge");

  const raw = await redis.get(`${REKEY_CHALLENGE_PREFIX}${agentId}`) as string | null;
  if (!raw) throw new Error("No active rekey challenge — expired or not issued");

  let record: ChallengeRecord;
  try { record = JSON.parse(raw) as ChallengeRecord; }
  catch { throw new Error("Corrupt challenge record"); }

  // Binding checks — all three must match exactly
  if (record.destinationAddress !== destinationAddress) {
    throw new Error("Challenge destination address mismatch");
  }
  if (record.custodyVersion !== custodyVersion) {
    throw new Error("Challenge custodyVersion mismatch — a concurrent transition may have occurred");
  }

  const challengeBytes = Buffer.from(record.challenge, "base64");
  const signatureBytes  = Buffer.from(signatureBase64, "base64");

  if (!algosdk.verifyBytes(challengeBytes, signatureBytes, destinationAddress)) {
    throw new Error("Signature verification failed — destination key not proven");
  }

  // Single-use: consume immediately after successful verification
  await redis.del(`${REKEY_CHALLENGE_PREFIX}${agentId}`);
}

// ── Rekey Execution ───────────────────────────────────────────────

/**
 * Execute the rekey from Rocca custody to user custody.
 *
 * Call AFTER verifyRekeyChallenge succeeds. This function:
 *   - Acquires a per-agent in-progress lock (prevents concurrent rekey)
 *   - Constructs an unsigned self-payment txn with rekey_to = destination
 *   - Signs via the signing service admin endpoint (Rocca holds auth-addr)
 *   - Broadcasts to algod and waits for confirmation
 *   - Updates the registry ONLY after on-chain confirmation
 */
export async function executeRekey(
  agentId:            string,
  destinationAddress: string,
  custodyVersion:     number,
): Promise<RekeyResult> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const lockKey = `${REKEY_IN_PROGRESS_PREFIX}${agentId}`;
  if (await redis.set(lockKey, "1", { nx: true, ex: IN_PROGRESS_TTL_S }) !== "OK") {
    throw new Error(`Rekey already in progress for agent ${agentId}`);
  }

  try {
    const agent = await getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if ((agent.custody ?? "rocca") !== "rocca") {
      throw new Error("Agent is no longer under Rocca custody");
    }
    if ((agent.custodyVersion ?? 0) !== custodyVersion) {
      throw new Error("custodyVersion mismatch — state changed since challenge was issued");
    }

    // Construct unsigned rekey txn: zero-value self-payment with rekey_to set
    const sp = await getSuggestedParams();
    // T2.1: Tighten validity window to ~450s (~100 rounds). Replay protection is
    // enforced by the signing-service groupId replay guard (5-min TTL), not by
    // the on-chain validity window. 100 rounds gives plenty of runway for queue depth.
    sp.lastValid = BigInt(sp.firstValid) + 100n;

    const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender:          agent.address,
      receiver:        agent.address,
      amount:          0n,
      rekeyTo:         destinationAddress,
      suggestedParams: sp,
    });

    const unsignedTxnBase64 = Buffer.from(
      algosdk.encodeUnsignedTransaction(rekeyTxn),
    ).toString("base64");

    // Signing service admin path — bypasses x402 toll check (platform operation)
    const signedTxnBase64 = await callAdminSignRekey({
      agentId,
      destinationAddress,
      custodyVersion,
      unsignedTxnBase64,
    });

    // Broadcast
    const client       = getAlgodClient();
    const submitResult = await client
      .sendRawTransaction(Buffer.from(signedTxnBase64, "base64"))
      .do();
    const txid = submitResult.txid as string;

    // Wait for on-chain confirmation — registry update only after this
    await waitForConfirmation(txid);

    // ── Post-commit on-chain verification ─────────────────────────
    // "On-Chain State is the Only Truth" — confirm auth-addr matches
    // the intended destination before writing to the registry.
    // If algod reports a different auth-addr, the txn may have been
    // replaced or the node may be lagging — abort rather than desync.
    const accountInfo = await getAlgodClient().accountInformation(agent.address).do();
    const confirmedAuthAddr = accountInfo.authAddr?.toString() ?? null;
    if (confirmedAuthAddr !== destinationAddress) {
      throw new Error(
        `Post-commit auth-addr mismatch for ${agent.address}: ` +
        `expected ${destinationAddress}, on-chain is ${confirmedAuthAddr ?? "unset"}. ` +
        "Registry NOT updated — manual investigation required.",
      );
    }

    const newCustodyVersion = (agent.custodyVersion ?? 0) + 1;
    const updated: AgentRecord = {
      ...agent,
      authAddr:       destinationAddress,
      custody:        "user",
      custodyVersion: newCustodyVersion,
    };
    await updateAgentRecord(updated);

    await writeCustodyAudit({
      type:           "rekey_to_user",
      agentId,
      ownerWalletId:  agent.ownerWalletId,
      fromAuthAddr:   agent.authAddr,
      toAuthAddr:     destinationAddress,
      txid,
      custodyVersion: newCustodyVersion,
      timestamp:      new Date().toISOString(),
    });

    return {
      txid,
      agentId,
      fromAuthAddr:   agent.authAddr,
      toAuthAddr:     destinationAddress,
      custody:        "user",
      custodyVersion: newCustodyVersion,
    };
  } finally {
    await redis.del(lockKey);
  }
}

// ── Re-Custody Execution ──────────────────────────────────────────

/**
 * Accept a user-signed rekey transaction returning custody to Rocca.
 *
 * The user's key currently holds auth-addr. They sign a rekey transaction
 * pointing rekey_to = Rocca signer, and submit it here.
 *
 * Rocca is NOT a blind relay. The submitted transaction is validated:
 *   - Must be a payment transaction
 *   - Amount must be 0 (no ALGO movement)
 *   - Sender must be the agent's address
 *   - Receiver must equal sender (self-payment)
 *   - rekey_to must equal the Rocca signer address exactly
 *   - Transaction must not be expired
 */
export async function executeRecustody(
  agentId:          string,
  signedTxnBase64:  string,
  requestorWalletId: string,
): Promise<RecustodyResult> {
  // Distributed lock — prevents concurrent re-custody for the same agent
  // across multi-region instances. Mirrors the executeRekey lock pattern.
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const lockKey = `${REKEY_IN_PROGRESS_PREFIX}${agentId}`;
  if (await redis.set(lockKey, "1", { nx: true, ex: IN_PROGRESS_TTL_S }) !== "OK") {
    throw new Error(`Custody transition already in progress for agent ${agentId}`);
  }

  try {
    return await _executeRecustodyLocked(agentId, signedTxnBase64, requestorWalletId);
  } finally {
    await redis.del(lockKey);
  }
}

async function _executeRecustodyLocked(
  agentId:           string,
  signedTxnBase64:   string,
  requestorWalletId: string,
): Promise<RecustodyResult> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if ((agent.custody ?? "rocca") !== "user") {
    throw new Error(`Agent ${agentId} is already under Rocca custody`);
  }
  if (agent.ownerWalletId && agent.ownerWalletId !== requestorWalletId) {
    throw new Error("Re-custody denied: requestor wallet does not own this agent");
  }

  const roccaSignerAddress = config.rocca.signerAddress;
  if (!roccaSignerAddress) {
    throw new Error(
      "ROCCA_SIGNER_ADDRESS not configured — cannot validate re-custody transaction",
    );
  }

  // Decode
  let signedTxn: algosdk.SignedTransaction;
  try {
    signedTxn = algosdk.decodeSignedTransaction(
      new Uint8Array(Buffer.from(signedTxnBase64, "base64")),
    );
  } catch {
    throw new Error("Cannot decode signed transaction");
  }

  const txn = signedTxn.txn;

  // Strict structural validation — each check is a distinct security property
  if (txn.type !== algosdk.TransactionType.pay) {
    throw new Error("Re-custody transaction must be a payment transaction");
  }
  if (!txn.payment || txn.payment.amount !== 0n) {
    throw new Error("Re-custody transaction must have amount = 0");
  }
  if (txn.sender.toString() !== agent.address) {
    throw new Error(
      `Sender ${txn.sender} does not match agent address ${agent.address}`,
    );
  }
  if (txn.payment.receiver.toString() !== agent.address) {
    throw new Error("Re-custody transaction must be a self-payment (receiver = sender)");
  }
  if (!txn.rekeyTo || txn.rekeyTo.toString() !== roccaSignerAddress) {
    throw new Error(
      `rekey_to must be the Rocca signer address (${roccaSignerAddress})`,
    );
  }

  // Expiry check
  const nodeStatus = await getAlgodClient().status().do();
  if (txn.lastValid <= BigInt(nodeStatus.lastRound ?? 0)) {
    throw new Error("Re-custody transaction has expired");
  }

  // Broadcast
  const client       = getAlgodClient();
  const submitResult = await client
    .sendRawTransaction(Buffer.from(signedTxnBase64, "base64"))
    .do();
  const txid = submitResult.txid as string;

  await waitForConfirmation(txid);

  const updated: AgentRecord = {
    ...agent,
    authAddr:       roccaSignerAddress,
    custody:        "rocca",
    custodyVersion: (agent.custodyVersion ?? 0) + 1,
  };
  await updateAgentRecord(updated);

  await writeCustodyAudit({
    type:           "recustody_to_rocca",
    agentId,
    ownerWalletId:  agent.ownerWalletId,
    fromAuthAddr:   agent.authAddr,
    toAuthAddr:     roccaSignerAddress,
    txid,
    custodyVersion: updated.custodyVersion ?? 0,
    timestamp:      new Date().toISOString(),
  });

  return {
    txid,
    agentId,
    fromAuthAddr:   agent.authAddr,
    toAuthAddr:     roccaSignerAddress,
    custody:        "rocca",
    custodyVersion: updated.custodyVersion ?? 0,
  };
}

// ── Tier 1 Approval Signal ────────────────────────────────────────
//
// For semi-custodial mode: agent-initiated transactions above a spend
// threshold require explicit user approval before Rocca will sign them.
//
// Module 1 hardening — all four properties:
//
//   1. HMAC-SHA256 signed tokens — Redis is treated as untrusted storage.
//      The API issues tokens signed with APPROVAL_TOKEN_SECRET. On consume,
//      the HMAC is re-computed and verified as the first check (before expiry,
//      before any binding check). Redis poisoning cannot inject a valid token
//      without the secret.
//
//   2. Atomic GETDEL — single Redis command replaces GET + DEL.
//      Eliminates the TOCTOU window where two concurrent requests could
//      both observe the token before either deletes it.
//
//   3. Authoritative amount from decoded txn bytes — the consumer does NOT
//      trust any caller-supplied amount. decodeAxferTotal() decodes each
//      unsigned blob and sums USDC axfers, enforcing: correct asset ID,
//      correct sender (== agent address), non-zero amount.
//
//   4. Canonical groupIdHash from raw bytes — groupIdHash is always
//      SHA-256(concat(raw txn bytes)), computed server-side. The caller
//      never supplies a groupId string. Different transactions → different
//      hash (cryptographically guaranteed).
//
// The approval token is bound to:
//   agentId + amount ceiling + SHA-256(txn bytes) + expiry + walletId + treasuryAddress
//
// Verification order in consumeApprovalToken:
//   1. GETDEL (atomic)
//   2. Parse
//   3. HMAC verify (timingSafeEqual — before any other check)
//   4. Expiry check
//   5. agentId + walletId binding
//   6. Treasury address binding
//   7. Decoded amount check (from txn bytes, not from caller)
//   8. Canonical groupIdHash check (recomputed from txn bytes)

// ── HMAC helpers ──────────────────────────────────────────────────

interface ApprovalTokenRecord {
  agentId:         string;
  amount:          number;  // microUSDC ceiling approved by wallet UI
  groupIdHash:     string;  // SHA-256(concatenated raw txn bytes), hex
  expiry:          number;  // Unix milliseconds
  walletId:        string;  // FIDO2 credential hash of the approving wallet
  treasuryAddress: string;  // config.x402.payToAddress at token issuance time
  hmac:            string;  // HMAC-SHA256 over all above fields, hex-encoded
}

function getApprovalTokenSecret(): Buffer {
  const secret = process.env.APPROVAL_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "APPROVAL_TOKEN_SECRET must be set and at least 32 characters. " +
      "Generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(secret, "utf8");
}

/**
 * Compute HMAC-SHA256 over the approval token payload.
 *
 * Fields are serialised with explicit alphabetical key ordering so the
 * output is deterministic regardless of JavaScript engine or V8 version.
 * All values are primitives (string | number) — no nesting, no undefined.
 */
function computeApprovalHmac(fields: {
  agentId:         string;
  amount:          number;
  expiry:          number;
  groupIdHash:     string;
  treasuryAddress: string;
  walletId:        string;
}): string {
  const payload = JSON.stringify({
    agentId:         fields.agentId,
    amount:          fields.amount,
    expiry:          fields.expiry,
    groupIdHash:     fields.groupIdHash,
    treasuryAddress: fields.treasuryAddress,
    walletId:        fields.walletId,
  });
  return createHmac("sha256", getApprovalTokenSecret())
    .update(payload)
    .digest("hex");
}

// ── Canonical group ID ────────────────────────────────────────────

/**
 * Compute a canonical group ID hash from the raw unsigned transaction bytes.
 *
 * SHA-256 over the concatenation of all raw transaction bytes, in order.
 * This is always computed server-side — callers never supply a groupId string.
 * Any modification to any transaction in the group changes the hash.
 */
function computeGroupIdHash(unsignedTxns: string[]): string {
  if (unsignedTxns.length === 0) {
    throw new Error("computeGroupIdHash: empty transaction list");
  }
  const hasher = createHash("sha256");
  for (const b64 of unsignedTxns) {
    hasher.update(Buffer.from(b64, "base64"));
  }
  return hasher.digest("hex");
}

// ── Authoritative amount decoder ──────────────────────────────────

/**
 * Decode unsigned transaction blobs and sum all valid USDC axfer amounts.
 *
 * Rules (all axfers in the group must pass all three checks):
 *   - txn.type === axfer
 *   - txn.assetTransfer.assetIndex === configured USDC asset ID
 *   - txn.sender === agentAddress
 *   - txn.assetTransfer.amount > 0 (zero-value opt-ins are rejected)
 *
 * Non-axfer transactions (pay, etc.) are skipped — they are permitted in
 * the group but do not contribute to the USDC spend total.
 *
 * Any axfer that fails a check throws immediately — there is no partial
 * acceptance of mixed-asset or wrong-sender transfers.
 *
 * Returns total in micro-USDC. Both caller and callee use the same unit
 * as the stored approval ceiling.
 */
export function decodeAxferTotal(unsignedTxns: string[], agentAddress: string): bigint {
  const usdcAssetId = BigInt(config.x402.usdcAssetId);
  let total = 0n;

  for (const b64 of unsignedTxns) {
    const blob = new Uint8Array(Buffer.from(b64, "base64"));
    const txn  = algosdk.decodeUnsignedTransaction(blob);

    if (txn.type !== algosdk.TransactionType.axfer) continue; // non-axfer: skip

    // Every axfer in the group must be valid USDC from the agent.
    // Anything else is an unexpected transfer — reject the whole group.
    if (!txn.assetTransfer) {
      throw new Error("Malformed axfer transaction: missing assetTransfer fields");
    }
    if (txn.assetTransfer.assetIndex !== usdcAssetId) {
      throw new Error(
        `Unexpected axfer asset ID ${txn.assetTransfer.assetIndex} in approval group — ` +
        `only USDC (asset ${usdcAssetId}) is permitted`,
      );
    }
    if (txn.sender.toString() !== agentAddress) {
      throw new Error(
        `axfer sender ${txn.sender} does not match agent address ${agentAddress} — ` +
        "cross-sender axfer rejected",
      );
    }
    if (txn.assetTransfer.amount === 0n) {
      throw new Error(
        "Zero-value axfer rejected — opt-in transactions must not appear in approval groups",
      );
    }

    total += txn.assetTransfer.amount;
  }

  return total;
}

// ── Token lifecycle ───────────────────────────────────────────────

/**
 * Issue a Tier 1 approval token.
 *
 * The wallet UI calls this after the user reviews and approves the
 * pending transaction group above their configured spend threshold.
 * The unsigned transaction blobs are passed here so the server can
 * compute the canonical groupIdHash — the caller never supplies a
 * groupId string.
 *
 * The token is HMAC-signed over all binding fields (including treasury
 * address) before storage so any Redis-layer tampering is detected at
 * consumption time.
 *
 * Returns a nonce the agent includes in its re-submission.
 */
export async function issueApprovalToken(
  agentId:      string,
  amount:       number,
  unsignedTxns: string[],  // raw txn blobs — groupIdHash derived from these, not from caller
  walletId:     string,
): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const treasuryAddress = config.x402.payToAddress;
  if (!treasuryAddress) {
    throw new Error(
      "X402_PAY_TO_ADDRESS not configured — cannot issue approval token without treasury binding",
    );
  }

  const groupIdHash = computeGroupIdHash(unsignedTxns);
  const nonce       = randomBytes(16).toString("hex");
  const expiry      = Date.now() + APPROVAL_TTL_S * 1_000;
  const hmac        = computeApprovalHmac({
    agentId, amount, expiry, groupIdHash, treasuryAddress, walletId,
  });

  const record: ApprovalTokenRecord = {
    agentId, amount, groupIdHash, expiry, walletId, treasuryAddress, hmac,
  };

  await redis.set(
    `${TIER1_APPROVAL_PREFIX}${agentId}:${nonce}`,
    JSON.stringify(record),
    { ex: APPROVAL_TTL_S },
  );

  return nonce;
}

/**
 * Validate and atomically consume a Tier 1 approval token.
 *
 * Verification order (must not be reordered):
 *   1. GETDEL — atomic consume; concurrent races get null → rejected
 *   2. Parse stored record
 *   3. HMAC verify (timingSafeEqual) — must precede all other checks
 *   4. Expiry — immediately after HMAC; before any binding check
 *   5. agentId + walletId binding
 *   6. Treasury address binding (stored vs current config)
 *   7. Decoded USDC amount from txn bytes (agentAddress from registry)
 *   8. Canonical groupIdHash (recomputed from txn bytes — no caller input)
 */
export async function consumeApprovalToken(
  agentId:      string,
  nonce:        string,
  unsignedTxns: string[],  // base64-encoded unsigned txn blobs
  walletId:     string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const key = `${TIER1_APPROVAL_PREFIX}${agentId}:${nonce}`;

  // ── Step 1: Atomic GETDEL ─────────────────────────────────────
  // Single command — no TOCTOU window. Concurrent requests for the
  // same nonce: exactly one gets the value, the rest get null.
  const raw = await redis.getdel(key) as string | null;
  if (!raw) throw new Error("Approval token not found — expired or already used");

  // ── Step 2: Parse ─────────────────────────────────────────────
  let stored: ApprovalTokenRecord;
  try { stored = JSON.parse(raw) as ApprovalTokenRecord; }
  catch { throw new Error("Corrupt approval token"); }

  // ── Step 3: HMAC verify — must be first check after parse ─────
  // Re-compute over the stored fields. Constant-time comparison
  // prevents timing-oracle attacks on the HMAC byte stream.
  // Checking expiry or any other field BEFORE this step would leak
  // information about stored state to an unauthenticated caller.
  const expectedHmac    = computeApprovalHmac({
    agentId:         stored.agentId,
    amount:          stored.amount,
    expiry:          stored.expiry,
    groupIdHash:     stored.groupIdHash,
    treasuryAddress: stored.treasuryAddress,
    walletId:        stored.walletId,
  });
  const storedHmacBuf   = Buffer.from(stored.hmac ?? "", "hex");
  const expectedHmacBuf = Buffer.from(expectedHmac, "hex");
  if (
    storedHmacBuf.length !== expectedHmacBuf.length ||
    !timingSafeEqual(storedHmacBuf, expectedHmacBuf)
  ) {
    throw new Error("Approval token HMAC invalid — token integrity compromised");
  }

  // ── Step 4: Expiry — immediately after HMAC ───────────────────
  // Checking expiry before HMAC would allow a timing oracle: an attacker
  // could probe whether a forged token has a valid expiry by observing
  // which error path is taken (cheap expiry check vs expensive HMAC).
  if (Date.now() > stored.expiry) throw new Error("Approval token expired");

  // ── Step 5: Wallet and agent binding ─────────────────────────
  if (stored.agentId  !== agentId)  throw new Error("Token agentId mismatch");
  if (stored.walletId !== walletId) throw new Error("Token walletId mismatch — cross-wallet replay blocked");

  // ── Step 6: Treasury address binding ─────────────────────────
  // The stored address must match the current treasury config.
  // If the treasury was reconfigured since issuance, the token is stale.
  // (60s TTL makes this a non-issue in practice; defence in depth.)
  const currentTreasury = config.x402.payToAddress;
  if (stored.treasuryAddress !== currentTreasury) {
    throw new Error(
      `Token treasury mismatch: token bound to ${stored.treasuryAddress}, ` +
      `current treasury is ${currentTreasury}`,
    );
  }

  // ── Step 7: Decoded amount from txn bytes ─────────────────────
  // Look up agent address from registry for sender validation inside
  // decodeAxferTotal. Never trust a caller-supplied amount.
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const txnTotal = decodeAxferTotal(unsignedTxns, agent.address);
  if (txnTotal > BigInt(stored.amount)) {
    throw new Error(
      `Token approves up to ${stored.amount} microUSDC; ` +
      `transaction group total is ${txnTotal} microUSDC`,
    );
  }

  // ── Step 8: Canonical group ID ────────────────────────────────
  // Recomputed from raw txn bytes — caller cannot influence this value.
  const recomputedGroupIdHash = computeGroupIdHash(unsignedTxns);
  if (stored.groupIdHash !== recomputedGroupIdHash) {
    throw new Error(
      "Group ID hash mismatch — submitted transactions do not match the approved group",
    );
  }
}

/** Test-only exports — never call from production code */
export const _custodyTestExports = { computeApprovalHmac, computeGroupIdHash };
