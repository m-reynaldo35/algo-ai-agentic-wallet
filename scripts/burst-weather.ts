/**
 * burst-weather.ts — Concurrent x402 payment burst test
 *
 * Fires CONCURRENCY requests simultaneously per round, retries on
 * 429 CONCURRENT_SETTLEMENT (the per-agent lock), and measures
 * real throughput under load.
 *
 * Usage:
 *   CONCURRENCY=5 ROUNDS=4 CITY=London npx tsx scripts/burst-weather.ts
 */

import algosdk from "algosdk";
import "dotenv/config";
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const API_URL      = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const CITY         = process.env.CITY    ?? "London";
const MNEMONIC     = process.env.ALGO_MNEMONIC!;
const PORTAL_KEY   = process.env.PORTAL_API_SECRET ?? "";
const CONCURRENCY  = parseInt(process.env.CONCURRENCY  ?? "5",  10);
const ROUNDS       = parseInt(process.env.ROUNDS       ?? "4",  10);
const RETRY_LIMIT  = 8;   // max retries per request on 429
const RETRY_MS     = 600; // backoff between retries

const G = "\x1b[32m"; const Y = "\x1b[33m"; const R = "\x1b[31m";
const C = "\x1b[36m"; const D = "\x1b[2m";  const RS = "\x1b[0m";

interface Result {
  n: number; txid: string; round: number; ms: number; retries: number;
}

async function pollJob(jobId: string): Promise<{ txid: string; round: number }> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${API_URL}/api/jobs/${jobId}`, {
      headers: PORTAL_KEY ? { "X-Portal-Key": PORTAL_KEY } : {},
    });
    if (r.ok) {
      const j = await r.json() as { status: string; txnId?: string; confirmedRound?: number };
      if (j.status === "confirmed" && j.txnId) return { txid: j.txnId, round: j.confirmedRound ?? 0 };
      if (j.status === "failed") throw new Error("Job failed on server");
    }
    await new Promise(res => setTimeout(res, 1_500));
  }
  throw new Error("Job confirmation timed out");
}

async function fireOne(client: AlgoAgentClient, n: number): Promise<Result> {
  const start   = Date.now();
  let   retries = 0;

  while (retries <= RETRY_LIMIT) {
    const res = await client.fetch("/api/weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: CITY }),
    });

    // 429 CONCURRENT_SETTLEMENT — another request from this agent is in-flight
    if (res.status === 429) {
      retries++;
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "CONCURRENT_SETTLEMENT") {
        await new Promise(r => setTimeout(r, RETRY_MS * retries));
        continue;
      }
      throw new Error(`429 rate limit (non-lock): ${JSON.stringify(body)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }

    const data   = await res.json() as { jobId?: string };
    if (!data.jobId) throw new Error("No jobId");

    const { txid, round } = await pollJob(data.jobId);
    return { n, txid, round, ms: Date.now() - start, retries };
  }
  throw new Error(`Exceeded ${RETRY_LIMIT} retries on CONCURRENT_SETTLEMENT`);
}

async function main() {
  if (!MNEMONIC) { console.error("ALGO_MNEMONIC not set"); process.exit(1); }
  const account = algosdk.mnemonicToSecretKey(MNEMONIC);
  const client  = new AlgoAgentClient({ baseUrl: API_URL, privateKey: account.sk });

  const totalTx = CONCURRENCY * ROUNDS;
  console.log(`\n${C}${"═".repeat(62)}${RS}`);
  console.log(`${C}  BURST TEST — ${CONCURRENCY} concurrent × ${ROUNDS} rounds = ${totalTx} payments${RS}`);
  console.log(`${C}${"═".repeat(62)}${RS}`);
  console.log(`${D}  Agent  : ${account.addr.toString()}${RS}`);
  console.log(`${D}  Target : ${API_URL}${RS}`);
  console.log(`${D}  Cost   : ${totalTx} × $0.01 = $${(totalTx * 0.01).toFixed(2)} USDC${RS}`);
  console.log(`${C}${"═".repeat(62)}${RS}\n`);

  const allResults: Result[] = [];
  const allFailed: string[]  = [];
  let   txCounter = 0;
  const runStart  = Date.now();

  for (let r = 1; r <= ROUNDS; r++) {
    const roundStart = Date.now();
    const nums = Array.from({ length: CONCURRENCY }, (_, i) => ++txCounter);

    process.stdout.write(`  Round ${r}/${ROUNDS} — firing ${CONCURRENCY} concurrent... `);

    const settled = await Promise.allSettled(
      nums.map(n => fireOne(client, n))
    );

    const roundMs = Date.now() - roundStart;
    let passed = 0; let failed = 0; let totalRetries = 0;

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        allResults.push(s.value);
        totalRetries += s.value.retries;
        passed++;
      } else {
        failed++;
        allFailed.push(`tx${nums[i]}: ${s.reason?.message ?? s.reason}`);
      }
    }

    const icon = failed === 0 ? `${G}✓${RS}` : `${Y}~${RS}`;
    console.log(`${icon} ${G}${passed}/${CONCURRENCY}${RS} confirmed  ${D}${roundMs}ms  retries: ${totalRetries}${RS}`);

    // Show individual txids for this round
    for (const res of passed > 0 ? allResults.slice(-passed) : []) {
      const retriesTxt = res.retries > 0 ? ` ${Y}(${res.retries} retries)${RS}` : "";
      console.log(`    ${D}tx${String(res.n).padStart(3)}  ${res.txid.slice(0,16)}…  round ${res.round}  ${res.ms}ms${RS}${retriesTxt}`);
    }
    console.log();

    // Small gap between rounds to let the lock clear
    if (r < ROUNDS) await new Promise(res => setTimeout(res, 500));
  }

  // ── Summary ─────────────────────────────────────────────────
  const elapsed   = Date.now() - runStart;
  const passed    = allResults.length;
  const avgMs     = passed > 0 ? Math.round(allResults.reduce((s, r) => s + r.ms, 0) / passed) : 0;
  const p95Ms     = passed > 0 ? [...allResults].sort((a,b) => a.ms-b.ms)[Math.floor(passed*0.95)].ms : 0;
  const maxRetry  = passed > 0 ? Math.max(...allResults.map(r => r.retries)) : 0;
  const totalRetry = allResults.reduce((s,r) => s + r.retries, 0);
  const tps       = (passed / (elapsed / 1000)).toFixed(2);

  console.log(`${C}${"═".repeat(62)}${RS}`);
  console.log(`${C}  RESULTS${RS}`);
  console.log(`${C}${"═".repeat(62)}${RS}`);
  console.log(`  Confirmed     : ${G}${passed}/${totalTx}${RS}${allFailed.length ? ` ${R}(${allFailed.length} failed)${RS}` : ""}`);
  console.log(`  USDC spent    : ${G}$${(passed * 0.01).toFixed(2)}${RS}`);
  console.log(`  Total time    : ${D}${(elapsed/1000).toFixed(1)}s${RS}`);
  console.log(`  Throughput    : ${G}${tps} payments/sec${RS}`);
  console.log(`  Avg latency   : ${D}${avgMs}ms${RS}`);
  console.log(`  p95 latency   : ${D}${p95Ms}ms${RS}`);
  console.log(`  Lock retries  : ${D}${totalRetry} total, max ${maxRetry} on one request${RS}`);
  console.log(`  Fee/txn       : ${D}~$0.0002${RS}`);
  console.log(`${C}${"═".repeat(62)}${RS}`);

  if (allFailed.length) {
    console.log(`\n${R}  FAILURES${RS}`);
    allFailed.forEach(f => console.log(`  ${R}✗${RS} ${f}`));
  }

  if (allResults.length > 0) {
    console.log(`\n${C}  VERIFY${RS}`);
    console.log(`  First : https://explorer.perawallet.app/tx/${allResults[0].txid}`);
    console.log(`  Last  : https://explorer.perawallet.app/tx/${allResults[allResults.length-1].txid}`);
    console.log(`  Agent : https://explorer.perawallet.app/address/${account.addr.toString()}`);
  }
  console.log();
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
