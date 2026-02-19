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
import helmet from "helmet";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
    res.status(500).json({ error: "Failed to construct atomic group", detail: message });
  }
});

// ── Execute full pipeline: validate → auth → sign → broadcast ───
app.post("/api/execute", async (req, res) => {
  try {
    const { sandboxExport, agentId } = req.body;

    if (!sandboxExport || !agentId) {
      res.status(400).json({ error: "Missing required fields: sandboxExport, agentId" });
      return;
    }

    const result = await executePipeline(sandboxExport, agentId);

    if (!result.success) {
      res.status(502).json({
        error: "Settlement pipeline failed",
        failedStage: result.failedStage,
        detail: result.error,
      });
      return;
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[execute]", message);
    res.status(500).json({ error: "Pipeline execution failed", detail: message });
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
    res.status(500).json({ error: "Failed to construct batched atomic group", detail: message });
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
    parsed = parsed.map((s: { txnId?: string; agentId: string; tollAmountMicroUsdc?: number; settledAt?: string; oracleContext?: { assetPair: string; goraConsensusPrice: string; goraTimestamp: number; slippageDelta: number } }, i: number) => ({
      id: `stl-${String(i + 1).padStart(3, "0")}`,
      time: s.settledAt || new Date().toISOString(),
      agentId: s.agentId,
      status: "confirmed" as const,
      amountMicroUsdc: s.tollAmountMicroUsdc || 0,
      txnId: s.txnId || "unknown",
      chain: "algorand-mainnet",
      oracleContext: s.oracleContext,
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
    await redis.hset(API_KEYS_HASH, { [id]: JSON.stringify(entry) });
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
    await redis.hset(API_KEYS_HASH, { [id]: JSON.stringify(entry) });
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

// ── Boot ────────────────────────────────────────────────────────
// Local dev: listen on PORT. Vercel: app is imported as a module.
if (process.env.NODE_ENV !== "production") {
  app.listen(config.port, () => {
    console.log(`\n  Algo AI Agentic Wallet — Phase 3`);
    console.log(`  x402 server listening on http://localhost:${config.port}`);
    console.log(`  Network: algorand-${config.algorand.network}`);
    console.log(`  Default slippage: ${DEFAULT_SLIPPAGE_BIPS} bips (${DEFAULT_SLIPPAGE_BIPS / 100}%)`);
    console.log(`  Endpoints:`);
    console.log(`    POST /api/agent-action  — construct atomic group (x402-gated)`);
    console.log(`    POST /api/batch-action  — batched multiparty settlement (x402-gated)`);
    console.log(`    POST /api/execute       — pipeline: validate → auth → sign → broadcast`);
    console.log(`  Middleware: rate-limiter (Upstash sliding window) → x402 paywall → replay guard\n`);
  });
}

// Vercel Serverless: @vercel/node imports this as a module
export default app;
