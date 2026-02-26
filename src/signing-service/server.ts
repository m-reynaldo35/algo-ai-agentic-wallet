/**
 * Rocca Signing Microservice
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  SIGNING BOUNDARY — this process holds the private key.             │
 * │  No public ingress. Called only by the main API server.             │
 * │                                                                     │
 * │  Trust model:                                                        │
 * │    Caller authenticates with SIGNING_SERVICE_API_KEY (Bearer token) │
 * │    In production: replace with mTLS (mutual TLS) between services   │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * API contract:
 *
 *   POST /sign
 *     Auth:    Authorization: Bearer <SIGNING_SERVICE_API_KEY>
 *     Body:    SignRequest
 *     200:     SignResponse
 *     400:     { error: string }  malformed request
 *     401:     { error: string }  bad API key or invalid auth token
 *     409:     { error: string }  replay detected (requestId or groupId reused)
 *     429:     { error: string }  rate limited (per-agent or global)
 *     500:     { error: string }  signing failed
 *     503:     { error: string }  system halted
 *
 *   GET /health
 *     200: { status: "ok", signerAddress: string, cohort: string }
 *
 *   GET /metrics
 *     Auth: Bearer <SIGNING_SERVICE_API_KEY>
 *     200: SigningMetrics
 *
 * Request/response schemas are defined as TypeScript interfaces below.
 * They are the authoritative contract — kept here alongside the handler.
 */

import express from "express";
import https from "node:https";
import algosdk from "algosdk";
import helmet from "helmet";
import { validateAuthToken, assertProductionAuthReady, type AuthToken } from "../auth/liquidAuth.js";
import { assertAndFreezeTreasury, assertSignerEnvironment, assertMtlsEnv, assertSignerRedis } from "../protection/envGuard.js";
import { MTLS_ENABLED, loadServerMtlsConfig, logMtlsStatus } from "../protection/mtlsConfig.js";
import { config } from "../config.js";
import { getAgent, isHalted, assignCohort } from "../services/agentRegistry.js";
import { getSignerRedis } from "./signerRedis.js";
import { getRedis } from "../services/redis.js";
import { assertSignerKeyScope } from "../protection/redisAcl.js";
import { writeSigningAudit, getSigningMetrics } from "./signingAudit.js";
import { checkSigningRateLimit } from "./signingRateLimiter.js";

// ── Schema ────────────────────────────────────────────────────────

export interface SignRequest {
  /** Client-generated UUID — used for idempotency and audit. Must be unique per request. */
  requestId: string;
  /** Registered agentId — looked up in registry to confirm it is active */
  agentId: string;
  /** Verified Liquid Auth credential for this agent */
  authToken: AuthToken;
  /** Base64-encoded unsigned transaction blobs (algosdk.encodeUnsignedTransaction output) */
  unsignedTransactions: string[];
}

export interface SignResponse {
  requestId: string;
  /** Base64-encoded signed transaction blobs, same order as input */
  signedTransactions: string[];
  /** The Algorand address that signed (auth-addr of all agent senders) */
  signerAddress: string;
  txnCount: number;
  signedAt: string;
}

export interface SignError {
  error: string;
  requestId?: string;
}

// ── Signing key (this process only) ──────────────────────────────

let _signerAccount: algosdk.Account | null = null;

function getSignerAccount(): algosdk.Account {
  if (_signerAccount) return _signerAccount;

  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_SIGNER_MNEMONIC not configured");

  _signerAccount = algosdk.mnemonicToSecretKey(mnemonic);
  console.log(`[SigningService] Signer loaded: ${_signerAccount.addr}`);
  return _signerAccount;
}

// ── Replay guard (signing-layer, separate from X-PAYMENT guard) ───
//
// Module 7: uses the signing-service-isolated Redis instance (getSignerRedis)
// and the x402:sign:* key namespace to enforce database-level isolation.

const REPLAY_KEY_PREFIX = "x402:sign:replay:";
const REPLAY_TTL_S      = 300; // 5 minutes

async function checkAndConsumeRequestId(requestId: string): Promise<boolean> {
  // Returns true if this is a fresh requestId (not seen before).
  // Uses the signer-isolated Redis when configured; falls back to the shared
  // main-API Redis if SIGNER_REDIS_REST_URL is not set (dev / single-DB mode).
  const redis = getSignerRedis() ?? getRedis();
  if (!redis) {
    // Without Redis we cannot guarantee uniqueness — fail closed
    throw new Error("Redis unavailable — cannot enforce signing replay protection");
  }
  const key = `${REPLAY_KEY_PREFIX}${requestId}`;
  assertSignerKeyScope(key); // ACL gate: only x402:sign:* allowed
  const result = await redis.set(key, "1", { nx: true, ex: REPLAY_TTL_S });
  return result === "OK"; // null = already exists = replay
}

async function checkGroupIdNotSeen(groupId: string): Promise<boolean> {
  const redis = getSignerRedis() ?? getRedis();
  if (!redis) return true; // best-effort when Redis unavailable
  const key = `x402:sign:groupid:${groupId}`;
  assertSignerKeyScope(key); // ACL gate: only x402:sign:* allowed
  const result = await redis.set(key, "1", { nx: true, ex: REPLAY_TTL_S });
  return result === "OK";
}

// ── API key auth ──────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.SIGNING_SERVICE_API_KEY;
  if (!key || key.length < 32) {
    throw new Error("SIGNING_SERVICE_API_KEY must be set and at least 32 characters");
  }
  return key;
}

function verifyBearer(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7);
  const expected = getApiKey();
  // Constant-time comparison — no early return on length mismatch to prevent
  // key-length side-channel. XOR lengths into diff and always iterate maxLen chars.
  const maxLen = Math.max(provided.length, expected.length);
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ── Core signing logic ────────────────────────────────────────────

async function signTransactions(
  unsignedBlobs: Uint8Array[],
): Promise<Uint8Array[]> {
  const account = getSignerAccount();
  return unsignedBlobs.map((blob) => {
    const txn = algosdk.decodeUnsignedTransaction(blob);
    return txn.signTxn(account.sk);
  });
}

function extractGroupId(unsignedBlobs: Uint8Array[]): string {
  const txn = algosdk.decodeUnsignedTransaction(unsignedBlobs[0]);
  if (!txn.group) throw new Error("Transaction has no group ID");
  return Buffer.from(txn.group).toString("base64");
}

// ── Validation steps (in order, abort on first failure) ──────────
//
//   1.  API key authentication
//   2.  Request schema validation
//   3.  System halt check
//   4.  Per-agent rate limit check
//   5.  Global rate limit check
//   6.  requestId replay guard (signing-layer nonce)
//   7.  Liquid Auth token validation
//   8.  Agent registry check (agent exists, is active, cohort matches)
//   9.  Group integrity: all txns share same groupId
//   9b. Business rule: group must contain at least one USDC toll payment to treasury
//  10.  GroupId replay guard (prevents re-signing the same group)
//  11.  Auth-addr check: all txn senders have auth-addr = our signer
//  12.  Sign and return

// ── Express app ───────────────────────────────────────────────────

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // internal service
app.use(express.json({ limit: "512kb" }));

// ── POST /sign ────────────────────────────────────────────────────

app.post("/sign", async (req, res) => {
  const startMs = Date.now();
  const requestId: string = req.body?.requestId ?? "";

  const reject = async (
    status: number,
    error: string,
    agentId = "",
    groupId = "",
    txnCount = 0,
    cohort = "",
  ) => {
    await writeSigningAudit({
      requestId,
      agentId,
      groupId,
      txnCount,
      outcome:         "rejected",
      rejectionReason: error,
      durationMs:      Date.now() - startMs,
      requestedAt:     new Date(startMs).toISOString(),
      signerAddress:   _signerAccount?.addr.toString() ?? "unloaded",
      cohort,
    });
    res.status(status).json({ error, requestId } as SignError);
  };

  // ── Step 1: API key ────────────────────────────────────────────
  if (!verifyBearer(req.headers.authorization)) {
    await reject(401, "Unauthorized: invalid or missing API key");
    return;
  }

  // ── Step 2: Schema validation ──────────────────────────────────
  const body = req.body as Partial<SignRequest>;

  if (!requestId || typeof requestId !== "string" || requestId.length < 8) {
    await reject(400, "Missing or invalid requestId (must be string ≥ 8 chars)");
    return;
  }
  if (!body.agentId || typeof body.agentId !== "string") {
    await reject(400, "Missing agentId");
    return;
  }
  if (!body.authToken || typeof body.authToken !== "object") {
    await reject(400, "Missing authToken");
    return;
  }
  if (!Array.isArray(body.unsignedTransactions) || body.unsignedTransactions.length === 0) {
    await reject(400, "Missing or empty unsignedTransactions");
    return;
  }
  if (body.unsignedTransactions.length > 16) {
    await reject(400, "unsignedTransactions exceeds Algorand group limit of 16");
    return;
  }

  const { agentId, authToken, unsignedTransactions } = body as SignRequest;

  // ── Step 3: Halt check ─────────────────────────────────────────
  const haltRecord = await isHalted();
  if (haltRecord) {
    await reject(503, `Signing service halted: ${haltRecord.reason}`, agentId);
    return;
  }

  // ── Step 4-5: Rate limit ───────────────────────────────────────
  const rateResult = await checkSigningRateLimit(agentId);
  if (!rateResult.allowed) {
    res.setHeader("Retry-After", Math.ceil((rateResult.retryAfterMs ?? 60000) / 1000));
    await reject(429, rateResult.reason ?? "Rate limit exceeded", agentId);
    return;
  }

  // ── Step 6: requestId replay guard ────────────────────────────
  let fresh: boolean;
  try {
    fresh = await checkAndConsumeRequestId(requestId);
  } catch (err) {
    await reject(500, `Replay guard unavailable: ${err instanceof Error ? err.message : err}`, agentId);
    return;
  }
  if (!fresh) {
    await reject(409, `Replay detected: requestId ${requestId} already used`, agentId);
    return;
  }

  // ── Step 7: Liquid Auth token validation ──────────────────────
  try {
    await validateAuthToken(authToken);
  } catch (err) {
    await reject(401, `Auth token invalid: ${err instanceof Error ? err.message : err}`, agentId);
    return;
  }
  if (authToken.agentId !== agentId) {
    await reject(401, `Auth token agentId mismatch: token=${authToken.agentId} request=${agentId}`, agentId);
    return;
  }

  // ── Step 8: Agent registry ────────────────────────────────────
  const agent = await getAgent(agentId);
  if (!agent) {
    await reject(401, `Agent not registered: ${agentId}`, agentId);
    return;
  }
  if (agent.status === "suspended") {
    await reject(403, `Agent is suspended: ${agentId}`, agentId, "", 0, agent.cohort);
    return;
  }
  if (agent.status === "orphaned") {
    await reject(403, `Agent has drift/orphan status: ${agentId} — run verify-registry`, agentId, "", 0, agent.cohort);
    return;
  }
  const expectedCohort = assignCohort(agentId);
  if (agent.cohort !== expectedCohort) {
    await reject(400, `Agent cohort mismatch: expected ${expectedCohort}, got ${agent.cohort}`, agentId, "", 0, agent.cohort);
    return;
  }

  // ── Step 9: Decode blobs and verify group integrity ───────────
  let unsignedBlobs: Uint8Array[];
  let groupId: string;

  try {
    unsignedBlobs = unsignedTransactions.map((b64) =>
      new Uint8Array(Buffer.from(b64, "base64")),
    );

    // All transactions must share the same group ID
    let expectedGroup: Uint8Array | undefined;
    for (let i = 0; i < unsignedBlobs.length; i++) {
      const txn = algosdk.decodeUnsignedTransaction(unsignedBlobs[i]);
      if (!txn.group) {
        throw new Error(`Transaction [${i}] has no group ID — ungrouped transactions refused`);
      }
      if (!expectedGroup) {
        expectedGroup = txn.group;
      } else if (!Buffer.from(txn.group).equals(Buffer.from(expectedGroup))) {
        throw new Error(`Transaction [${i}] group ID mismatch — atomic integrity violated`);
      }
    }

    groupId = Buffer.from(expectedGroup!).toString("base64");
  } catch (err) {
    await reject(400, `Group integrity check failed: ${err instanceof Error ? err.message : err}`, agentId);
    return;
  }

  // ── Step 9b: Business rule — USDC toll payment to treasury ────
  // Every signed group must contain at least one ASA transfer of the
  // configured USDC asset to the treasury pay-to address. This prevents
  // the signing service from signing arbitrary transactions that bypass
  // the x402 payment rail (T3.1 — malicious backend modification).
  //
  // This check is UNCONDITIONAL. assertAndFreezeTreasury() at boot
  // guarantees the address is set and immutable. A missing address here
  // is an invariant violation — we hard-reject rather than skip the check.
  const treasuryAddress = config.x402.payToAddress;
  if (!treasuryAddress) {
    // Boot should have prevented this. Reject every request if we somehow
    // reach here without a treasury address — never sign an unchecked group.
    await reject(500, "Invariant violation: treasury address not configured in signing service", agentId, groupId, unsignedBlobs.length, agent.cohort);
    return;
  }

  const hasToll = unsignedBlobs.some((blob) => {
    const txn = algosdk.decodeUnsignedTransaction(blob);
    // algosdk v3: axfer fields live under txn.assetTransfer
    return (
      txn.type === algosdk.TransactionType.axfer &&
      txn.assetTransfer !== undefined &&
      Number(txn.assetTransfer.assetIndex) === config.x402.usdcAssetId &&
      txn.assetTransfer.receiver.toString() === treasuryAddress
    );
  });
  if (!hasToll) {
    await reject(
      400,
      `Business rule violation: group contains no USDC toll payment to treasury (asset=${config.x402.usdcAssetId}, payTo=${treasuryAddress})`,
      agentId, groupId, unsignedBlobs.length, agent.cohort,
    );
    return;
  }

  // ── Step 10: GroupId replay guard ────────────────────────────
  const groupFresh = await checkGroupIdNotSeen(groupId);
  if (!groupFresh) {
    await reject(409, `Replay detected: groupId already signed within the replay window`, agentId, groupId, unsignedBlobs.length, agent.cohort);
    return;
  }

  // ── Step 11: Verify sender auth-addr on-chain ─────────────────
  // Each unique sender in the group must have auth-addr = our signer.
  // This is the critical gate: we refuse to sign for accounts we don't control.
  const signerAddress = getSignerAccount().addr.toString();
  const uniqueSenders = [...new Set(
    unsignedBlobs.map((blob) => algosdk.decodeUnsignedTransaction(blob).sender.toString()),
  )];

  for (const sender of uniqueSenders) {
    if (sender !== agent.address) {
      await reject(
        400,
        `Transaction sender ${sender} does not match agent address ${agent.address}`,
        agentId, groupId, unsignedBlobs.length, agent.cohort,
      );
      return;
    }
    if (agent.authAddr !== signerAddress) {
      await reject(
        401,
        `Agent registry authAddr ${agent.authAddr} does not match this signer ${signerAddress}`,
        agentId, groupId, unsignedBlobs.length, agent.cohort,
      );
      return;
    }
  }

  // ── Step 12: Sign ─────────────────────────────────────────────
  let signedBlobs: Uint8Array[];
  try {
    signedBlobs = await signTransactions(unsignedBlobs);
  } catch (err) {
    await reject(500, `Signing failed: ${err instanceof Error ? err.message : err}`, agentId, groupId, unsignedBlobs.length, agent.cohort);
    return;
  }

  const durationMs = Date.now() - startMs;

  await writeSigningAudit({
    requestId,
    agentId,
    groupId,
    txnCount:      signedBlobs.length,
    outcome:       "signed",
    durationMs,
    requestedAt:   new Date(startMs).toISOString(),
    signerAddress,
    cohort:        agent.cohort,
  });

  console.log(
    `[SigningService] SIGNED agent=${agentId} group=${groupId.slice(0, 12)}... ` +
    `txns=${signedBlobs.length} duration=${durationMs}ms`,
  );

  const response: SignResponse = {
    requestId,
    signedTransactions: signedBlobs.map((b) => Buffer.from(b).toString("base64")),
    signerAddress,
    txnCount:           signedBlobs.length,
    signedAt:           new Date().toISOString(),
  };

  res.json(response);
});

// ── POST /admin/sign-rekey ────────────────────────────────────────
//
// Platform-only endpoint for custody transitions (rekey-to-user).
// Does NOT enforce the x402 toll check — this is a platform operation,
// not a settlement. Authenticated via SIGNING_SERVICE_API_KEY only.
//
// The main API constructs the unsigned rekey txn; this endpoint validates
// its structure strictly and signs it. Validated properties:
//   - Must be a payment transaction (not axfer — no asset transfers)
//   - Amount must be 0 (no ALGO movement)
//   - Sender must match the agent's registered address
//   - Receiver must equal sender (self-payment / rekey pattern)
//   - rekey_to must equal the declared destinationAddress
//   - custodyVersion must match the registry value (anti-race)
//   - Agent's current auth-addr must equal this signer's address

app.post("/admin/sign-rekey", async (req, res) => {
  if (!verifyBearer(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    agentId,
    destinationAddress,
    custodyVersion,
    unsignedTxnBase64,
  } = req.body as Partial<{
    agentId:            string;
    destinationAddress: string;
    custodyVersion:     number;
    unsignedTxnBase64:  string;
  }>;

  if (
    !agentId ||
    !destinationAddress ||
    typeof custodyVersion !== "number" ||
    !unsignedTxnBase64
  ) {
    res.status(400).json({
      error: "Missing required fields: agentId, destinationAddress, custodyVersion, unsignedTxnBase64",
    });
    return;
  }

  const agent = await getAgent(agentId);
  if (!agent) {
    res.status(404).json({ error: `Agent not found: ${agentId}` });
    return;
  }

  // Custody and version guards — prevent stale or already-transitioned agents
  // Legacy records without these fields are treated as custody="rocca", version=0
  const custody = agent.custody        ?? "rocca";
  const version  = agent.custodyVersion ?? 0;

  if (custody !== "rocca") {
    res.status(409).json({ error: `Agent ${agentId} is not under Rocca custody` });
    return;
  }
  if (version !== custodyVersion) {
    res.status(409).json({
      error: `custodyVersion mismatch: registry=${version}, provided=${custodyVersion}`,
    });
    return;
  }

  const signerAddress = getSignerAccount().addr.toString();
  if (agent.authAddr !== signerAddress) {
    res.status(409).json({
      error: `Agent auth-addr ${agent.authAddr} does not match this signer — cannot sign rekey`,
    });
    return;
  }

  // Decode the unsigned transaction
  let txn: algosdk.Transaction;
  try {
    txn = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(unsignedTxnBase64, "base64")),
    );
  } catch {
    res.status(400).json({ error: "Cannot decode unsigned transaction" });
    return;
  }

  // Strict structural validation — this endpoint must not be a generic signing oracle
  if (txn.type !== algosdk.TransactionType.pay) {
    res.status(400).json({ error: "Admin rekey: transaction must be a payment transaction" });
    return;
  }
  if (!txn.payment || txn.payment.amount !== 0n) {
    res.status(400).json({ error: "Admin rekey: payment amount must be 0" });
    return;
  }
  if (txn.sender.toString() !== agent.address) {
    res.status(400).json({ error: "Admin rekey: sender does not match agent address" });
    return;
  }
  if (txn.payment.receiver.toString() !== agent.address) {
    res.status(400).json({ error: "Admin rekey: receiver must equal sender (self-payment)" });
    return;
  }
  if (!txn.rekeyTo || txn.rekeyTo.toString() !== destinationAddress) {
    res.status(400).json({
      error: "Admin rekey: rekey_to must match declared destinationAddress",
    });
    return;
  }

  // Sign
  const account    = getSignerAccount();
  const signedBlob = txn.signTxn(account.sk);

  console.log(
    `[SigningService] ADMIN-REKEY agent=${agentId} ` +
    `destination=${destinationAddress} custodyVersion=${custodyVersion}`,
  );

  res.json({ signedTxnBase64: Buffer.from(signedBlob).toString("base64") });
});

// ── GET /health ───────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  try {
    const account = getSignerAccount();
    res.json({
      status:        "ok",
      signerAddress: account.addr.toString(),
      cohort:        "A",
    });
  } catch {
    res.status(503).json({ status: "degraded", error: "Signer key not loaded" });
  }
});

// ── GET /metrics ──────────────────────────────────────────────────

app.get("/metrics", async (req, res) => {
  if (!verifyBearer(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const metrics = await getSigningMetrics();
  res.json(metrics);
});

// ── Boot ──────────────────────────────────────────────────────────

// Railway injects PORT; SIGNING_SERVICE_PORT is the override for standalone deploys
const port = parseInt(process.env.PORT ?? process.env.SIGNING_SERVICE_PORT ?? "4021", 10);

// ── Boot order is security-critical. Do not reorder. ─────────────
//
// 1. assertAndFreezeTreasury()
//    Reads X402_PAY_TO_ADDRESS once and deep-freezes config.
//    No runtime code path may alter the treasury address after this point.
//    Step 9b in the signing pipeline depends on this being immutable.
//
// 2. assertSignerEnvironment()
//    Validates that this process is running in a production environment
//    before the mnemonic is decoded. RAILWAY_ENVIRONMENT is the authoritative
//    check because NODE_ENV is not set on this service in Railway.
//    Throws for any non-production value (pr-*, staging, undefined) unless
//    DEV_SIGNER_ALLOWED=true is explicitly set for local testing.
//    This prevents PR preview deployments that inherit env vars from ever
//    decoding the signer key into memory.
//
// 3. getSignerAccount()
//    Decodes ALGO_SIGNER_MNEMONIC into an Ed25519 secret key.
//    Only reached if both guards above pass.

assertAndFreezeTreasury();
assertSignerEnvironment();
assertSignerRedis();          // Module 7: warn if no isolated Redis DB
assertMtlsEnv("server");     // Module 9: fail fast if mTLS enabled but certs missing
getSignerAccount();

// Module 9: log mTLS activation status before starting the server
logMtlsStatus("signing-service");

// ── Module 9: HTTPS/mTLS strict mode ─────────────────────────────
//
// When MTLS_ENABLED=true the signing service starts an HTTPS server
// that demands a client certificate signed by the internal CA.
// Any connection without a valid client cert is rejected at the TLS
// handshake — the application layer never sees the request.
//
// When MTLS_ENABLED=false (default) the server starts in plain HTTP
// and the Bearer token provides the only auth layer.
const httpServer = MTLS_ENABLED
  ? https.createServer(
      {
        ...loadServerMtlsConfig(),
        requestCert:        true,   // demand client cert
        rejectUnauthorized: true,   // reject if not signed by CA
      },
      app,
    )
  : app; // plain HTTP (dev / PERMISSIVE mode — Bearer token only)

const server = httpServer.listen(port, "0.0.0.0", () => {
  console.log(
    `[SigningService] Listening on ${port} (${MTLS_ENABLED ? "HTTPS/mTLS" : "HTTP/Bearer"})`,
  );
  console.log(`[SigningService] Signer: ${getSignerAccount().addr}`);
});

// Hard request timeout — abort hung connections (DOS mitigation T8.1)
server.setTimeout(10_000);
server.keepAliveTimeout = 5_000;

export { app };
