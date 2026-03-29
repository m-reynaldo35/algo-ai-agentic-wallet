/**
 * x402-mcp HTTP transport
 *
 * Mounts an MCP endpoint at POST /mcp that exposes the same 3 tools as the
 * standalone @algo-wallet/x402-mcp stdio server, but over HTTP so it can be
 * listed on Smithery and called by any HTTP-capable MCP client.
 *
 * Credentials are passed per-request via headers:
 *   X-Algo-Mnemonic  — 25-word Algorand mnemonic of the registered agent wallet
 *   X-Agent-Id       — agent ID registered at ai-agentic-wallet.com
 *   X-Portal-Key     — portal API key (optional, required for check_mandates / pay)
 *
 * Stateless mode: each POST creates an independent Server + Transport.
 * No session IDs, no persistent connections.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import algosdk from "algosdk";
import crypto from "node:crypto";
import type { Request, Response } from "express";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.ai-agentic-wallet.com";
const INDEXER         = "https://mainnet-idx.algonode.cloud";
const ALGOD_URL       = process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.4160.nodely.dev";
const USDC_ID         = 31566704;
const MBR_MICRO       = 200_000;

// ── Tool definitions ───────────────────────────────────────────────────────

const PAY_TOOL: Tool = {
  name: "pay_with_x402",
  description:
    "Pay for an x402-gated API service using your mandate-governed AI agent wallet on Algorand. " +
    "Automatically handles the x402 payment handshake — verifies your active spending mandate, " +
    "pays the USDC toll on-chain, and returns the Algorand transaction ID as cryptographic proof. " +
    "Your owner-set spending limits (max per transaction, daily cap) are enforced automatically — " +
    "the payment is rejected before any funds move if it would breach your mandate. " +
    "Use this to call any x402-gated API endpoint that returns a 402 Payment Required response.",
  inputSchema: {
    type: "object" as const,
    properties: {
      endpoint: {
        type: "string",
        description:
          "The x402-gated API endpoint to call. Can be a full URL or a path " +
          "(e.g. '/api/weather' — resolved against the configured API base URL).",
      },
    },
    required: ["endpoint"],
  },
};

const BALANCE_TOOL: Tool = {
  name: "check_balance",
  description:
    "Check your AI agent wallet's current USDC and ALGO balances on Algorand mainnet. " +
    "USDC is your spending balance for x402 payments. ALGO is your gas — the wallet needs " +
    "enough ALGO to cover transaction fees or payments will fail. Also returns gas status " +
    "(ok / low / critical) and estimated remaining transactions before a top-up is needed.",
  inputSchema: { type: "object" as const, properties: {} },
};

const MANDATES_TOOL: Tool = {
  name: "check_mandates",
  description:
    "List the active spending mandates configured by your wallet owner. Each mandate shows " +
    "the per-transaction cap, daily cap, and expiry date. Mandates are the safety boundary " +
    "between human intent and autonomous action — your agent cannot spend beyond what the " +
    "owner has authorised, regardless of what you are asked to do.",
  inputSchema: { type: "object" as const, properties: {} },
};

// ── Per-request helpers ────────────────────────────────────────────────────

interface PayJson {
  version: string;
  payment: { amount: string; payTo: string; asset: { id: number } };
  expires: string;
  memo: string;
}

async function buildPaymentProof(payJson: PayJson, senderAddr: string, privateKey: Uint8Array): Promise<string> {
  const algod  = new algosdk.Algodv2("", ALGOD_URL, "");
  const params = await algod.getTransactionParams().do();

  const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          senderAddr,
    receiver:        payJson.payment.payTo,
    amount:          BigInt(payJson.payment.amount),
    assetIndex:      BigInt(payJson.payment.asset.id),
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(payJson.memo ?? "x402")),
  });

  algosdk.assignGroupID([tollTxn]);
  const groupIdBytes = tollTxn.group!;
  const groupId      = Buffer.from(groupIdBytes).toString("base64");
  const signature    = Buffer.from(algosdk.signBytes(groupIdBytes, privateKey)).toString("base64");

  return Buffer.from(JSON.stringify({
    groupId,
    senderAddr,
    signature,
    timestamp: Math.floor(Date.now() / 1000) - 5,
    nonce: crypto.randomUUID(),
  })).toString("base64");
}

async function executeX402Payment(
  endpoint: string,
  apiUrl: string,
  agentId: string,
  portalKey: string,
  senderAddr: string,
  privateKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (portalKey) headers["X-Portal-Key"] = portalKey;

  const target = endpoint.startsWith("http") ? endpoint : `${apiUrl}${endpoint}`;

  const bounceRes = await fetch(target, { method: "POST", headers, body: JSON.stringify({ senderAddress: senderAddr }) });

  if (bounceRes.status !== 402) {
    const body = await bounceRes.json().catch(() => ({})) as Record<string, unknown>;
    if (!bounceRes.ok) throw new Error(`Request failed (${bounceRes.status}): ${String(body.error ?? bounceRes.statusText)}`);
    return executeSettlement((body as { export: unknown }).export, apiUrl, agentId, portalKey);
  }

  const payJson    = await bounceRes.json() as PayJson;
  const xPayment   = await buildPaymentProof(payJson, senderAddr, privateKey);

  const actionRes = await fetch(target, {
    method: "POST",
    headers: { ...headers, "X-PAYMENT": xPayment },
    body: JSON.stringify({ senderAddress: senderAddr }),
  });

  if (!actionRes.ok) {
    const body = await actionRes.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Payment rejected (${actionRes.status}): ${String(body.error ?? actionRes.statusText)}`);
  }

  const { export: sandboxExport } = await actionRes.json() as { export: unknown };
  return executeSettlement(sandboxExport, apiUrl, agentId, portalKey);
}

async function executeSettlement(
  sandboxExport: unknown,
  apiUrl: string,
  agentId: string,
  portalKey: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (portalKey) headers["X-Portal-Key"] = portalKey;

  const res = await fetch(`${apiUrl}/api/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sandboxExport, agentId }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function fetchBalance(senderAddr: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${INDEXER}/v2/accounts/${senderAddr}`);
  if (!res.ok) throw new Error(`Indexer error: HTTP ${res.status}`);

  const data = await res.json() as {
    account: { amount: number; assets?: Array<{ "asset-id": number; amount: number }> };
  };

  const algo_micro = data.account.amount ?? 0;
  const usdc_micro = data.account.assets?.find((a) => a["asset-id"] === USDC_ID)?.amount ?? 0;
  const above      = Math.max(0, algo_micro - MBR_MICRO);
  const gas_status = above < 50_000 ? "critical" : above < 200_000 ? "low" : "ok";
  const gasIcon    = gas_status === "ok" ? "✅" : gas_status === "low" ? "⚠️" : "🔴";

  return {
    address:            senderAddr,
    usdc_balance:       `$${(usdc_micro / 1_000_000).toFixed(6)} USDC`,
    algo_balance:       `${(algo_micro / 1_000_000).toFixed(6)} ALGO`,
    gas_status:         `${gasIcon} ${gas_status.toUpperCase()}`,
    gas_remaining_txns: Math.floor(above / 1_000),
  };
}

async function fetchMandates(agentId: string, portalKey: string, apiUrl: string): Promise<unknown[]> {
  if (!portalKey) throw new Error("X-Portal-Key header is required to check mandates.");
  const res = await fetch(`${apiUrl}/api/agents/${agentId}/mandates`, {
    headers: { "X-Portal-Key": portalKey },
  });
  if (!res.ok) throw new Error(`Mandates fetch failed: HTTP ${res.status}`);
  const data = await res.json() as { mandates?: unknown[] };
  return data.mandates ?? [];
}

// ── MCP server factory (one per request) ──────────────────────────────────

function createMcpServer(
  agentId: string,
  senderAddr: string,
  privateKey: Uint8Array,
  portalKey: string,
  apiUrl: string,
): Server {
  const server = new Server(
    { name: "x402-wallet", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [PAY_TOOL, BALANCE_TOOL, MANDATES_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === "pay_with_x402") {
        const { endpoint } = args as { endpoint?: string };
        if (!endpoint) return { content: [{ type: "text", text: "endpoint is required" }], isError: true };

        const result = await executeX402Payment(endpoint, apiUrl, agentId, portalKey, senderAddr, privateKey);

        if (!result.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error ?? "Settlement failed", failedStage: result.failedStage }, null, 2) }],
            isError: true,
          };
        }

        const settlement = result.settlement as Record<string, unknown> | undefined;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:        true,
              txnId:          settlement?.txnId,
              confirmedRound: settlement?.confirmedRound,
              settledAt:      settlement?.settledAt,
              agentId,
              explorer:       `https://explorer.perawallet.app/tx/${settlement?.txnId}`,
            }, null, 2),
          }],
        };
      }

      if (name === "check_balance") {
        const balance = await fetchBalance(senderAddr);
        return { content: [{ type: "text", text: JSON.stringify({ agent_id: agentId, ...balance }, null, 2) }] };
      }

      if (name === "check_mandates") {
        const mandates = await fetchMandates(agentId, portalKey, apiUrl);
        const active   = (mandates as Array<Record<string, unknown>>).filter((m) => m.status === "active");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent_id:     agentId,
              active_count: active.length,
              mandates: active.map((m) => ({
                mandate_id:    m.mandateId,
                max_per_tx:    m.maxPerTx    !== undefined ? `$${(Number(m.maxPerTx)    / 1_000_000).toFixed(2)} USDC` : undefined,
                max_per_10min: m.maxPer10Min !== undefined ? `$${(Number(m.maxPer10Min) / 1_000_000).toFixed(2)} USDC` : undefined,
                max_per_day:   m.maxPerDay   !== undefined ? `$${(Number(m.maxPerDay)   / 1_000_000).toFixed(2)} USDC` : undefined,
                expires:       m.expiresAt,
                granted_by:    m.ownerAddress,
              })),
              note: active.length === 0 ? "No active mandates — payments use global velocity limits." : undefined,
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Tool error (${name}): ${message}` }], isError: true };
    }
  });

  return server;
}

// ── Express handler ────────────────────────────────────────────────────────

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const mnemonic  = req.headers["x-algo-mnemonic"] as string | undefined;
  const agentId   = req.headers["x-agent-id"]      as string | undefined;
  const portalKey = (req.headers["x-portal-key"]   as string | undefined) ?? "";
  const apiUrl    = ((req.headers["x-api-url"]      as string | undefined) ?? DEFAULT_API_URL).replace(/\/+$/, "");

  if (!mnemonic || !agentId) {
    res.status(400).json({ error: "X-Algo-Mnemonic and X-Agent-Id headers are required" });
    return;
  }

  let account: { addr: algosdk.Address; sk: Uint8Array };
  try {
    account = algosdk.mnemonicToSecretKey(mnemonic);
  } catch {
    res.status(400).json({ error: "Invalid X-Algo-Mnemonic" });
    return;
  }

  const senderAddr = account.addr.toString();
  const privateKey = account.sk;

  const server    = createMcpServer(agentId, senderAddr, privateKey, portalKey, apiUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
