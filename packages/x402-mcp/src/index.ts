#!/usr/bin/env node
/**
 * @algo-wallet/x402-mcp
 *
 * MCP server that gives Claude and other LLMs mandate-governed payment tools
 * for AI agents on Algorand. Exposes three tools:
 *
 *   pay_with_x402     — pay for any x402-gated API, enforces your mandate
 *   check_balance     — USDC + ALGO balance and gas status
 *   check_mandates    — active spending mandates set by your wallet owner
 *
 * Setup (Claude Desktop / Claude Code):
 *   {
 *     "mcpServers": {
 *       "x402-wallet": {
 *         "command": "npx",
 *         "args": ["-y", "@algo-wallet/x402-mcp"],
 *         "env": {
 *           "ALGO_MNEMONIC":    "word1 word2 ... word25",
 *           "MANDATE_APP_ID":  "123456789",
 *           "X402_AGENT_ID":   "my-claude-agent",
 *           "X402_PORTAL_KEY": "pk_...",
 *           "X402_API_URL":    "https://api.ai-agentic-wallet.com"
 *         }
 *       }
 *     }
 *   }
 *
 * Required env vars:
 *   ALGO_MNEMONIC    — 25-word Algorand mnemonic of your registered agent wallet
 *   MANDATE_APP_ID   — MandateContract application ID (from operator / register-mandate)
 *   X402_AGENT_ID    — agent ID registered at ai-agentic-wallet.com
 *   X402_PORTAL_KEY  — Portal API key (from /dashboard → API Keys)
 *
 * Optional env vars:
 *   X402_API_URL     — backend base URL (default: https://api.ai-agentic-wallet.com)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import algosdk from "algosdk";

// ── Config ────────────────────────────────────────────────────────

const API_URL       = (process.env.X402_API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const AGENT_ID      = process.env.X402_AGENT_ID;
const MNEMONIC      = process.env.ALGO_MNEMONIC;
const PORTAL_KEY    = process.env.X402_PORTAL_KEY ?? "";
const MANDATE_APP_ID = process.env.MANDATE_APP_ID ? parseInt(process.env.MANDATE_APP_ID, 10) : 0;

if (!MNEMONIC) {
  process.stderr.write("[x402-mcp] FATAL: ALGO_MNEMONIC env var is required\n");
  process.exit(1);
}
if (!AGENT_ID) {
  process.stderr.write("[x402-mcp] FATAL: X402_AGENT_ID env var is required\n");
  process.exit(1);
}
if (!MANDATE_APP_ID) {
  process.stderr.write("[x402-mcp] FATAL: MANDATE_APP_ID env var is required (deploy MandateContract first)\n");
  process.exit(1);
}

const account    = algosdk.mnemonicToSecretKey(MNEMONIC);
const privateKey = account.sk;
const senderAddr = account.addr.toString();

const INDEXER     = "https://mainnet-idx.algonode.cloud";
const ALGOD_URL   = process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.4160.nodely.dev";
const USDC_ID     = 31566704; // mainnet USDC ASA
const MBR_MICRO   = 200_000; // minimum balance requirement in µALGO

// ── Types ─────────────────────────────────────────────────────────

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
  settlement?: { txnId: string; confirmedRound: number; settledAt: string };
  error?: string;
  failedStage?: string;
}

// ── Payment Proof Builder ─────────────────────────────────────────
// Builds a signed MandateContract.pay() application call.
// X-PAYMENT = base64(msgpack(SignedTransaction))

const PAY_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("pay(address,uint64)void").getSelector(),
);

async function buildPaymentProof(payJson: PayJson): Promise<string> {
  const algod  = new algosdk.Algodv2("", ALGOD_URL, "");
  const params = await algod.getTransactionParams().do();

  // AVM fires 2 inner asset transfers — budget outer + 2 inner txn fees
  const sp = { ...params, fee: 3_000n, flatFee: true };

  const treasuryBytes = algosdk.decodeAddress(payJson.payment.payTo).publicKey;
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64BE(BigInt(payJson.payment.amount));

  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender:          senderAddr,
    appIndex:        MANDATE_APP_ID,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [PAY_SELECTOR, treasuryBytes, amountBuf],
    suggestedParams: sp,
  });

  const signedTxn = txn.signTxn(privateKey);
  return Buffer.from(signedTxn).toString("base64");
}

// ── x402 Payment Execution ────────────────────────────────────────

async function executeX402Payment(endpoint: string): Promise<SettlementResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PORTAL_KEY) headers["X-Portal-Key"] = PORTAL_KEY;

  const target = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;

  // Step 1 — probe for 402 terms
  const bounceRes = await fetch(target, { method: "POST", headers, body: JSON.stringify({ senderAddress: senderAddr }) });

  if (bounceRes.status !== 402) {
    const body = await bounceRes.json().catch(() => ({})) as Record<string, unknown>;
    if (!bounceRes.ok) throw new Error(`Request failed (${bounceRes.status}): ${body.error ?? bounceRes.statusText}`);
    return executeSettlement((body as { export: unknown }).export);
  }

  const payJson = await bounceRes.json() as PayJson;

  // Step 2 — build proof
  const xPayment = await buildPaymentProof(payJson);

  // Step 3 — replay with proof
  const actionRes = await fetch(target, {
    method: "POST",
    headers: { ...headers, "X-PAYMENT": xPayment },
    body: JSON.stringify({ senderAddress: senderAddr }),
  });

  if (!actionRes.ok) {
    const body = await actionRes.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Payment rejected (${actionRes.status}): ${body.error ?? actionRes.statusText}`);
  }

  const { export: sandboxExport } = await actionRes.json() as { export: unknown };
  return executeSettlement(sandboxExport);
}

async function executeSettlement(sandboxExport: unknown): Promise<SettlementResult> {
  const execHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (PORTAL_KEY) execHeaders["X-Portal-Key"] = PORTAL_KEY;

  const execRes = await fetch(`${API_URL}/api/execute`, {
    method: "POST",
    headers: execHeaders,
    body: JSON.stringify({ sandboxExport, agentId: AGENT_ID }),
  });

  return execRes.json() as Promise<SettlementResult>;
}

// ── Balance Fetch ─────────────────────────────────────────────────

async function fetchBalance(): Promise<{
  agent_address: string;
  contract_address: string;
  mandate_app_id: number;
  contract_algo_micro: number;
  contract_usdc_micro: number;
  contract_usdc: string;
  contract_algo: string;
  gas_status: string;
  gas_remaining_txns: number;
}> {
  const contractAddr = algosdk.getApplicationAddress(BigInt(MANDATE_APP_ID)).toString();

  const res = await fetch(`${INDEXER}/v2/accounts/${contractAddr}`);
  if (!res.ok) throw new Error(`Indexer error: HTTP ${res.status}`);

  const data = await res.json() as {
    account: {
      amount: number;
      assets?: Array<{ "asset-id": number; amount: number }>;
    };
  };

  const contract_algo_micro = data.account.amount ?? 0;
  const contract_usdc_micro = data.account.assets?.find((a) => a["asset-id"] === USDC_ID)?.amount ?? 0;
  const above               = Math.max(0, contract_algo_micro - MBR_MICRO);
  const gas_status          = above < 50_000 ? "critical" : above < 200_000 ? "low" : "ok";

  return {
    agent_address:       senderAddr,
    contract_address:    contractAddr,
    mandate_app_id:      MANDATE_APP_ID,
    contract_algo_micro,
    contract_usdc_micro,
    contract_usdc:       (contract_usdc_micro / 1_000_000).toFixed(6),
    contract_algo:       (contract_algo_micro / 1_000_000).toFixed(6),
    gas_status,
    gas_remaining_txns:  Math.floor(above / 1_000),
  };
}

// ── Mandate Fetch ─────────────────────────────────────────────────

async function fetchMandates(): Promise<unknown[]> {
  if (!PORTAL_KEY) throw new Error("X402_PORTAL_KEY is required to check mandates.");
  const res = await fetch(`${API_URL}/api/agents/${AGENT_ID}/mandates`, {
    headers: { "X-Portal-Key": PORTAL_KEY },
  });
  if (!res.ok) throw new Error(`Mandates fetch failed: HTTP ${res.status}`);
  const data = await res.json() as { mandates?: unknown[] };
  return data.mandates ?? [];
}

// ── Tool Definitions ──────────────────────────────────────────────

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
    "(ok / low / critical) and estimated remaining transactions before a top-up is needed. " +
    "Use this before making payments to confirm sufficient funds, or to report wallet status.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const MANDATES_TOOL: Tool = {
  name: "check_mandates",
  description:
    "List the active spending mandates configured by your wallet owner. Each mandate shows " +
    "the per-transaction cap, daily cap, and expiry date. Mandates are the safety boundary " +
    "between human intent and autonomous action — your agent cannot spend beyond what the " +
    "owner has authorised, regardless of what you are asked to do. " +
    "Use this to check your current spending authority before executing a task, or to " +
    "explain to users what limits are in place on this agent.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

// ── MCP Server ────────────────────────────────────────────────────

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
    // ── pay_with_x402 ─────────────────────────────────────────────
    if (name === "pay_with_x402") {
      const { endpoint } = args as { endpoint?: string };
      if (!endpoint) return { content: [{ type: "text", text: "endpoint is required" }], isError: true };

      const result = await executeX402Payment(endpoint);

      if (!result.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error ?? "Settlement failed", failedStage: result.failedStage }, null, 2) }],
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
    }

    // ── check_balance ─────────────────────────────────────────────
    if (name === "check_balance") {
      const balance = await fetchBalance();
      const gasIcon = balance.gas_status === "ok" ? "✅" : balance.gas_status === "low" ? "⚠️" : "🔴";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id:            AGENT_ID,
            agent_address:       balance.agent_address,
            contract_address:    balance.contract_address,
            mandate_app_id:      balance.mandate_app_id,
            usdc_balance:        `$${balance.contract_usdc} USDC`,
            algo_balance:        `${balance.contract_algo} ALGO`,
            gas_status:          `${gasIcon} ${balance.gas_status.toUpperCase()}`,
            gas_remaining_txns:  balance.gas_remaining_txns,
            note: balance.gas_status === "critical"
              ? "Gas critical — send ALGO to contract_address to avoid payment failures."
              : balance.gas_status === "low"
              ? "Gas low — consider topping up ALGO to contract_address soon."
              : undefined,
          }, null, 2),
        }],
      };
    }

    // ── check_mandates ────────────────────────────────────────────
    if (name === "check_mandates") {
      const mandates = await fetchMandates();
      const active = (mandates as Array<Record<string, unknown>>).filter((m) => m.status === "active");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent_id:       AGENT_ID,
            active_count:   active.length,
            mandates: active.map((m) => ({
              mandate_id:   m.mandateId,
              max_per_tx:   m.maxPerTx   !== undefined ? `$${(Number(m.maxPerTx)   / 1_000_000).toFixed(2)} USDC` : undefined,
              max_per_10min:m.maxPer10Min !== undefined ? `$${(Number(m.maxPer10Min)/ 1_000_000).toFixed(2)} USDC` : undefined,
              max_per_day:  m.maxPerDay  !== undefined ? `$${(Number(m.maxPerDay)  / 1_000_000).toFixed(2)} USDC` : undefined,
              expires:      m.expiresAt,
              granted_by:   m.ownerAddress,
            })),
            note: active.length === 0
              ? "No active mandates — payments will use global velocity limits only."
              : undefined,
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

// ── Start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[x402-mcp] Ready — agent ${AGENT_ID} at ${senderAddr}\n`);
