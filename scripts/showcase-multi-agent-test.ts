/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MULTI-AGENT SHOWCASE TEST                                          ║
 * ║                                                                     ║
 * ║  Proves true throughput with zero lock contention:                  ║
 * ║    N agents × M payments = N×M total on-chain confirmations         ║
 * ║    Each agent has its own mandate contract + per-agent lock         ║
 * ║    Payments are sequential within each agent (no contention)        ║
 * ║    All agents run in parallel (no shared lock)                      ║
 * ║                                                                     ║
 * ║  Usage:                                                             ║
 * ║    npx tsx scripts/showcase-multi-agent-test.ts                     ║
 * ║                                                                     ║
 * ║  Required env:                                                      ║
 * ║    PORTAL_API_SECRET — portal auth for polling job status           ║
 * ║                                                                     ║
 * ║  Optional env:                                                      ║
 * ║    AGENTS_CONFIG     — path to JSON config (default: scripts/showcase-agents.json)
 * ║    API_URL           — defaults to https://api.ai-agentic-wallet.com ║
 * ║    CITY              — city for weather endpoint (default: Lagos)   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { AlgoAgentClient } from "@algo-wallet/x402-client";
import fs from "fs";
import path from "path";
import "dotenv/config";

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL        = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const PORTAL_SECRET  = process.env.PORTAL_API_SECRET!;
const CITY           = process.env.CITY ?? "Lagos";
const AGENTS_CONFIG  = process.env.AGENTS_CONFIG ?? path.join(process.cwd(), "scripts", "showcase-agents.json");
const POLL_INTERVAL  = 500;
const POLL_TIMEOUT   = 90_000;

// ── ANSI ──────────────────────────────────────────────────────────────────────

const R  = "\x1b[0m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const C  = "\x1b[36m";
const B  = "\x1b[1m";
const RE = "\x1b[31m";
const D  = "\x1b[2m";

const ts   = () => `${D}${new Date().toISOString().slice(11, 23)}${R}`;
const ok   = (m: string) => console.log(`  ${ts()} ${G}✔${R} ${m}`);
const fail = (m: string) => console.log(`  ${ts()} ${RE}✗${R} ${m}`);
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(70)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(70)}${R}\n`);
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentConfig {
  agentId:      string;
  mnemonic:     string;
  address:      string;
  mandateAppId: number;
  appAddress:   string;
}

interface ShowcaseConfig {
  generatedAt:      string;
  network:          string;
  nAgents:          number;
  paymentsPerAgent: number;
  totalPayments:    number;
  agents:           AgentConfig[];
}

interface PaymentResult {
  agentIndex:     number;
  slot:           number;
  enqueueMs:      number;
  confirmMs:      number;
  httpStatus:     number;
  jobId:          string;
  txnId:          string;
  confirmedRound?: number;
  status:         "confirmed" | "failed" | "timeout" | "error";
  error?:         string;
}

interface JobStatus {
  jobId:           string;
  status:          "queued" | "broadcasting" | "confirmed" | "failed";
  txnId?:          string;
  confirmedRound?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function pollJob(jobId: string, startMs: number): Promise<{
  status: PaymentResult["status"]; confirmMs: number; txnId: string; confirmedRound?: number;
}> {
  if (!jobId) return { status: "error", confirmMs: Date.now() - startMs, txnId: "" };

  const deadline = startMs + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const res = await fetch(`${API_URL}/api/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${PORTAL_SECRET}` },
      });
      if (!res.ok) continue;
      const job = await res.json() as JobStatus;
      if (job.status === "confirmed") {
        return { status: "confirmed", confirmMs: Date.now() - startMs, txnId: job.txnId ?? "", confirmedRound: job.confirmedRound };
      }
      if (job.status === "failed") {
        return { status: "failed", confirmMs: Date.now() - startMs, txnId: job.txnId ?? "" };
      }
    } catch { /* retry */ }
  }
  return { status: "timeout", confirmMs: POLL_TIMEOUT, txnId: "" };
}

// ── Single agent stream ───────────────────────────────────────────────────────

async function runAgentStream(
  agentIndex:       number,
  cfg:              AgentConfig,
  paymentsCount:    number,
  wallStartMs:      number,
): Promise<PaymentResult[]> {
  const account = algosdk.mnemonicToSecretKey(cfg.mnemonic);
  const client  = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    mandateAppId: cfg.mandateAppId,
  });

  const results: PaymentResult[] = [];

  for (let slot = 1; slot <= paymentsCount; slot++) {
    const t0 = Date.now();
    let enqueueMs = 0;
    let httpStatus = 0;
    let jobId = "";
    let enqueueError: string | undefined;

    try {
      const response = await client.fetch("/api/weather", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ city: CITY }),
      });
      enqueueMs  = Date.now() - t0;
      httpStatus = response.status;

      if (response.ok) {
        const body = await response.json() as { jobId?: string };
        jobId = body.jobId ?? "";
      } else {
        const body = await response.json().catch(() => ({})) as Record<string, string>;
        enqueueError = body.error ?? `HTTP ${httpStatus}`;
      }
    } catch (err) {
      enqueueMs    = Date.now() - t0;
      enqueueError = err instanceof Error ? err.message : String(err);
    }

    if (enqueueError || !jobId) {
      results.push({
        agentIndex, slot, enqueueMs, confirmMs: 0, httpStatus, jobId, txnId: "",
        status: "error", error: enqueueError,
      });
      continue;
    }

    // Poll to confirmation
    const poll = await pollJob(jobId, t0);
    results.push({
      agentIndex, slot, enqueueMs, confirmMs: poll.confirmMs,
      httpStatus, jobId, txnId: poll.txnId, confirmedRound: poll.confirmedRound,
      status: poll.status,
    });

    const statusIcon = poll.status === "confirmed" ? `${G}✔${R}` : `${RE}✗${R}`;
    const shortAddr  = cfg.address.slice(0, 8);
    process.stdout.write(
      `  ${ts()} ${statusIcon} agent[${agentIndex}] slot ${slot}/${paymentsCount}` +
      `  enq ${enqueueMs}ms  confirm ${poll.confirmMs}ms\n`,
    );
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!PORTAL_SECRET) {
    console.error("[FATAL] PORTAL_API_SECRET is required.");
    process.exit(1);
  }

  if (!fs.existsSync(AGENTS_CONFIG)) {
    console.error(`[FATAL] Config file not found: ${AGENTS_CONFIG}`);
    console.error("Run npx tsx scripts/setup-multi-agent-showcase.ts first.");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(AGENTS_CONFIG, "utf8")) as ShowcaseConfig;
  const { agents, paymentsPerAgent, nAgents } = config;
  const totalPayments = nAgents * paymentsPerAgent;

  console.log(`\n${C}${"═".repeat(70)}${R}`);
  console.log(`  ${B}${C}MULTI-AGENT SHOWCASE TEST${R}`);
  console.log(`${C}${"═".repeat(70)}${R}`);
  console.log(`  ${D}Target:         ${API_URL}${R}`);
  console.log(`  ${D}Agents:         ${nAgents}${R}`);
  console.log(`  ${D}Payments/agent: ${paymentsPerAgent}${R}`);
  console.log(`  ${D}Total payments: ${totalPayments}${R}`);
  console.log(`  ${D}City:           ${CITY}${R}`);
  console.log(`  ${D}Config:         ${AGENTS_CONFIG}${R}`);
  console.log(`${C}${"═".repeat(70)}${R}\n`);

  // Pre-flight health check
  sep("PRE-FLIGHT");
  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    fail(`Server unhealthy: HTTP ${health.status}`);
    process.exit(1);
  }
  const healthBody = await health.json() as { status: string; network: string };
  ok(`Server: ${healthBody.status} on ${healthBody.network}`);

  for (const [i, a] of agents.entries()) {
    info(`Agent ${i + 1}: ${a.address.slice(0, 10)}...  mandate=${a.mandateAppId}`);
  }

  // ── Run all agent streams in parallel ─────────────────────────────────────
  sep(`RUNNING ${nAgents} PARALLEL STREAMS — ${paymentsPerAgent} sequential payments each`);
  info(`Each agent runs sequentially within its own stream (no contention between agents).`);
  info(`Expect 0 retries — each agent has its own settling lock.`);
  console.log();

  const wallStart = Date.now();

  const streamPromises = agents.map((cfg, i) =>
    runAgentStream(i + 1, cfg, paymentsPerAgent, wallStart),
  );

  const allStreams   = await Promise.all(streamPromises);
  const wallMs       = Date.now() - wallStart;
  const allResults   = allStreams.flat();

  // ── Results ───────────────────────────────────────────────────────────────
  sep("RESULTS");

  const confirmed     = allResults.filter((r) => r.status === "confirmed");
  const failed        = allResults.filter((r) => r.status !== "confirmed");
  const enqueueTimes  = allResults.filter((r) => r.enqueueMs > 0).map((r) => r.enqueueMs).sort((a, b) => a - b);
  const confirmTimes  = confirmed.map((r) => r.confirmMs).sort((a, b) => a - b);

  // Per-agent summary
  console.log(`  ${C}Per-agent summary:${R}`);
  console.log(`  ${"─".repeat(65)}`);
  console.log(`  ${"Agent".padEnd(8)}  ${"Mandate".padEnd(12)}  ${"Confirmed".padStart(9)}  ${"Enq p50".padStart(8)}  ${"Cnf p50".padStart(8)}`);
  console.log(`  ${"─".repeat(65)}`);
  for (const [i, stream] of allStreams.entries()) {
    const cfg         = agents[i]!;
    const agentConf   = stream.filter((r) => r.status === "confirmed");
    const agentEnq    = stream.map((r) => r.enqueueMs).sort((a, b) => a - b);
    const agentCnf    = agentConf.map((r) => r.confirmMs).sort((a, b) => a - b);
    const confColor   = agentConf.length === paymentsPerAgent ? G : RE;
    console.log(
      `  ${String(i + 1).padEnd(8)}` +
      `  ${String(cfg.mandateAppId).padEnd(12)}` +
      `  ${confColor}${String(agentConf.length + "/" + paymentsPerAgent).padStart(9)}${R}` +
      `  ${String(pct(agentEnq, 50) + "ms").padStart(8)}` +
      `  ${String(pct(agentCnf, 50) + "ms").padStart(8)}`,
    );
  }
  console.log(`  ${"─".repeat(65)}`);
  console.log();

  // Aggregate latency
  console.log(`  ${C}Aggregate latency:${R}`);
  console.log(`    Enqueue  p50: ${pct(enqueueTimes, 50)}ms   p95: ${pct(enqueueTimes, 95)}ms   p99: ${pct(enqueueTimes, 99)}ms`);
  if (confirmTimes.length > 0) {
    console.log(`    Confirm  p50: ${pct(confirmTimes, 50)}ms   p95: ${pct(confirmTimes, 95)}ms   p99: ${pct(confirmTimes, 99)}ms`);
    console.log(`    Confirm  min: ${confirmTimes[0]}ms   max: ${confirmTimes[confirmTimes.length - 1]}ms`);
  }
  console.log();

  // Throughput
  const tps = (confirmed.length / (wallMs / 1000)).toFixed(2);
  const tpm = (confirmed.length / (wallMs / 60_000)).toFixed(1);
  console.log(`  ${C}Throughput:${R}`);
  console.log(`    ${confirmed.length}/${totalPayments} confirmed in ${(wallMs / 1000).toFixed(1)}s wall time`);
  console.log(`    ${tps} tx/sec   ${tpm} tx/min`);
  console.log(`    Algorand block time: ~3.8s   Optimistic delivery: ~${pct(enqueueTimes, 50)}ms p50`);
  console.log();

  if (failed.length > 0) {
    console.log(`  ${RE}Failed / timed out (${failed.length}):${R}`);
    for (const f of failed) {
      console.log(`    Agent ${f.agentIndex} slot ${f.slot}: ${f.status}${f.error ? ` — ${f.error}` : ""}`);
    }
    console.log();
  }

  // ── Save report ───────────────────────────────────────────────────────────
  const report = {
    schema:       "multi-agent-showcase-v1",
    generatedAt:  new Date().toISOString(),
    testType:     "multi-agent-mandate-showcase",
    network:      healthBody.network ?? "mainnet",
    nAgents,
    paymentsPerAgent,
    totalPayments,
    confirmed:    confirmed.length,
    failed:       failed.length,
    wallTimeMs:   wallMs,
    enqueueLatencyMs: {
      p50: pct(enqueueTimes, 50), p95: pct(enqueueTimes, 95), p99: pct(enqueueTimes, 99),
      avg: Math.round(enqueueTimes.reduce((a, b) => a + b, 0) / (enqueueTimes.length || 1)),
    },
    confirmLatencyMs: confirmTimes.length > 0 ? {
      p50: pct(confirmTimes, 50), p95: pct(confirmTimes, 95), p99: pct(confirmTimes, 99),
      min: confirmTimes[0], max: confirmTimes[confirmTimes.length - 1],
    } : null,
    throughputTxPerSec:    parseFloat(tps),
    throughputTxPerMin:    parseFloat(tpm),
    agentSummary: allStreams.map((stream, i) => ({
      agentIndex:   i + 1,
      mandateAppId: agents[i]!.mandateAppId,
      address:      agents[i]!.address,
      confirmed:    stream.filter((r) => r.status === "confirmed").length,
      failed:       stream.filter((r) => r.status !== "confirmed").length,
    })),
    slots: allResults.map((r) => ({
      agentIndex:     r.agentIndex,
      slot:           r.slot,
      enqueueMs:      r.enqueueMs,
      confirmMs:      r.confirmMs,
      confirmedRound: r.confirmedRound ?? null,
      txnId:          r.txnId || null,
      explorerUrl:    r.txnId ? `https://explorer.perawallet.app/tx/${r.txnId}` : null,
      status:         r.status,
    })),
  };

  const reportPath = path.join(process.cwd(), "public", "mandate-test-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  sep("SUMMARY");

  if (confirmed.length === totalPayments) {
    ok(`${confirmed.length}/${totalPayments} payments CONFIRMED on-chain.  ${nAgents} agents × ${paymentsPerAgent} sequential payments.`);
    ok(`Multi-agent showcase PASSED.`);
    console.log();
    console.log(`  ${D}Wall time:       ${(wallMs / 1000).toFixed(1)}s${R}`);
    console.log(`  ${D}Throughput:      ${tpm} tx/min  (${tps} tx/sec)${R}`);
    console.log(`  ${D}Enqueue p50:     ${pct(enqueueTimes, 50)}ms${R}`);
    console.log(`  ${D}Confirm p50:     ${pct(confirmTimes, 50)}ms${R}`);
  } else {
    console.log(`  ${Y}${confirmed.length}/${totalPayments} confirmed.${R}`);
    if (failed.length > 0) {
      console.log(`  ${RE}${failed.length} failed — check agent USDC balances and retry.${R}`);
    }
  }

  console.log();
  console.log(`  ${D}Report saved → ${reportPath}${R}`);
  console.log();

  if (confirmed.length < totalPayments) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[SHOWCASE] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
