console.log("Boot start. PORT=", process.env.PORT);

import { initSentry } from "./lib/sentry.js";
initSentry(); // Must be first — before any other imports touch the network

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { getNodeStatus } from "./network/nodely.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { x402Paywall } from "./middleware/x402.js";
import { constructAtomicGroup, constructBatchedAtomicGroup } from "./services/transaction.js";
import type { TradeIntent } from "./services/transaction.js";
import { executePipeline } from "./executor.js";
import { DEFAULT_SLIPPAGE_BIPS } from "./utils/slippage.js";
import { getRedis } from "./services/redis.js";
import { getWebhookDeliveries } from "./services/webhook.js";
import { registerSSEBroadcaster } from "./services/audit.js";
import { requirePortalAuth } from "./middleware/portalAuth.js";
import { registerAgent } from "./services/agentRegistration.js";
import { assertProductionAuthReady } from "./auth/liquidAuth.js";
import { runBootGuards, assertCrossRegionTreasuryHash } from "./protection/envGuard.js";
import { checkExecutionLimits } from "./protection/executionLimiter.js";
import { isCircuitOpen, recordSuccess, recordFailure } from "./protection/circuitBreaker.js";
import { logRejection } from "./protection/rejectionLogger.js";
import {
  getAgent, listAgents, updateAgentStatus,
  setHalt, clearHalt, isHalted, getActiveRotation, getRotationBatch,
  assertCustodyInvariant,
} from "./services/agentRegistry.js";
import {
  issueRekeyChallenge, verifyRekeyChallenge, executeRekey,
  executeRecustody, issueApprovalToken, decodeAxferTotal,
} from "./services/custodyManager.js";
import { checkAndReserveVelocity, rollbackVelocityReservation, recordGlobalOutflow, sumUsdcAxfers, getMassDrainStatus, clearMassDrain } from "./protection/velocityEngine.js";
import { atomicReserve, completeReservation, releaseReservation, markTxIdSettled } from "./services/executionIdempotency.js";
import { runRekeySync } from "./services/rekeySync.js";
import { startDriftPulse }             from "./jobs/driftPulse.js";
import { startRecurringScheduler }       from "./jobs/recurringScheduler.js";
import {
  createMandate, revokeMandate, listMandates,
  registerWebAuthnCredential, issueMandateChallenge,
}                                        from "./services/mandateService.js";
import { evaluateMandate }               from "./services/mandateEngine.js";
import a2aRouter                         from "./routes/a2a.js";
import { getRecentSecurityEvents, emitSecurityEvent, querySecurityEvents } from "./services/securityAudit.js";
import { validateAuthToken } from "./auth/liquidAuth.js";
import { logMtlsStatus } from "./protection/mtlsConfig.js";
import { verifyMultiSigHalt, isMultiSigConfigured } from "./protection/multiSigHalt.js";
import helmet from "helmet";
import cors from "cors";

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

// ── Serve public/skill.md and other static assets ─────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── A2A Agent Card discovery ─────────────────────────────────────
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "agent-card.json"));
});

// ── A2A Agent-to-Agent endpoint (open — mandate/velocity gated internally) ──
app.use("/a2a", a2aRouter);

// ── Rate Limiting (Upstash sliding window — before all API routes) ─
app.use("/api", rateLimiter);

// ── API info manifest (machine-readable; landing page is served by static middleware) ──
app.get("/api/info", (_req, res) => {
  res.json({
    name: "Algo AI Wallet Router",
    protocol: "x402-v1",
    network: "algorand-mainnet",
    docs: {
      manifest: "https://ai-agentic-wallet.com/moltbook-agent.json",
      registry: "https://ai-agentic-wallet.com/openclaw-registry.json",
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
  const node = await getNodeStatus();
  res.json({
    status: node.healthy ? "ok" : "degraded",
    protocol: "x402",
    network: node.network,
    node: {
      provider: "nodely",
      tier: "free",
      algod: node.algodUrl,
      indexer: node.indexerUrl,
      latestRound: node.latestRound,
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
    console.error("[agent-action]", message);
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
        console.error("[execute/velocity]", velocityErr instanceof Error ? velocityErr.message : velocityErr);
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
      recordSuccess().catch(() => {});
    } else if (result.failedStage === "sign" || result.failedStage === "broadcast") {
      // Only signing/RPC failures feed the circuit breaker.
      // Auth and validation failures indicate client errors, not RPC instability.
      recordFailure(`stage=${result.failedStage}: ${result.error ?? "unknown"}`).catch(() => {});
    }

    if (!result.success) {
      // Release the execution reservation so the client can retry
      releaseReservation(sandboxId).catch(() => {});
      // Roll back the velocity reservation so the failed attempt does not
      // consume the agent's spend allowance.
      const reservationKey = (req as unknown as Record<string, unknown>)._velocityReservationKey as string | undefined;
      if (!usedMandatePath && reservationKey) {
        rollbackVelocityReservation(agentId, reservationKey).catch(() => {});
      }
      res.status(502).json({
        error: "Settlement pipeline failed",
        failedStage: result.failedStage,
      });
      return;
    }

    // ── Record global outflow for mass drain tracking ──────────
    if (!usedMandatePath && proposedMicroUsdc > 0n) {
      recordGlobalOutflow(agentId, proposedMicroUsdc).catch(() => {});
    }

    // ── Mark execution complete (replaces pending marker, 24h TTL) ──
    // Awaited first so the idempotency result is durable before we mark
    // the txnId. If this fails and the key expires, a retry can re-execute;
    // markTxIdSettled below will then return wasNew=false (already settled)
    // which surfaces the crash-recovery anomaly at the call site below.
    try {
      await completeReservation(sandboxId, result);
    } catch (err) {
      console.error("[execute] completeReservation failed — idempotency gap possible:", err);
    }

    // ── Mark confirmed txnId as settled (7-day retention) ─────
    // Must run AFTER completeReservation so that if both fail in sequence,
    // the retry can still be caught via the idempotency cache first.
    // wasNew=false means a previous execution settled this txnId but
    // completeReservation did not persist — log the anomaly but still succeed.
    if (result.settlement?.txnId) {
      const { wasNew } = await markTxIdSettled(result.settlement.txnId, {
        agentId,
        sandboxId,
        groupId:        result.settlement.groupId,
        confirmedRound: result.settlement.confirmedRound,
        settledAt:      result.settlement.settledAt,
      });
      if (!wasNew) {
        console.warn(
          `[execute] markTxIdSettled NX=false for txnId ${result.settlement.txnId} — ` +
          `crash-recovery: previous execution settled this txnId but completeReservation did not persist. ` +
          `Returning success; idempotency gap was ${sandboxId}.`,
        );
      }
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[execute]", message);
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
    console.error("[batch-action]", message);
    res.status(500).json({ error: "Failed to construct batched atomic group" });
  }
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
// POST /api/agents/register  — create a new rekeyed agent wallet
// GET  /api/agents            — list registered agents
// GET  /api/agents/:agentId   — fetch a single agent record
// PATCH /api/agents/:agentId/suspend — suspend an agent

app.post("/api/agents/register", requirePortalAuth, async (req, res) => {
  try {
    const { agentId, platform } = req.body;

    if (!agentId || typeof agentId !== "string") {
      res.status(400).json({ error: "Missing required field: agentId" });
      return;
    }

    const result = await registerAgent(agentId, platform);

    res.status(201).json({
      status:              "registered",
      agentId:             result.agentId,
      address:             result.address,
      cohort:              result.cohort,
      authAddr:            result.authAddr,
      registrationTxnId:  result.registrationTxnId,
      explorerUrl:         result.explorerUrl,
      instructions: [
        `Agent ${result.agentId} is rekeyed to Rocca signer (auth-addr: ${result.authAddr}).`,
        "Fund the agent address with USDC to enable x402 payments.",
        `Explorer: ${result.explorerUrl}`,
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("already registered")) {
      res.status(409).json({ error: message });
      return;
    }
    if (message.includes("Invalid agentId")) {
      res.status(400).json({ error: message });
      return;
    }

    console.error("[agents/register]", message);
    res.status(500).json({ error: "Agent registration failed", detail: message });
  }
});

app.get("/api/agents", requirePortalAuth, async (req, res) => {
  try {
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

    res.json(agent);
  } catch (err) {
    console.error("[agents/get]", err);
    res.status(500).json({ error: "Failed to fetch agent" });
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

app.patch("/api/agents/:agentId/suspend", requirePortalAuth, async (req, res) => {
  try {
    const agentId = String(req.params.agentId || "");
    await updateAgentStatus(agentId, "suspended");
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
  const batchId  = await getActiveRotation();
  const batch    = batchId ? await getRotationBatch(batchId) : null;
  res.json({
    halted:          !!haltRecord,
    haltReason:      haltRecord ?? null,
    activeRotation:  batch ? {
      batchId:        batch.batchId,
      cohort:         batch.cohort,
      status:         batch.status,
      confirmedCount: batch.confirmedCount,
      totalAgents:    batch.totalAgents,
      updatedAt:      batch.updatedAt,
    } : null,
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
  console.error(`[system/halt] Halt set via API: ${reason}`);
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
  console.log("[system/unhalt] Halt cleared via API");
  res.json({ halted: false });
});

// ── Custody Transition Routes ─────────────────────────────────────
//
// These endpoints implement the rekey-to-user and re-custody flows.
// All require portal auth (same gate as agent management routes).
//
// Route summary:
//   POST /api/agents/:agentId/rekey/challenge
//     Issue a proof-of-control challenge. User signs the returned bytes
//     with their destination key to prove they control it before any
//     rekey transaction is constructed.
//
//   POST /api/agents/:agentId/rekey/execute
//     Execute the rekey after challenge verification. Constructs an
//     unsigned self-payment with rekey_to = destination, routes through
//     the signing service admin path, broadcasts, and updates the registry
//     post-confirmation.
//
//   POST /api/agents/:agentId/recustody
//     Accept a user-signed rekey transaction returning custody to Rocca.
//     Validates structure strictly (not a blind relay), broadcasts, and
//     updates the registry post-confirmation.

app.post("/api/agents/:agentId/rekey/challenge", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { destinationAddress, walletId } = req.body as {
    destinationAddress?: string;
    walletId?: string;
  };

  if (!destinationAddress || !walletId) {
    res.status(400).json({ error: "Missing required fields: destinationAddress, walletId" });
    return;
  }

  try {
    const challenge = await issueRekeyChallenge(agentId, destinationAddress, walletId);
    res.json({ challenge, agentId, destinationAddress });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/rekey/execute", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { destinationAddress, signatureBase64, custodyVersion, walletId } = req.body as {
    destinationAddress?: string;
    signatureBase64?:    string;
    custodyVersion?:     number;
    walletId?:           string;
  };

  if (!destinationAddress || !signatureBase64 || typeof custodyVersion !== "number" || !walletId) {
    res.status(400).json({
      error: "Missing required fields: destinationAddress, signatureBase64, custodyVersion, walletId",
    });
    return;
  }

  try {
    // Verify challenge before executing the rekey
    await verifyRekeyChallenge(agentId, destinationAddress, signatureBase64, custodyVersion);
    const result = await executeRekey(agentId, destinationAddress, custodyVersion);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : msg.includes("in progress") ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/recustody", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");
  const { signedTxnBase64, walletId } = req.body as {
    signedTxnBase64?: string;
    walletId?:        string;
  };

  if (!signedTxnBase64 || !walletId) {
    res.status(400).json({ error: "Missing required fields: signedTxnBase64, walletId" });
    return;
  }

  try {
    const result = await executeRecustody(agentId, signedTxnBase64, walletId);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

// ── Tier 1 Approval Token ────────────────────────────────────────
//
// POST /api/agents/:agentId/approval-token
//
// Issues a single-use approval token for a transaction group that has
// exceeded the agent's spend velocity threshold.
//
// FIDO2-bound: the caller must supply a fresh FIDO2 AuthToken proving
// the wallet owner explicitly approved this specific action. The API
// cannot manufacture an approval token without hardware user intent.
//
// Body:
//   amount        number   — microUSDC ceiling the user is approving
//   unsignedTxns  string[] — exact transaction blobs being approved
//   walletId      string   — FIDO2 credential ID hash
//   authToken     AuthToken — fresh FIDO2 assertion (expires in 5 min)

app.post("/api/agents/:agentId/approval-token", requirePortalAuth, async (req, res) => {
  const { agentId } = req.params;
  const { amount, unsignedTxns, walletId, authToken } = req.body as {
    amount?:       number;
    unsignedTxns?: string[];
    walletId?:     string;
    authToken?:    { token: string; agentId: string; issuedAt: number; expiresAt: number; method: string };
  };

  if (typeof amount !== "number" || !Array.isArray(unsignedTxns) || !walletId || !authToken) {
    res.status(400).json({
      error: "Missing required fields: amount, unsignedTxns, walletId, authToken",
    });
    return;
  }

  // ── FIDO2 assertion validation ─────────────────────────────────
  // The authToken must be a freshly issued FIDO2 credential for this agent.
  // This ensures the wallet hardware device explicitly approved the action —
  // the API cannot issue approval tokens on behalf of the user.
  try {
    await validateAuthToken(authToken as Parameters<typeof validateAuthToken>[0]);
  } catch (authErr) {
    const msg = authErr instanceof Error ? authErr.message : String(authErr);
    res.status(401).json({ error: `FIDO2 assertion invalid: ${msg}` });
    return;
  }
  if (authToken.agentId !== agentId) {
    res.status(401).json({ error: "FIDO2 assertion agentId does not match :agentId param" });
    return;
  }

  // ── Validate the proposed amount against decoded txn bytes ─────
  // The stored ceiling must not be less than the actual group spend
  // (callers cannot manufacture an inflated amount for future replays).
  try {
    const decodedTotal = decodeAxferTotal(unsignedTxns, "");  // address validated inside issueApprovalToken
    if (BigInt(amount) < decodedTotal) {
      res.status(400).json({
        error: `Approved amount (${amount}) is less than decoded group total (${decodedTotal}) — ceiling cannot be below actual spend`,
      });
      return;
    }
  } catch {
    // decodeAxferTotal with empty agentAddress will fail strict checks;
    // the canonical validation happens inside consumeApprovalToken.
    // Here we just use sumUsdcAxfers for a non-strict sanity check.
    const looseTotalMicroUsdc = sumUsdcAxfers(unsignedTxns);
    if (BigInt(amount) < looseTotalMicroUsdc) {
      res.status(400).json({ error: "Approved amount is less than decoded group USDC total" });
      return;
    }
  }

  try {
    const nonce = await issueApprovalToken(agentId, amount, unsignedTxns, walletId);

    emitSecurityEvent({
      type:    "TOKEN_ISSUED",
      agentId,
      walletId,
      detail: {
        amountMicroUsdc:  amount,
        txnCount:         unsignedTxns.length,
        fido2AgentId:     authToken.agentId,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ nonce, agentId, expiresInSeconds: 60 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ── AP2 Mandate Endpoints ─────────────────────────────────────────
//
// PATCH /api/agents/:agentId/webauthn-pubkey
//   Register the owner's FIDO2 public key. Immutable once set.
//
// GET  /api/agents/:agentId/mandates
//   List active mandates for an agent.
//
// POST /api/agents/:agentId/mandate/challenge
//   Issue a single-use WebAuthn challenge for mandate operations.
//
// POST /api/agents/:agentId/mandate/create
//   Create a new AP2 mandate. FIDO2 assertion required.
//
// POST /api/agents/:agentId/mandate/:mandateId/revoke
//   Revoke a mandate. FIDO2 assertion required.

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
  try {
    const mandates = await listMandates(agentId);
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
    res.json({ agentId, challenge });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/mandate/create", requirePortalAuth, async (req, res) => {
  const agentId = String(req.params.agentId || "");

  const {
    ownerWalletId, maxPerTx, maxPer10Min, maxPerDay,
    allowedRecipients, recurring, expiresAt, webauthnAssertion,
  } = req.body;

  if (!ownerWalletId || !webauthnAssertion) {
    res.status(400).json({
      error: "Missing required fields: ownerWalletId, webauthnAssertion",
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
    });
    res.status(201).json(mandate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("WebAuthn")  ? 401 :
      msg.includes("mismatch")  ? 403 :
      400;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/agents/:agentId/mandate/:mandateId/revoke", requirePortalAuth, async (req, res) => {
  const agentId   = String(req.params.agentId || "");
  const mandateId = String(req.params.mandateId || "");
  const { ownerWalletId, webauthnAssertion } = req.body;

  if (!ownerWalletId || !webauthnAssertion) {
    res.status(400).json({
      error: "Missing required fields: ownerWalletId, webauthnAssertion",
    });
    return;
  }

  try {
    const result = await revokeMandate(agentId, mandateId, { ownerWalletId, webauthnAssertion });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      msg.includes("not found") ? 404 :
      msg.includes("WebAuthn")  ? 401 :
      msg.includes("mismatch")  ? 403 :
      400;
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

// ── Boot ────────────────────────────────────────────────────────
// Deployed on Railway — persistent process, always binds a port.

// Phase 1.5 boot guards — Redis creds, treasury address, signer env, mTLS
runBootGuards();

// Cross-region treasury hash consistency check (async — runs after Redis is reachable).
// Fails the process if X402_PAY_TO_ADDRESS differs from what other regions registered.
assertCrossRegionTreasuryHash().catch((err: unknown) => {
  console.error(
    "[Boot] FATAL: Cross-region treasury hash mismatch —",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});

// Assert auth config is safe — throws in production without LIQUID_AUTH_SERVER_URL
assertProductionAuthReady();

const port = Number(process.env.PORT);

if (!port) {
  throw new Error("PORT not defined");
}

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on ${port}`);
  console.log(`  Network: algorand-${config.algorand.network}`);
  console.log(`  Default slippage: ${DEFAULT_SLIPPAGE_BIPS} bips (${DEFAULT_SLIPPAGE_BIPS / 100}%)`);
});

// Async boot assertion: custody invariant.
// Runs after listen() so Railway health checks pass during the Redis scan.
// If violated, the server shuts down — registry drift must not go undetected.
// Skipped when ROCCA_SIGNER_ADDRESS is unset (legacy / first deploy without custody fields).
const roccaSignerAddress = config.rocca.signerAddress;
if (roccaSignerAddress) {
  assertCustodyInvariant(roccaSignerAddress)
    .then(() => console.log("[Boot] Custody invariant: OK"))
    .catch((err: unknown) => {
      console.error(
        "[Boot] FATAL: Custody invariant violated —",
        err instanceof Error ? err.message : err,
      );
      server.close(() => process.exit(1));
    });
}

// Module 9 — Log mTLS activation status at boot
logMtlsStatus("main-api");

// Module 3 — Rekey sync: reconcile any dangling rekey-in-progress locks
// against on-chain state before serving traffic. Runs after custody invariant
// so a clean registry is confirmed first.
runRekeySync()
  .then(() => console.log("[Boot] Rekey sync: OK"))
  .catch((err: unknown) =>
    console.error("[Boot] Rekey sync error:", err instanceof Error ? err.message : err),
  );

// Module 5 — Drift pulse: start 60s heartbeat that samples 5% of agents
// and orphans any whose on-chain auth-addr no longer matches the registry.
startDriftPulse();

// AP2 Module 5 — Recurring scheduler: 30s tick for due recurring mandates.
startRecurringScheduler();
