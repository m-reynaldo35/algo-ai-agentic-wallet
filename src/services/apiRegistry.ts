/**
 * API Registry — Sprint 19
 *
 * Stores x402-listed API endpoints that agents can discover and pay for.
 * Backed by Redis (sorted set for ordering + hash for full records).
 *
 * Redis key layout:
 *   x402:registry:entries        ZSET  { member: toolId, score: createdAt }
 *   x402:registry:tool:{toolId}  HASH  full RegistryEntry fields
 */

import crypto       from "crypto";
import { getRedis } from "./redis.js";
import { logger }   from "../lib/logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RegistryCategory =
  | "data"
  | "compute"
  | "finance"
  | "ai"
  | "utility"
  | "other";

export interface RegistryEntry {
  /** Stable, URL-safe ID — e.g. "get_weather" */
  toolId:       string;
  name:         string;
  description:  string;
  /** Full URL of the x402-gated endpoint */
  endpoint:     string;
  /** Price in micro-USDC (1 USDC = 1_000_000) */
  priceMicro:   number;
  category:     RegistryCategory;
  /** "algorand-mainnet" | "algorand-testnet" */
  network:      string;
  /** Input JSON Schema passed to the LLM as the tool's inputSchema */
  inputSchema:  Record<string, unknown>;
  /** ISO 8601 creation timestamp */
  createdAt:    string;
  /** Whether /.well-known/x402 ping succeeded */
  verified:     boolean;
  /** Address that receives the USDC payment */
  payTo:        string;
  /** Optional portal key of the seller (for attribution) */
  ownerKey?:    string;
}

export interface ListRegistryOptions {
  category?: RegistryCategory;
  verified?: boolean;
  limit?:    number;
  offset?:   number;
}

// ── Redis helpers ──────────────────────────────────────────────────────────

function entryKey(toolId: string) { return `x402:registry:tool:${toolId}`; }
const ZSET_KEY = "x402:registry:entries";

// ── Verification ───────────────────────────────────────────────────────────

/**
 * Ping `{endpoint}/.well-known/x402` — returns true if the seller's endpoint
 * advertises x402 support. Non-blocking: a failed ping marks verified=false
 * but still allows registration (seller can fix their endpoint later).
 */
export async function pingX402Endpoint(endpoint: string): Promise<boolean> {
  try {
    const base = endpoint.replace(/\/+$/, "");
    const res  = await fetch(`${base}/.well-known/x402`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const json = await res.json() as Record<string, unknown>;
    // Must advertise at least one x402 payment method
    return Array.isArray(json["payment_methods"]) ||
           typeof json["pay_to"] === "string";
  } catch {
    return false;
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Register (or upsert) an API listing. Verifies the endpoint if possible.
 * Returns the created/updated RegistryEntry.
 */
export async function registerTool(
  input: Omit<RegistryEntry, "toolId" | "createdAt" | "verified"> & { toolId?: string },
): Promise<RegistryEntry> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis unavailable");

  const toolId   = input.toolId ?? slugify(input.name);
  const verified = await pingX402Endpoint(input.endpoint);
  const entry: RegistryEntry = {
    toolId,
    name:        input.name,
    description: input.description,
    endpoint:    input.endpoint,
    priceMicro:  input.priceMicro,
    category:    input.category,
    network:     input.network ?? "algorand-mainnet",
    inputSchema: input.inputSchema ?? { type: "object", properties: {} },
    payTo:       input.payTo,
    ownerKey:    input.ownerKey,
    createdAt:   new Date().toISOString(),
    verified,
  };

  await redis.hset(entryKey(toolId), flatten(entry));
  await redis.zadd(ZSET_KEY, { score: Date.now(), member: toolId });

  logger.info({ toolId, verified }, "[registry] tool registered");
  return entry;
}

/**
 * List registry entries, optionally filtered by category / verified status.
 */
export async function listTools(opts: ListRegistryOptions = {}): Promise<RegistryEntry[]> {
  const redis = getRedis();
  if (!redis) return [];

  const limit  = opts.limit  ?? 100;
  const offset = opts.offset ?? 0;

  // zrange returns members newest-first (rev score order)
  const members = await redis._ioredis.zrevrange(ZSET_KEY, offset, offset + limit - 1);
  if (!members.length) return [];

  const pipeline = redis._ioredis.pipeline();
  for (const id of members) pipeline.hgetall(entryKey(id));
  const results = await pipeline.exec() as Array<[Error | null, Record<string, string>]>;

  const entries: RegistryEntry[] = [];
  for (const [err, raw] of results) {
    if (err || !raw || !raw["toolId"]) continue;
    const entry = inflate(raw);
    if (opts.category && entry.category !== opts.category) continue;
    if (opts.verified !== undefined && entry.verified !== opts.verified) continue;
    entries.push(entry);
  }
  return entries;
}

/**
 * Get a single registry entry by toolId.
 */
export async function getTool(toolId: string): Promise<RegistryEntry | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis._ioredis.hgetall(entryKey(toolId));
  if (!raw || !raw["toolId"]) return null;
  return inflate(raw);
}

/**
 * Delete a listing (owner portal key must match, or admin).
 */
export async function deleteTool(toolId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis unavailable");
  await Promise.all([
    redis._ioredis.del(entryKey(toolId)),
    redis._ioredis.zrem(ZSET_KEY, toolId),
  ]);
  logger.info({ toolId }, "[registry] tool deleted");
}

// ── Seed: first-party APIs ─────────────────────────────────────────────────

/** Upsert the built-in first-party tools at startup (idempotent). */
export async function seedFirstPartyTools(apiBase: string, payTo: string): Promise<void> {
  const tools: Array<Omit<RegistryEntry, "toolId" | "createdAt" | "verified">> = [
    {
      name:        "get_weather",
      description: "Current weather conditions for any city worldwide. Returns temperature, conditions, humidity, and wind.",
      endpoint:    `${apiBase}/api/weather`,
      priceMicro:  1_000,     // $0.001
      category:    "data",
      network:     "algorand-mainnet",
      payTo,
      inputSchema: {
        type:       "object",
        properties: {
          city: { type: "string", description: "City name, e.g. 'Lagos' or 'London, UK'" },
        },
        required: ["city"],
      },
    },
    {
      name:        "get_crypto_price",
      description: "Current price for any cryptocurrency. Returns price in USD and 24h change.",
      endpoint:    `${apiBase}/api/crypto/price`,
      priceMicro:  1_000,     // $0.001
      category:    "finance",
      network:     "algorand-mainnet",
      payTo,
      inputSchema: {
        type:       "object",
        properties: {
          symbol: { type: "string", description: "Crypto ticker, e.g. 'ALGO', 'BTC', 'ETH'" },
        },
        required: ["symbol"],
      },
    },
    {
      name:        "get_fx_rate",
      description: "Live foreign exchange rate between two currencies. Returns rate and timestamp.",
      endpoint:    `${apiBase}/api/fx`,
      priceMicro:  2_000,     // $0.002
      category:    "finance",
      network:     "algorand-mainnet",
      payTo,
      inputSchema: {
        type:       "object",
        properties: {
          from: { type: "string", description: "Source currency code, e.g. 'USD'" },
          to:   { type: "string", description: "Target currency code, e.g. 'NGN'" },
        },
        required: ["from", "to"],
      },
    },
    {
      name:        "geocode",
      description: "Convert a street address or place name to latitude/longitude coordinates.",
      endpoint:    `${apiBase}/api/geocode`,
      priceMicro:  1_000,
      category:    "data",
      network:     "algorand-mainnet",
      payTo,
      inputSchema: {
        type:       "object",
        properties: {
          address: { type: "string", description: "Full address or place name" },
        },
        required: ["address"],
      },
    },
    {
      name:        "get_news",
      description: "Latest news headlines for any topic. Returns top 5 articles with title, summary, and URL.",
      endpoint:    `${apiBase}/api/news`,
      priceMicro:  5_000,     // $0.005
      category:    "data",
      network:     "algorand-mainnet",
      payTo,
      inputSchema: {
        type:       "object",
        properties: {
          topic: { type: "string", description: "News topic or keywords, e.g. 'Algorand', 'AI payments'" },
        },
        required: ["topic"],
      },
    },
  ];

  for (const tool of tools) {
    const existing = await getTool(slugify(tool.name));
    if (existing) continue; // don't overwrite on every boot
    await registerTool(tool).catch((err: unknown) =>
      logger.warn({ name: tool.name, err }, "[registry] seed error"),
    );
  }
  logger.info("[registry] first-party tools seeded");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Flatten RegistryEntry to a string map for Redis HSET */
function flatten(entry: RegistryEntry): Record<string, string> {
  return {
    toolId:      entry.toolId,
    name:        entry.name,
    description: entry.description,
    endpoint:    entry.endpoint,
    priceMicro:  String(entry.priceMicro),
    category:    entry.category,
    network:     entry.network,
    inputSchema: JSON.stringify(entry.inputSchema),
    payTo:       entry.payTo,
    ownerKey:    entry.ownerKey ?? "",
    createdAt:   entry.createdAt,
    verified:    entry.verified ? "1" : "0",
  };
}

/** Inflate a Redis HGETALL map back to a RegistryEntry */
function inflate(raw: Record<string, string>): RegistryEntry {
  return {
    toolId:      raw["toolId"] ?? "",
    name:        raw["name"] ?? "",
    description: raw["description"] ?? "",
    endpoint:    raw["endpoint"] ?? "",
    priceMicro:  Number(raw["priceMicro"] ?? 0),
    category:    (raw["category"] ?? "other") as RegistryCategory,
    network:     raw["network"] ?? "algorand-mainnet",
    inputSchema: safeJson(raw["inputSchema"]) as Record<string, unknown>,
    payTo:       raw["payTo"] ?? "",
    ownerKey:    raw["ownerKey"] || undefined,
    createdAt:   raw["createdAt"] ?? "",
    verified:    raw["verified"] === "1",
  };
}

function safeJson(s: string | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
