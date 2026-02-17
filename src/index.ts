import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { x402Paywall } from "./middleware/x402.js";
import { constructAtomicGroup, constructBatchedAtomicGroup } from "./services/transaction.js";
import type { TradeIntent } from "./services/transaction.js";
import { executePipeline } from "./executor.js";
import { DEFAULT_SLIPPAGE_BIPS } from "./utils/slippage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ── Serve public/skill.md and other static assets ─────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Rate Limiting (Upstash sliding window — before all API routes) ─
app.use("/api", rateLimiter);

// ── Health ──────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", protocol: "x402", network: `algorand-${config.algorand.network}` });
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
