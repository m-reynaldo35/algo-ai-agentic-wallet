#!/usr/bin/env node
/**
 * @algo-wallet/x402-mcp
 *
 * MCP server exposing a single tool — pay_with_x402 — that executes
 * a full x402 payment handshake on Algorand and returns the on-chain
 * settlement result.
 *
 * Setup (Claude Desktop / Claude Code):
 *   {
 *     "mcpServers": {
 *       "x402": {
 *         "command": "npx",
 *         "args": ["-y", "@algo-wallet/x402-mcp"],
 *         "env": {
 *           "ALGO_MNEMONIC": "word1 word2 ... word25",
 *           "X402_AGENT_ID": "my-claude-agent",
 *           "X402_API_URL": "https://api.ai-agentic-wallet.com"
 *         }
 *       }
 *     }
 *   }
 *
 * Required env vars:
 *   ALGO_MNEMONIC   — 25-word Algorand mnemonic of your registered agent wallet
 *   X402_AGENT_ID   — agent ID registered with the wallet router
 *
 * Optional env vars:
 *   X402_API_URL         — wallet router base URL (default: https://api.ai-agentic-wallet.com)
 *   X402_PORTAL_KEY      — Portal API key (if required by your server config)
 *   X402_SLIPPAGE_BIPS   — slippage tolerance in basis points (default: 50)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import algosdk from "algosdk";
import crypto from "crypto";

// ── Config from environment ───────────────────────────────────────

const API_URL     = (process.env.X402_API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const AGENT_ID    = process.env.X402_AGENT_ID;
const MNEMONIC    = process.env.ALGO_MNEMONIC;
const PORTAL_KEY  = process.env.X402_PORTAL_KEY ?? "";
const SLIPPAGE    = parseInt(process.env.X402_SLIPPAGE_BIPS ?? "50", 10);

if (!MNEMONIC) {
  process.stderr.write("[x402-mcp] FATAL: ALGO_MNEMONIC env var is required\n");
  process.exit(1);
}
if (!AGENT_ID) {
  process.stderr.write("[x402-mcp] FATAL: X402_AGENT_ID env var is required\n");
  process.exit(1);
}

const account    = algosdk.mnemonicToSecretKey(MNEMONIC);
const privateKey = account.sk;  // 64-byte [seed(32)|pubkey(32)]
const senderAddr = account.addr.toString();

// ── x402 Handshake Helpers ────────────────────────────────────────

interface PayJson {
  version: string;
  payment: { amount: string; payTo: string; asset: { id: number } };
  expires: string;
  memo: string;
}

interface SettlementResult {
  success: boolean;
  agentId: string;
  sandboxId: string;
  settlement?: {
    txnId: string;
    confirmedRound: number;
    groupId: string;
    settledAt: string;
  };
  error?: string;
  failedStage?: string;
}

async function buildPaymentProof(
  payJson: PayJson,
  nodeUrl = "https://mainnet-api.4160.nodely.dev",
): Promise<string> {
  const algod = new algosdk.Algodv2("", nodeUrl, "");
  const params = await algod.getTransactionParams().do();

  const assetId = BigInt(payJson.payment.asset.id);
  const amount  = BigInt(payJson.payment.amount);

  const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          senderAddr,
    receiver:        payJson.payment.payTo,
    amount,
    assetIndex:      assetId,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(payJson.memo ?? "x402")),
  });

  algosdk.assignGroupID([tollTxn]);

  const groupId    = Buffer.from(tollTxn.group!).toString("base64");
  const signedTxn  = Buffer.from(tollTxn.signTxn(privateKey)).toString("base64");
  const timestamp  = Math.floor(Date.now() / 1000);
  const nonce      = crypto.randomUUID();

  const sigPayload = Buffer.from(`${groupId}:${timestamp}:${nonce}`);
  const signature  = Buffer.from(
    algosdk.signBytes(sigPayload, privateKey),
  ).toString("base64");

  const proof = {
    groupId,
    transactions: [signedTxn],
    senderAddr,
    signature,
    timestamp,
    nonce,
  };

  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

async function executeX402Payment(input: {
  amount_usdc?: number;
  destination_chain?: string;
  destination_recipient?: string;
}): Promise<SettlementResult> {
  const reqBody: Record<string, unknown> = { senderAddress: senderAddr };
  if (input.amount_usdc !== undefined) reqBody.amount = Math.round(input.amount_usdc * 1_000_000);
  if (input.destination_chain)     reqBody.destinationChain = input.destination_chain;
  if (input.destination_recipient) reqBody.destinationRecipient = input.destination_recipient;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PORTAL_KEY) headers["X-Portal-Key"] = PORTAL_KEY;
  headers["X-SLIPPAGE-BIPS"] = String(SLIPPAGE);

  // Step 1 — Bounce request to get 402 terms
  const bounceRes = await fetch(`${API_URL}/v1/api/agent-action`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (bounceRes.status !== 402) {
    // Unexpected: either already paid or error
    const body = await bounceRes.json().catch(() => ({})) as Record<string, unknown>;
    if (!bounceRes.ok) throw new Error(`agent-action failed (${bounceRes.status}): ${body.error ?? bounceRes.statusText}`);
    // Got 200 directly (no toll) — treat as sandbox export
    return executeSettlement((body as { export: unknown }).export);
  }

  const payJson = await bounceRes.json() as PayJson;

  // Step 2 — Build payment proof
  const xPayment = await buildPaymentProof(payJson);

  // Step 3 — Replay with proof
  const actionRes = await fetch(`${API_URL}/v1/api/agent-action`, {
    method:  "POST",
    headers: { ...headers, "X-PAYMENT": xPayment },
    body:    JSON.stringify(reqBody),
  });

  if (!actionRes.ok) {
    const body = await actionRes.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`agent-action (with payment) failed (${actionRes.status}): ${body.error ?? actionRes.statusText}`);
  }

  const { export: sandboxExport } = await actionRes.json() as { export: unknown };

  // Step 4 — Execute settlement
  return executeSettlement(sandboxExport);
}

async function executeSettlement(sandboxExport: unknown): Promise<SettlementResult> {
  const execHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (PORTAL_KEY) execHeaders["X-Portal-Key"] = PORTAL_KEY;

  const execRes = await fetch(`${API_URL}/v1/api/execute`, {
    method:  "POST",
    headers: execHeaders,
    body:    JSON.stringify({ sandboxExport, agentId: AGENT_ID }),
  });

  return execRes.json() as Promise<SettlementResult>;
}

// ── MCP Tool Definition ───────────────────────────────────────────

const PAY_TOOL: Tool = {
  name: "pay_with_x402",
  description:
    "Execute an x402 payment on Algorand. Handles the full 402-handshake, " +
    "signs the payment with the configured agent wallet, and returns the " +
    "on-chain settlement result including the Algorand transaction ID. " +
    "Use this whenever a task requires paying a service fee or sending USDC " +
    "cross-chain (Ethereum, Solana, Base, Avalanche, Polygon, Arbitrum, Optimism).",
  inputSchema: {
    type: "object" as const,
    properties: {
      amount_usdc: {
        type: "number",
        description: "Amount in USDC (e.g. 0.01 for 1 cent). Omit to use the server's default toll.",
      },
      destination_chain: {
        type: "string",
        enum: ["ethereum", "solana", "base", "algorand", "avalanche", "polygon", "arbitrum", "optimism"],
        description: "Destination chain for USDC bridging. Default: algorand (no bridge).",
      },
      destination_recipient: {
        type: "string",
        description: "Recipient address on the destination chain (required if bridging cross-chain).",
      },
    },
  },
};

// ── MCP Server ────────────────────────────────────────────────────

const server = new Server(
  { name: "x402-payments", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [PAY_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "pay_with_x402") {
    return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
  }

  const input = (request.params.arguments ?? {}) as {
    amount_usdc?: number;
    destination_chain?: string;
    destination_recipient?: string;
  };

  try {
    const result = await executeX402Payment(input);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: result.error ?? "Settlement failed",
            failedStage: result.failedStage,
          }, null, 2),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          txnId:          result.settlement?.txnId,
          confirmedRound: result.settlement?.confirmedRound,
          settledAt:      result.settlement?.settledAt,
          agentId:        result.agentId,
          explorer:       `https://explorer.perawallet.app/tx/${result.settlement?.txnId}`,
        }, null, 2),
      }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `x402 payment failed: ${message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[x402-mcp] Server ready — agent ${AGENT_ID} (${senderAddr})\n`);
