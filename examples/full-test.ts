/**
 * Full end-to-end test:
 *   1. Verify balances
 *   2. Register agent (idempotent)
 *   3. Run multiple live x402 payment tests
 *
 * Usage:
 *   ALGO_MNEMONIC="25 words..." PORTAL_API_SECRET=... npx tsx examples/full-test.ts
 */

import algosdk from "algosdk";
import { AlgoAgentClient } from "@algo-wallet/x402-client";
import "dotenv/config";

const MNEMONIC       = process.env.ALGO_MNEMONIC!;
const PORTAL_SECRET  = process.env.PORTAL_API_SECRET!;
const API_URL        = process.env.X402_API_URL ?? process.env.E2E_BASE_URL ?? "http://localhost:4020";
const AGENT_ID       = "setup-tester-v1";
const NODE_URL       = process.env.ALGORAND_NODE_URL ?? "https://mainnet-api.4160.nodely.dev";
const NODE_TOKEN     = process.env.ALGORAND_NODE_TOKEN ?? "";
const USDC_ASSET_ID  = 31566704n;
const PAY_RUNS       = 5; // x402 payment test iterations

if (!MNEMONIC)      { console.error("[FATAL] ALGO_MNEMONIC not set"); process.exit(1); }
if (!PORTAL_SECRET) { console.error("[FATAL] PORTAL_API_SECRET not set"); process.exit(1); }

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const ADDRESS = account.addr.toString();

const portalHeaders = {
  "Content-Type":  "application/json",
  "Authorization": `Bearer ${PORTAL_SECRET}`,
};

function sep(label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(60));
}

// ── 1. Balance check ───────────────────────────────────────────
async function checkBalances() {
  sep("1. BALANCE CHECK");
  const algod = new algosdk.Algodv2(NODE_TOKEN, NODE_URL);
  const info  = await algod.accountInformation(ADDRESS).do();
  const algo  = Number(info.amount) / 1e6;
  const usdcAsset = info.assets?.find((a: { assetId: bigint }) => a.assetId === USDC_ASSET_ID);
  const usdc  = usdcAsset ? Number(usdcAsset.amount) / 1e6 : 0;

  console.log(`  Address : ${ADDRESS}`);
  console.log(`  ALGO    : ${algo.toFixed(6)}`);
  console.log(`  USDC    : ${usdc.toFixed(6)}`);

  if (usdc < 0.05) {
    console.error(`  [FAIL] Need at least 0.05 USDC — only have ${usdc}`);
    process.exit(1);
  }
  console.log(`  [PASS] Funded — ready for ${PAY_RUNS} x402 test payments`);
  return { algo, usdc };
}

// ── 2. Register agent ──────────────────────────────────────────
async function registerAgent() {
  sep("2. AGENT REGISTRATION");

  // Check if already registered
  const checkRes = await fetch(`${API_URL}/api/agents/${encodeURIComponent(AGENT_ID)}`, {
    headers: portalHeaders,
  });

  if (checkRes.ok) {
    const existing = await checkRes.json() as { address: string; cohort: string; authAddr: string; status: string };
    console.log(`  Already registered — skipping rekey`);
    console.log(`  Agent ID : ${AGENT_ID}`);
    console.log(`  Address  : ${existing.address}`);
    console.log(`  Cohort   : ${existing.cohort}`);
    console.log(`  Auth Addr: ${existing.authAddr}`);
    console.log(`  Status   : ${existing.status}`);
    console.log(`  [PASS]`);
    return existing;
  }

  console.log(`  Registering ${AGENT_ID}...`);
  const res = await fetch(`${API_URL}/api/agents/register-existing`, {
    method:  "POST",
    headers: portalHeaders,
    body:    JSON.stringify({ agentId: AGENT_ID, mnemonic: MNEMONIC, platform: "setup-tester" }),
  });

  if (!res.ok) {
    const err = await res.json() as { error: string; detail?: string };
    console.error(`  [FAIL] ${res.status}: ${err.error} ${err.detail ?? ""}`);
    process.exit(1);
  }

  const reg = await res.json() as {
    agentId: string; address: string; cohort: string;
    authAddr: string; registrationTxnId: string; explorerUrl: string;
  };
  console.log(`  Agent ID : ${reg.agentId}`);
  console.log(`  Address  : ${reg.address}`);
  console.log(`  Cohort   : ${reg.cohort}`);
  console.log(`  Auth Addr: ${reg.authAddr}`);
  console.log(`  Txn      : ${reg.registrationTxnId}`);
  console.log(`  Explorer : ${reg.explorerUrl}`);
  console.log(`  [PASS] Rekeyed to Rocca signer`);
  return reg;
}

// ── Poll job until confirmed/failed ────────────────────────────
async function pollJob(jobId: string, timeoutMs = 60_000): Promise<{ txnId?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 600));
    const res = await fetch(`${API_URL}/api/jobs/${jobId}`, { headers: portalHeaders });
    if (!res.ok) continue;
    const job = await res.json() as { status: string; txnId?: string; error?: string };
    if (job.status === "confirmed") return { txnId: job.txnId };
    if (job.status === "failed")    return { error: job.error ?? "unknown" };
  }
  return { error: "poll timeout" };
}

// ── 3. x402 payment tests ──────────────────────────────────────
async function runPaymentTests() {
  sep(`3. LIVE x402 PAYMENT TESTS (${PAY_RUNS} runs × 0.01 USDC)`);

  const client = new AlgoAgentClient({
    baseUrl:    API_URL,
    privateKey: account.sk,
  });

  const results: { run: number; success: boolean; txnId?: string; error?: string; enqueueMs: number; totalMs: number }[] = [];

  for (let i = 1; i <= PAY_RUNS; i++) {
    const start = Date.now();
    process.stdout.write(`  Run ${i}/${PAY_RUNS} ... `);

    try {
      // Step 1: x402 handshake → sealed sandbox
      const sandboxResponse = await client.requestSandboxExport({
        senderAddress:        ADDRESS,
        amount:               10_000,
        destinationChain:     "algorand",
        destinationRecipient: ADDRESS,
      });

      // Step 2: submit — now returns immediately with jobId
      const execRes = await fetch(`${API_URL}/api/execute`, {
        method:  "POST",
        headers: portalHeaders,
        body:    JSON.stringify({ sandboxExport: sandboxResponse.export, agentId: AGENT_ID }),
      });

      const enqueueMs = Date.now() - start;

      if (execRes.status === 402) {
        const body = await execRes.json() as { error: string };
        results.push({ run: i, success: false, error: `VELOCITY: ${body.error}`, enqueueMs, totalMs: enqueueMs });
        console.log(`VELOCITY (${enqueueMs}ms)`);
        continue;
      }

      if (!execRes.ok) {
        const body = await execRes.json() as { error?: string; failedStage?: string };
        results.push({ run: i, success: false, error: `HTTP ${execRes.status}: ${body.error ?? body.failedStage}`, enqueueMs, totalMs: enqueueMs });
        console.log(`FAIL ${execRes.status} (${enqueueMs}ms)`);
        continue;
      }

      const queued = await execRes.json() as { queued: boolean; jobId?: string; settlement?: { txnId: string } };

      // Legacy sync response (no worker running)
      if (!queued.queued && queued.settlement?.txnId) {
        const totalMs = Date.now() - start;
        results.push({ run: i, success: true, txnId: queued.settlement.txnId, enqueueMs, totalMs });
        console.log(`OK (sync) ${totalMs}ms  txn: ${queued.settlement.txnId}`);
        continue;
      }

      // Async path — poll for confirmation
      process.stdout.write(`queued(${enqueueMs}ms) polling`);
      const { txnId, error } = await pollJob(queued.jobId!);
      const totalMs = Date.now() - start;

      if (txnId) {
        results.push({ run: i, success: true, txnId, enqueueMs, totalMs });
        console.log(` confirmed ${totalMs}ms  txn: ${txnId}`);
      } else {
        results.push({ run: i, success: false, error, enqueueMs, totalMs });
        console.log(` FAIL (${totalMs}ms): ${error}`);
      }

    } catch (err) {
      const totalMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ run: i, success: false, error: msg, enqueueMs: 0, totalMs });
      console.log(`ERROR (${totalMs}ms): ${msg}`);
    }

    if (i < PAY_RUNS) await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// ── Final report ───────────────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  x402 Full End-to-End Test                                  ║
╠══════════════════════════════════════════════════════════════╣
║  API   : ${API_URL.padEnd(50)}║
║  Agent : ${AGENT_ID.padEnd(50)}║
╚══════════════════════════════════════════════════════════════╝`);

  const { usdc } = await checkBalances();
  await registerAgent();
  const results   = await runPaymentTests();

  sep("RESULTS SUMMARY");
  const passed     = results.filter(r => r.success).length;
  const failed     = results.filter(r => !r.success).length;
  const avgEnqueue = Math.round(results.reduce((s, r) => s + r.enqueueMs, 0) / results.length);
  const avgTotal   = Math.round(results.reduce((s, r) => s + r.totalMs,   0) / results.length);
  const spent      = passed * 0.01;

  console.log(`  Passed      : ${passed}/${PAY_RUNS}`);
  console.log(`  Failed      : ${failed}/${PAY_RUNS}`);
  console.log(`  Avg enqueue : ${avgEnqueue}ms  ← HTTP response time (what client waits)`);
  console.log(`  Avg total   : ${avgTotal}ms   ← enqueue + on-chain confirmation`);
  console.log(`  Spent       : ${spent.toFixed(2)} USDC`);
  console.log(`  Remaining   : ~${(usdc - spent).toFixed(2)} USDC`);

  console.log(`\n  Transactions:`);
  for (const r of results) {
    if (r.success && r.txnId) {
      console.log(`    ✓ Run ${r.run}: https://allo.info/tx/${r.txnId}`);
    } else {
      console.log(`    ✗ Run ${r.run}: ${r.error}`);
    }
  }

  const verdict = passed === PAY_RUNS ? "✅ ALL PASS" : passed > 0 ? "⚠️  PARTIAL" : "❌ ALL FAIL";
  console.log(`\n  Overall: ${verdict}\n`);
}

main().catch(e => { console.error("\n[FATAL]", e.message); process.exit(1); });
