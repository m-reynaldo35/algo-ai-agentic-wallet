/**
 * x402-mcp HTTP transport — Smithery / HTTP MCP clients
 *
 * Exposes MCP tools over HTTP (StreamableHTTP transport) at POST /mcp.
 * Designed for listing on Smithery and other HTTP-capable MCP hosts.
 *
 * ── Non-custodial boundary ────────────────────────────────────────────────
 * The agent's private key (ALGO_MNEMONIC) is NEVER passed via this transport.
 * Smithery and this server never see or store the signing key.
 *
 * Tools available via HTTP:
 *   check_balance   — USDC + ALGO balances, gas status  (read-only, no key needed)
 *   check_mandates  — active spending mandates           (read-only, portal key only)
 *   pay_with_x402   — NOT available via HTTP; returns a redirect to STDIO
 *
 * For autonomous payment (pay_with_x402), use the STDIO transport:
 *   npx @algo-wallet/x402-mcp
 * The agent signs the Algorand transaction locally — the key never leaves the device.
 *
 * Required headers (configured via Smithery):
 *   X-Agent-Id    — agent ID registered at ai-agentic-wallet.com
 *   X-Portal-Key  — pk_live_... API key from your dashboard
 *
 * Optional headers:
 *   X-Api-Url     — override backend URL (default: https://api.ai-agentic-wallet.com)
 */

import { Server }                        from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
}                                        from "@modelcontextprotocol/sdk/types.js";
import algosdk                           from "algosdk";
import type { Request, Response }        from "express";

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.ai-agentic-wallet.com";
const INDEXER         = "https://mainnet-idx.algonode.cloud";
const USDC_ID         = 31_566_704;
const MBR_MICRO       = 200_000;

// ── Tool definitions ──────────────────────────────────────────────────────

const PAY_TOOL: Tool = {
  name: "pay_with_x402",
  description:
    "Pay for an x402-gated API using your mandate-governed Algorand agent wallet.\n\n" +
    "⚠️  Payment requires the STDIO transport — the agent signs the Algorand transaction " +
    "locally so the private key never leaves your device.\n\n" +
    "To enable payments, add the STDIO server to Claude Desktop:\n" +
    "  npx -y @algo-wallet/x402-mcp\n\n" +
    "This HTTP transport (Smithery) intentionally does not handle signing — " +
    "custody of the key is a non-negotiable property of the mandate architecture.",
  inputSchema: {
    type:       "object" as const,
    properties: {
      endpoint: {
        type:        "string",
        description: "The x402-gated API endpoint to call.",
      },
    },
    required: ["endpoint"],
  },
};

const BALANCE_TOOL: Tool = {
  name: "check_balance",
  description:
    "Check your AI agent wallet's current USDC and ALGO balances on Algorand mainnet. " +
    "USDC is your spending balance for x402 payments. ALGO is the gas token — the mandate " +
    "contract needs enough ALGO to cover transaction fees. " +
    "Returns gas status (ok / low / critical) and estimated transactions remaining before a top-up is needed.",
  inputSchema: { type: "object" as const, properties: {} },
};

const MANDATES_TOOL: Tool = {
  name: "check_mandates",
  description:
    "List the active spending mandates configured by your wallet owner. Each mandate shows " +
    "the per-transaction cap, daily velocity cap, and expiry date. " +
    "Mandates are enforced by the Algorand AVM — the agent cannot spend beyond what the " +
    "owner has authorised regardless of what it is asked to do.",
  inputSchema: { type: "object" as const, properties: {} },
};

// ── Agent info lookup ─────────────────────────────────────────────────────

interface AgentInfo {
  address:      string;
  mandateAppId: number | null;
}

/**
 * Look up the agent's on-chain address and mandateAppId from the registry.
 * Uses the portal-auth GET /api/agents/:agentId endpoint — no mnemonic needed.
 */
async function getAgentInfo(
  agentId:   string,
  portalKey: string,
  apiUrl:    string,
): Promise<AgentInfo> {
  const res = await fetch(`${apiUrl}/api/agents/${agentId}`, {
    headers: { "X-Portal-Key": portalKey },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `Agent "${agentId}" not found. Register at ai-agentic-wallet.com.`
        : `Agent lookup failed: HTTP ${res.status}`,
    );
  }
  const data = await res.json() as {
    agent?: { address?: string; mandateAppId?: number | null };
    address?: string;
    mandateAppId?: number | null;
  };

  // Support both wrapped { agent: {...} } and flat response shapes
  const agent  = data.agent ?? data;
  const address = agent.address;
  if (!address) throw new Error("Agent record missing address field");

  return {
    address,
    mandateAppId: agent.mandateAppId ?? null,
  };
}

// ── Balance fetch ─────────────────────────────────────────────────────────

async function fetchBalance(
  agentId:   string,
  portalKey: string,
  apiUrl:    string,
): Promise<Record<string, unknown>> {
  const { address, mandateAppId } = await getAgentInfo(agentId, portalKey, apiUrl);

  // ALGO balance is on the agent's own address (covers tx fees)
  const agentRes  = await fetch(`${INDEXER}/v2/accounts/${address}`);
  if (!agentRes.ok) throw new Error(`Indexer error for agent address: HTTP ${agentRes.status}`);
  const agentData = await agentRes.json() as {
    account: { amount: number };
  };
  const algo_micro = agentData.account.amount ?? 0;
  const above      = Math.max(0, algo_micro - MBR_MICRO);
  const gas_status = above < 50_000 ? "critical" : above < 200_000 ? "low" : "ok";
  const gasIcon    = gas_status === "ok" ? "✅" : gas_status === "low" ? "⚠️" : "🔴";

  // USDC balance is in the mandate contract account (holds the spending funds)
  let usdc_micro = 0;
  let contractAddress: string | null = null;
  if (mandateAppId) {
    contractAddress = algosdk.getApplicationAddress(BigInt(mandateAppId)).toString();
    const contractRes  = await fetch(`${INDEXER}/v2/accounts/${contractAddress}`);
    if (contractRes.ok) {
      const contractData = await contractRes.json() as {
        account: { assets?: Array<{ "asset-id": number; amount: number }> };
      };
      usdc_micro = contractData.account.assets?.find(
        (a) => a["asset-id"] === USDC_ID,
      )?.amount ?? 0;
    }
  }

  return {
    agent_id:           agentId,
    agent_address:      address,
    contract_address:   contractAddress,
    mandate_app_id:     mandateAppId,
    usdc_balance:       `$${(usdc_micro / 1_000_000).toFixed(6)} USDC`,
    algo_balance:       `${(algo_micro / 1_000_000).toFixed(6)} ALGO`,
    gas_status:         `${gasIcon} ${gas_status.toUpperCase()}`,
    gas_remaining_txns: Math.floor(above / 1_000),
    ...(gas_status !== "ok" ? {
      action_required: `Send ALGO to your agent address (${address}) to restore gas.`,
    } : {}),
  };
}

// ── Mandate fetch ─────────────────────────────────────────────────────────

async function fetchMandates(
  agentId:   string,
  portalKey: string,
  apiUrl:    string,
): Promise<unknown[]> {
  const res = await fetch(`${apiUrl}/api/agents/${agentId}/mandates`, {
    headers: { "X-Portal-Key": portalKey },
  });
  if (!res.ok) throw new Error(`Mandates fetch failed: HTTP ${res.status}`);
  const data = await res.json() as { mandates?: unknown[] };
  return data.mandates ?? [];
}

// ── MCP server factory (one per request, stateless) ───────────────────────

function createMcpServer(
  agentId:   string,
  portalKey: string,
  apiUrl:    string,
): Server {
  const server = new Server(
    { name: "x402-wallet", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [BALANCE_TOOL, MANDATES_TOOL, PAY_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    try {
      // ── check_balance ──────────────────────────────────────────
      if (name === "check_balance") {
        const balance = await fetchBalance(agentId, portalKey, apiUrl);
        return { content: [{ type: "text" as const, text: JSON.stringify(balance, null, 2) }] };
      }

      // ── check_mandates ─────────────────────────────────────────
      if (name === "check_mandates") {
        const mandates = await fetchMandates(agentId, portalKey, apiUrl);
        const active   = (mandates as Array<Record<string, unknown>>).filter(
          (m) => m.status === "active",
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              agent_id:     agentId,
              active_count: active.length,
              mandates: active.map((m) => ({
                mandate_id:    m.mandateId,
                max_per_tx:    m.maxPerTx    != null ? `$${(Number(m.maxPerTx)    / 1_000_000).toFixed(2)} USDC` : undefined,
                max_per_10min: m.maxPer10Min != null ? `$${(Number(m.maxPer10Min) / 1_000_000).toFixed(2)} USDC` : undefined,
                max_per_day:   m.maxPerDay   != null ? `$${(Number(m.maxPerDay)   / 1_000_000).toFixed(2)} USDC` : undefined,
                expires:       m.expiresAt,
                granted_by:    m.ownerAddress,
              })),
              note: active.length === 0
                ? "No active mandates. Set spending limits at ai-agentic-wallet.com."
                : undefined,
            }, null, 2),
          }],
        };
      }

      // ── pay_with_x402 — redirect to STDIO ──────────────────────
      if (name === "pay_with_x402") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "STDIO_REQUIRED",
              message:
                "pay_with_x402 is not available via the HTTP transport. " +
                "The agent must sign the Algorand transaction locally — " +
                "the private key must never leave your device.",
              setup: {
                step1: "Add the STDIO MCP server to Claude Desktop:",
                config: {
                  mcpServers: {
                    "x402-wallet": {
                      command: "npx",
                      args:    ["-y", "@algo-wallet/x402-mcp"],
                      env: {
                        ALGO_MNEMONIC:   "<your 25-word agent mnemonic>",
                        MANDATE_APP_ID:  "<your mandate app ID>",
                        X402_AGENT_ID:   agentId,
                        X402_PORTAL_KEY: "<your portal key>",
                      },
                    },
                  },
                },
                step2: "The key stays on your machine. No third party ever sees it.",
              },
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Tool error (${name}): ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Express handler ────────────────────────────────────────────────────────

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const agentId   = req.headers["x-agent-id"]   as string | undefined;
  const portalKey = req.headers["x-portal-key"] as string | undefined;
  const apiUrl    = ((req.headers["x-api-url"]  as string | undefined) ?? DEFAULT_API_URL).replace(/\/+$/, "");

  if (!agentId || !portalKey) {
    res.status(400).json({
      error: "X-Agent-Id and X-Portal-Key headers are required",
    });
    return;
  }

  // StreamableHTTP transport requires Accept: application/json, text/event-stream.
  // Smithery and some MCP clients omit text/event-stream — inject it so the
  // transport doesn't reject valid requests with 406 Not Acceptable.
  const accept = req.headers["accept"] ?? "";
  if (!accept.includes("text/event-stream")) {
    req.headers["accept"] = "application/json, text/event-stream";
  }

  const server    = createMcpServer(agentId, portalKey, apiUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
