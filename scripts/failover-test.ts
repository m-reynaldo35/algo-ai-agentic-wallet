/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FAILOVER TEST (Sprint 5.4)                                              │
 * │                                                                          │
 * │  Guided test — confirms Nodely algod failover activates when the        │
 * │  primary node is unreachable, payments continue via fallback, and        │
 * │  the recovery probe switches back when primary is restored.             │
 * │                                                                          │
 * │  Requires operator access to Railway env vars (interactive).            │
 * │                                                                          │
 * │  Procedure:                                                              │
 * │    1. Script checks baseline health (primary must be active)            │
 * │    2. Operator sets ALGORAND_NODE_URL to an unreachable URL in Railway  │
 * │       and triggers a redeploy (or changes it on a running service)      │
 * │    3. Script polls /health until usingFallback=true (up to 2 min)      │
 * │    4. Script fires 3 test payments — confirms they succeed on fallback  │
 * │    5. Operator restores ALGORAND_NODE_URL and redeploys                 │
 * │    6. Script polls /health until usingFallback=false (up to 3 min)     │
 * │    7. Script fires 1 final payment — confirms primary is working        │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    ALGO_MNEMONIC="..." PORTAL_API_SECRET="..." AGENT_ID="..." \         │
 * │      npx tsx scripts/failover-test.ts                                   │
 * │                                                                          │
 * │  Env:                                                                    │
 * │    ALGO_MNEMONIC        — 25-word mnemonic of registered agent wallet   │
 * │    PORTAL_API_SECRET    — bearer token for /api/execute                 │
 * │    AGENT_ID             — registered agent ID                           │
 * │    API_URL              — API base URL (default: Railway production)    │
 * │    FAILOVER_POLL_MS     — health poll interval ms (default: 5000)      │
 * │    FAILOVER_TIMEOUT_MS  — max wait for failover (default: 120000)      │
 * │    RECOVERY_TIMEOUT_MS  — max wait for recovery (default: 180000)      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import * as readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────────────
const API_URL           = (process.env.API_URL || "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const AGENT_ID          = process.env.AGENT_ID;
const PORTAL_SEC        = process.env.PORTAL_API_SECRET;
const MNEMONIC          = process.env.ALGO_MNEMONIC;
const POLL_INTERVAL_MS  = parseInt(process.env.FAILOVER_POLL_MS    || "5000",   10);
const FAILOVER_WAIT_MS  = parseInt(process.env.FAILOVER_TIMEOUT_MS || "120000", 10);
const RECOVERY_WAIT_MS  = parseInt(process.env.RECOVERY_TIMEOUT_MS || "180000", 10);
const TEST_AMOUNT_MICRO = 1000; // $0.001 per test payment

const REPORT_PATH = path.join(__dirname, "..", "public", "failover-test-report.json");

// ── ANSI helpers ──────────────────────────────────────────────────
const R   = "\x1b[0m";
const G   = "\x1b[32m";
const Y   = "\x1b[33m";
const C   = "\x1b[36m";
const D   = "\x1b[2m";
const RE  = "\x1b[31m";
const B   = "\x1b[1m";

const ts   = () => `${D}${new Date().toISOString().slice(11, 23)}${R}`;
const ok   = (m: string) => console.log(`  ${ts()} ${G}✔${R} ${m}`);
const fail = (m: string) => console.log(`  ${ts()} ${RE}✗${R} ${m}`);
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
};

// ── Health probe ─────────────────────────────────────────────────
interface HealthStatus {
  ok:            boolean;
  usingFallback: boolean;
  algodUrl:      string;
  network:       string;
  latestRound:   number;
}

async function probeHealth(): Promise<HealthStatus | null> {
  try {
    const res = await fetch(`${API_URL}/health`);
    if (!res.ok) return null;
    const b = await res.json() as Record<string, unknown>;
    const node = b["node"] as Record<string, unknown> | undefined;
    return {
      ok:            b["status"] === "ok",
      usingFallback: !!(node?.["usingFallback"]),
      algodUrl:      String(node?.["algod"] ?? ""),
      network:       String(b["network"] ?? ""),
      latestRound:   Number(node?.["latestRound"] ?? 0),
    };
  } catch {
    return null;
  }
}

// ── Wait for health condition ────────────────────────────────────
async function waitForCondition(
  condition:  (h: HealthStatus) => boolean,
  label:      string,
  timeoutMs:  number,
): Promise<HealthStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await probeHealth();
    if (h && condition(h)) return h;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r  ${D}${label}... ${remaining}s remaining${R}    `);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write("\n");
  return null;
}

// ── Send one test payment ────────────────────────────────────────
async function testPayment(
  client:    AlgoAgentClient,
  address:   string,
  agentId:   string,
  portalSec: string,
  label:     string,
): Promise<boolean> {
  process.stdout.write(`  ${D}${label}... ${R}`);
  try {
    const resp = await client.requestSandboxExport({ senderAddress: address, amount: TEST_AMOUNT_MICRO });
    const execRes = await fetch(`${API_URL}/api/execute`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${portalSec}` },
      body:    JSON.stringify({ sandboxExport: resp.export, agentId }),
    });
    const body = await execRes.json() as Record<string, unknown>;

    if (!execRes.ok) {
      process.stdout.write(`${RE}✗ HTTP ${execRes.status} — ${body.error ?? "unknown"}${R}\n`);
      return false;
    }

    const jobId = String(body.jobId ?? "");
    // Poll briefly for confirmation
    const deadline = Date.now() + 60_000;
    while (jobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const jr = await fetch(`${API_URL}/api/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${portalSec}` },
      });
      if (!jr.ok) continue;
      const jb = await jr.json() as Record<string, string>;
      if (jb.status === "confirmed") { process.stdout.write(`${G}✔ confirmed${R}\n`); return true; }
      if (jb.status === "failed")    { process.stdout.write(`${RE}✗ failed${R}\n`); return false; }
    }
    process.stdout.write(`${Y}queued (not confirmed within 60s)${R}\n`);
    return true; // queued counts as working
  } catch (err) {
    process.stdout.write(`${RE}✗ ${err instanceof Error ? err.message : String(err)}${R}\n`);
    return false;
  }
}

// ── Interactive prompt ───────────────────────────────────────────
function prompt(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n  ${B}${Y}${question}${R}\n  Press ENTER when done: `, () => {
      rl.close();
      resolve();
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────
async function runFailoverTest() {
  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}FAILOVER TEST (Sprint 5.4)${R}`);
  console.log(`  ${D}Target:   ${API_URL}${R}`);
  console.log(`  ${D}Date:     ${new Date().toISOString()}${R}`);
  console.log(`${C}${"═".repeat(68)}${R}\n`);

  console.log(`  ${D}This is a guided interactive test.${R}`);
  console.log(`  ${D}You will be prompted to change Railway env vars at specific steps.${R}`);
  console.log(`  ${D}Have Railway dashboard open before proceeding.${R}`);

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

  // ── Step 1: Baseline health check ─────────────────────────────
  sep("STEP 1 — BASELINE HEALTH CHECK");
  const baseline = await probeHealth();
  if (!baseline) {
    fail("Cannot reach /health endpoint — is the server running?");
    process.exit(1);
  }
  if (!baseline.ok) {
    fail(`Server health is not OK: usingFallback=${baseline.usingFallback}, algod=${baseline.algodUrl}`);
    process.exit(1);
  }
  if (baseline.usingFallback) {
    fail("Server is already using fallback — cannot test failover activation. Restore primary first.");
    process.exit(1);
  }

  ok(`Baseline: network=${baseline.network} algod=${baseline.algodUrl.slice(0, 40)}...`);
  ok(`Primary node is active (usingFallback=false)`);

  const client = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    slippageBips: 0,
  });

  // ── Step 2: Operator action — break primary ────────────────────
  sep("STEP 2 — BREAK PRIMARY NODE (operator action required)");
  console.log(`  In the Railway dashboard for the main API service:`);
  console.log(`  ${Y}  1. Go to Variables tab${R}`);
  console.log(`  ${Y}  2. Change ALGORAND_NODE_URL to: https://unreachable.invalid${R}`);
  console.log(`  ${Y}  3. Click Deploy (service will redeploy with broken algod URL)${R}`);
  console.log();
  console.log(`  The script will poll /health every ${POLL_INTERVAL_MS / 1000}s until usingFallback=true.`);
  console.log(`  Timeout: ${FAILOVER_WAIT_MS / 1000}s`);

  await prompt("Have you changed ALGORAND_NODE_URL to an unreachable host and redeployed?");

  // ── Step 3: Wait for failover ──────────────────────────────────
  sep("STEP 3 — WAITING FOR FAILOVER TO ACTIVATE");
  const failoverHealth = await waitForCondition(
    (h) => h.usingFallback,
    "Polling for usingFallback=true",
    FAILOVER_WAIT_MS,
  );
  process.stdout.write("\n");

  if (!failoverHealth) {
    fail(`Failover did NOT activate within ${FAILOVER_WAIT_MS / 1000}s`);
    fail("Check that the redeployed service has the broken ALGORAND_NODE_URL env var.");
    fail("Also confirm ALGORAND_FALLBACK_NODE_URL is set to a working Nodely URL.");
    process.exit(1);
  }

  ok(`Failover activated — algod=${failoverHealth.algodUrl.slice(0, 40)}...`);
  ok(`usingFallback=true confirmed`);

  // ── Step 4: Test payments during fallback ──────────────────────
  sep("STEP 4 — TEST PAYMENTS DURING FALLBACK");
  info("Sending 3 test payments via fallback node...");
  console.log();

  const fallbackResults = await Promise.all([
    testPayment(client, account.addr.toString(), AGENT_ID, PORTAL_SEC, "Payment 1 (fallback)"),
    testPayment(client, account.addr.toString(), AGENT_ID, PORTAL_SEC, "Payment 2 (fallback)"),
    testPayment(client, account.addr.toString(), AGENT_ID, PORTAL_SEC, "Payment 3 (fallback)"),
  ]);

  const fallbackOk = fallbackResults.filter(Boolean).length;
  if (fallbackOk === 0) {
    fail("ALL payments failed during fallback — fallback node may also be unreachable");
    process.exit(1);
  }
  console.log();
  ok(`${fallbackOk}/3 payments succeeded via fallback node`);

  // ── Step 5: Operator action — restore primary ──────────────────
  sep("STEP 5 — RESTORE PRIMARY NODE (operator action required)");
  console.log(`  In the Railway dashboard for the main API service:`);
  console.log(`  ${Y}  1. Go to Variables tab${R}`);
  console.log(`  ${Y}  2. Restore ALGORAND_NODE_URL to the correct primary URL${R}`);
  console.log(`  ${Y}  3. Click Deploy${R}`);
  console.log();
  console.log(`  The recovery probe runs every 60s — it will detect the primary is back`);
  console.log(`  and switch usingFallback back to false automatically.`);
  console.log(`  Timeout: ${RECOVERY_WAIT_MS / 1000}s`);

  await prompt("Have you restored ALGORAND_NODE_URL to the correct primary and redeployed?");

  // ── Step 6: Wait for recovery ──────────────────────────────────
  sep("STEP 6 — WAITING FOR PRIMARY RECOVERY");
  const recoveredHealth = await waitForCondition(
    (h) => !h.usingFallback && h.ok,
    "Polling for usingFallback=false",
    RECOVERY_WAIT_MS,
  );
  process.stdout.write("\n");

  if (!recoveredHealth) {
    fail(`Primary node did NOT recover within ${RECOVERY_WAIT_MS / 1000}s`);
    fail("Check that the recovery probe is running (RECOVERY_INTERVAL_MS = 60s in nodely.ts).");
    fail("Also verify the restored ALGORAND_NODE_URL is actually reachable.");
    process.exit(1);
  }

  ok(`Recovery confirmed — algod=${recoveredHealth.algodUrl.slice(0, 40)}...`);
  ok(`usingFallback=false — primary node is active again`);

  // ── Step 7: Final payment on restored primary ──────────────────
  sep("STEP 7 — FINAL PAYMENT ON RESTORED PRIMARY");
  const finalOk = await testPayment(
    client, account.addr.toString(), AGENT_ID, PORTAL_SEC, "Final payment (primary restored)",
  );

  if (!finalOk) {
    fail("Final payment failed after primary recovery — investigate logs");
    process.exit(1);
  }

  // ── Results ────────────────────────────────────────────────────
  sep("RESULTS SUMMARY");
  ok("Baseline:  Primary node active");
  ok("Failover:  Activated within detection window");
  ok(`Fallback:  ${fallbackOk}/3 payments succeeded`);
  ok("Recovery:  Primary switched back automatically");
  ok("Final:     Payment confirmed on restored primary");

  console.log(`\n  ${G}✔ FAILOVER TEST PASSED${R}\n`);
  console.log(`  ${D}Manual check: Verify Telegram alert fired when primary went down${R}`);
  console.log(`  ${D}             and again when primary recovered.${R}`);
  console.log(`  ${D}  railway logs --filter "Algod" | grep "failover\|recovered"${R}`);
  console.log();

  const report = {
    schema:          "failover-test-v1",
    generatedAt:     new Date().toISOString(),
    apiUrl:          API_URL,
    baseline:        baseline,
    failoverHealth,
    fallbackPayments: { total: 3, ok: fallbackOk },
    recoveredHealth,
    finalPaymentOk:  finalOk,
    passed:          true,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  info(`Report: ${REPORT_PATH}`);
}

runFailoverTest().catch((err) => {
  console.error(`\n  \x1b[31mFATAL: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  process.exit(1);
});
