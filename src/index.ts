console.log("Boot start. PORT=", process.env.PORT);

// Algosdk v3 + Node fetch add one abort listener per concurrent request.
// The default limit of 10 fires false-positive warnings under normal load.
// 0 = unlimited (suppresses the warning without masking real leaks, since
// algosdk's concurrent algod calls are the legitimate source).
import { setMaxListeners } from "events";
import https from "https";
setMaxListeners(0);

import { initSentry } from "./lib/sentry.js";
initSentry(); // Must be first — before any other imports touch the network

import algosdk from "algosdk";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { getAlgodClient, getNodeStatus } from "./network/nodely.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { x402Paywall } from "./middleware/x402.js";
import { x402Settle } from "./middleware/x402Settle.js";
import { constructAtomicGroup, constructBatchedAtomicGroup } from "./services/transaction.js";
import type { TradeIntent } from "./services/transaction.js";
import { executePipeline } from "./executor.js";
import { DEFAULT_SLIPPAGE_BIPS } from "./utils/slippage.js";
import { getRedis } from "./services/redis.js";
import { getWebhookDeliveries } from "./services/webhook.js";
import { registerSSEBroadcaster } from "./services/audit.js";
import { requirePortalAuth } from "./middleware/portalAuth.js";
import { getOnboardingQuote, prepareOnboardingGroup, submitOnboardingGroup } from "./services/treasuryFunder.js";
import { startActivationPoller, stopActivationPoller } from "./services/activationPoller.js";
import { assertProductionAuthReady } from "./auth/liquidAuth.js";
import { runBootGuards, assertCrossRegionTreasuryHash } from "./protection/envGuard.js";
import { checkExecutionLimits } from "./protection/executionLimiter.js";
import { isCircuitOpen, recordSuccess, recordFailure } from "./protection/circuitBreaker.js";
import { logRejection } from "./protection/rejectionLogger.js";
import {
  getAgent, listAgents, updateAgentStatus, updateAgentRecord,
  storeAgent, assignCohort,
  setHalt, clearHalt, isHalted,
  storePendingAgent, getPendingAgent, validateAgentId,
  listAgentsByOwner, listPendingAgentsByOwner, listAgentsByWebAuthnOwner,
  claimAgentOwnership, transferAgentOwnership,
  storeClaimChallenge, consumeClaimChallenge,
  linkAlgorandRecovery,
  type PendingAgentRecord,
} from "./services/agentRegistry.js";
import { checkAndReserveVelocity, rollbackVelocityReservation, recordGlobalOutflow, sumUsdcAxfers, getMassDrainStatus, clearMassDrain } from "./protection/velocityEngine.js";
import { atomicReserve, completeReservation, releaseReservation, markTxIdSettled } from "./services/executionIdempotency.js";
import { startRecurringScheduler }       from "./jobs/recurringScheduler.js";
import { runWorker }                     from "./queue/settlementWorker.js";
import { prewarmProvenance }             from "./services/mandateVerifier.js";
import { scanAllAgents }                 from "./services/agentRegistry.js";
import {
  createMandate, revokeMandate, listMandates,
  registerWebAuthnCredential, issueMandateChallenge, registerAlgorandAddress,
  issueWebAuthnRegistrationChallenge, verifyAndRegisterWebAuthn,
  issueWebAuthnLoginChallenge, verifyWebAuthnLoginAssertion,
  issueOwnerWebAuthnLoginChallenge, verifyOwnerWebAuthnLoginAssertion,
  adoptWebAuthnOwner, issueWebAuthnAdoptChallenge,
}                                        from "./services/mandateService.js";
import {
  issueAlgorandChallenge, getLiquidAuthStatus,
  issueAgentPeraChallenge, verifyAgentPeraSignature, consumeVerifiedPeraSession,
}                                        from "./auth/humanAuth.js";
import {
  issueAdminLiquidChallenge, getAdminLiquidStatus,
  consumeAdminLiquidSession,
  issueAdminWebAuthnRegChallenge, verifyAndRegisterAdminWebAuthn,
  issueAdminWebAuthnLoginChallenge, verifyAdminWebAuthnLoginAssertion,
  issueAdminPeraChallenge, verifyAdminPeraSignature, consumeAdminPeraSession,
}                                        from "./auth/adminAuth.js";
import { evaluateMandate }               from "./services/mandateEngine.js";
import { createMandateAgent }            from "./services/mandateFactory.js";
import a2aRouter                         from "./routes/a2a.js";
import { getRecentSecurityEvents, emitSecurityEvent, querySecurityEvents } from "./services/securityAudit.js";
import { validateAuthToken } from "./auth/liquidAuth.js";
import { logMtlsStatus } from "./protection/mtlsConfig.js";
import { verifyMultiSigHalt, isMultiSigConfigured } from "./protection/multiSigHalt.js";
import helmet from "helmet";
import cors from "cors";
import { logger } from "./lib/logger.js";
import { handleMcpRequest } from "./mcp/httpServer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── CORS Policy ─────────────────────────────────────────────────
// Explicitly deny all cross-origin requests to the API.
// The developer portal (separate origin) uses server-side proxying
// through /api/live/* so it does not need CORS headers here.
// If browser-based agents need direct access in future, add allowed
// origins via CORS_ALLOWED_ORIGINS env var.
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  methods: ["GET", "POST", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-PAYMENT",
    "X-Portal-Key",
    "x-api-key",
    "X-SLIPPAGE-BIPS",
    "X-Algo-Mnemonic",
    "X-Agent-Id",
    "X-Api-Url",
  ],
  credentials: false,
}));

// ── Security Headers (helmet) ───────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true,
  xFrameOptions: { action: "deny" },
}));

// ── HTTPS Enforcement (production) ─────────────────────────────
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.header("x-forwarded-proto") === "http"
  ) {
    res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    return;
  }
  next();
});

app.use(express.json({ limit: "256kb" })); // Limit request body size

// ── API versioning: /v1/* → /* (canonical is /v1/, old paths kept as aliases) ──
// Rewriting before routing means all existing handlers work for both paths.
app.use((req, _res, next) => {
  if (req.url.startsWith("/v1/")) {
    req.url = req.url.slice(3); // "/v1/api/execute" → "/api/execute"
  }
  next();
});

// ── Serve public/skill.md and other static assets ─────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── A2A Agent Card discovery ─────────────────────────────────────
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "agent-card.json"));
});

// ── A2A Agent-to-Agent endpoint (open — mandate/velocity gated internally) ──
app.use("/a2a", a2aRouter);

// ── Rate Limiting (Upstash sliding window — all routes including /health, /a2a) ─
app.use(rateLimiter);

// ── API info manifest (machine-readable; landing page is served by static middleware) ──
app.get("/api/info", (_req, res) => {
  res.json({
    name: "Algo AI Wallet Router",
    protocol: "x402-v1",
    network: "algorand-mainnet",
    docs: {
      manifest: "https://api.ai-agentic-wallet.com/moltbook-agent.json",
      registry: "https://api.ai-agentic-wallet.com/openclaw-registry.json",
    },
    endpoints: {
      health: "GET /health",
      agentAction: "POST /api/agent-action",
      batchAction: "POST /api/batch-action",
      execute: "POST /api/execute",
    },
  });
});

// ── Health ──────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const [node, haltRecord, circuitState] = await Promise.all([
    getNodeStatus(),
    isHalted(),
    isCircuitOpen(),
  ]);

  // Redis ping
  let redisOk = false;
  try {
    const redis = getRedis();
    if (redis) {
      await (redis._ioredis?.ping?.() ?? Promise.resolve("PONG"));
      redisOk = true;
    }
  } catch { /* redis down */ }

  // Indexer reachability (lightweight HEAD-like call)
  let indexerOk = false;
  try {
    const r = await fetch(`${config.algorand.indexerUrl}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    indexerOk = r.ok;
  } catch { /* indexer unreachable */ }

  const nodeUrl  = node.algodUrl;
  const provider = nodeUrl.includes("nodely") ? "nodely"
    : (nodeUrl.includes("localhost") || nodeUrl.includes("127.0.0.1")) ? "local"
    : "custom";

  const halted = !!(haltRecord as unknown);
  const allOk  = node.healthy && redisOk && !halted;

  res.json({
    status:     halted ? "halted" : allOk ? "ok" : "degraded",
    protocol:   "x402",
    apiVersion: "v1",
    network:    node.network,
    halted,
    node: {
      provider,
      algod:         node.algodUrl,
      indexer:       node.indexerUrl,
      usingFallback: node.usingFallback,
      latestRound:   node.latestRound,
      indexerOk,
    },
    redis: redisOk,
    circuit: {
      open:         circuitState.open,
      failureCount: circuitState.failureCount,
    },
  });
});

// ── Construct unsigned atomic group (x402-gated) ────────────────
app.post("/api/agent-action", x402Paywall, async (req, res) => {
  try {
    const { senderAddress, amount, destinationChain, destinationRecipient } = req.body;

    if (!senderAddress || typeof senderAddress !== "string") {
      res.status(400).json({ error: "Missing required field: senderAddress" });
      return;
    }

    const slippageHeader = req.header("X-SLIPPAGE-BIPS");
    const slippageBips = slippageHeader
      ? parseInt(slippageHeader, 10)
      : DEFAULT_SLIPPAGE_BIPS;

    if (Number.isNaN(slippageBips)) {
      res.status(400).json({ error: "X-SLIPPAGE-BIPS header must be an integer" });
      return;
    }

    const sandboxExport = await constructAtomicGroup(
      senderAddress,
      amount,
      destinationChain,
      destinationRecipient,
      slippageBips,
    );

    res.json({
      status: "awaiting_signature",
      export: sandboxExport,
      instructions: [
        "1. POST this export to /api/execute with your agentId to settle on-chain.",
        "2. Or route atomicGroup.transactions[] to Rocca Wallet manually.",
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "[agent-action] Failed to construct atomic group");
    res.status(500).json({ error: "Failed to construct atomic group" });
  }
});

// ── Execute full pipeline: validate → auth → sign → broadcast ───
app.post("/api/execute", requirePortalAuth, async (req, res) => {
  try {
    const { sandboxExport, agentId, mandateId } = req.body;

    if (!sandboxExport || !agentId) {
      res.status(400).json({ error: "Missing required fields: sandboxExport, agentId" });
      return;
    }

    if (typeof agentId !== "string" || agentId.length < 3 || agentId.length > 128) {
      res.status(400).json({ error: "agentId must be a string between 3 and 128 characters" });
      return;
    }

    const sandboxId: string = sandboxExport?.sandboxId ?? "";

    // ── Phase 1.5: Operational protection layer ────────────────
    // Extract the agent's on-chain address for per-agent rate keys.
    // Falls back to agentId string if the sandbox export is malformed.
    const publicAddress: string =
      (sandboxExport?.routing?.requiredSigner as string | undefined) ?? agentId;
    const clientIp = req.ip;

    // Circuit breaker — checked first so a tripped circuit never
    // consumes agent quota and returns a clear 503 before rate checks.
    const circuit = await isCircuitOpen();
    if (circuit.open) {
      await logRejection("CIRCUIT_OPEN", publicAddress, clientIp, "SIGNER_CIRCUIT_OPEN");
      res.status(503).json({
        error:           "SIGNER_CIRCUIT_OPEN",
        message:         "Signing service is temporarily unavailable due to repeated failures.",
        failureCount:    circuit.failureCount,
      });
      return;
    }

    // Rate limits — burst → per-agent → global (in strictness order)
    const limit = await checkExecutionLimits(publicAddress);
    if (!limit.allowed) {
      const rejType =
        limit.violation === "GLOBAL_RATE_LIMIT_EXCEEDED" ? "GLOBAL_LIMIT" :
        limit.violation === "AGENT_BURST_LIMIT"          ? "BURST_LIMIT"  :
                                                           "RATE_LIMIT";
      await logRejection(rejType, publicAddress, clientIp, limit.violation!);

      const httpStatus = limit.violation === "GLOBAL_RATE_LIMIT_EXCEEDED" ? 503 : 429;
      res.setHeader("Retry-After", Math.ceil((limit.retryAfterMs ?? 60_000) / 1_000));
      res.status(httpStatus).json({
        error:        limit.violation,
        retryAfterMs: limit.retryAfterMs,
      });
      return;
    }

    // ── Authorization: mandate path or legacy velocity path ───
    // Decode the USDC amount from the transaction blobs server-side
    // (never trust a caller-supplied amount field).
    const txnBlobs = (sandboxExport?.atomicGroup?.transactions ?? []) as string[];
    const proposedMicroUsdc = sumUsdcAxfers(txnBlobs);
    let usedMandatePath = false;

    if (mandateId && typeof mandateId === "string") {
      // ── Mandate path: evaluate against AP2 mandate ─────────
      // Skips velocity check; mandate rolling windows used instead.
      const evalResult = await evaluateMandate(agentId, mandateId, txnBlobs);
      if (!evalResult.allowed) {
        const isVelocityCode = evalResult.code === "VELOCITY_10M_EXCEEDED" ||
                               evalResult.code === "VELOCITY_24H_EXCEEDED" ||
                               evalResult.code === "MAX_PER_TX_EXCEEDED";
        res.status(isVelocityCode ? 402 : 403).json({
          error:   evalResult.code ?? "MANDATE_REJECTED",
          message: evalResult.message ?? "Mandate evaluation rejected",
        });
        return;
      }
      usedMandatePath = true;

    } else if (proposedMicroUsdc > 0n) {
      // ── MANDATE_REQUIRED guard ──────────────────────────────
      // If this agent has active mandates, ALL payments MUST go through
      // the mandate path. The mandate is the owner's blast-radius control —
      // allowing an agent to bypass it via the velocity path would defeat
      // the product's core security guarantee.
      const activeMandates = await listMandates(agentId);
      if (activeMandates.length > 0) {
        res.status(403).json({
          error:               "MANDATE_REQUIRED",
          message:             "This agent has active mandates. All payments must reference a valid mandateId.",
          activeMandateCount:  activeMandates.length,
          hint:                "Include mandateId in the request body, or revoke all mandates to use the velocity path.",
        });
        return;
      }

      // ── Velocity path: atomic check+reserve ────────────────
      // checkAndReserveVelocity atomically checks the rolling windows AND
      // records the reservation in one Redis round-trip (Lua script).
      // This prevents concurrent requests from both passing the check
      // before either records its spend (multi-region race condition T1).
      try {
        const velocity = await checkAndReserveVelocity(agentId, proposedMicroUsdc);
        if (velocity.serviceUnavailable) {
          res.status(503).json({
            error:      "SERVICE_UNAVAILABLE",
            message:    "Velocity enforcement store unreachable — cannot verify spend limits above micro-threshold. Retry when Redis is restored.",
            retryAfter: 30,
          });
          return;
        }
        if (velocity.requiresApproval) {
          res.status(402).json({
            error:            "VELOCITY_APPROVAL_REQUIRED",
            message:          "Spend velocity exceeds threshold — submit a Tier 1 approval token",
            tenMinTotal:      velocity.tenMinTotal.toString(),
            dayTotal:         velocity.dayTotal.toString(),
            threshold10m:     velocity.threshold10m.toString(),
            threshold24h:     velocity.threshold24h.toString(),
            proposedMicroUsdc: proposedMicroUsdc.toString(),
          });
          return;
        }
        // Attach reservation key so we can roll back on pipeline failure
        (req as unknown as Record<string, unknown>)._velocityReservationKey = velocity.reservationKey;
      } catch (velocityErr) {
        logger.error({ err: velocityErr instanceof Error ? velocityErr.message : velocityErr }, "[execute] velocity check threw");
      }
    }

    // ── Idempotency guard: globally-atomic sandboxId reservation ──
    // atomicReserve() uses SET NX so only ONE region instance can win
    // the execution slot. The old GET → execute → SET pattern was a
    // TOCTOU race: two concurrent instances could both GET null and
    // both execute the pipeline.
    const redis = getRedis();
    const reservation = await atomicReserve(sandboxId);
    if (reservation.status === "completed") {
      res.setHeader("X-Idempotent-Replay", "true");
      res.json(reservation.cachedResult);
      return;
    }
    if (reservation.status === "processing") {
      res.status(202).json({
        status:  "processing",
        message: "Settlement in progress — retry in a few seconds",
        sandboxId,
      });
      return;
    }
    if (reservation.status === "unavailable") {
      res.status(503).json({
        error:      "SERVICE_UNAVAILABLE",
        message:    "Idempotency store unreachable — cannot guarantee safe execution. Retry when Redis is restored.",
        retryAfter: 30,
      });
      return;
    }
    // status === "ok" — we hold the reservation; proceed to execute

    const result = await executePipeline(sandboxExport, agentId);

    // ── Phase 1.5: Circuit breaker feedback ───────────────────
    if (result.success) {
      // Any successful submission resets the failure counter immediately.
      recordSuccess().catch((e) => logger.warn({ err: e }, "[execute] recordSuccess failed"));
    } else if (result.failedStage === "sign" || result.failedStage === "broadcast") {
      // Only RPC/infrastructure failures feed the circuit breaker.
      // Rate-limit rejections (429) from the signing service are policy decisions,
      // not infrastructure failures — do not open the circuit for them.
      const isRateLimit = /rate.limit|429/i.test(result.error ?? "");
      if (!isRateLimit) {
        recordFailure(`stage=${result.failedStage}: ${result.error ?? "unknown"}`).catch((e) => logger.warn({ err: e }, "[execute] recordFailure failed"));
      }
    }

    if (!result.success) {
      // Release the execution reservation so the client can retry
      releaseReservation(sandboxId).catch((e) => logger.warn({ err: e }, "[execute] releaseReservation failed"));
      // Roll back the velocity reservation so the failed attempt does not
      // consume the agent's spend allowance.
      const reservationKey = (req as unknown as Record<string, unknown>)._velocityReservationKey as string | undefined;
      if (!usedMandatePath && reservationKey) {
        rollbackVelocityReservation(agentId, reservationKey).catch((e) => logger.warn({ err: e }, "[execute] rollbackVelocity failed"));
      }
      res.status(502).json({
        error: "Settlement pipeline failed",
        failedStage: result.failedStage,
      });
      return;
    }

    // ── Record global outflow for mass drain tracking ──────────
    if (!usedMandatePath && proposedMicroUsdc > 0n) {
      recordGlobalOutflow(agentId, proposedMicroUsdc).catch((e) => logger.warn({ err: e }, "[execute] recordGlobalOutflow failed"));
    }

    // ── Async path: job queued, return immediately ─────────────
    if (result.queued) {
      res.json({
        success:              true,
        queued:               true,
        jobId:                result.jobId,
        status:               "queued",
        agentId:              result.agentId,
        sandboxId:            result.sandboxId,
        estimatedConfirmMs:   4000,
        pollUrl:              `/api/jobs/${result.jobId}`,
        streamUrl:            `/api/jobs/${result.jobId}/stream`,
      });
      return;
    }

    // ── Mark execution complete (replaces pending marker, 24h TTL) ──
    // Awaited first so the idempotency result is durable before we mark
    // the txnId. If this fails and the key expires, a retry can re-execute;
    // markTxIdSettled below will then return wasNew=false (already settled)
    // which surfaces the crash-recovery anomaly at the call site below.
    try {
      await completeReservation(sandboxId, result);
    } catch (err) {
      logger.error({ err }, "[execute] completeReservation failed — idempotency gap possible");
    }

    // ── Mark confirmed txnId as settled (7-day retention) ─────
    if (result.settlement?.txnId) {
      const { wasNew } = await markTxIdSettled(result.settlement.txnId, {
        agentId,
        sandboxId,
        groupId:        result.settlement.groupId,
        confirmedRound: result.settlement.confirmedRound,
        settledAt:      result.settlement.settledAt,
      });
      if (!wasNew) {
        logger.warn(
          { txnId: result.settlement.txnId, sandboxId },
          "[execute] markTxIdSettled NX=false — crash-recovery: completeReservation did not persist",
        );
      }
    }

    // ── Gas warning headers — advisory, best-effort ───────────────
    // Fetch agent ALGO balance with a 1.5s timeout so we never block the
    // response for a slow algod call.  Headers are omitted if the call
    // times out or the address is unknown.
    if (publicAddress && publicAddress !== agentId) {
      try {
        const algod = getAlgodClient();
        const info  = await Promise.race<{ amount?: bigint | number } | null>([
          algod.accountInformation(publicAddress).do() as Promise<{ amount?: bigint | number }>,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
        ]);
        if (info) {
          const MBR_MICRO = 200_000n; // 0.1 base + 0.1 USDC optin
          const balance   = BigInt(info.amount ?? 0n);
          const above     = balance > MBR_MICRO ? balance - MBR_MICRO : 0n;
          const remaining = above / 1_000n; // each txn costs ~1 000 µALGO in fees
          const status    = above < 50_000n ? "critical" : above < 200_000n ? "low" : "ok";
          res.setHeader("X-Agent-Gas-Status",    status);
          res.setHeader("X-Agent-Gas-Remaining", remaining.toString());
        }
      } catch { /* non-blocking — header omitted on algod error */ }
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "[execute] Pipeline execution failed");
    res.status(500).json({ error: "Pipeline execution failed" });
  }
});

// ── Batched atomic settlement (x402-gated) ──────────────────────
app.post("/api/batch-action", x402Paywall, async (req, res) => {
  try {
    const { senderAddress, intents } = req.body;

    if (!senderAddress || typeof senderAddress !== "string") {
      res.status(400).json({ error: "Missing required field: senderAddress" });
      return;
    }

    if (!Array.isArray(intents) || intents.length === 0) {
      res.status(400).json({ error: "Missing or empty intents array" });
      return;
    }

    if (intents.length > 16) {
      res.status(400).json({ error: "Maximum 16 intents per batch (Algorand atomic group limit)" });
      return;
    }

    const sandboxExport = await constructBatchedAtomicGroup(
      senderAddress,
      intents as TradeIntent[],
    );

    res.json({
      status: "awaiting_signature",
      export: sandboxExport,
      batchSize: sandboxExport.batchSize,
      instructions: [
        `1. ${sandboxExport.batchSize} trades bundled into a single atomic group.`,
        "2. POST this export to /api/execute with your agentId to settle all trades atomically.",
        "3. If ANY trade fails, ALL trades revert — zero partial execution risk.",
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "[batch-action] Failed to construct batched atomic group");
    res.status(500).json({ error: "Failed to construct batched atomic group" });
  }
});

// ── Weather data (x402-gated demo endpoint) ─────────────────────
// Atomic payment-then-deliver flow:
//   1. POST /api/weather (no X-PAYMENT) → 402 challenge
//   2. Client builds proof, retries with X-PAYMENT header
//   3. x402Paywall verifies identity + replay protection
//   4. x402Settle executes USDC toll inline (sign → enqueue) — data gated on success
//   5. Handler fetches weather and returns { weather, jobId }
//   6. Client polls /api/jobs/{jobId} to get the confirmed on-chain txnId
//
/** HTTPS GET that avoids Node's undici/native-fetch (which can enter a broken
 *  state on Railway after network blips). Uses the stable `https` core module. */
function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = { timeout: 10_000, headers: { "User-Agent": "algo-wallet/1.0" } };
    const req = https.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T); }
        catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("https request timed out")); });
    req.on("error", reject);
  });
}

// 60-second in-process cache for weather data per city.
// Prevents Open-Meteo rate-limits under burst load.
const _weatherCache = new Map<string, { data: unknown; expiresAt: number }>();
const WEATHER_CACHE_TTL_MS = 60_000;

app.post("/api/weather", x402Paywall, x402Settle, async (req, res) => {
  try {
    const { city = "Lagos" } = req.body;

    const cacheKey = city.toLowerCase().trim();
    const cached = _weatherCache.get(cacheKey);
    let weatherPayload: { city: string; country: string; temperature_c: number; wind_speed_kmh: number; weather_code: number; timestamp: string } | undefined;

    if (cached && cached.expiresAt > Date.now()) {
      weatherPayload = cached.data as typeof weatherPayload;
    } else {
      // Geocode city name → lat/lon
      const geoData = await httpsGetJson<{
        results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
      }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
      const loc = geoData.results?.[0];
      if (!loc) {
        res.status(404).json({ error: `City not found: ${city}` });
        return;
      }

      // Fetch current conditions from Open-Meteo (free, no API key)
      const weatherData = await httpsGetJson<{
        current: { temperature_2m: number; wind_speed_10m: number; weather_code: number; time: string };
      }>(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,wind_speed_10m,weather_code&timezone=auto`);

      weatherPayload = {
        city:           loc.name,
        country:        loc.country,
        temperature_c:  weatherData.current.temperature_2m,
        wind_speed_kmh: weatherData.current.wind_speed_10m,
        weather_code:   weatherData.current.weather_code,
        timestamp:      weatherData.current.time,
      };
      _weatherCache.set(cacheKey, { data: weatherPayload, expiresAt: Date.now() + WEATHER_CACHE_TTL_MS });
    }

    // Payment already executed by x402Settle — deliver data with settlement reference
    res.json({
      weather:         weatherPayload,
      status:          "settled",
      jobId:           req.x402!.settlementJobId,
      agentId:         req.x402!.settlementAgentId,
      toll_micro_usdc: config.x402.priceMicroUsdc,
      pollUrl:         `/api/jobs/${req.x402!.settlementJobId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err: message }, "[weather] Failed to fetch weather data");
    res.status(500).json({ error: "Weather data unavailable", detail: message });
  }
});

// ── Job Status Routes ───────────────────────────────────────────
// Poll or stream the status of an async settlement job.

app.get("/api/jobs/:jobId", requirePortalAuth, async (req, res) => {
  try {
    const { getJob } = await import("./queue/jobStore.js");
    const job = await getJob(String(req.params.jobId));
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({
      jobId:          job.jobId,
      status:         job.status,
      agentId:        job.agentId,
      sandboxId:      job.sandboxId,
      enqueuedAt:     job.enqueuedAt,
      updatedAt:      job.updatedAt,
      txnId:          job.txnId,
      confirmedRound: job.confirmedRound,
      settledAt:      job.settledAt,
      error:          job.error,
      ...(job.txnId ? { explorerUrl: `https://allo.info/tx/${job.txnId}` } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

// SSE stream — pushes a single event when the job completes, then closes.
app.get("/api/jobs/:jobId/stream", requirePortalAuth, async (req, res) => {
  const jobId = String(req.params.jobId);

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Immediately send current status
  const { getJob } = await import("./queue/jobStore.js");
  const initial = await getJob(jobId).catch(() => null);
  if (!initial) { send("error", { error: "Job not found" }); res.end(); return; }

  send("status", { jobId, status: initial.status, txnId: initial.txnId });

  if (initial.status === "confirmed" || initial.status === "failed") {
    send("done", { jobId, status: initial.status, txnId: initial.txnId, error: initial.error });
    res.end();
    return;
  }

  // Poll until terminal state
  const POLL_MS   = 500;
  const TIMEOUT_S = 120;
  let elapsed = 0;

  const interval = setInterval(async () => {
    elapsed += POLL_MS;
    const job = await getJob(jobId).catch(() => null);
    if (!job) { clearInterval(interval); send("error", { error: "Job not found" }); res.end(); return; }

    send("status", { jobId, status: job.status, txnId: job.txnId });

    if (job.status === "confirmed" || job.status === "failed") {
      clearInterval(interval);
      send("done", {
        jobId,
        status:         job.status,
        txnId:          job.txnId,
        confirmedRound: job.confirmedRound,
        settledAt:      job.settledAt,
        error:          job.error,
        ...(job.txnId ? { explorerUrl: `https://allo.info/tx/${job.txnId}` } : {}),
      });
      res.end();
      return;
    }

    if (elapsed >= TIMEOUT_S * 1000) {
      clearInterval(interval);
      send("timeout", { jobId, message: `Job not confirmed within ${TIMEOUT_S}s` });
      res.end();
    }
  }, POLL_MS);

  req.on("close", () => clearInterval(interval));
});

// ── Portal Telemetry Routes ─────────────────────────────────────

function parseRange(range: string): number {
  const ms: Record<string, number> = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  return ms[range] ?? ms["24h"];
}

/** Safe JSON.parse — returns null on malformed input, never throws */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParse(s: unknown): any {
  if (typeof s !== "string") return s ?? null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Bounded integer query param */
function intParam(raw: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

app.get("/api/portal/telemetry", requirePortalAuth, async (_req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.json({ metrics: [], recentEvents: [] });
    return;
  }

  try {
    const now = Date.now();
    const dayAgo = now - 86400000;

    // Fetch 24h settlements and all recent events
    const [settlements, events] = await Promise.all([
      redis.zrange("x402:settlements", dayAgo, now, { byScore: true }) as Promise<string[]>,
      redis.zrange("x402:events", dayAgo, now, { byScore: true }) as Promise<string[]>,
    ]);

    const parsedSettlements = settlements.map((s) => safeParse(s)).filter(Boolean);
    const parsedEvents = events.map((e) => safeParse(e)).filter(Boolean);

    // Aggregate metrics
    const totalUsdc = parsedSettlements.reduce((sum: number, s: { tollAmountMicroUsdc?: number }) => sum + (s.tollAmountMicroUsdc || 0), 0);
    const uniqueAgents = new Set(parsedSettlements.map((s: { agentId: string }) => s.agentId));
    const replayCount = parsedEvents.filter((e: { failureReason?: string }) => e.failureReason === "VALIDATION_ERROR").length;
    const breachCount = parsedEvents.filter((e: { failureReason?: string }) => e.failureReason === "POLICY_BREACH").length;
    const rateLimitCount = parsedEvents.filter((e: { event?: string }) => e.event === "rate.limit").length;

    const metrics = [
      { label: "Total USDC Revenue", value: `$${(totalUsdc / 1e6).toFixed(2)}`, delta: "24h window", status: "positive" },
      { label: "Settlements (24h)", value: String(parsedSettlements.length), status: "positive" },
      { label: "Blocked Replays", value: String(replayCount), status: replayCount > 0 ? "negative" : "neutral" },
      { label: "Blocked TEAL Breaches", value: String(breachCount), status: breachCount > 0 ? "negative" : "neutral" },
      { label: "Rate Limit Hits", value: String(rateLimitCount), status: "neutral" },
      { label: "Active Agents", value: String(uniqueAgents.size), status: "positive" },
    ];

    // Return 10 most recent events combined
    const allEvents = [...parsedSettlements, ...parsedEvents]
      .sort((a: { settledAt?: string; timestamp?: string }, b: { settledAt?: string; timestamp?: string }) => {
        const ta = new Date(a.settledAt || a.timestamp || 0).getTime();
        const tb = new Date(b.settledAt || b.timestamp || 0).getTime();
        return tb - ta;
      })
      .slice(0, 10);

    res.json({ metrics, recentEvents: allEvents });
  } catch (err) {
    console.error("[portal/telemetry]", err);
    res.json({ metrics: [], recentEvents: [] });
  }
});

app.get("/api/portal/treasury-status", requirePortalAuth, async (_req, res) => {
  try {
    const mnemonic = process.env.ALGO_TREASURY_MNEMONIC;
    // Gas station removed — replaced by ALGO-triggered activation poller.
    // Keep the gasStation response shape for admin portal backward compat.
    const gasEnabled   = false;
    const intervalS    = 0;
    const triggerMicro = 0;
    const topupMicro   = 0;

    let treasuryAddress: string | null = null;
    let algoBalanceMicro: number | null = null;
    let usdcBalanceMicro: number | null = null;

    if (mnemonic) {
      const account = algosdk.mnemonicToSecretKey(mnemonic);
      treasuryAddress = account.addr.toString();

      const algod = getAlgodClient();
      const info  = await algod.accountInformation(treasuryAddress).do();
      algoBalanceMicro = Number(info.amount ?? 0);

      const NETWORK = process.env.ALGORAND_NETWORK ?? "testnet";
      const USDC_ASSET_ID = NETWORK === "mainnet" ? 31566704 : 10458941;
      const assets = (info.assets ?? []) as unknown as Array<{ assetId?: bigint; amount: bigint | number }>;
      const usdcAsset = assets.find((a) => Number(a.assetId) === USDC_ASSET_ID);
      usdcBalanceMicro = usdcAsset ? Number(usdcAsset.amount) : 0;
    }

    res.json({
      gasStation: {
        enabled:      gasEnabled && !!mnemonic,
        configured:   !!mnemonic,
        intervalS,
        triggerMicro,
        topupMicro,
      },
      treasury: {
        address:          treasuryAddress,
        algoBalanceMicro,
        usdcBalanceMicro,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[portal/treasury-status]", msg);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/portal/settlements", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.json({ settlements: [], total: 0 });
    return;
  }

  try {
    const range = parseRange(req.query.range as string || "7d");
    const status = (req.query.status as string) || "all";
    const agent = ((req.query.agent as string) || "").slice(0, 128);
    const offset = intParam(req.query.offset as string, 0, 0, 100000);
    const limit  = intParam(req.query.limit as string,  25, 1, 100);

    const now = Date.now();
    const entries = await redis.zrange("x402:settlements", now - range, now, { byScore: true, rev: true }) as string[];
    let parsed = entries.map((s: string) => safeParse(s)).filter(Boolean);

    // Map to portal Settlement shape
    parsed = parsed.map((s: { txnId?: string; agentId: string; tollAmountMicroUsdc?: number; settledAt?: string }, i: number) => ({
      id: `stl-${String(i + 1).padStart(3, "0")}`,
      time: s.settledAt || new Date().toISOString(),
      agentId: s.agentId,
      status: "confirmed" as const,
      amountMicroUsdc: s.tollAmountMicroUsdc || 0,
      txnId: s.txnId || "unknown",
      chain: "algorand-mainnet",
    }));

    if (status !== "all") {
      parsed = parsed.filter((s: { status: string }) => s.status === status);
    }
    if (agent) {
      parsed = parsed.filter((s: { agentId: string }) => s.agentId.toLowerCase().includes(agent.toLowerCase()));
    }

    const total = parsed.length;
    const page = parsed.slice(offset, offset + limit);

    res.json({ settlements: page, total });
  } catch (err) {
    console.error("[portal/settlements]", err);
    res.json({ settlements: [], total: 0 });
  }
});

app.get("/api/portal/events", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.json({ events: [] });
    return;
  }

  try {
    const range = parseRange(req.query.range as string || "24h");
    const type = (req.query.type as string) || "all";
    const agent = ((req.query.agent as string) || "").slice(0, 128);

    const now = Date.now();
    const [settlements, failures] = await Promise.all([
      redis.zrange("x402:settlements", now - range, now, { byScore: true, rev: true }) as Promise<string[]>,
      redis.zrange("x402:events", now - range, now, { byScore: true, rev: true }) as Promise<string[]>,
    ]);

    // Map both to the portal AuditEvent shape
    let events = [
      ...settlements.map((s: string, i: number) => {
        const p = safeParse(s);
        if (!p) return null;
        return {
          id: `evt-s-${i}`,
          time: p.settledAt || new Date().toISOString(),
          type: "settlement.success" as const,
          agentId: p.agentId,
          detail: `Toll: ${((p.tollAmountMicroUsdc || 0) / 1e6).toFixed(2)} USDC — ${p.txnId || "pending"}`,
        };
      }),
      ...failures.map((e: string, i: number) => {
        const p = safeParse(e);
        if (!p) return null;
        const evtType = p.event === "rate.limit" ? "rate.limit" : "execution.failure";
        return {
          id: `evt-f-${i}`,
          time: (p.timestamp as string) || new Date().toISOString(),
          type: evtType as "execution.failure" | "rate.limit",
          agentId: (p.agentId as string) || "unknown",
          detail: (p.error as string) || (p.failureReason as string) || "Unknown failure",
        };
      }),
    ].filter(Boolean);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (events as any[]).sort((a: { time: string }, b: { time: string }) => new Date(b.time).getTime() - new Date(a.time).getTime());

    if (type !== "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events = (events as any[]).filter((e: { type: string }) => e.type === type);
    }
    if (agent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events = (events as any[]).filter((e: { agentId: string }) => (e.agentId || "").toLowerCase().includes(agent.toLowerCase()));
    }

    res.json({ events: events.slice(0, 100) });
  } catch (err) {
    console.error("[portal/events]", err);
    res.json({ events: [] });
  }
});

// ── Portal API Key Management ────────────────────────────────────

const API_KEYS_HASH = "x402:api-keys";

interface ApiKeyEntry {
  id: string;
  name: string;
  platform: string;
  key: string;
  webhookUrl: string;
  created: string;
  status: "active" | "revoked";
  usageCount: number;
  rateLimit: string;
}

app.get("/api/portal/api-keys", requirePortalAuth, async (_req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.json([]);
    return;
  }
  try {
    const raw = await redis.hgetall(API_KEYS_HASH) as Record<string, string> | null;
    if (!raw || Object.keys(raw).length === 0) {
      res.json([]);
      return;
    }
    const keys: ApiKeyEntry[] = Object.values(raw)
      .map((v) => safeParse(v) as ApiKeyEntry | null)
      .filter((v): v is ApiKeyEntry => v !== null);
    keys.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
    res.json(keys);
  } catch (err) {
    console.error("[portal/api-keys GET]", err);
    res.json([]);
  }
});

app.post("/api/portal/api-keys", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.status(503).json({ error: "Redis not available" });
    return;
  }
  try {
    const { name, platform, webhookUrl } = req.body;
    if (!name || !platform) {
      res.status(400).json({ error: "Missing required fields: name, platform" });
      return;
    }
    const id = crypto.randomUUID();
    const entry: ApiKeyEntry = {
      id,
      name,
      platform,
      key: `x402_live_${platform.slice(0, 2)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      webhookUrl: webhookUrl || `https://${platform}/webhooks/x402`,
      created: new Date().toISOString().slice(0, 10),
      status: "active",
      usageCount: 0,
      rateLimit: "100 req/min",
    };
    // Write main record + secondary index for O(1) rate limiter lookups
    const keyHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", Buffer.from(entry.key))
    ).toString("hex");
    await Promise.all([
      redis.hset(API_KEYS_HASH, { [id]: JSON.stringify(entry) }),
      redis.set(`x402:api-key-index:${keyHash}`, id),
    ]);
    res.json(entry);
  } catch (err) {
    console.error("[portal/api-keys POST]", err);
    res.status(500).json({ error: "Failed to create API key" });
  }
});

app.patch("/api/portal/api-keys/:id/revoke", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.status(503).json({ error: "Redis not available" });
    return;
  }
  try {
    const id = String(req.params.id || "");
    const raw = await redis.hget(API_KEYS_HASH, id) as string | null;
    if (!raw) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    const entry = safeParse(raw) as ApiKeyEntry | null;
    if (!entry) { res.status(500).json({ error: "Corrupted key record" }); return; }
    entry.status = "revoked";
    // Delete secondary index so revoked keys fail rate limiter lookup immediately
    const keyHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", Buffer.from(entry.key))
    ).toString("hex");
    await Promise.all([
      redis.hset(API_KEYS_HASH, { [id]: JSON.stringify(entry) }),
      redis.del(`x402:api-key-index:${keyHash}`),
    ]);
    res.json(entry);
  } catch (err) {
    console.error("[portal/api-keys PATCH]", err);
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

// ── Portal Settlement Volume ────────────────────────────────────

app.get("/api/portal/settlement-volume", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.json({ data: [], total: 0 });
    return;
  }
  try {
    const days = intParam(req.query.days as string, 7, 1, 30);
    const now = Date.now();
    const rangeMs = days * 86400000;
    const entries = await redis.zrange("x402:settlements", now - rangeMs, now, { byScore: true }) as string[];

    // Bucket into daily counts
    const buckets: Record<string, number> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }

    for (const raw of entries) {
      const s = safeParse(raw);
      if (!s) continue;
      const date = ((s.settledAt as string) || new Date().toISOString()).slice(0, 10);
      if (date in buckets) buckets[date]++;
    }

    const data = Object.entries(buckets).map(([date, value]) => ({
      label: new Date(date).toLocaleDateString("en-US", { weekday: "short" }),
      value,
    }));

    const total = data.reduce((s, d) => s + d.value, 0);
    res.json({ data, total });
  } catch (err) {
    console.error("[portal/settlement-volume]", err);
    res.json({ data: [], total: 0 });
  }
});

// ── Portal Config ───────────────────────────────────────────────

app.get("/api/portal/config", requirePortalAuth, (_req, res) => {
  res.json({
    network: `algorand-${config.algorand.network}`,
    serverUrl: process.env.SERVER_URL || `http://localhost:${config.port}`,
    rateLimits: {
      ipMax: parseInt(process.env.RATE_LIMIT_IP_MAX || "30", 10),
      ipWindow: `${process.env.RATE_LIMIT_IP_WINDOW || "10"}s`,
      platformMax: parseInt(process.env.RATE_LIMIT_PLATFORM_MAX || "100", 10),
      platformWindow: `${process.env.RATE_LIMIT_PLATFORM_WINDOW || "10"}s`,
    },
  });
});

// Register SSE broadcaster with the audit service (avoids circular dep)
registerSSEBroadcaster(broadcastSSE);

// ── Portal Webhook Delivery Log ─────────────────────────────────

app.get("/api/portal/webhook-deliveries", requirePortalAuth, async (_req, res) => {
  try {
    const deliveries = await getWebhookDeliveries(100);
    res.json({ deliveries });
  } catch (err) {
    console.error("[portal/webhook-deliveries]", err);
    res.json({ deliveries: [] });
  }
});

// ── SSE: Real-time Event Stream ──────────────────────────────────
// Clients subscribe to GET /api/portal/stream and receive server-sent
// events as settlements and failures are written to Redis pub/sub.
// Falls back to polling if Redis pub/sub is unavailable.

const sseClients = new Set<{ res: import("express").Response; id: string }>();

/// Helper: broadcast to all active SSE clients
export function broadcastSSE(eventType: string, data: unknown): void {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

app.get("/api/portal/stream", requirePortalAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const clientId = crypto.randomUUID();
  const client = { res, id: clientId };
  sseClients.add(client);

  // Send a heartbeat comment every 20s to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

// ── Agent Registration ───────────────────────────────────────────
//
// USDC-native onboarding (no manual ALGO required):
// ── Agent registration routes ─────────────────────────────────────────────────
//
// Mandate architecture (non-custodial, AVM-enforced):
//   POST /api/agents/register-mandate  — register agent + MandateContract app ID
//
// USDC-native onboarding (operator-funded factory):
//   GET  /api/agents/onboarding-quote   — live USDC fee for MBR funding (public)
//   POST /api/agents/prepare-onboarding — build atomic group (treasury pre-signs ALGO tx)
//   POST /api/agents/activate           — submit signed group + register agent
//
// Keypair generation (factory path):
//   POST /api/agents/create            — generate keypair, show mnemonic once
//
// Management:
//   GET  /api/agents                   — list registered agents
//   GET  /api/agents/:agentId          — fetch a single agent record
//   PATCH /api/agents/:agentId/suspend — suspend an agent

// Agent creation — generates a keypair and returns the mnemonic once.
// After saving the mnemonic, deploy a MandateContract via MandateFactory.create_agent(),
// then register via POST /api/agents/register-mandate with the returned app ID.
// Per-IP cap: max 10 per hour.
app.post("/api/agents/create", requirePortalAuth, async (req, res) => {
  try {
    const { agentId, ownerWalletId: creationOwnerWalletId } = req.body as { agentId?: string; ownerWalletId?: string };

    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "Missing required field: agentId" });
      return;
    }

    // ── Validate format ────────────────────────────────────────────
    try { validateAgentId(agentId); } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid agentId" });
      return;
    }

    // ── Duplicate check ────────────────────────────────────────────
    const existing = await getAgent(agentId);
    if (existing) {
      res.status(409).json({ error: `Agent already registered: ${agentId}` });
      return;
    }
    const existingPending = await getPendingAgent(agentId);
    if (existingPending) {
      res.status(409).json({
        error:   `Agent ${agentId} is already pending activation.`,
        address: existingPending.address,
        nextStep: `Send at least 0.5 ALGO to ${existingPending.address} to activate.`,
      });
      return;
    }

    // ── Per-IP hourly cap ──────────────────────────────────────────
    const redis = getRedis();
    if (redis) {
      const forwarded   = req.header("X-Forwarded-For");
      const trustedHops = parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10);
      let ip = req.socket?.remoteAddress || req.ip || "unknown";
      if (forwarded) {
        const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
        const idx  = Math.max(0, hops.length - trustedHops);
        if (hops[idx]) ip = hops[idx];
      }
      const { createHash } = await import("node:crypto");
      const ipHash   = createHash("sha256").update(ip).digest("hex").slice(0, 16);
      const limitKey = `x402:create-limit:ip:${ipHash}`;
      try {
        const count = await redis.incr(limitKey) as number;
        if (count === 1) await redis.expire(limitKey, 3600);
        if (count > 10) {
          res.status(429).json({
            error:      "Too Many Requests",
            detail:     "Maximum 10 keypair generations per IP per hour.",
            retryAfter: 3600,
          });
          return;
        }
      } catch { /* Redis error — allow through */ }
    }

    // ── Generate keypair and store pending record ──────────────────
    const agentAccount   = algosdk.generateAccount();
    const agentAddress   = agentAccount.addr.toString();
    const mnemonic       = algosdk.secretKeyToMnemonic(agentAccount.sk);
    const secretKeyB64   = Buffer.from(agentAccount.sk).toString("base64");
    const platform       = typeof req.body.platform === "string" ? req.body.platform : undefined;
    const ownerAddress   = typeof req.body.ownerAddress === "string" ? req.body.ownerAddress : undefined;

    const pending: PendingAgentRecord = {
      agentId,
      address:      agentAddress,
      secretKeyB64,
      platform,
      ownerAddress,
      ownerWalletId: creationOwnerWalletId ?? undefined,
      createdAt:    new Date().toISOString(),
    };
    await storePendingAgent(pending);

    res.status(201).json({
      agentId,
      address:           agentAddress,
      mnemonic,
      minimumFundingAlgo: 0.5,
      warning:  "Save this mnemonic — it will be deleted from our systems after your agent activates.",
      nextStep: `Send at least 0.5 ALGO to ${agentAddress}. Your agent will activate automatically within ~10 seconds of the deposit confirming.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[agents/create]", message);
    res.status(500).json({ error: "Agent creation failed", detail: message });
  }
});

// ── Mandate-Architecture Agent Creation (portal-managed) ────────
//
// POST /api/agents/create-mandate
//   Calls MandateFactory.create_agent() on-chain via the operator wallet.
//   The operator is set as the contract's master wallet, allowing the
//   server to call opt_in_usdc() automatically once the contract is funded.
//
//   Body:  { agentId, agentKey, maxPerTx?, velocityCap?, dailyCap? }
//   Returns: { agentId, address, mandateAppId, appAddress, deployTxid }
//
// Default caps (in micro-USDC):
//   maxPerTx:    1_000_000  ($1.00)
//   velocityCap: 5_000_000  ($5.00 / 10 min)
//   dailyCap:   50_000_000  ($50.00 / day)

const DEFAULT_MAX_PER_TX    = 1_000_000;
const DEFAULT_VELOCITY_CAP  = 5_000_000;
const DEFAULT_DAILY_CAP     = 50_000_000;
const ALGO_ADDR_RE_CM       = /^[A-Z2-7]{58}$/;

app.post("/api/agents/create-mandate", requirePortalAuth, async (req, res) => {
  try {
    const {
      agentId,
      agentKey,
      maxPerTx    = DEFAULT_MAX_PER_TX,
      velocityCap = DEFAULT_VELOCITY_CAP,
      dailyCap    = DEFAULT_DAILY_CAP,
      platform,
      ownerAddress,
    } = req.body as {
      agentId:      unknown;
      agentKey:     unknown;
      maxPerTx?:    number;
      velocityCap?: number;
      dailyCap?:    number;
      platform?:    string;
      ownerAddress?: string;
    };

    // ── Validate inputs ────────────────────────────────────────────
    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "Missing required field: agentId" });
      return;
    }
    if (!agentKey || typeof agentKey !== "string" || !ALGO_ADDR_RE_CM.test(agentKey)) {
      res.status(400).json({ error: "Missing or invalid field: agentKey (must be a 58-char Algorand address)" });
      return;
    }
    if (typeof maxPerTx !== "number" || maxPerTx <= 0) {
      res.status(400).json({ error: "maxPerTx must be a positive integer (micro-USDC)" });
      return;
    }
    if (typeof velocityCap !== "number" || velocityCap <= 0) {
      res.status(400).json({ error: "velocityCap must be a positive integer (micro-USDC)" });
      return;
    }
    if (typeof dailyCap !== "number" || dailyCap <= 0 || velocityCap > dailyCap) {
      res.status(400).json({ error: "dailyCap must be a positive integer ≥ velocityCap (micro-USDC)" });
      return;
    }

    try { validateAgentId(agentId); } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid agentId" });
      return;
    }

    // ── Duplicate check ────────────────────────────────────────────
    const existing = await getAgent(agentId);
    if (existing) {
      res.status(409).json({ error: `Agent already registered: ${agentId}` });
      return;
    }

    // ── Deploy MandateContract via factory ─────────────────────────
    const { mandateAppId, appAddress, txid: deployTxid } = await createMandateAgent(
      agentKey,
      maxPerTx,
      velocityCap,
      dailyCap,
    );

    // ── Store agent record ─────────────────────────────────────────
    const record = {
      agentId,
      address:              agentKey,
      cohort:               assignCohort(agentId),
      authAddr:             agentKey,   // non-custodial — agent is its own auth
      custody:              "user" as const,
      custodyVersion:       0,
      mandateAppId,
      mandateOperatorMaster: true,       // operator = master wallet → server can call opt_in_usdc()
      platform,
      ownerAddress,
      createdAt:            new Date().toISOString(),
      registrationTxnId:    deployTxid,
      status:               "registered" as const, // poller sets "active" once USDC arrives
    };

    await storeAgent(record);

    res.status(201).json({
      agentId,
      address:     agentKey,
      mandateAppId,
      appAddress,
      deployTxid,
      nextSteps: [
        `Send ≥0.5 ALGO to ${appAddress} (contract MBR + fee reserve).`,
        `Server will call opt_in_usdc() automatically within ~10s of the deposit confirming.`,
        `Send USDC to ${appAddress} — agent activates automatically when USDC balance > 0.`,
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[agents/create-mandate]", message);
    res.status(500).json({ error: "Mandate agent creation failed", detail: message });
  }
});

// ── Mandate-Architecture Registration (self-deployed) ────────────
//
// For agents that deployed their own MandateContract via deploy.py.
// No on-chain operations — just records the agentId → address → mandateAppId.
//
// POST /api/agents/register-mandate
//   Body: { agentId, address, mandateAppId }
//   Returns: { status: "registered", agentId, address, mandateAppId }

const ALGO_ADDR_RE_MANDATE = /^[A-Z2-7]{58}$/;

app.post("/api/agents/register-mandate", requirePortalAuth, async (req, res) => {
  try {
    const { agentId, address, mandateAppId, platform, ownerAddress } = req.body as {
      agentId:      unknown;
      address:      unknown;
      mandateAppId: unknown;
      platform?:    string;
      ownerAddress?: string;
    };

    // ── Validate inputs ──────────────────────────────────────────
    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "Missing required field: agentId" });
      return;
    }
    if (!address || typeof address !== "string" || !ALGO_ADDR_RE_MANDATE.test(address)) {
      res.status(400).json({ error: "Missing or invalid field: address (must be a 58-char Algorand address)" });
      return;
    }
    if (!mandateAppId || typeof mandateAppId !== "number" || !Number.isInteger(mandateAppId) || mandateAppId <= 0) {
      res.status(400).json({ error: "Missing or invalid field: mandateAppId (must be a positive integer application ID)" });
      return;
    }

    try { validateAgentId(agentId); } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid agentId" });
      return;
    }

    // ── Duplicate check ──────────────────────────────────────────
    const existing = await getAgent(agentId);
    if (existing) {
      res.status(409).json({ error: `Agent already registered: ${agentId}` });
      return;
    }

    // ── Store record ─────────────────────────────────────────────
    // Non-custodial mandate agent: no Rocca signer, no rekey.
    // custody = "user" — agent holds their own key.
    // authAddr left as address (no rekey = auth-addr IS the address).
    const record = {
      agentId,
      address,
      cohort:            assignCohort(agentId),
      authAddr:          address,  // no rekey — agent is their own auth
      custody:           "user" as const,
      custodyVersion:    0,
      mandateAppId,
      platform,
      ownerAddress,
      createdAt:         new Date().toISOString(),
      registrationTxnId: "",       // no on-chain registration txn
      status:            "active" as const,
    };

    await storeAgent(record);

    res.status(201).json({
      status:       "registered",
      agentId,
      address,
      mandateAppId,
      custody:      "user",
      instructions: [
        `Agent ${agentId} registered with MandateContract app ID ${mandateAppId}.`,
        `The agent signs pay() calls with their own key — no Rocca rekeying required.`,
        `Ensure the MandateContract is opted into USDC before making payments.`,
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[agents/register-mandate]", message);
    res.status(500).json({ error: "Mandate agent registration failed", detail: message });
  }
});

// ── USDC-Native Onboarding ───────────────────────────────────────
//
// Three-step flow that eliminates manual ALGO acquisition:
//   1. GET  /api/agents/onboarding-quote     — live pricing (USDC cost for MBR)
//   2. POST /api/agents/prepare-onboarding   — build atomic group (treasury pre-signs ALGO tx)
//   3. POST /api/agents/activate             — submit signed group + register agent
//
// The payer signs only the USDC transfer using any Algorand wallet (Pera, Defly, SDK).
// Treasury atomically sends ALGO to the new agent wallet in the same group.

// Step 1 — public (no portal auth required; agents can query this autonomously)
app.get("/api/agents/onboarding-quote", async (_req, res) => {
  try {
    const quote = await getOnboardingQuote();
    res.json(quote);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[agents/onboarding-quote]", message);
    res.status(500).json({ error: "Failed to generate onboarding quote", detail: message });
  }
});

// Step 2 — build the partially-signed atomic group
app.post("/api/agents/prepare-onboarding", requirePortalAuth, async (req, res) => {
  try {
    const { payerAddress, agentAddress } = req.body;

    if (!payerAddress || typeof payerAddress !== "string") {
      res.status(400).json({ error: "Missing required field: payerAddress" });
      return;
    }
    if (!agentAddress || typeof agentAddress !== "string") {
      res.status(400).json({ error: "Missing required field: agentAddress" });
      return;
    }

    const prepared = await prepareOnboardingGroup(payerAddress, agentAddress);

    // Single-use quote nonce — expires in 90s (matches quote.expiresAt).
    // activate checks + deletes this key, rejecting expired or replayed calls.
    const onboardingRedis = getRedis();
    if (onboardingRedis) {
      await onboardingRedis.set(`x402:onboarding:nonce:${prepared.groupIdB64}`, "1", { ex: 90 });
    }

    res.json({
      ...prepared,
      instructions: [
        "Sign unsignedUsdcTxB64 with your payer wallet (the wallet that holds USDC).",
        "Then call POST /api/agents/activate with signedUsdcTxB64, signedAlgoTxB64, agentId, and mnemonic.",
        "Quote expires in 90 seconds — complete activation before expiry.",
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.startsWith("Invalid payerAddress") || message.startsWith("Invalid agentAddress")) {
      res.status(400).json({ error: message });
      return;
    }
    console.error("[agents/prepare-onboarding]", message);
    res.status(500).json({ error: "Failed to prepare onboarding group" });
  }
});

// Step 3 — submit atomic group + register agent
app.post("/api/agents/activate", requirePortalAuth, async (req, res) => {
  try {
    const { agentId, mnemonic, signedUsdcTxB64, signedAlgoTxB64, groupIdB64, platform } = req.body;

    if (!agentId  || typeof agentId  !== "string") { res.status(400).json({ error: "Missing required field: agentId" });         return; }
    if (!mnemonic || typeof mnemonic !== "string") { res.status(400).json({ error: "Missing required field: mnemonic" });        return; }
    if (!signedUsdcTxB64 || typeof signedUsdcTxB64 !== "string") { res.status(400).json({ error: "Missing required field: signedUsdcTxB64" }); return; }
    if (!signedAlgoTxB64 || typeof signedAlgoTxB64 !== "string") { res.status(400).json({ error: "Missing required field: signedAlgoTxB64" }); return; }
    if (!groupIdB64      || typeof groupIdB64      !== "string") { res.status(400).json({ error: "Missing required field: groupIdB64 (returned by prepare-onboarding)" }); return; }

    // Quote nonce check — reject if expired (> 90s) or already used.
    // groupIdB64 was returned by prepare-onboarding and stored in Redis with 90s TTL.
    // HIGH-1: Use atomic GETDEL so concurrent requests cannot both pass the
    // exists check before either deletes — eliminates the TOCTOU race.
    const activateRedis = getRedis();
    if (activateRedis) {
      const nonceKey = `x402:onboarding:nonce:${groupIdB64}`;
      const consumed = await activateRedis.getdel(nonceKey);
      if (!consumed) {
        res.status(410).json({ error: "Onboarding quote has expired or was already used. Call prepare-onboarding again." });
        return;
      }
    }

    // Submit the atomic group — treasury ALGO arrives at agent wallet on confirmation
    const fundingTxId = await submitOnboardingGroup(signedUsdcTxB64, signedAlgoTxB64);

    // Mandate architecture: return the funded address.
    // The agent must now deploy a MandateContract via MandateFactory.create_agent()
    // and register via POST /api/agents/register-mandate with the returned app ID.
    const agentAccount = algosdk.mnemonicToSecretKey(mnemonic);
    const agentAddress = agentAccount.addr.toString();

    res.status(201).json({
      status:      "funded",
      agentId,
      address:     agentAddress,
      fundingTxId,
      nextStep:    "Deploy a MandateContract via MandateFactory.create_agent(), then call POST /api/agents/register-mandate with the returned mandateAppId.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("already registered")) { res.status(409).json({ error: message }); return; }
    if (message.includes("Invalid agentId"))     { res.status(400).json({ error: message }); return; }
    if (message.includes("Group ID mismatch"))   { res.status(400).json({ error: message }); return; }
    console.error("[agents/activate]", message);
    res.status(500).json({ error: "Agent activation failed" });
  }
});

// ── Owner-level auth (wallet-first, no agent ID required) ─────────────────
// Generates and verifies a signed challenge to prove ownership of an Algorand address.

app.post("/api/owner/auth/challenge", requirePortalAuth, async (req, res) => {
  try {
    const { randomBytes, createHash } = await import("node:crypto");
    const challengeBytes = randomBytes(32);
    const challengeB64   = challengeBytes.toString("base64");
    const challengeId    = createHash("sha256").update(challengeBytes).digest("hex").slice(0, 32);

    const redis = getRedis();
    if (!redis) {
      res.status(503).json({ error: "Redis not available" });
      return;
    }
    await redis.set(`x402:owner-challenge:${challengeId}`, challengeB64, { ex: 300 });
    res.json({ challengeId, challengeB64 });
  } catch (err) {
    console.error("[owner/auth/challenge]", err);
    res.status(500).json({ error: "Failed to generate challenge" });
  }
});

app.post("/api/owner/auth/verify", requirePortalAuth, async (req, res) => {
  try {
    const { challengeId, address, signatureB64 } = req.body as {
      challengeId?: string;
      address?: string;
      signatureB64?: string;
    };

    if (!challengeId || !address || !signatureB64) {
      res.status(400).json({ error: "challengeId, address, and signatureB64 required" });
      return;
    }

    const redis = getRedis();
    if (!redis) {
      res.status(503).json({ error: "Redis not available" });
      return;
    }

    const stored = await redis.getdel<string>(`x402:owner-challenge:${challengeId}`);
    if (!stored) {
      res.status(401).json({ error: "Challenge expired or not found" });
      return;
    }

    const challengeBytes = Buffer.from(typeof stored === "string" ? stored : JSON.stringify(stored), "base64");
    const sigBytes       = Buffer.from(signatureB64, "base64");

    const valid = algosdk.verifyBytes(challengeBytes, sigBytes, address);
    if (!valid) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    res.json({ ownerAddress: address });
  } catch (err) {
    console.error("[owner/auth/verify]", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ── Owner-level WebAuthn (master account / passkey login without agentId) ───
// POST /api/owner/auth/webauthn-challenge
//   Issue a challenge; no agentId required.
// POST /api/owner/auth/webauthn-login
//   Verify assertion; return ownerWalletId (and implicitly all linked agents).

app.post("/api/owner/auth/webauthn-challenge", requirePortalAuth, rateLimiter, async (_req, res) => {
  try {
    res.json(await issueOwnerWebAuthnLoginChallenge());
  } catch (err) {
    console.error("[owner/auth/webauthn-challenge]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

app.post("/api/owner/auth/webauthn-login", requirePortalAuth, async (req, res) => {
  const { challengeId, assertion } = req.body as { challengeId?: string; assertion?: unknown };
  if (!challengeId || !assertion) {
    res.status(400).json({ error: "challengeId and assertion required" });
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await verifyOwnerWebAuthnLoginAssertion(challengeId, assertion as any);
    res.json(result);
  } catch (err) {
    console.error("[owner/auth/webauthn-login]", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "Verification failed" });
  }
});

app.post("/api/owner/auth/link-algorand-recovery", requirePortalAuth, async (req, res) => {
  const { ownerWalletId, algorandAddress } = req.body as { ownerWalletId?: string; algorandAddress?: string };
  if (!ownerWalletId || !algorandAddress) {
    res.status(400).json({ error: "ownerWalletId and algorandAddress required" });
    return;
  }
  if (!ownerWalletId.startsWith("webauthn:")) {
    res.status(400).json({ error: "ownerWalletId must be a passkey identity (webauthn:...)" });
    return;
  }
  try {
    const linkedAgents = await linkAlgorandRecovery(ownerWalletId, algorandAddress);
    res.json({ ok: true, linkedAgents, recoveryAddress: algorandAddress });
  } catch (err) {
    console.error("[owner/auth/link-algorand-recovery]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

app.get("/api/agents", requirePortalAuth, async (req, res) => {
  try {
    if (req.query.ownerWalletId && typeof req.query.ownerWalletId === "string") {
      const agents = await listAgentsByWebAuthnOwner(req.query.ownerWalletId);
      res.json({ agents, count: agents.length });
      return;
    }
    if (req.query.owner && typeof req.query.owner === "string") {
      const [active, pending] = await Promise.all([
        listAgentsByOwner(req.query.owner),
        listPendingAgentsByOwner(req.query.owner),
      ]);
      // Active agents take precedence — if an agent just activated, remove from pending list
      const activeIds = new Set(active.map((a) => a.agentId));
      const pendingFiltered = pending.filter((p) => !activeIds.has(p.agentId));
      const agents = [...active, ...pendingFiltered];
      res.json({ agents, count: agents.length });
      return;
    }
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "50"), 10), 100);
    const offset = parseInt(String(req.query.offset ?? "0"),  10);
    const agents = await listAgents(limit, offset);
    res.json({ agents, count: agents.length });
  } catch (err) {
    console.error("[agents/list]", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

app.get("/api/agents/:agentId", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const agent   = await getAgent(agentId);

    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${agentId}` });
      return;
    }

    // Strip the raw COSE public key — it is only needed server-side for
    // WebAuthn assertion verification and should not be exposed to clients.
    // webauthnCredentialId is kept (already exposed via mandate challenge).
    const { webauthnPublicKey: _stripped, ...safeAgent } = agent;
    res.json(safeAgent);
  } catch (err) {
    console.error("[agents/get]", err);
    res.status(500).json({ error: "Failed to fetch agent" });
  }
});

// Per-agent settlement history — queries the global x402:settlements ZSET and
// filters in-memory by agentId. The ZSET is capped at 1,000 entries so the
// scan is bounded. Returns the most-recent `limit` settlements for this agent.
app.get("/api/agents/:agentId/settlements", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  if (!agentId) { res.status(400).json({ error: "Missing agentId" }); return; }

  const redis = getRedis();
  if (!redis) { res.json({ settlements: [] }); return; }

  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
    const now   = Date.now();
    // Scan last 90 days (matches typical retention window)
    const entries = await redis.zrange("x402:settlements", now - 90 * 86_400_000, now, { byScore: true, rev: true }) as string[];
    const settlements = entries
      .map((s) => safeParse(s))
      .filter((s) => s?.agentId === agentId)
      .slice(0, limit);
    res.json({ settlements });
  } catch (err) {
    console.error("[agents/:agentId/settlements]", err);
    res.status(500).json({ error: "Failed to fetch settlement history" });
  }
});

app.patch("/api/agents/:agentId/unsuspend", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    await updateAgentStatus(agentId, "active");
    res.json({ agentId, status: "active" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("not found")) { res.status(404).json({ error: message }); return; }
    res.status(500).json({ error: "Failed to unsuspend agent" });
  }
});

// Claim ownership of an orphan agent — proves ownership via signed challenge
app.post("/api/agents/:agentId/claim", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const { ownerAddress, signatureB64, challengeB64 } = req.body as {
      ownerAddress?: string;
      signatureB64?: string;
      challengeB64?: string;
    };

    if (!agentId || !ownerAddress || !signatureB64 || !challengeB64) {
      res.status(400).json({ error: "agentId, ownerAddress, signatureB64, challengeB64 required" });
      return;
    }

    const challengeBytes = Buffer.from(challengeB64, "base64");
    const sigBytes       = Buffer.from(signatureB64, "base64");
    const valid = algosdk.verifyBytes(challengeBytes, sigBytes, ownerAddress);
    if (!valid) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    await claimAgentOwnership(agentId, ownerAddress);
    const updated = await getAgent(agentId);
    res.json({ ok: true, agent: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already owned")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: "Claim failed", detail: msg });
    }
  }
});

// Transfer agent ownership — current owner signs to prove authority
app.post("/api/agents/:agentId/transfer", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    const { fromAddress, toAddress, signatureB64, challengeB64 } = req.body as {
      fromAddress?: string;
      toAddress?: string;
      signatureB64?: string;
      challengeB64?: string;
    };

    if (!agentId || !fromAddress || !toAddress || !signatureB64 || !challengeB64) {
      res.status(400).json({ error: "agentId, fromAddress, toAddress, signatureB64, challengeB64 required" });
      return;
    }

    // Verify fromAddress signed the challenge
    const challengeBytes = Buffer.from(challengeB64, "base64");
    const sigBytes       = Buffer.from(signatureB64, "base64");
    const valid = algosdk.verifyBytes(challengeBytes, sigBytes, fromAddress);
    if (!valid) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    await transferAgentOwnership(agentId, fromAddress, toAddress);
    const updated = await getAgent(agentId);
    res.json({ ok: true, agent: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else if (msg.includes("Not authorised")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Transfer failed", detail: msg });
    }
  }
});

app.patch("/api/agents/:agentId/suspend", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    // Load before suspend so we have the address for cache invalidation
    const agentForCache = await getAgent(agentId);
    await updateAgentStatus(agentId, "suspended");
    // Eagerly invalidate auth-addr cache so Rule 3 re-fetches on next request
    if (agentForCache?.address) {
      getRedis()?.del(`x402:authaddr:${agentForCache.address}`).catch(() => {});
    }
    res.json({ agentId, status: "suspended" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    console.error("[agents/suspend]", err);
    res.status(500).json({ error: "Failed to suspend agent" });
  }
});

// ── Emergency Halt ───────────────────────────────────────────────
// GET  /api/system/halt-status — check if halt is active
// POST /api/system/halt        — set halt (body: { reason })
// POST /api/system/unhalt      — clear halt

app.get("/api/system/halt-status", requirePortalAuth, async (_req, res) => {
  const haltRecord = await isHalted();
  res.json({
    halted:     !!haltRecord,
    haltReason: haltRecord?.reason ?? null,
  });
});

app.post("/api/system/halt", requirePortalAuth, async (req, res) => {
  // T8.2: Require HALT_OVERRIDE_KEY to prevent insider / compromised-portal abuse.
  // Without this, any valid portal session could halt the signing pipeline.
  const overrideKey = process.env.HALT_OVERRIDE_KEY;
  if (overrideKey) {
    const provided = String(req.body?.overrideKey ?? "");
    if (provided !== overrideKey) {
      res.status(403).json({ error: "Forbidden: invalid HALT_OVERRIDE_KEY" });
      return;
    }
  }
  const reason = String(req.body?.reason ?? "Manual halt via portal API");
  await setHalt(reason);
  logger.warn({ reason }, "[system/halt] Halt set via API");
  res.json({ halted: true, reason });
});

app.post("/api/system/unhalt", requirePortalAuth, async (req, res) => {
  // T8.2: Require HALT_OVERRIDE_KEY to resume signing after a halt.
  const overrideKey = process.env.HALT_OVERRIDE_KEY;
  if (overrideKey) {
    const provided = String(req.body?.overrideKey ?? "");
    if (provided !== overrideKey) {
      res.status(403).json({ error: "Forbidden: invalid HALT_OVERRIDE_KEY" });
      return;
    }
  }
  await clearHalt();
  logger.info("[system/unhalt] Halt cleared via API");
  res.json({ halted: false });
});


// ── AP2 Mandate Endpoints ─────────────────────────────────────────
//
// PATCH /api/agents/:agentId/webauthn-pubkey
//   Register the owner's FIDO2 public key (Standard WebAuthn path). Immutable once set.
//
// GET  /api/agents/:agentId/mandates
//   List active mandates for an agent.
//
// POST /api/agents/:agentId/mandate/challenge
//   Issue a single-use WebAuthn challenge for mandate operations (Standard WebAuthn path).
//
// POST /api/agents/:agentId/mandate/create
//   Create a new AP2 mandate.
//   Auth: webauthnAssertion (Standard WebAuthn) | liquidAuthSessionId (Liquid Auth QR).
//
// POST /api/agents/:agentId/mandate/:mandateId/revoke
//   Revoke a mandate.
//   Auth: webauthnAssertion (Standard WebAuthn) | liquidAuthSessionId (Liquid Auth QR).

app.patch("/api/agents/:agentId/webauthn-pubkey", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { ownerWalletId, credentialId, publicKeyCose, counter } = req.body as {
    ownerWalletId?: string;
    credentialId?:  string;
    publicKeyCose?: string;
    counter?:       number;
  };

  if (!ownerWalletId || !credentialId || !publicKeyCose || typeof counter !== "number") {
    res.status(400).json({
      error: "Missing required fields: ownerWalletId, credentialId, publicKeyCose, counter",
    });
    return;
  }

  try {
    await registerWebAuthnCredential(agentId, ownerWalletId, credentialId, publicKeyCose, counter);
    res.json({ agentId, ownerWalletId, status: "registered" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : msg.includes("mismatch") ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

app.get("/api/agents/:agentId/mandates", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const includeRevoked = req.query.includeRevoked === "true";
  try {
    const mandates = await listMandates(agentId, { includeRevoked });
    res.json({ mandates, count: mandates.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/mandate/challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  try {
    const challenge = await issueMandateChallenge(agentId);
    // Also return allowCredentials so the browser pre-selects the registered passkey.
    const agent = await getAgent(agentId);
    const allowCredentials = agent?.webauthnCredentialId
      ? [{ id: agent.webauthnCredentialId, type: "public-key" as const }]
      : [];
    res.json({ agentId, challenge, allowCredentials });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/mandate/create", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");

  const {
    ownerWalletId, maxPerTx, maxPer10Min, maxPerDay,
    allowedRecipients, recurring,
    webauthnAssertion, liquidAuthSessionId, peraSessionId,
  } = req.body;

  // Coerce expiresAt to a finite integer — guards against NaN/Infinity slipping
  // through (NaN is not caught by ??, so must be validated explicitly).
  const rawExpiry = req.body.expiresAt;
  const expiresAt: number | undefined =
    rawExpiry !== undefined && rawExpiry !== null
      ? (Number.isFinite(Number(rawExpiry)) ? Number(rawExpiry) : undefined)
      : undefined;

  if (!ownerWalletId || (!webauthnAssertion && !liquidAuthSessionId && !peraSessionId)) {
    res.status(400).json({
      error: "Missing required fields: ownerWalletId and one of (webauthnAssertion | liquidAuthSessionId | peraSessionId)",
    });
    return;
  }

  try {
    const mandate = await createMandate(agentId, {
      ownerWalletId,
      maxPerTx,
      maxPer10Min,
      maxPerDay,
      allowedRecipients,
      recurring,
      expiresAt,
      webauthnAssertion,
      liquidAuthSessionId,
      peraSessionId,
    });
    res.status(201).json(mandate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("WebAuthn") || msg.includes("Liquid Auth") ? 401 :
      msg.includes("mismatch")  ? 403 :
      400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/mandate/:mandateId/revoke", requirePortalAuth, async (req, res) => {
  const agentId   = String(req.params.agentId || "");
  const mandateId = String(req.params.mandateId || "");
  const { ownerWalletId, webauthnAssertion, liquidAuthSessionId, peraSessionId } = req.body;

  if (!ownerWalletId || (!webauthnAssertion && !liquidAuthSessionId && !peraSessionId)) {
    res.status(400).json({
      error: "Missing required fields: ownerWalletId and one of (webauthnAssertion | liquidAuthSessionId | peraSessionId)",
    });
    return;
  }

  try {
    const result = await revokeMandate(agentId, mandateId, {
      ownerWalletId,
      webauthnAssertion,
      liquidAuthSessionId,
      peraSessionId,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("WebAuthn") || msg.includes("Liquid Auth") ? 401 :
      msg.includes("mismatch")  ? 403 :
      400;
    res.status(status).json({ error: msg });
  }
});

// ── Liquid Auth (Algorand wallet QR) ─────────────────────────────
//
// POST /api/agents/:agentId/auth/liquid-challenge
//   Issue a QR challenge for operator Algorand wallet sign-in.
//   Returns { sessionId, qrPayload, expiresAt }.
//
// GET  /api/agents/:agentId/auth/liquid-status/:sessionId
//   Poll from frontend every ~2 s until status === "verified".
//
// POST /api/agents/:agentId/auth/liquid-register
//   Consume a verified session to register the Algorand address as ownerWalletId.

app.post("/api/agents/:agentId/auth/liquid-challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const intent  = String(req.body?.intent ?? "register");
  const baseUrl = String(req.body?.baseUrl ?? process.env.API_BASE_URL ?? "https://api.ai-agentic-wallet.com");

  const validIntents = ["register", "mandate-create", "mandate-revoke"];
  if (!validIntents.includes(intent)) {
    res.status(400).json({ error: `Invalid intent. Must be one of: ${validIntents.join(", ")}` });
    return;
  }

  try {
    const result = await issueAlgorandChallenge(agentId, intent as "register" | "mandate-create" | "mandate-revoke", baseUrl);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});


app.get("/api/agents/:agentId/auth/liquid-status/:sessionId", requirePortalAuth, async (req, res) => {
  const sessionId = String(req.params.sessionId || "");
  try {
    const status = await getLiquidAuthStatus(sessionId);
    if (!status) {
      res.status(404).json({ error: "Session not found — expired or invalid sessionId" });
      return;
    }
    res.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/liquid-register", requirePortalAuth, async (req, res) => {
  const agentId   = String(req.params.agentId || "");
  // Accept both "sessionId" (canonical) and "liquidAuthSessionId" (portal alias)
  const sessionId = String(req.body?.sessionId ?? req.body?.liquidAuthSessionId ?? "");

  if (!sessionId) {
    res.status(400).json({ error: "Missing required field: sessionId (or liquidAuthSessionId)" });
    return;
  }

  try {
    const result = await registerAlgorandAddress(agentId, sessionId);
    res.json({ agentId, ...result, status: "registered" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("mismatch") || msg.includes("denied") ? 403 :
      msg.includes("Liquid Auth") ? 401 :
      400;
    res.status(status).json({ error: msg });
  }
});

// ── Pera Connect Auth (WalletConnect — Pera, Defly, Kibisis) ─────
//
// POST /api/agents/:agentId/auth/pera-challenge   Issue random 32-byte challenge
// POST /api/agents/:agentId/auth/pera-verify      Verify wallet signature → verifiedSessionId
// POST /api/agents/:agentId/auth/pera-register    Register ownerWalletId from verified pera session

app.post("/api/agents/:agentId/auth/pera-challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const intent  = String(req.body?.intent ?? "register");
  const validIntents = ["register", "mandate-create", "mandate-revoke"];
  if (!validIntents.includes(intent)) {
    res.status(400).json({ error: `Invalid intent. Must be one of: ${validIntents.join(", ")}` });
    return;
  }
  try {
    const result = await issueAgentPeraChallenge(agentId, intent as "register" | "mandate-create" | "mandate-revoke");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/agents/:agentId/auth/pera-verify", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { challengeId, intent, address, signatureB64 } = req.body as {
    challengeId?: string; intent?: string; address?: string; signatureB64?: string;
  };
  if (!challengeId || !intent || !address || !signatureB64) {
    res.status(400).json({ error: "Missing required fields: challengeId, intent, address, signatureB64" });
    return;
  }
  const validIntents = ["register", "mandate-create", "mandate-revoke"];
  if (!validIntents.includes(intent)) {
    res.status(400).json({ error: `Invalid intent` });
    return;
  }
  try {
    const result = await verifyAgentPeraSignature(
      challengeId, agentId, intent as "register" | "mandate-create" | "mandate-revoke",
      address, signatureB64,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") || msg.includes("expired") ? 404 :
      msg.includes("Invalid signature") ? 401 : 400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/pera-register", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { peraSessionId } = req.body as { peraSessionId?: string };
  if (!peraSessionId) {
    res.status(400).json({ error: "Missing required field: peraSessionId" });
    return;
  }
  try {
    const { address } = await consumeVerifiedPeraSession(peraSessionId, agentId, "register");
    // Reuse registerAlgorandAddress logic inline
    const agent = await getAgent(agentId);
    if (!agent) { res.status(404).json({ error: `Agent not found: ${agentId}` }); return; }
    if (agent.ownerWalletId && agent.ownerWalletId !== address) {
      res.status(403).json({ error: "ownerWalletId already registered — lateral ownership transfer denied" });
      return;
    }
    if (!algosdk.isValidAddress(address)) {
      res.status(400).json({ error: `Invalid Algorand address from session: ${address}` });
      return;
    }
    // Bridge ownerWalletId → ownerAddress so the portfolio index picks this agent up.
    // ownerAddress is only set once (the first wallet to register owns the agent).
    await updateAgentRecord({
      ...agent,
      ownerWalletId: address,
      ownerAddress: agent.ownerAddress ?? address,
    });
    res.json({ agentId, ownerWalletId: address, status: "registered" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") || msg.includes("expired") ? 404 :
      msg.includes("mismatch") || msg.includes("denied") ? 403 :
      msg.includes("Invalid signature") ? 401 : 400;
    res.status(status).json({ error: msg });
  }
});

// ── WebAuthn Login (device passkey — first-class auth path) ──────
//
// POST /api/agents/:agentId/auth/webauthn-register-challenge
//   Issue a registration challenge for navigator.credentials.create().
//   Returns { challenge, userId, rpId, rpName, userName, userDisplayName, hasCredentials }.
//
// POST /api/agents/:agentId/auth/webauthn-register
//   Verify attestation, store credential ID + COSE key, set ownerWalletId.
//   Returns { ownerWalletId, credentialId, status: "registered" }.
//
// POST /api/agents/:agentId/auth/webauthn-login-challenge
//   Issue a login challenge for navigator.credentials.get().
//   Returns { challenge, allowCredentials, hasCredentials, rpId }.
//   hasCredentials=false → client should call register-challenge instead.
//
// POST /api/agents/:agentId/auth/webauthn-login
//   Verify assertion, update counter, return ownerWalletId.
//   Returns { ownerWalletId }.

app.post("/api/agents/:agentId/auth/webauthn-register-challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  try {
    const result = await issueWebAuthnRegistrationChallenge(agentId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/webauthn-register", requirePortalAuth, async (req, res) => {
  const agentId  = String(req.params.agentId || "");
  const response = req.body?.registrationResponse ?? req.body;

  if (!response?.id || !response?.response) {
    res.status(400).json({ error: "Missing registrationResponse (RegistrationResponseJSON)" });
    return;
  }

  try {
    const result = await verifyAndRegisterWebAuthn(agentId, response);
    res.json({ agentId, ...result, status: "registered" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found")    ? 404 :
      msg.includes("verification") ? 401 :
      msg.includes("challenge")    ? 400 :
      400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/webauthn-login-challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  try {
    const result = await issueWebAuthnLoginChallenge(agentId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/webauthn-login", requirePortalAuth, async (req, res) => {
  const agentId   = String(req.params.agentId || "");
  const assertion = req.body?.assertion ?? req.body;

  if (!assertion?.id || !assertion?.response) {
    res.status(400).json({ error: "Missing assertion (AuthenticationResponseJSON)" });
    return;
  }

  try {
    const result = await verifyWebAuthnLoginAssertion(agentId, assertion);
    res.json({ agentId, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found")    ? 404 :
      msg.includes("verification") ? 401 :
      msg.includes("challenge")    ? 400 :
      401;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/auth/webauthn-adopt-challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  try {
    res.json(await issueWebAuthnAdoptChallenge(agentId));
  } catch (err) {
    const msg    = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST /api/agents/:agentId/auth/webauthn-adopt-owner
//   Bind an existing owner passkey to a new agent (no new registration).
//   Requires a login challenge pre-issued via webauthn-login-challenge.
//   Copies the master credential to the new agent, sets same ownerWalletId.
app.post("/api/agents/:agentId/auth/webauthn-adopt-owner", requirePortalAuth, async (req, res) => {
  const agentId   = String(req.params.agentId || "");
  const assertion = req.body?.assertion ?? req.body;

  if (!assertion?.id || !assertion?.response) {
    res.status(400).json({ error: "Missing assertion (AuthenticationResponseJSON)" });
    return;
  }

  try {
    const result = await adoptWebAuthnOwner(agentId, assertion);
    res.json({ agentId, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found")    ? 404 :
      msg.includes("verification") ? 401 :
      msg.includes("challenge")    ? 400 :
      400;
    res.status(status).json({ error: msg });
  }
});

// ── Admin Portal Auth — Liquid Auth + WebAuthn ───────────────────
//
// These routes are PUBLIC (no requirePortalAuth) — the admin is not yet
// authenticated when calling them.  The portal issues the JWT after
// verifying the session or assertion.
//
// POST /api/admin/auth/liquid-challenge     Issue QR challenge
// GET  /api/admin/auth/liquid-status/:id   Poll for "verified"
// POST /api/admin/auth/liquid-consume      Consume session → address
// POST /api/admin/auth/webauthn-register-challenge
// POST /api/admin/auth/webauthn-register
// POST /api/admin/auth/webauthn-login-challenge
// POST /api/admin/auth/webauthn-login

app.post("/api/admin/auth/liquid-challenge", async (req, res) => {
  const baseUrl = String(req.body?.baseUrl ?? process.env.API_BASE_URL ?? "https://api.ai-agentic-wallet.com");
  try {
    const result = await issueAdminLiquidChallenge(baseUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


app.get("/api/admin/auth/liquid-status/:sessionId", async (req, res) => {
  try {
    const result = await getAdminLiquidStatus(String(req.params.sessionId));
    if (!result) { res.status(404).json({ error: "Session not found or expired" }); return; }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/admin/auth/liquid-consume", async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "");
  if (!sessionId) { res.status(400).json({ error: "Missing sessionId" }); return; }
  try {
    const result = await consumeAdminLiquidSession(sessionId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") || msg.includes("expired") ? 404 :
      msg.includes("not yet verified") ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// ── Admin Portal Auth — Pera Connect ─────────────────────────────
//
// POST /api/admin/auth/pera-challenge   Issue random 32-byte challenge
// POST /api/admin/auth/pera-verify      Verify wallet signature → verifiedSessionId
// POST /api/admin/auth/pera-consume     Consume verified session → address (used by portal login)

app.post("/api/admin/auth/pera-challenge", async (_req, res) => {
  try {
    res.json(await issueAdminPeraChallenge());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/admin/auth/pera-verify", async (req, res) => {
  const { challengeId, address, signatureB64 } = req.body as {
    challengeId?: string; address?: string; signatureB64?: string;
  };
  if (!challengeId || !address || !signatureB64) {
    res.status(400).json({ error: "Missing required fields: challengeId, address, signatureB64" });
    return;
  }
  try {
    const result = await verifyAdminPeraSignature(challengeId, address, signatureB64);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") || msg.includes("expired") ? 404 :
      msg.includes("Invalid signature") ? 401 : 400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/admin/auth/pera-consume", async (req, res) => {
  const challengeId = String(req.body?.challengeId ?? "");
  if (!challengeId) { res.status(400).json({ error: "Missing challengeId" }); return; }
  try {
    const result = await consumeAdminPeraSession(challengeId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") || msg.includes("expired") ? 404 :
      msg.includes("not yet verified") ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/admin/auth/webauthn-register-challenge", async (req, res) => {
  try {
    res.json(await issueAdminWebAuthnRegChallenge());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/admin/auth/webauthn-register", async (req, res) => {
  const response = req.body?.registrationResponse ?? req.body;
  if (!response?.id || !response?.response) {
    res.status(400).json({ error: "Missing registrationResponse (RegistrationResponseJSON)" });
    return;
  }
  try {
    res.json(await verifyAndRegisterAdminWebAuthn(response));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("failed") ? 401 : 500).json({ error: msg });
  }
});

app.post("/api/admin/auth/webauthn-login-challenge", async (req, res) => {
  try {
    res.json(await issueAdminWebAuthnLoginChallenge());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/admin/auth/webauthn-login", async (req, res) => {
  const assertion = req.body?.assertion ?? req.body;
  if (!assertion?.id || !assertion?.response) {
    res.status(400).json({ error: "Missing assertion (AuthenticationResponseJSON)" });
    return;
  }
  try {
    await verifyAdminWebAuthnLoginAssertion(assertion);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("not verified") || msg.includes("failed") ? 401 : 400;
    res.status(status).json({ error: msg });
  }
});

// ── Security Audit Log ────────────────────────────────────────────

app.get("/api/portal/security-audit", requirePortalAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 1000);
    const events = await getRecentSecurityEvents(limit);
    res.json({ events, count: events.length });
  } catch (err) {
    console.error("[portal/security-audit]", err);
    res.json({ events: [], count: 0 });
  }
});

// ── Mass Drain Status / Admin ─────────────────────────────────────

app.get("/api/system/mass-drain", requirePortalAuth, async (_req, res) => {
  const status = await getMassDrainStatus();
  res.json(status);
});

app.post("/api/system/mass-drain/clear", requirePortalAuth, async (req, res) => {
  const overrideKey = process.env.HALT_OVERRIDE_KEY;
  if (overrideKey) {
    const provided = String(req.body?.overrideKey ?? "");
    if (provided !== overrideKey) {
      res.status(403).json({ error: "Forbidden: invalid HALT_OVERRIDE_KEY" });
      return;
    }
  }
  await clearMassDrain();
  console.log("[system/mass-drain/clear] Mass drain marker cleared via API");
  res.json({ cleared: true });
});

// ── Multi-Sig Emergency Halt ──────────────────────────────────────
//
// POST /api/system/multisig-halt
//
// Self-authenticating 2-of-3 Ed25519 multi-signature halt/unhalt.
// Does NOT require requirePortalAuth — the admin signatures ARE the auth.
// Rate-limited independently (5 req/min per IP) to prevent brute-force.
//
// Body:
//   action:     "halt" | "unhalt"
//   reason:     string (max 256 chars)
//   timestamp:  number  (unix seconds at signing time, ±5 min window)
//   signatures: Array<{ keyIndex: 1|2|3, sig: string }>  (base64)

const multisigHaltCounts = new Map<string, { count: number; resetAt: number }>();
const MULTISIG_RATE_WINDOW_MS = 60_000;
const MULTISIG_RATE_MAX       = 5;

function checkMultisigRateLimit(ip: string): boolean {
  const now  = Date.now();
  const slot = multisigHaltCounts.get(ip);
  if (!slot || now > slot.resetAt) {
    multisigHaltCounts.set(ip, { count: 1, resetAt: now + MULTISIG_RATE_WINDOW_MS });
    return true;
  }
  if (slot.count >= MULTISIG_RATE_MAX) return false;
  slot.count++;
  return true;
}

app.post("/api/system/multisig-halt", async (req, res) => {
  const ip = req.ip ?? "unknown";
  if (!checkMultisigRateLimit(ip)) {
    res.status(429).json({ error: "Rate limit exceeded — max 5 multisig-halt requests per minute per IP" });
    return;
  }

  const { action, reason, timestamp, signatures } = req.body as {
    action?:     unknown;
    reason?:     unknown;
    timestamp?:  unknown;
    signatures?: unknown;
  };

  if (!action || !reason || typeof timestamp !== "number" || !Array.isArray(signatures)) {
    res.status(400).json({ error: "Missing required fields: action, reason, timestamp, signatures" });
    return;
  }

  if (action !== "halt" && action !== "unhalt") {
    res.status(400).json({ error: 'action must be "halt" or "unhalt"' });
    return;
  }
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 256) {
    res.status(400).json({ error: "reason must be a non-empty string (max 256 chars)" });
    return;
  }

  if (!isMultiSigConfigured()) {
    res.status(503).json({
      error: "Multi-sig halt not configured — set HALT_ADMIN_PUBKEY_1/2/3 env vars",
    });
    return;
  }

  try {
    const validCount = verifyMultiSigHalt(
      action as "halt" | "unhalt",
      reason as string,
      timestamp,
      signatures as Array<{ keyIndex: 1 | 2 | 3; sig: string }>,
    );

    if (action === "halt") {
      await setHalt(reason as string);
    } else {
      await clearHalt();
    }

    emitSecurityEvent({
      type:   "SECURITY_ALERT",
      detail: {
        event:      `MULTISIG_${action.toUpperCase()}`,
        reason,
        validSigs:  validCount,
        ip,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, action, validSigs: validCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(403).json({ error: `Multi-sig verification failed: ${msg}` });
  }
});

// ── Security Metrics Dashboard ────────────────────────────────────
//
// GET /api/portal/security-metrics
//
// Aggregates security events, circuit state, and mass-drain status
// into a single response for the operator dashboard.

app.get("/api/portal/security-metrics", requirePortalAuth, async (_req, res) => {
  const redis = getRedis();

  // Event catalogue for counts
  const eventTypes = [
    "TOKEN_ISSUED", "TOKEN_CONSUMED", "TOKEN_REJECTED",
    "DRIFT_DETECTED", "DRIFT_RESOLVED",
    "MASS_DRAIN_DETECTED",
    "REKEY_INITIATED", "REKEY_CONFIRMED", "REKEY_FAILED",
    "CUSTODY_TRANSITION",
    "VELOCITY_APPROVAL_REQUIRED",
    "REKEY_SYNC_CORRECTION",
    "SECURITY_ALERT",
  ] as const;

  try {
    // Fetch recent events (last 24h window via ZRANGEBYSCORE)
    const now      = Date.now();
    const dayAgo   = now - 86_400_000;

    // Count events by type
    const eventCounts: Record<string, number> = {};
    for (const t of eventTypes) eventCounts[t] = 0;

    if (redis) {
      const members = await redis.zrange(
        "x402:security-audit", dayAgo, now, { byScore: true },
      ) as string[];

      // Count by type and collect agentId occurrences for top-alerted
      const agentAlerts = new Map<string, number>();

      for (const m of members) {
        try {
          const ev = JSON.parse(m) as { type: string; agentId?: string };
          if (ev.type in eventCounts) eventCounts[ev.type]++;
          if (ev.agentId) {
            agentAlerts.set(ev.agentId, (agentAlerts.get(ev.agentId) ?? 0) + 1);
          }
        } catch { /* skip malformed entries */ }
      }

      const topAlertedAgents = [...agentAlerts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([agentId, count]) => ({ agentId, count }));

      // Circuit state
      const [failureStr, openFlag] = await Promise.all([
        redis.get("x402:circuit:signer:failures") as Promise<string | null>,
        redis.get("x402:circuit:signer:open")     as Promise<string | null>,
      ]);

      // Mass drain status
      const massDrain = await getMassDrainStatus();

      res.json({
        window:            "24h",
        eventCounts,
        circuitStatus: {
          open:         !!openFlag,
          failureCount: parseInt(failureStr ?? "0", 10),
        },
        massDrain: {
          active: massDrain.active,
          reason: massDrain.reason,
        },
        topAlertedAgents,
      });
    } else {
      res.json({
        window:            "24h",
        eventCounts,
        circuitStatus:     { open: false, failureCount: 0 },
        massDrain:         { active: false, reason: null },
        topAlertedAgents:  [],
        _note:             "Redis unavailable — counts are empty",
      });
    }
  } catch (err) {
    console.error("[portal/security-metrics]", err);
    res.status(500).json({ error: "Failed to compute security metrics" });
  }
});

// ── MCP HTTP transport ───────────────────────────────────────────
// Exposes the same 3 tools as @algo-wallet/x402-mcp (pay_with_x402,
// check_balance, check_mandates) over HTTP for Smithery and HTTP-capable
// MCP clients. Credentials are passed per-request via headers.
app.post("/mcp", rateLimiter, async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "[MCP] Unhandled error");
    if (!res.headersSent) res.status(500).json({ error: "MCP handler error" });
  }
});

// ── Global error handler ─────────────────────────────────────────
// Must be registered after all routes (Express requires the 4-arg signature).
// Catches any error passed to next(err) or thrown synchronously in a route.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "[Express] Unhandled error");
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Process-level safety nets ─────────────────────────────────────
// Catch async errors that escape route handlers entirely.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "[Process] Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "[Process] Uncaught exception");
  process.exit(1);
});

// ── Benchmark endpoints ──────────────────────────────────────────────────────

/**
 * GET /api/benchmark
 * Public — returns the most recent A2A benchmark result stored in Redis.
 * Updated automatically at the end of every benchmark run.
 */
app.get("/api/benchmark", async (_req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.status(503).json({ error: "Redis unavailable" });
    return;
  }
  try {
    const raw = await redis.get("x402:benchmark:latest") as Record<string, unknown> | string | null;
    if (!raw) {
      res.status(404).json({ error: "No benchmark results recorded yet" });
      return;
    }
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to read benchmark results" });
  }
});

/**
 * POST /api/admin/benchmark/record
 * Portal-auth — called by a2a-benchmark.ts at end of run to persist results.
 */
app.post("/api/admin/benchmark/record", requirePortalAuth, async (req, res) => {
  const redis = getRedis();
  if (!redis) {
    res.status(503).json({ error: "Redis unavailable" });
    return;
  }
  try {
    const payload = {
      ...req.body,
      recordedAt: new Date().toISOString(),
    };
    await redis.set("x402:benchmark:latest", JSON.stringify(payload));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to record benchmark results" });
  }
});

// ── Boot ────────────────────────────────────────────────────────
// Deployed on Railway — persistent process, always binds a port.

// Phase 1.5 boot guards — Redis creds, treasury address, signer env, mTLS
runBootGuards();

// Cross-region treasury hash consistency check (async — runs after Redis is reachable).
// Fails the process if X402_PAY_TO_ADDRESS differs from what other regions registered.
assertCrossRegionTreasuryHash().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, "[Boot] FATAL: Cross-region treasury hash mismatch");
  process.exit(1);
});

// Log active auth mode at boot (embedded HMAC or external Liquid Auth server)
assertProductionAuthReady();

const port = Number(process.env.PORT);

if (!port) {
  throw new Error("PORT not defined");
}

const server = app.listen(port, "0.0.0.0", () => {
  logger.info(
    { port, network: `algorand-${config.algorand.network}`, slippageBips: DEFAULT_SLIPPAGE_BIPS },
    "Server listening",
  );
});

// Module 9 — Log mTLS activation status at boot
logMtlsStatus("main-api");

// Pre-warm mandate provenance cache — eliminates the cold-start ~400ms algod
// call on the first payment after each deploy. Runs in background, non-fatal.
(async () => {
  try {
    const agents = await scanAllAgents();
    const appIds = agents
      .map((a) => a.mandateAppId)
      .filter((id): id is number => typeof id === "number" && id > 0);
    if (appIds.length > 0) await prewarmProvenance(appIds);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err },
      "[Boot] Provenance pre-warm failed — first payment will take ~400ms longer");
  }
})();

// AP2 Module 5 — Recurring scheduler: 30s tick for due recurring mandates.
startRecurringScheduler();

// Activation poller — watches MandateContract app accounts for USDC deposits.
// When USDC > 0 is detected in a contract app account, confirms agent is funded.
startActivationPoller();

// Settlement worker — dequeues signed transactions and broadcasts to Algorand.
// Default: 1 worker (~6 jobs/min). Raise WORKER_COUNT for higher throughput
// (e.g. WORKER_COUNT=5 handles ~30 jobs/min under burst load).
// Workers are independent — each pops its own job from the shared Redis queue.
const workerAbort = new AbortController();
const WORKER_COUNT = Math.max(1, parseInt(process.env.WORKER_COUNT ?? "1", 10));
console.log(`[Boot] Starting ${WORKER_COUNT} settlement worker(s)...`);
for (let i = 0; i < WORKER_COUNT; i++) {
  runWorker(workerAbort.signal).catch((err: unknown) =>
    console.error(`[Boot] Settlement worker ${i + 1} crashed:`, err instanceof Error ? err.message : err),
  );
}
process.on("SIGTERM", () => { workerAbort.abort(); stopActivationPoller(); });
process.on("SIGINT",  () => { workerAbort.abort(); stopActivationPoller(); });
