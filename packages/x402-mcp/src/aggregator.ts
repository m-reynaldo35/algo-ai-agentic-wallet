#!/usr/bin/env node
/**
 * x402 Aggregator MCP Server — The Bazaar (Sprint 20)
 *
 * One MCP server. Every listed x402 API. Auto-pays with your mandate.
 *
 * Instead of installing a separate MCP server per API, add this one server
 * to Claude Desktop and instantly get access to every API registered in the
 * x402 marketplace. Claude picks the right tool for the task, payment fires
 * automatically, mandate limits enforce safety.
 *
 * Setup (Claude Desktop / Claude Code):
 *   {
 *     "mcpServers": {
 *       "x402-bazaar": {
 *         "command": "npx",
 *         "args": ["-y", "@algo-wallet/x402-mcp", "bazaar"],
 *         "env": {
 *           "ALGO_MNEMONIC":    "word1 word2 ... word25",
 *           "MANDATE_APP_ID":   "123456789",
 *           "X402_AGENT_ID":    "my-agent",
 *           "X402_PORTAL_KEY":  "pk_live_...",
 *           "X402_API_URL":     "https://api.ai-agentic-wallet.com"
 *         }
 *       }
 *     }
 *   }
 *
 * Required env vars:
 *   ALGO_MNEMONIC    — 25-word Algorand mnemonic (agent wallet, stays on device)
 *   MANDATE_APP_ID   — MandateContract app ID (AVM enforces your spending limits)
 *   X402_AGENT_ID    — your agent ID from ai-agentic-wallet.com
 *   X402_PORTAL_KEY  — Portal API key (pk_live_...)
 *
 * Optional env vars:
 *   X402_API_URL          — backend base URL (default: https://api.ai-agentic-wallet.com)
 *   X402_REGISTRY_URL     — registry endpoint (default: {X402_API_URL}/api/registry)
 *   MAX_PER_CALL_MICROUSDC — hard per-call ceiling in µUSDC (default: 10_000 = $0.01)
 *   REGISTRY_POLL_MS      — registry refresh interval ms (default: 300_000 = 5 min)
 */

import { Server }              from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
}                               from "@modelcontextprotocol/sdk/types.js";
import algosdk                  from "algosdk";

// ── Config ─────────────────────────────────────────────────────────────────

const API_URL         = (process.env["X402_API_URL"] ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const REGISTRY_URL    = (process.env["X402_REGISTRY_URL"] ?? `${API_URL}/api/registry`).replace(/\/+$/, "");
const MNEMONIC        = process.env["ALGO_MNEMONIC"];
const MANDATE_APP_ID  = process.env["MANDATE_APP_ID"] ? parseInt(process.env["MANDATE_APP_ID"], 10) : 0;
const AGENT_ID        = process.env["X402_AGENT_ID"];
const PORTAL_KEY      = process.env["X402_PORTAL_KEY"] ?? "";
const MAX_MICRO       = parseInt(process.env["MAX_PER_CALL_MICROUSDC"] ?? "10000", 10);  // $0.01 default cap
const POLL_MS         = parseInt(process.env["REGISTRY_POLL_MS"] ?? "300000", 10);       // 5 min default
const ALGOD_URL       = process.env["ALGO_CLIENT_NODE_URL"] ?? "https://mainnet-api.algonode.cloud";

// ── Validation ─────────────────────────────────────────────────────────────

function fatal(msg: string): never {
  process.stderr.write(`[x402-bazaar] FATAL: ${msg}\n`);
  process.exit(1);
}

if (!MNEMONIC)       fatal("ALGO_MNEMONIC env var is required");
if (!MANDATE_APP_ID) fatal("MANDATE_APP_ID env var is required (deploy MandateContract first)");
if (!AGENT_ID)       fatal("X402_AGENT_ID env var is required");

const account    = algosdk.mnemonicToSecretKey(MNEMONIC!);
const privateKey = account.sk;
const senderAddr = account.addr.toString();

const PAY_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("pay(address,uint64)void").getSelector(),
);

// ── Registry types ─────────────────────────────────────────────────────────

interface RegistryEntry {
  toolId:      string;
  name:        string;
  description: string;
  endpoint:    string;
  priceMicro:  number;
  category:    string;
  network:     string;
  inputSchema: Record<string, unknown>;
  payTo:       string;
  verified:    boolean;
}

// ── Registry cache ─────────────────────────────────────────────────────────

let cachedTools: RegistryEntry[] = [];
let lastFetch   = 0;

async function fetchRegistry(): Promise<RegistryEntry[]> {
  try {
    const res  = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Registry HTTP ${res.status}`);
    const data = await res.json() as { tools?: RegistryEntry[] };
    return (data.tools ?? []).filter(
      // Only include verified listings within our per-call cap
      (t) => t.verified && t.priceMicro <= MAX_MICRO,
    );
  } catch (err) {
    process.stderr.write(`[x402-bazaar] Registry fetch failed: ${err}\n`);
    return cachedTools; // return stale on error
  }
}

async function getTools(): Promise<RegistryEntry[]> {
  const now = Date.now();
  if (now - lastFetch > POLL_MS || cachedTools.length === 0) {
    cachedTools = await fetchRegistry();
    lastFetch   = now;
    process.stderr.write(`[x402-bazaar] Registry refreshed: ${cachedTools.length} tools\n`);
  }
  return cachedTools;
}

// ── Payment proof builder ──────────────────────────────────────────────────

async function buildPaymentProof(priceMicro: number, payTo: string): Promise<string> {
  const algod  = new algosdk.Algodv2("", ALGOD_URL, "");
  const params = await algod.getTransactionParams().do();
  const sp     = { ...params, fee: 3_000n, flatFee: true };

  const treasuryBytes = algosdk.decodeAddress(payTo).publicKey;
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64BE(BigInt(priceMicro));

  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender:          senderAddr,
    appIndex:        MANDATE_APP_ID,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [PAY_SELECTOR, treasuryBytes, amountBuf],
    suggestedParams: sp,
    note:            crypto.getRandomValues(new Uint8Array(8)), // prevent duplicate txn
  });

  const signedTxn = txn.signTxn(privateKey);
  return Buffer.from(signedTxn).toString("base64");
}

// ── Tool invocation — x402 payment + HTTP call ─────────────────────────────

async function callTool(
  entry:  RegistryEntry,
  args:   Record<string, unknown>,
): Promise<string> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(PORTAL_KEY ? { "X-Portal-Key": PORTAL_KEY } : {}),
  };

  // Build URL with query params for GET-style endpoints, or POST body
  const hasInput  = Object.keys(args).length > 0;
  const queryStr  = hasInput
    ? "?" + new URLSearchParams(
        Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
      ).toString()
    : "";
  const url = entry.endpoint + queryStr;

  // Step 1 — probe (no payment header) → expect 402
  const probeRes = await fetch(url, {
    method:  "GET",
    headers: baseHeaders,
    signal:  AbortSignal.timeout(10_000),
  });

  if (probeRes.status !== 402) {
    // Endpoint didn't ask for payment — return result directly (misconfigured but handle gracefully)
    if (probeRes.ok) {
      const body = await probeRes.json().catch(() => ({}));
      return JSON.stringify(body);
    }
    throw new Error(`Endpoint error: HTTP ${probeRes.status}`);
  }

  // Step 2 — build signed payment proof
  const xPayment = await buildPaymentProof(entry.priceMicro, entry.payTo);

  // Step 3 — replay with X-PAYMENT
  const paidRes = await fetch(url, {
    method:  "GET",
    headers: { ...baseHeaders, "X-PAYMENT": xPayment },
    signal:  AbortSignal.timeout(15_000),
  });

  if (!paidRes.ok) {
    const body = await paidRes.json().catch(() => ({})) as { error?: string };
    throw new Error(`Payment rejected: HTTP ${paidRes.status} — ${body.error ?? paidRes.statusText}`);
  }

  const result = await paidRes.json().catch(() => ({}));
  return JSON.stringify(result, null, 2);
}

// ── MCP tool schema builder ────────────────────────────────────────────────

function toMcpTool(entry: RegistryEntry): Tool {
  const priceDisplay = `$${(entry.priceMicro / 1_000_000).toFixed(4)} USDC`;
  return {
    name:        entry.toolId,
    description: `${entry.description} [${priceDisplay} per call via x402 Algorand mandate]`,
    inputSchema: {
      ...entry.inputSchema,
      type: "object",
    } as Tool["inputSchema"],
  };
}

// ── MCP server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Pre-warm the registry
  await getTools();

  const server = new Server(
    { name: "x402-bazaar", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await getTools();
    return { tools: tools.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Refresh registry if needed
    const tools  = await getTools();
    const entry  = tools.find((t) => t.toolId === name);

    if (!entry) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}. Tools may have changed — try listing again.` }],
        isError: true,
      };
    }

    if (entry.priceMicro > MAX_MICRO) {
      return {
        content: [{
          type: "text" as const,
          text: `Tool "${name}" costs ${entry.priceMicro} µUSDC which exceeds your MAX_PER_CALL_MICROUSDC=${MAX_MICRO}. Increase the limit or use a cheaper tool.`,
        }],
        isError: true,
      };
    }

    try {
      const result = await callTool(entry, args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Tool error (${name}): ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[x402-bazaar] Ready — ${cachedTools.length} tools available as agent: ${AGENT_ID}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[x402-bazaar] Fatal: ${err}\n`);
  process.exit(1);
});
