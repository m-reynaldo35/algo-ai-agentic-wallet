/**
 * Sprint 19 — API Registry HTTP routes
 *
 * POST /api/registry/list    — register a tool (portal key auth)
 * GET  /api/registry         — list tools (public, optional ?category= filter)
 * GET  /api/registry/:toolId — get one tool
 * DELETE /api/registry/:toolId — remove tool (owner or admin)
 *
 * Tool registration flow:
 *   1. Seller POSTs with X-Portal-Key header
 *   2. Server pings {endpoint}/.well-known/x402 — sets verified flag
 *   3. Entry stored in Redis, returned to caller
 */

import { Router, type Request, type Response } from "express";
import {
  registerTool,
  listTools,
  getTool,
  deleteTool,
  type RegistryCategory,
} from "../services/apiRegistry.js";
import { requirePortalAuth } from "../middleware/portalAuth.js";

const router = Router();

// ── POST /api/registry/list — register a tool ─────────────────────────────

router.post("/list", requirePortalAuth, async (req: Request, res: Response) => {
  const {
    name, description, endpoint, price, category, network, inputSchema, payTo,
  } = req.body as {
    name?:        string;
    description?: string;
    endpoint?:    string;
    price?:       number;
    category?:    string;
    network?:     string;
    inputSchema?: Record<string, unknown>;
    payTo?:       string;
  };

  if (!name || !description || !endpoint || price == null || !payTo) {
    res.status(400).json({
      error: "name, description, endpoint, price (µUSDC), and payTo are required",
    });
    return;
  }

  const VALID_CATEGORIES = new Set<string>(["data","compute","finance","ai","utility","other"]);
  const cat = VALID_CATEGORIES.has(category ?? "") ? category as RegistryCategory : "other";

  try {
    const entry = await registerTool({
      name,
      description,
      endpoint,
      priceMicro:  Math.round(Number(price)),
      category:    cat,
      network:     network ?? "algorand-mainnet",
      inputSchema: inputSchema ?? { type: "object", properties: {} },
      payTo,
      ownerKey:    req.headers["x-portal-key"] as string,
    });
    res.status(201).json({ tool: entry });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/registry — list tools (public) ────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const { category, verified, limit, offset } = req.query as Record<string, string>;

  const VALID_CATEGORIES = new Set<string>(["data","compute","finance","ai","utility","other"]);

  const tools = await listTools({
    category: VALID_CATEGORIES.has(category ?? "") ? category as RegistryCategory : undefined,
    verified: verified === "true" ? true : verified === "false" ? false : undefined,
    limit:    limit  ? Number(limit)  : 100,
    offset:   offset ? Number(offset) : 0,
  });

  res.json({
    count: tools.length,
    tools,
  });
});

// ── GET /api/registry/:toolId — single entry ──────────────────────────────

router.get("/:toolId", async (req: Request, res: Response) => {
  const tool = await getTool(String(req.params["toolId"] ?? ""));
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }
  res.json({ tool });
});

// ── DELETE /api/registry/:toolId — remove (owner or admin) ────────────────

router.delete("/:toolId", requirePortalAuth, async (req: Request, res: Response) => {
  const toolId = String(req.params["toolId"] ?? "");
  const tool   = await getTool(toolId);

  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }

  const portalKey = req.headers["x-portal-key"] as string;
  // Owner can delete their own listing; an admin portal key bypass is handled by requirePortalAuth
  if (tool.ownerKey && tool.ownerKey !== portalKey) {
    res.status(403).json({ error: "Not the listing owner" });
    return;
  }

  await deleteTool(toolId);
  res.json({ deleted: toolId });
});

export default router;
