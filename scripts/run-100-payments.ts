/**
 * run-100-payments.ts — 100 sequential x402 weather payments
 *
 * Runs 100 real $0.01 USDC payments through the x402 payment rail,
 * each confirmed on Algorand mainnet. Generates a full receipt log.
 *
 * Usage: CITY=London npx tsx scripts/run-100-payments.ts
 */

import algosdk        from "algosdk";
import "dotenv/config";
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const API_URL    = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const CITY       = process.env.CITY ?? "London";
const MNEMONIC   = process.env.ALGO_MNEMONIC!;
const PORTAL_KEY = process.env.PORTAL_API_SECRET ?? process.env.PORTAL_KEY ?? "";
const TOTAL    = 100;
const DELAY_MS = 500; // gap between requests — respectful of rate limits

const C  = "\x1b[36m";  // cyan
const G  = "\x1b[32m";  // green
const Y  = "\x1b[33m";  // yellow
const R  = "\x1b[31m";  // red
const D  = "\x1b[2m";   // dim
const RS = "\x1b[0m";   // reset

interface Receipt {
  n:       number;
  txid:    string;
  round:   number;
  tempC:   number;
  ms:      number;
}

async function pollJob(jobId: string, timeoutMs = 30_000): Promise<{ txid: string; round: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${API_URL}/api/jobs/${jobId}`, {
      headers: PORTAL_KEY ? { "X-Portal-Key": PORTAL_KEY } : {},
    });
    if (r.ok) {
      const j = await r.json() as { status: string; txnId?: string; confirmedRound?: number };
      if (j.status === "confirmed" && j.txnId) {
        return { txid: j.txnId, round: j.confirmedRound ?? 0 };
      }
      if (j.status === "failed") throw new Error(`Job ${jobId} failed`);
    }
    await new Promise(res => setTimeout(res, 1_500));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}

async function main() {
  if (!MNEMONIC) { console.error("ALGO_MNEMONIC not set"); process.exit(1); }

  const account = algosdk.mnemonicToSecretKey(MNEMONIC);
  const addr    = account.addr.toString();

  const client = new AlgoAgentClient({ baseUrl: API_URL, privateKey: account.sk });

  console.log(`\n${C}${"═".repeat(66)}${RS}`);
  console.log(`${C}  100 × $0.01 USDC — x402 Algorand Payment Rail Proof${RS}`);
  console.log(`${C}${"═".repeat(66)}${RS}`);
  console.log(`${D}  Agent  : ${addr}${RS}`);
  console.log(`${D}  Target : ${API_URL}${RS}`);
  console.log(`${D}  City   : ${CITY}${RS}`);
  console.log(`${D}  Total  : ${TOTAL} payments × $0.01 = $${(TOTAL * 0.01).toFixed(2)} USDC${RS}`);
  console.log(`${C}${"═".repeat(66)}${RS}\n`);

  const receipts: Receipt[] = [];
  const failures: number[]  = [];
  const runStart = Date.now();

  for (let n = 1; n <= TOTAL; n++) {
    const txStart = Date.now();
    process.stdout.write(`  [${String(n).padStart(3)}/${TOTAL}] `);

    try {
      const res  = await client.fetch("/api/weather", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ city: CITY }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      }

      const data   = await res.json() as { weather?: { temperature_2m?: number }; jobId?: string };
      const jobId  = data.jobId;
      const tempC  = data.weather?.temperature_2m ?? 0;

      if (!jobId) throw new Error("No jobId in response");

      process.stdout.write(`paying... `);
      const { txid, round } = await pollJob(jobId);
      const ms = Date.now() - txStart;

      receipts.push({ n, txid, round, tempC, ms });
      console.log(`${G}✓${RS} ${D}${txid.slice(0, 12)}… round ${round} (${ms}ms) ${tempC}°C${RS}`);

    } catch (err) {
      const ms = Date.now() - txStart;
      failures.push(n);
      console.log(`${R}✗${RS} ${D}${err instanceof Error ? err.message.slice(0, 80) : String(err)} (${ms}ms)${RS}`);
    }

    if (n < TOTAL) await new Promise(res => setTimeout(res, DELAY_MS));
  }

  // ── Summary ───────────────────────────────────────────────────
  const totalMs   = Date.now() - runStart;
  const passed    = receipts.length;
  const avgMs     = passed > 0 ? Math.round(receipts.reduce((s, r) => s + r.ms, 0) / passed) : 0;
  const p95Ms     = passed > 0 ? receipts.map(r => r.ms).sort((a,b)=>a-b)[Math.floor(passed * 0.95)] : 0;
  const usdcSpent = (passed * 0.01).toFixed(2);

  console.log(`\n${C}${"═".repeat(66)}${RS}`);
  console.log(`${C}  RESULTS${RS}`);
  console.log(`${C}${"═".repeat(66)}${RS}`);
  console.log(`  Payments confirmed : ${G}${passed}/${TOTAL}${RS}${failures.length ? ` ${R}(failed: ${failures.join(", ")})${RS}` : ""}`);
  console.log(`  USDC spent         : ${G}$${usdcSpent}${RS}`);
  console.log(`  Total time         : ${D}${(totalMs/1000).toFixed(1)}s${RS}`);
  console.log(`  Avg per payment    : ${D}${avgMs}ms${RS}`);
  console.log(`  p95 per payment    : ${D}${p95Ms}ms${RS}`);
  console.log(`  Network            : ${D}Algorand mainnet${RS}`);
  console.log(`  Fee per txn        : ${D}~$0.0002${RS}`);
  console.log(`${C}${"═".repeat(66)}${RS}`);

  // ── Full receipt log ──────────────────────────────────────────
  console.log(`\n${C}  ON-CHAIN RECEIPTS${RS}`);
  console.log(`${D}  ${"─".repeat(64)}${RS}`);
  for (const r of receipts) {
    console.log(`  ${String(r.n).padStart(3)}  ${r.txid}  round ${r.round}`);
  }
  console.log(`${D}  ${"─".repeat(64)}${RS}`);

  // ── First and last explorer links ─────────────────────────────
  if (receipts.length > 0) {
    const first = receipts[0];
    const last  = receipts[receipts.length - 1];
    console.log(`\n${C}  VERIFY ON-CHAIN${RS}`);
    console.log(`  First: https://explorer.perawallet.app/tx/${first.txid}`);
    console.log(`  Last:  https://explorer.perawallet.app/tx/${last.txid}`);
    console.log(`  Agent: https://explorer.perawallet.app/address/${addr}`);
  }

  console.log();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
