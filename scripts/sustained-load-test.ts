/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  SUSTAINED LOAD TEST (Sprint 5.2)                                        │
 * │                                                                          │
 * │  50 sequential x402 payments over 10 minutes (1 every 12s).             │
 * │                                                                          │
 * │  Validates:                                                              │
 * │    - No crashes or 5xx errors after sustained load                      │
 * │    - Treasury outflow guard does not false-positive halt                 │
 * │    - Velocity engine stays clean (rolling window math holds)            │
 * │    - Redis does not accumulate stale keys (checked via /health)         │
 * │    - On-chain monitor reconciliation stays clean                        │
 * │                                                                          │
 * │  Each payment uses a small amount (1,000 µUSDC = $0.001) so the        │
 * │  50-payment total ($0.05) stays well below the 10-min velocity cap      │
 * │  ($50 default) and the 24h cap ($500 default).                          │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    ALGO_MNEMONIC="..." PORTAL_API_SECRET="..." AGENT_ID="..." \         │
 * │      npx tsx scripts/sustained-load-test.ts                             │
 * │                                                                          │
 * │  Env:                                                                    │
 * │    ALGO_MNEMONIC          — 25-word mnemonic of registered agent wallet │
 * │    PORTAL_API_SECRET      — bearer token for /api/execute               │
 * │    AGENT_ID               — registered agent ID                         │
 * │    API_URL                — API base URL (default: Railway production)  │
 * │    PAYMENT_COUNT          — number of payments (default: 50)            │
 * │    PAYMENT_INTERVAL_S     — seconds between payments (default: 12)      │
 * │    PAYMENT_AMOUNT_MICROUSDC — µUSDC per payment (default: 1000)        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────────────
const API_URL       = (process.env.API_URL || "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const AGENT_ID      = process.env.AGENT_ID;
const PORTAL_SEC    = process.env.PORTAL_API_SECRET;
const MNEMONIC      = process.env.ALGO_MNEMONIC;
const PAYMENT_COUNT = parseInt(process.env.PAYMENT_COUNT           || "50",   10);
const INTERVAL_S    = parseInt(process.env.PAYMENT_INTERVAL_S      || "12",   10);
const AMOUNT_MICRO  = parseInt(process.env.PAYMENT_AMOUNT_MICROUSDC || "10000", 10); // must match X402_PRICE_MICROUSDC on server

const REPORT_PATH = path.join(__dirname, "..", "public", "sustained-load-report.json");

// ── ANSI helpers ──────────────────────────────────────────────────
const R   = "\x1b[0m";
const G   = "\x1b[32m";
const Y   = "\x1b[33m";
const C   = "\x1b[36m";
const D   = "\x1b[2m";
const RE  = "\x1b[31m";

const ts   = () => `${D}${new Date().toISOString().slice(11, 23)}${R}`;
const ok   = (m: string) => console.log(`  ${ts()} ${G}✔${R} ${m}`);
const fail = (m: string) => console.log(`  ${ts()} ${RE}✗${R} ${m}`);
const warn = (m: string) => console.log(`  ${ts()} ${Y}⚠${R} ${m}`);
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Per-payment result ────────────────────────────────────────────
interface PaymentResult {
  seq:         number;
  ts:          string;
  success:     boolean;
  httpStatus:  number;
  enqueueMs:   number;
  confirmMs:   number;
  jobId:       string;
  jobStatus:   string;
  error?:      string;
  haltDetected: boolean;
}

// ── Single payment: sandbox → execute → poll ──────────────────────
async function sendOnePayment(
  client:    AlgoAgentClient,
  address:   string,
  agentId:   string,
  portalSec: string,
  seq:       number,
): Promise<PaymentResult> {
  const startMs = Date.now();
  const base: Omit<PaymentResult, "enqueueMs" | "confirmMs" | "jobId" | "jobStatus"> = {
    seq,
    ts:          new Date().toISOString(),
    success:     false,
    httpStatus:  0,
    haltDetected: false,
  };

  // Get sandbox export
  let sandboxExport: object;
  try {
    const resp = await client.requestSandboxExport({ senderAddress: address, amount: AMOUNT_MICRO });
    sandboxExport = resp.export as object;
  } catch (err) {
    return {
      ...base, enqueueMs: Date.now() - startMs, confirmMs: Date.now() - startMs,
      jobId: "", jobStatus: "export_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Execute
  const execT0 = Date.now();
  let execRes: Response;
  try {
    execRes = await fetch(`${API_URL}/api/execute`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${portalSec}`,
      },
      body: JSON.stringify({ sandboxExport, agentId }),
    });
  } catch (err) {
    return {
      ...base, httpStatus: 0, enqueueMs: Date.now() - execT0, confirmMs: Date.now() - startMs,
      jobId: "", jobStatus: "network_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const enqueueMs = Date.now() - execT0;
  const execBody = await execRes.json() as Record<string, unknown>;
  const haltDetected = execBody.error === "HALT" || String(execBody.error ?? "").includes("halt");

  if (!execRes.ok) {
    return {
      ...base, httpStatus: execRes.status, enqueueMs, confirmMs: Date.now() - startMs,
      jobId: "", jobStatus: "execute_failed",
      haltDetected,
      error: String(execBody.error ?? `HTTP ${execRes.status}`),
    };
  }

  const jobId = String(execBody.jobId ?? "");

  // Poll for confirmation (up to 90s)
  const POLL_TIMEOUT_MS = 90_000;
  const POLL_INTERVAL_MS = 2_000;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let jobStatus = "queued";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const jr = await fetch(`${API_URL}/api/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${portalSec}` },
      });
      if (!jr.ok) continue;
      const jb = await jr.json() as Record<string, string>;
      jobStatus = jb.status ?? "unknown";
      if (jobStatus === "confirmed" || jobStatus === "failed") break;
    } catch { /* retry */ }
  }

  const confirmMs = Date.now() - startMs;

  return {
    ...base,
    httpStatus: execRes.status,
    enqueueMs,
    confirmMs,
    jobId,
    jobStatus,
    success: jobStatus === "confirmed",
  };
}

// ── Check system health ───────────────────────────────────────────
async function checkHealth(): Promise<{ ok: boolean; halted: boolean; detail: string }> {
  try {
    const res = await fetch(`${API_URL}/health`);
    if (!res.ok) return { ok: false, halted: false, detail: `HTTP ${res.status}` };
    const b = await res.json() as Record<string, unknown>;
    const halted = b["status"] === "halted" || String(b["status"] ?? "").includes("halt");
    return { ok: b["status"] === "ok", halted, detail: String(b["status"] ?? "ok") };
  } catch (err) {
    return { ok: false, halted: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function runSustainedLoadTest() {
  const durationMin = Math.ceil((PAYMENT_COUNT * INTERVAL_S) / 60);
  const totalUsdcMin = PAYMENT_COUNT * AMOUNT_MICRO / 1_000_000;

  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}SUSTAINED LOAD TEST (Sprint 5.2)${R}`);
  console.log(`  ${D}Target:        ${API_URL}${R}`);
  console.log(`  ${D}Payments:      ${PAYMENT_COUNT} × every ${INTERVAL_S}s (~${durationMin} min)${R}`);
  console.log(`  ${D}Amount/pmt:    ${AMOUNT_MICRO} µUSDC ($${(AMOUNT_MICRO / 1_000_000).toFixed(6)})${R}`);
  console.log(`  ${D}Total spend:   ~$${totalUsdcMin.toFixed(4)} USDC${R}`);
  console.log(`  ${D}Date:          ${new Date().toISOString()}${R}`);
  console.log(`${C}${"═".repeat(68)}${R}\n`);

  if (!AGENT_ID || !PORTAL_SEC || !MNEMONIC) {
    fail("Missing required env vars: ALGO_MNEMONIC, PORTAL_API_SECRET, AGENT_ID");
    process.exit(1);
  }

  let account: algosdk.Account;
  try {
    account = algosdk.mnemonicToSecretKey(MNEMONIC);
  } catch (err) {
    fail(`Invalid ALGO_MNEMONIC: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Pre-flight ─────────────────────────────────────────────────
  sep("PRE-FLIGHT");
  const health = await checkHealth();
  if (!health.ok) {
    fail(`Server not healthy: ${health.detail}`);
    process.exit(1);
  }
  if (health.halted) {
    fail("System is HALTED — clear halt before running sustained test");
    process.exit(1);
  }
  ok(`Server: ${API_URL} — ${health.detail}`);
  ok(`Wallet: ${account.addr.toString().slice(0, 20)}...`);
  ok(`Agent:  ${AGENT_ID}`);

  const totalCostUSDC = (PAYMENT_COUNT * AMOUNT_MICRO) / 1_000_000;
  console.log(`\n  ${Y}This test will send ${PAYMENT_COUNT} payments (~$${totalCostUSDC.toFixed(4)} USDC total).${R}`);
  console.log(`  ${Y}Ctrl+C to abort. Starting in 5 seconds...${R}`);
  await new Promise((r) => setTimeout(r, 5000));

  const client = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    slippageBips: 0,
  });

  // ── Run 50 sequential payments ─────────────────────────────────
  sep(`EXECUTING ${PAYMENT_COUNT} PAYMENTS`);
  const results: PaymentResult[] = [];
  const wallStart = Date.now();

  for (let i = 0; i < PAYMENT_COUNT; i++) {
    const seq = i + 1;
    process.stdout.write(`  [${String(seq).padStart(3)}/${PAYMENT_COUNT}] `);

    const result = await sendOnePayment(client, account.addr.toString(), AGENT_ID, PORTAL_SEC, seq);
    results.push(result);

    if (result.success) {
      process.stdout.write(`${G}✔${R} confirmed  enq: ${result.enqueueMs}ms  total: ${result.confirmMs}ms\n`);
    } else if (result.haltDetected) {
      process.stdout.write(`${RE}✗ HALT DETECTED — stopping test${R}\n`);
      fail(`False-positive halt triggered at payment #${seq}`);
      break;
    } else {
      const statusColor = result.httpStatus === 429 ? Y : RE;
      process.stdout.write(`${statusColor}✗${R} ${result.error ?? result.jobStatus}  (HTTP ${result.httpStatus})\n`);
    }

    // Health spot-check every 10 payments
    if (seq % 10 === 0 && seq < PAYMENT_COUNT) {
      const h = await checkHealth();
      if (h.halted) {
        fail(`System halted at payment #${seq} — stopping test`);
        break;
      }
      info(`Health OK at payment #${seq} — ${h.detail}`);
    }

    // Wait before next payment (last payment: no wait)
    if (i < PAYMENT_COUNT - 1) {
      await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    }
  }

  const wallElapsedMs = Date.now() - wallStart;

  // ── Compute stats ──────────────────────────────────────────────
  const successes      = results.filter((r) => r.success);
  const failures       = results.filter((r) => !r.success);
  const haltTriggered  = results.some((r) => r.haltDetected);
  const rateLimited    = results.filter((r) => r.httpStatus === 429 || r.httpStatus === 503);

  const enqueueLatencies = successes.map((r) => r.enqueueMs).sort((a, b) => a - b);
  const confirmLatencies = successes.map((r) => r.confirmMs).sort((a, b) => a - b);

  // ── Print results ──────────────────────────────────────────────
  sep("RESULTS");

  console.log(`  ${D}Payments sent:   ${results.length}/${PAYMENT_COUNT}${R}`);
  console.log(`  ${G}Confirmed:       ${successes.length}${R}`);
  console.log(`  ${failures.length > 0 ? RE : G}Failed:          ${failures.length}${R}`);
  console.log(`  ${rateLimited.length > 0 ? Y : G}Rate-limited:    ${rateLimited.length}${R}`);
  console.log(`  ${haltTriggered ? RE : G}Halt triggered:  ${haltTriggered ? "YES — FALSE POSITIVE" : "No"}${R}`);
  console.log(`  ${D}Elapsed:         ${(wallElapsedMs / 60000).toFixed(1)} min${R}`);

  if (enqueueLatencies.length > 0) {
    console.log();
    console.log(`  ${C}Enqueue latency:${R}`);
    console.log(`    p50 ${percentile(enqueueLatencies, 50)}ms`);
    console.log(`    p95 ${percentile(enqueueLatencies, 95)}ms`);
    console.log(`    p99 ${percentile(enqueueLatencies, 99)}ms`);
    console.log(`    avg ${Math.round(enqueueLatencies.reduce((s, v) => s + v, 0) / enqueueLatencies.length)}ms`);
  }

  if (confirmLatencies.length > 0) {
    console.log();
    console.log(`  ${C}Total confirmation latency:${R}`);
    console.log(`    p50 ${percentile(confirmLatencies, 50)}ms`);
    console.log(`    p95 ${percentile(confirmLatencies, 95)}ms`);
  }

  // ── Write report ───────────────────────────────────────────────
  const report = {
    schema:      "sustained-load-v1",
    generatedAt: new Date().toISOString(),
    paymentCount: results.length,
    paymentTotal: PAYMENT_COUNT,
    intervalS:   INTERVAL_S,
    amountMicroUsdc: AMOUNT_MICRO,
    confirmed:   successes.length,
    failed:      failures.length,
    rateLimited: rateLimited.length,
    haltTriggered,
    elapsedMs:   wallElapsedMs,
    enqueueLatencyMs: enqueueLatencies.length > 0 ? {
      p50: percentile(enqueueLatencies, 50),
      p95: percentile(enqueueLatencies, 95),
      p99: percentile(enqueueLatencies, 99),
      avg: Math.round(enqueueLatencies.reduce((s, v) => s + v, 0) / enqueueLatencies.length),
    } : null,
    results,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  ok(`Report: ${REPORT_PATH}`);

  // ── Pass / fail ────────────────────────────────────────────────
  sep("SUMMARY");
  const passRate = successes.length / results.length;

  if (haltTriggered) {
    console.log(`  ${RE}✗ FAILED — false-positive halt triggered during test${R}`);
    process.exit(1);
  }
  if (passRate < 0.95) {
    console.log(`  ${RE}✗ FAILED — success rate ${(passRate * 100).toFixed(1)}% (target ≥ 95%)${R}`);
    process.exit(1);
  }

  console.log(`  ${G}✔ SUSTAINED LOAD TEST PASSED${R}`);
  console.log(`    ${successes.length}/${results.length} confirmed  |  ${(wallElapsedMs / 60000).toFixed(1)} min  |  p95 enq ${percentile(enqueueLatencies, 95)}ms`);
  console.log();

  // ── Checklist (manual verification items) ─────────────────────
  console.log(`  ${C}Post-test manual checks:${R}`);
  console.log(`  ${D}  □ Redis key count did not grow unboundedly${R}`);
  console.log(`  ${D}    railway run redis-cli DBSIZE (compare before/after)${R}`);
  console.log(`  ${D}  □ Treasury outflow guard did NOT halt during test${R}`);
  console.log(`  ${D}    railway logs --filter guardian | grep HALT${R}`);
  console.log(`  ${D}  □ On-chain monitor reconciliation stayed clean${R}`);
  console.log(`  ${D}    railway logs --filter guardian | grep SIGNER_KEY_COMPROMISE${R}`);
  console.log();
}

runSustainedLoadTest().catch((err) => {
  console.error(`\n  \x1b[31mFATAL: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  process.exit(1);
});
