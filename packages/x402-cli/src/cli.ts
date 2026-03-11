#!/usr/bin/env node
/**
 * @algo-wallet/x402-cli
 *
 * Developer CLI for the x402-Algorand autonomous payment rail.
 *
 * Usage:
 *   npx @algo-wallet/x402-cli balance   --agent my-agent-001
 *   npx @algo-wallet/x402-cli mandate   list   --agent my-agent-001
 *   npx @algo-wallet/x402-cli history   --agent my-agent-001 --limit 20
 *   npx @algo-wallet/x402-cli agents    list
 *   npx @algo-wallet/x402-cli health
 *
 * Required env vars:
 *   X402_PORTAL_KEY   Portal API key (from /dashboard → API Keys)
 *
 * Optional env vars:
 *   X402_API_URL      Backend base URL (default: https://api.ai-agentic-wallet.com)
 */

import { Command } from "commander";

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL    = process.env.X402_API_URL    || "https://api.ai-agentic-wallet.com";
const PORTAL_KEY = process.env.X402_PORTAL_KEY || "";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(PORTAL_KEY ? { "X-Portal-Key": PORTAL_KEY } : {}),
  };
  const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts?.headers as Record<string, string> || {}) } });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.stringify(JSON.parse(text), null, 2); } catch { /* use raw text */ }
    throw new Error(`HTTP ${res.status} from ${url}:\n${detail}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function microUsdc(val: number | string | undefined): string {
  if (val === undefined || val === null) return "—";
  return `$${(Number(val) / 1_000_000).toFixed(4)} USDC`;
}

function microAlgo(val: number | string | undefined): string {
  if (val === undefined || val === null) return "—";
  return `${(Number(val) / 1_000_000).toFixed(6)} ALGO`;
}

function formatDate(iso: string | number | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) { console.log("  (none)"); return; }
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] || "").length)));
  const hr = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const header = keys.map((k, i) => ` ${k.padEnd(widths[i])} `).join("│");
  console.log("┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
  console.log("│" + header + "│");
  console.log("├" + hr + "┤");
  for (const row of rows) {
    console.log("│" + keys.map((k, i) => ` ${String(row[k] || "").padEnd(widths[i])} `).join("│") + "│");
  }
  console.log("└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("x402")
  .description("x402-Algorand payment rail CLI")
  .version("0.1.0");

// ── health ────────────────────────────────────────────────────────────────────

program
  .command("health")
  .description("Show backend health status")
  .action(async () => {
    const data = await apiFetch("/health") as {
      status: string;
      halted: boolean;
      redis: boolean;
      network?: string;
      node?: { latestRound?: number; usingFallback?: boolean; provider?: string };
    };
    console.log(`\nSystem: ${data.status === "ok" ? "✅ OK" : "❌ " + data.status}`);
    console.log(`Halted: ${data.halted ? "⛔ YES" : "✅ No"}`);
    console.log(`Redis:  ${data.redis  ? "✅ Connected" : "❌ Disconnected"}`);
    console.log(`Network: ${data.network ?? "—"}`);
    if (data.node) {
      console.log(`Algod:  round ${data.node.latestRound?.toLocaleString() ?? "?"} (${data.node.usingFallback ? "fallback" : data.node.provider ?? "primary"})`);
    }
    console.log();
  });

// ── balance ───────────────────────────────────────────────────────────────────

program
  .command("balance")
  .description("Show agent wallet balance")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .action(async (opts: { agent: string }) => {
    const agent = await apiFetch(`/api/agents/${opts.agent}`) as {
      agentId: string;
      address?: string;
      authAddr?: string;
      status?: string;
      custody?: string;
    };
    const address = agent.address || agent.authAddr;
    if (!address) {
      console.error("No on-chain address found for this agent.");
      process.exit(1);
    }

    console.log(`\nAgent:   ${agent.agentId}`);
    console.log(`Address: ${address}`);
    console.log(`Status:  ${agent.status ?? "—"}`);
    console.log(`Custody: ${agent.custody ?? "—"}`);

    // Fetch balance from indexer
    const NETWORK = process.env.X402_NETWORK || "testnet";
    const indexer = NETWORK === "mainnet"
      ? "https://mainnet-idx.algonode.cloud"
      : "https://testnet-idx.algonode.cloud";
    const USDC_ID = NETWORK === "mainnet" ? 31566704 : 10458941;

    const idxRes = await fetch(`${indexer}/v2/accounts/${address}`);
    if (idxRes.ok) {
      const acc = await idxRes.json() as {
        account: {
          amount: number;
          assets?: Array<{ "asset-id": number; amount: number }>;
        };
      };
      const algoMicro = acc.account.amount;
      const usdcAsset = acc.account.assets?.find((a) => a["asset-id"] === USDC_ID);
      console.log(`\nALGO:    ${microAlgo(algoMicro)}`);
      console.log(`USDC:    ${usdcAsset ? microUsdc(usdcAsset.amount) : "Not opted in"}`);
    }
    console.log();
  });

// ── agents ────────────────────────────────────────────────────────────────────

const agents = program.command("agents").description("Agent management commands");

agents
  .command("list")
  .description("List all registered agents")
  .option("--limit <n>", "Max results", "50")
  .action(async (opts: { limit: string }) => {
    const data = await apiFetch(`/api/agents?limit=${opts.limit}`) as
      { agents?: Array<{ agentId: string; address?: string; status: string; createdAt?: string }> } |
      Array<{ agentId: string; address?: string; status: string; createdAt?: string }>;

    const list = Array.isArray(data) ? data : (data.agents ?? []);
    console.log(`\n${list.length} agent(s):\n`);
    table(list.map((a) => ({
      "Agent ID":  a.agentId,
      "Address":   a.address ? `${a.address.slice(0, 8)}…${a.address.slice(-6)}` : "—",
      "Status":    a.status,
      "Created":   a.createdAt ? new Date(a.createdAt).toLocaleDateString() : "—",
    })));
    console.log();
  });

// ── mandates ──────────────────────────────────────────────────────────────────

const mandates = program.command("mandate").description("Mandate management commands");

mandates
  .command("list")
  .description("List mandates for an agent")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("--all", "Include revoked mandates")
  .action(async (opts: { agent: string; all?: boolean }) => {
    const qs = opts.all ? "?includeRevoked=true" : "";
    const data = await apiFetch(`/api/agents/${opts.agent}/mandates${qs}`) as
      { mandates?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;

    const list = Array.isArray(data) ? data : (data.mandates ?? []);
    console.log(`\n${list.length} mandate(s) for ${opts.agent}:\n`);

    for (const m of list) {
      const expiry = m.expiresAt
        ? new Date(typeof m.expiresAt === "number" ? m.expiresAt : String(m.expiresAt)).toLocaleDateString()
        : "No expiry";
      console.log(`  ${m.mandateId} [${m.status}]`);
      if (m.maxPerTx !== undefined && m.maxPerTx !== null)    console.log(`    Per-tx cap:  ${microUsdc(m.maxPerTx as number)}`);
      if (m.maxPer10Min !== undefined && m.maxPer10Min !== null) console.log(`    Per-10m cap: ${microUsdc(m.maxPer10Min as number)}`);
      if (m.maxPerDay !== undefined && m.maxPerDay !== null)  console.log(`    Per-day cap: ${microUsdc(m.maxPerDay as number)}`);
      console.log(`    Expires:     ${expiry}`);
      if (m.allowedRecipients && (m.allowedRecipients as string[]).length > 0) {
        console.log(`    Recipients:  ${(m.allowedRecipients as string[]).join(", ")}`);
      }
      console.log();
    }
  });

// ── history ───────────────────────────────────────────────────────────────────

program
  .command("history")
  .description("Show transaction history for an agent")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .option("--limit <n>", "Number of transactions to show", "20")
  .action(async (opts: { agent: string; limit: string }) => {
    const data = await apiFetch(`/api/agents/${opts.agent}/history?limit=${opts.limit}`) as
      { transactions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;

    const list = Array.isArray(data) ? data : ((data as { transactions?: Array<Record<string, unknown>> }).transactions ?? []);
    console.log(`\nTransaction history for ${opts.agent} (last ${opts.limit}):\n`);

    if (list.length === 0) { console.log("  No transactions found.\n"); return; }

    table(list.map((t) => ({
      "Time":      formatDate(String(t.settledAt || t.timestamp || t.time || "")),
      "Amount":    t.amountMicroUsdc !== undefined ? microUsdc(t.amountMicroUsdc as number)
                 : t.tollAmountMicroUsdc !== undefined ? microUsdc(t.tollAmountMicroUsdc as number) : "—",
      "Status":    String(t.status || "confirmed"),
      "Tx ID":     t.txnId ? `${String(t.txnId).slice(0, 10)}…` : "—",
    })));
    console.log();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
