/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  VELOCITY LIMIT TEST (Sprint 5.3)                                        │
 * │                                                                          │
 * │  Deliberately triggers the 10-minute per-agent velocity cap and         │
 * │  confirms the correct 402 VELOCITY_APPROVAL_REQUIRED response fires.    │
 * │  Then waits for the rolling window to expire and confirms the cap        │
 * │  auto-clears (next request succeeds without approval token).            │
 * │                                                                          │
 * │  How it works:                                                           │
 * │    1. Reads current threshold from the API's 402 response body          │
 * │    2. Sends enough micro-payments to exceed the 10-min threshold        │
 * │    3. Confirms the cap fires (VELOCITY_APPROVAL_REQUIRED)               │
 * │    4. Waits for the 10-min rolling window to expire                     │
 * │    5. Sends one more payment — confirms it succeeds (cap cleared)       │
 * │                                                                          │
 * │  ⚠  For quick testing, set a low threshold on the API server:           │
 * │       VELOCITY_THRESHOLD_10M_MICROUSDC=100000  ($0.10)                  │
 * │     Then run this test with:                                             │
 * │       VELOCITY_TARGET_MICROUSDC=110000  ($0.11, just above threshold)   │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    ALGO_MNEMONIC="..." PORTAL_API_SECRET="..." AGENT_ID="..." \         │
 * │    VELOCITY_TARGET_MICROUSDC=110000 \                                   │
 * │      npx tsx scripts/velocity-limit-test.ts                             │
 * │                                                                          │
 * │  Env:                                                                    │
 * │    ALGO_MNEMONIC             — 25-word mnemonic of registered agent     │
 * │    PORTAL_API_SECRET         — bearer token for /api/execute            │
 * │    AGENT_ID                  — registered agent ID                      │
 * │    API_URL                   — API base URL                             │
 * │    VELOCITY_TARGET_MICROUSDC — total µUSDC to send (just above cap)    │
 * │                                  default: 50100000 ($50.10)             │
 * │    PAYMENT_AMOUNT_MICROUSDC  — µUSDC per payment (default: 1000000)    │
 * │    SKIP_WAIT                 — set to "1" to skip the 10-min window    │
 * │                                  wait (useful if you just want to       │
 * │                                  verify the cap fires, not the clear)   │
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
const API_URL             = (process.env.API_URL || "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const AGENT_ID            = process.env.AGENT_ID;
const PORTAL_SEC          = process.env.PORTAL_API_SECRET;
const MNEMONIC            = process.env.ALGO_MNEMONIC;
// Just above the default $50 threshold. Override with a lower value if you
// set VELOCITY_THRESHOLD_10M_MICROUSDC low on the server.
const VELOCITY_TARGET     = parseInt(process.env.VELOCITY_TARGET_MICROUSDC || "50100000", 10);
const PAYMENT_AMOUNT      = parseInt(process.env.PAYMENT_AMOUNT_MICROUSDC  || "1000000",  10); // $1
const SKIP_WAIT           = process.env.SKIP_WAIT === "1";

// Time to wait for the 10-min rolling window to expire (12 minutes to be safe)
const WINDOW_WAIT_MS = 12 * 60 * 1_000;

const REPORT_PATH = path.join(__dirname, "..", "public", "velocity-test-report.json");

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
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
};

interface StepResult {
  seq:               number;
  amountMicroUsdc:   number;
  success:           boolean;
  velocityCapped:    boolean;
  httpStatus:        number;
  enqueueMs:         number;
  jobStatus:         string;
  error?:            string;
  threshold10m?:     string;
  threshold24h?:     string;
  tenMinTotal?:      string;
}

async function sendPayment(
  client:    AlgoAgentClient,
  address:   string,
  agentId:   string,
  portalSec: string,
  amount:    number,
  seq:       number,
): Promise<StepResult> {
  const startMs = Date.now();

  // Get sandbox export
  let sandboxExport: object;
  try {
    const resp = await client.requestSandboxExport({ senderAddress: address, amount });
    sandboxExport = resp.export as object;
  } catch (err) {
    return {
      seq, amountMicroUsdc: amount, success: false, velocityCapped: false,
      httpStatus: 0, enqueueMs: 0, jobStatus: "export_failed",
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
      seq, amountMicroUsdc: amount, success: false, velocityCapped: false,
      httpStatus: 0, enqueueMs: Date.now() - execT0, jobStatus: "network_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const enqueueMs = Date.now() - execT0;
  const body = await execRes.json() as Record<string, unknown>;

  // 402 with VELOCITY_APPROVAL_REQUIRED = expected cap
  if (execRes.status === 402 && body.error === "VELOCITY_APPROVAL_REQUIRED") {
    return {
      seq, amountMicroUsdc: amount, success: false, velocityCapped: true,
      httpStatus: 402, enqueueMs, jobStatus: "velocity_capped",
      threshold10m:  String(body.threshold10m ?? ""),
      threshold24h:  String(body.threshold24h ?? ""),
      tenMinTotal:   String(body.tenMinTotal   ?? ""),
    };
  }

  if (!execRes.ok) {
    return {
      seq, amountMicroUsdc: amount, success: false, velocityCapped: false,
      httpStatus: execRes.status, enqueueMs, jobStatus: "execute_failed",
      error: String(body.error ?? `HTTP ${execRes.status}`),
    };
  }

  // Poll for confirmation
  const jobId = String(body.jobId ?? "");
  if (!jobId) {
    return {
      seq, amountMicroUsdc: amount, success: body.success === true,
      velocityCapped: false, httpStatus: execRes.status, enqueueMs,
      jobStatus: String(body.status ?? "unknown"),
    };
  }

  const deadline = Date.now() + 90_000;
  let jobStatus = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
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

  return {
    seq, amountMicroUsdc: amount, success: jobStatus === "confirmed",
    velocityCapped: false, httpStatus: execRes.status, enqueueMs,
    jobStatus,
  };
}

// ── Main ──────────────────────────────────────────────────────────
async function runVelocityLimitTest() {
  const paymentsNeeded  = Math.ceil(VELOCITY_TARGET / PAYMENT_AMOUNT);
  const totalCostUsdc   = (paymentsNeeded * PAYMENT_AMOUNT) / 1_000_000;

  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}VELOCITY LIMIT TEST (Sprint 5.3)${R}`);
  console.log(`  ${D}Target:         ${API_URL}${R}`);
  console.log(`  ${D}Velocity target: ${VELOCITY_TARGET} µUSDC ($${(VELOCITY_TARGET / 1_000_000).toFixed(4)})${R}`);
  console.log(`  ${D}Per payment:     ${PAYMENT_AMOUNT} µUSDC ($${(PAYMENT_AMOUNT / 1_000_000).toFixed(4)})${R}`);
  console.log(`  ${D}Payments needed: ~${paymentsNeeded}  (~$${totalCostUsdc.toFixed(4)} total)${R}`);
  console.log(`  ${D}Skip wait:       ${SKIP_WAIT ? "yes (window expiry not tested)" : "no (will wait ~12 min)"}${R}`);
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
  try {
    const h = await fetch(`${API_URL}/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    const b = await h.json() as Record<string, unknown>;
    if (b["status"] !== "ok") throw new Error(`Server not ok: ${b["status"]}`);
    ok(`Server healthy — ${b["protocol"]} on ${b["network"]}`);
  } catch (err) {
    fail(`Pre-flight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  ok(`Wallet: ${account.addr.toString().slice(0, 20)}...`);
  ok(`Agent:  ${AGENT_ID}`);
  console.log(`\n  ${Y}⚠ This test will spend ~$${totalCostUsdc.toFixed(4)} USDC.${R}`);
  console.log(`  ${Y}  TIP: Set VELOCITY_THRESHOLD_10M_MICROUSDC=100000 on the server for cheap testing.${R}`);
  console.log(`  ${Y}  Then set VELOCITY_TARGET_MICROUSDC=110000 and PAYMENT_AMOUNT_MICROUSDC=25000.${R}`);
  console.log(`  ${Y}Ctrl+C to abort. Starting in 5 seconds...${R}`);
  await new Promise((r) => setTimeout(r, 5000));

  const client = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    slippageBips: 0,
  });

  // ── Phase 1: Exhaust the velocity window ──────────────────────
  sep("PHASE 1 — EXHAUSTING 10-MIN VELOCITY WINDOW");
  const phase1Results: StepResult[] = [];
  let capFired = false;
  let capResult: StepResult | null = null;

  for (let i = 0; i < paymentsNeeded + 5; i++) {
    const seq = i + 1;
    process.stdout.write(`  [${String(seq).padStart(3)}] sending ${PAYMENT_AMOUNT} µUSDC... `);

    const result = await sendPayment(client, account.addr.toString(), AGENT_ID, PORTAL_SEC, PAYMENT_AMOUNT, seq);
    phase1Results.push(result);

    if (result.velocityCapped) {
      process.stdout.write(`${Y}402 VELOCITY_APPROVAL_REQUIRED${R}`);
      if (result.threshold10m) process.stdout.write(` (threshold: ${result.threshold10m} µUSDC, window: ${result.tenMinTotal} µUSDC)`);
      process.stdout.write("\n");

      capFired = true;
      capResult = result;
      break;
    } else if (result.success) {
      process.stdout.write(`${G}✔${R} confirmed  ${result.enqueueMs}ms\n`);
    } else {
      process.stdout.write(`${RE}✗${R} ${result.error ?? result.jobStatus}  (HTTP ${result.httpStatus})\n`);
      // Non-cap failures: continue (could be transient)
    }

    // Small delay between payments to avoid rate limiting the burst
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!capFired) {
    fail("Velocity cap did NOT fire after exhausting budget — check threshold configuration");
    fail(`  Sent ${phase1Results.length} × ${PAYMENT_AMOUNT} µUSDC = ${phase1Results.length * PAYMENT_AMOUNT} µUSDC total`);
    fail(`  Expected cap at ${VELOCITY_TARGET} µUSDC — was VELOCITY_THRESHOLD_10M_MICROUSDC already exceeded before test?`);
    process.exit(1);
  }

  ok(`VELOCITY_APPROVAL_REQUIRED fired correctly at payment #${capResult!.seq}`);
  if (capResult?.threshold10m) {
    info(`  10-min threshold: ${capResult.threshold10m} µUSDC`);
    info(`  Window total:     ${capResult.tenMinTotal} µUSDC`);
  }

  // ── Phase 2: Confirm cap persists on retry ─────────────────────
  sep("PHASE 2 — CONFIRMING CAP PERSISTS (retry immediately)");
  const retryResult = await sendPayment(
    client, account.addr.toString(), AGENT_ID, PORTAL_SEC, PAYMENT_AMOUNT, 0,
  );

  if (retryResult.velocityCapped) {
    ok("Cap correctly persists on retry (idempotent)");
  } else if (retryResult.success) {
    fail("Payment succeeded when it should be capped — velocity state may have reset unexpectedly");
    process.exit(1);
  } else {
    info(`Retry returned HTTP ${retryResult.httpStatus}: ${retryResult.error ?? retryResult.jobStatus}`);
  }

  if (SKIP_WAIT) {
    info("SKIP_WAIT=1 — skipping window expiry test");
    sep("SUMMARY (partial — window wait skipped)");
    ok("Phase 1: velocity cap fired correctly");
    ok("Phase 2: cap persists on retry");
    console.log(`  ${Y}Phase 3 skipped. To test cap auto-clear, rerun without SKIP_WAIT=1 after 10+ minutes.${R}`);
    writeReport(phase1Results, capFired, false, SKIP_WAIT);
    return;
  }

  // ── Phase 3: Wait for window to expire, confirm auto-clear ─────
  const waitMin = Math.ceil(WINDOW_WAIT_MS / 60_000);
  sep(`PHASE 3 — WAITING ${waitMin} MINUTES FOR WINDOW TO EXPIRE`);
  console.log(`  ${D}Window started at approximately: ${new Date(Date.now() - 10 * 60_000).toISOString()}${R}`);
  console.log(`  ${D}Waiting until:                  ${new Date(Date.now() + WINDOW_WAIT_MS).toISOString()}${R}`);

  const tickInterval = 30_000; // update every 30s
  let remaining = WINDOW_WAIT_MS;
  while (remaining > 0) {
    const sleepMs = Math.min(tickInterval, remaining);
    await new Promise((r) => setTimeout(r, sleepMs));
    remaining -= sleepMs;
    if (remaining > 0) {
      process.stdout.write(`\r  ${D}Waiting... ${Math.ceil(remaining / 60_000)} min remaining${R}    `);
    }
  }
  process.stdout.write("\n");

  console.log();
  ok("Window wait complete — testing cap auto-clear");

  const clearResult = await sendPayment(
    client, account.addr.toString(), AGENT_ID, PORTAL_SEC, PAYMENT_AMOUNT, 0,
  );

  if (clearResult.success) {
    ok("Cap auto-cleared after window expiry — payment succeeded");
  } else if (clearResult.velocityCapped) {
    fail("Cap did NOT clear after window expiry — velocity window math may be wrong");
    fail(`  Threshold: ${clearResult.threshold10m} µUSDC  Window total: ${clearResult.tenMinTotal} µUSDC`);
    writeReport(phase1Results, capFired, false, SKIP_WAIT);
    process.exit(1);
  } else {
    fail(`Payment after window expiry failed: HTTP ${clearResult.httpStatus} — ${clearResult.error}`);
    writeReport(phase1Results, capFired, false, SKIP_WAIT);
    process.exit(1);
  }

  // ── Results ────────────────────────────────────────────────────
  sep("SUMMARY");
  ok("Phase 1: velocity cap fired (VELOCITY_APPROVAL_REQUIRED at 402)");
  ok("Phase 2: cap persists on retry (idempotent)");
  ok("Phase 3: cap auto-clears after 10-min rolling window expires");
  console.log(`\n  ${G}✔ VELOCITY LIMIT TEST PASSED${R}\n`);

  writeReport(phase1Results, capFired, true, SKIP_WAIT);
}

function writeReport(
  phase1Results: StepResult[],
  capFired:      boolean,
  capCleared:    boolean,
  skipWait:      boolean,
) {
  const report = {
    schema:       "velocity-limit-test-v1",
    generatedAt:  new Date().toISOString(),
    velocityTarget: VELOCITY_TARGET,
    paymentAmount:  PAYMENT_AMOUNT,
    capFired,
    capCleared,
    skipWait,
    phase1Results,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`  Report: ${REPORT_PATH}`);
}

runVelocityLimitTest().catch((err) => {
  console.error(`\n  \x1b[31mFATAL: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  process.exit(1);
});
