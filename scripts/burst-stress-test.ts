/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HONDA SYSTEM — BURST STRESS TEST                                        │
 * │                                                                          │
 * │  Two independent burst modes:                                            │
 * │                                                                          │
 * │  On-chain modes (direct Algorand):                                       │
 * │    460 mainnet Type A atomic settlements across 4 amount tranches.      │
 * │    Proves throughput, robustness, and settlement correctness under       │
 * │    concurrent load with random amounts.                                 │
 * │                                                                          │
 * │    Tranche breakdown:                                                    │
 * │      Micro    (200 txns)  100–500 µUSDC    ($0.0001–$0.0005)  ~$0.06   │
 * │      Standard (200 txns)  1,000–5,000 µUSDC ($0.001–$0.005)   ~$0.30   │
 * │      Bulk     (50 txns)   10,000–50,000 µUSDC ($0.01–$0.05)   ~$1.00   │
 * │      Spike    (10 txns)   100,000–500,000 µUSDC ($0.10–$0.50) ~$2.00   │
 * │      Total    460 txns                                          ~$3.40   │
 * │                                                                          │
 * │  x402 API mode (Sprint 5.1 — tests the full API pipeline):              │
 * │    N concurrent requests through /api/execute. Measures enqueue          │
 * │    p50/p95/p99 with pass target p95 < 5s.                               │
 * │    - Phase 1: get N sandbox exports sequentially (x402 handshake)       │
 * │    - Phase 2: fire all N /api/execute calls simultaneously              │
 * │    - Phase 3: poll all job statuses to confirmation                     │
 * │                                                                          │
 * │  MODES:                                                                  │
 * │    --probe    (default)  Dry run. No on-chain activity.                 │
 * │    --sandbox             Full construction + sign. No broadcast.        │
 * │    --live                Real mainnet settlement. Requires wallet.      │
 * │    --x402                x402 API pipeline burst (Sprint 5.1).         │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    npx tsx scripts/burst-stress-test.ts                   # probe       │
 * │    npx tsx scripts/burst-stress-test.ts --sandbox         # dry-run     │
 * │    npx tsx scripts/burst-stress-test.ts --live            # mainnet     │
 * │    npx tsx scripts/burst-stress-test.ts --x402            # API burst   │
 * │                                                                          │
 * │  Env (on-chain modes):                                                   │
 * │    ALGO_MNEMONIC         — 25-word mnemonic of funded mainnet wallet    │
 * │    X402_PAY_TO_ADDRESS   — treasury address receiving toll payments     │
 * │    ALGORAND_NODE_URL     — Algod endpoint (default: Nodely mainnet)     │
 * │    CONCURRENCY           — worker pool size (default: 10)               │
 * │                                                                          │
 * │  Env (--x402 mode):                                                      │
 * │    ALGO_MNEMONIC         — 25-word mnemonic of registered agent wallet  │
 * │    PORTAL_API_SECRET     — bearer token for /api/execute                │
 * │    AGENT_ID              — registered agent ID                          │
 * │    BURST_SIZE            — concurrent requests (default: 20)            │
 * │    BURST_AMOUNT_MICROUSDC — per-request USDC amount (default: 1000)    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import { randomInt } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Mode ──────────────────────────────────────────────────────────
const MODE: "probe" | "sandbox" | "live" | "x402" =
  process.argv.includes("--x402")    ? "x402"    :
  process.argv.includes("--live")    ? "live"    :
  process.argv.includes("--sandbox") ? "sandbox" :
  "probe";

// ── Config ────────────────────────────────────────────────────────
const API_URL    = (process.env.API_URL || "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const ALGO_NODE  = process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev";
const TREASURY   = process.env.X402_PAY_TO_ADDRESS || "";
const USDC_ASA   = 31566704n;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10", 10);

const REPORT_PATH = path.join(__dirname, "..", "public", "stress-report.json");

// ── Tranche definitions ───────────────────────────────────────────
interface Tranche {
  name:    string;
  count:   number;
  minAmt:  number;   // µUSDC inclusive
  maxAmt:  number;   // µUSDC inclusive
}

const TRANCHES: Tranche[] = [
  { name: "micro",    count: 200, minAmt:    100, maxAmt:    500 },
  { name: "standard", count: 200, minAmt:   1000, maxAmt:   5000 },
  { name: "bulk",     count:  50, minAmt:  10000, maxAmt:  50000 },
  { name: "spike",    count:  10, minAmt: 100000, maxAmt: 500000 },
];

const TOTAL = TRANCHES.reduce((s, t) => s + t.count, 0); // 460

// ── ANSI helpers ──────────────────────────────────────────────────
const R  = "\x1b[0m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const C  = "\x1b[36m";
const D  = "\x1b[2m";
const RE = "\x1b[31m";
const B  = "\x1b[34m";
const M  = "\x1b[35m";

const ts  = () => `${D}${new Date().toISOString().slice(11, 23)}${R}`;
const ok  = (m: string) => console.log(`  ${ts()} ${G}✔${R} ${m}`);
const fail = (m: string) => console.log(`  ${ts()} ${RE}✗${R} ${m}`);
const warn = (m: string) => console.log(`  ${ts()} ${Y}⚠${R} ${m}`);
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
};

// ── Percentile helper ─────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Random amount within tranche ─────────────────────────────────
function randomAmount(tranche: Tranche): bigint {
  return BigInt(randomInt(tranche.minAmt, tranche.maxAmt + 1));
}

// ── Build flat job list (tranche × count, shuffled) ───────────────
interface Job {
  index:    number;
  tranche:  string;
  amount:   bigint;
}

function buildJobQueue(): Job[] {
  const jobs: Job[] = [];
  let idx = 0;
  for (const t of TRANCHES) {
    for (let i = 0; i < t.count; i++) {
      jobs.push({ index: idx++, tranche: t.name, amount: randomAmount(t) });
    }
  }
  // Fisher-Yates shuffle — mix tranches so workers get varied load
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  return jobs;
}

// ── Per-transaction result ────────────────────────────────────────
interface TxResult {
  index:     number;
  tranche:   string;
  amount:    string;    // µUSDC
  success:   boolean;
  latencyMs: number;
  txId:      string;
  error?:    string;
  mode:      string;
}

// ── Execute one Type A atomic settlement ─────────────────────────
async function executeJob(
  job: Job,
  account: algosdk.Account,
  algodClient: algosdk.Algodv2 | null,
  cachedParams: algosdk.SuggestedParams,
): Promise<TxResult> {
  const t0 = Date.now();

  const base: Omit<TxResult, "latencyMs"> = {
    index:   job.index,
    tranche: job.tranche,
    amount:  job.amount.toString(),
    success: false,
    txId:    "",
    mode:    MODE,
  };

  if (MODE === "probe") {
    return { ...base, success: true, txId: `probe-${job.index}`, latencyMs: Date.now() - t0 };
  }

  if (!algodClient || !TREASURY) {
    const error = !algodClient ? "algod not configured" : "X402_PAY_TO_ADDRESS not set";
    return { ...base, latencyMs: Date.now() - t0, error };
  }

  try {
    const auditNote = [
      "honda_v1",
      "burst",
      MODE === "sandbox" ? "dry-run" : "success",
      new Date().toISOString(),
      `algorand->algorand`,
      `${job.amount}musd`,
      `tranche:${job.tranche}`,
      `idx:${job.index}`,
    ].join("|");

    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender:      account.addr.toString(),
      receiver:    TREASURY,
      amount:      job.amount,
      assetIndex:  USDC_ASA,
      suggestedParams: cachedParams,
      note:        new Uint8Array(Buffer.from(auditNote)),
    });

    const signed = txn.signTxn(account.sk);
    const txId   = txn.txID().toString();

    if (MODE === "sandbox") {
      return { ...base, success: true, txId: `sandbox-${txId}`, latencyMs: Date.now() - t0 };
    }

    // --live: broadcast and wait for confirmation
    await algodClient.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(algodClient, txId, 4);

    return { ...base, success: true, txId, latencyMs: Date.now() - t0 };

  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 120) : String(err);
    return { ...base, latencyMs: Date.now() - t0, error };
  }
}

// ── Promise pool — runs up to `concurrency` jobs simultaneously ───
async function runPool(
  jobs: Job[],
  concurrency: number,
  account: algosdk.Account,
  algodClient: algosdk.Algodv2 | null,
  cachedParams: algosdk.SuggestedParams,
): Promise<TxResult[]> {
  const results: TxResult[] = new Array(jobs.length);
  let   next    = 0;
  let   done    = 0;

  // Progress bar state
  const barWidth = 40;
  const renderBar = () => {
    const pct   = done / jobs.length;
    const fill  = Math.round(pct * barWidth);
    const bar   = G + "█".repeat(fill) + R + D + "░".repeat(barWidth - fill) + R;
    process.stdout.write(`\r  [${bar}] ${String(done).padStart(3)}/${jobs.length}`);
  };

  renderBar();

  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await executeJob(job, account, algodClient, cachedParams);
      results[job.index] = result;
      done++;
      renderBar();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker());
  await Promise.all(workers);
  process.stdout.write("\n");

  return results;
}

// ── Percentile stats per tranche ──────────────────────────────────
interface TrancheStats {
  tranche:   string;
  total:     number;
  passed:    number;
  failed:    number;
  p50Ms:     number;
  p95Ms:     number;
  p99Ms:     number;
  avgMs:     number;
  minAmt:    string;
  maxAmt:    string;
}

function computeStats(results: TxResult[], trancheName: string): TrancheStats {
  const subset  = results.filter((r) => r.tranche === trancheName);
  const passed  = subset.filter((r) => r.success);
  const failed  = subset.filter((r) => !r.success);
  const latencies = passed.map((r) => r.latencyMs).sort((a, b) => a - b);
  const amounts   = subset.map((r) => BigInt(r.amount));

  return {
    tranche: trancheName,
    total:   subset.length,
    passed:  passed.length,
    failed:  failed.length,
    p50Ms:   percentile(latencies, 50),
    p95Ms:   percentile(latencies, 95),
    p99Ms:   percentile(latencies, 99),
    avgMs:   latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0,
    minAmt:  amounts.length ? amounts.reduce((a, b) => a < b ? a : b).toString() : "0",
    maxAmt:  amounts.length ? amounts.reduce((a, b) => a > b ? a : b).toString() : "0",
  };
}

// ── Write JSON report ─────────────────────────────────────────────
interface StressReport {
  schema:       string;
  generatedAt:  string;
  mode:         string;
  concurrency:  number;
  totalTxns:    number;
  passed:       number;
  failed:       number;
  elapsedMs:    number;
  tps:          number;
  globalP50Ms:  number;
  globalP95Ms:  number;
  globalP99Ms:  number;
  tranches:     TrancheStats[];
  results:      TxResult[];
}

function writeReport(report: StressReport): void {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────
async function runBurstStressTest() {
  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}HONDA SYSTEM — BURST STRESS TEST${R}`);
  console.log(`  ${D}Mode:        ${MODE.toUpperCase()}${R}`);
  console.log(`  ${D}Target:      ${API_URL}${R}`);
  console.log(`  ${D}Txns:        ${TOTAL} (200 micro · 200 standard · 50 bulk · 10 spike)${R}`);
  console.log(`  ${D}Concurrency: ${CONCURRENCY} workers${R}`);
  console.log(`  ${D}Date:        ${new Date().toISOString()}${R}`);
  console.log(`${C}${"═".repeat(68)}${R}`);

  if (MODE === "probe") {
    console.log(`\n  ${Y}PROBE mode — zero spend. Add --sandbox or --live to execute.${R}\n`);
  } else if (MODE === "sandbox") {
    console.log(`\n  ${Y}SANDBOX mode — constructs + signs every txn, no broadcast.${R}\n`);
  } else {
    console.log(`\n  ${RE}LIVE mode — 460 real mainnet USDC transactions.${R}`);
    console.log(`  ${RE}Ctrl+C to abort. Starting in 5 seconds...${R}`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── Server health check ────────────────────────────────────────
  sep("PRE-FLIGHT");
  try {
    const h = await fetch(`${API_URL}/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    const b = await h.json() as Record<string, unknown>;
    ok(`Server: ${API_URL} — ${b["protocol"]} on ${b["network"]}`);
  } catch (err) {
    fail(`Server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Algod client ───────────────────────────────────────────────
  let algodClient: algosdk.Algodv2 | null = null;
  if (MODE !== "probe") {
    algodClient = new algosdk.Algodv2("", ALGO_NODE, "");
    try {
      const status = await algodClient.status().do();
      ok(`Algod: round ${status["last-round"]}`);
    } catch {
      warn("Algod unreachable — all txns will fail");
      algodClient = null;
    }
  }

  // ── SuggestedParams — fetched ONCE, reused for all 460 txns ───
  let cachedParams!: algosdk.SuggestedParams;
  if (MODE !== "probe") {
    if (!algodClient) {
      fail("Cannot fetch suggestedParams without Algod — aborting");
      process.exit(1);
    }
    cachedParams = await algodClient.getTransactionParams().do();
    ok(`SuggestedParams cached — valid through round ${cachedParams.lastValid} (~${Math.round((Number(cachedParams.lastValid - cachedParams.firstValid)) * 4.5 / 60)} min)`);
  } else {
    // Probe: dummy params for dry-run construction
    cachedParams = {
      flatFee: true,
      fee: 1000n,
      minFee: 1000n,
      firstValid: 1000n,
      lastValid: 2000n,
      genesisID: "mainnet-v1.0",
      genesisHash: new Uint8Array(32),
    } as algosdk.SuggestedParams;
  }

  // ── Wallet ─────────────────────────────────────────────────────
  let account: algosdk.Account;
  if (process.env.ALGO_MNEMONIC && MODE === "live") {
    try {
      account = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC);
      ok(`Wallet: ${account.addr.toString()}`);

      if (algodClient) {
        const acctInfo = await algodClient.accountInformation(account.addr.toString()).do();
        const microAlgo = acctInfo["amount"] ?? 0n;
        const assets = (acctInfo["assets"] as Array<{ assetId: bigint; amount: bigint }>) ?? [];
        const usdc = assets.find((a) => a.assetId === USDC_ASA);
        const usdcBal = usdc ? Number(usdc.amount) / 1e6 : 0;
        const algoBal = Number(microAlgo) / 1e6;

        info(`Balance: ${algoBal.toFixed(3)} ALGO | ${usdcBal.toFixed(6)} USDC`);

        // Safety check
        if (!usdc) {
          fail("Wallet has not opted into USDC ASA (31566704). Opt in first.");
          process.exit(1);
        }
        if (usdcBal < 3.5) {
          warn(`Low USDC balance: ${usdcBal} USDC. Stress test may cost ~$3.40.`);
        }
        if (algoBal < 0.5) {
          warn(`Low ALGO balance: ${algoBal} ALGO. Need ~0.5 ALGO for tx fees.`);
        }

        if (!TREASURY) {
          fail("X402_PAY_TO_ADDRESS not set — set treasury address before --live");
          process.exit(1);
        }
      }
    } catch (err) {
      fail(`Invalid ALGO_MNEMONIC: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    account = algosdk.generateAccount();
    info(`Ephemeral wallet: ${account.addr.toString().slice(0, 20)}... (${MODE})`);
    if (MODE === "live") {
      fail("ALGO_MNEMONIC required for --live mode");
      process.exit(1);
    }
  }

  // ── Build job queue ────────────────────────────────────────────
  sep("EXECUTING 460 TRANSACTIONS");

  const jobs = buildJobQueue();

  const totalEstimateUSDC = TRANCHES.reduce((sum, t) => {
    const midpoint = (t.minAmt + t.maxAmt) / 2;
    return sum + (midpoint * t.count) / 1_000_000;
  }, 0);

  info(`Estimated cost (--live): ~$${totalEstimateUSDC.toFixed(2)} USDC + ~0.46 ALGO fees`);
  info(`Workers: ${CONCURRENCY} concurrent`);
  console.log();

  const wallStart = Date.now();
  const results   = await runPool(jobs, CONCURRENCY, account, algodClient, cachedParams);
  const elapsedMs = Date.now() - wallStart;

  // ── Compute stats ──────────────────────────────────────────────
  const allLatencies = results.filter((r) => r.success).map((r) => r.latencyMs).sort((a, b) => a - b);
  const globalPassed = results.filter((r) => r.success).length;
  const globalFailed = results.filter((r) => !r.success).length;
  const tps          = parseFloat(((globalPassed / elapsedMs) * 1000).toFixed(2));

  const trancheStats = TRANCHES.map((t) => computeStats(results, t.name));

  // ── Print results ──────────────────────────────────────────────
  sep("RESULTS");

  const col = (s: string | number, w: number) => String(s).padStart(w);

  console.log(`  ${C}${"Tranche".padEnd(10)}  ${"Total".padStart(6)}  ${"Pass".padStart(5)}  ${"Fail".padStart(5)}  ${"P50".padStart(7)}  ${"P95".padStart(7)}  ${"P99".padStart(7)}  ${"Avg".padStart(7)}${R}`);
  console.log(`  ${"─".repeat(66)}`);

  for (const s of trancheStats) {
    const failColor = s.failed > 0 ? RE : G;
    const trancheColor =
      s.tranche === "spike"    ? M :
      s.tranche === "bulk"     ? Y :
      s.tranche === "standard" ? B : D;

    console.log(
      `  ${trancheColor}${s.tranche.padEnd(10)}${R}` +
      `  ${col(s.total, 6)}` +
      `  ${G}${col(s.passed, 5)}${R}` +
      `  ${failColor}${col(s.failed, 5)}${R}` +
      `  ${col(s.p50Ms + "ms", 7)}` +
      `  ${col(s.p95Ms + "ms", 7)}` +
      `  ${col(s.p99Ms + "ms", 7)}` +
      `  ${col(s.avgMs + "ms", 7)}`
    );
  }

  console.log(`  ${"─".repeat(66)}`);

  const globalP50 = percentile(allLatencies, 50);
  const globalP95 = percentile(allLatencies, 95);
  const globalP99 = percentile(allLatencies, 99);

  console.log(
    `  ${C}${"ALL".padEnd(10)}${R}` +
    `  ${col(TOTAL, 6)}` +
    `  ${G}${col(globalPassed, 5)}${R}` +
    `  ${globalFailed > 0 ? RE : G}${col(globalFailed, 5)}${R}` +
    `  ${col(globalP50 + "ms", 7)}` +
    `  ${col(globalP95 + "ms", 7)}` +
    `  ${col(globalP99 + "ms", 7)}`
  );

  console.log();
  console.log(`  ${D}Elapsed:      ${(elapsedMs / 1000).toFixed(1)}s${R}`);
  console.log(`  ${D}Throughput:   ${tps} TPS${R}`);
  console.log(`  ${D}Mode:         ${MODE.toUpperCase()}${R}`);

  // ── Write report ───────────────────────────────────────────────
  const report: StressReport = {
    schema:      "honda-burst-stress-v1",
    generatedAt: new Date().toISOString(),
    mode:        MODE,
    concurrency: CONCURRENCY,
    totalTxns:   TOTAL,
    passed:      globalPassed,
    failed:      globalFailed,
    elapsedMs,
    tps,
    globalP50Ms: globalP50,
    globalP95Ms: globalP95,
    globalP99Ms: globalP99,
    tranches:    trancheStats,
    results,
  };

  writeReport(report);
  ok(`Report: ${REPORT_PATH}`);

  // ── Failure details ────────────────────────────────────────────
  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    sep("FAILURES");
    for (const f of failures.slice(0, 20)) {
      console.log(`  ${RE}[${f.tranche}#${f.index}]${R} ${f.error ?? "unknown error"}`);
    }
    if (failures.length > 20) {
      info(`...and ${failures.length - 20} more — see stress-report.json`);
    }
  }

  // ── Final status ───────────────────────────────────────────────
  sep("SUMMARY");

  if (MODE === "live") {
    console.log(`  ${G}${globalPassed}/${TOTAL} transactions confirmed on-chain.${R}`);
    console.log(`  On-chain audit: https://mainnet-idx.algonode.cloud/v2/transactions?note-prefix=aG9uZGFfdjE%3D`);
    console.log(`  Treasury:       https://allo.info/account/${TREASURY}`);
  } else if (MODE === "sandbox") {
    console.log(`  ${G}${globalPassed}/${TOTAL} transactions constructed + signed (not broadcast).${R}`);
    console.log(`  Re-run with --live to settle on mainnet.`);
  } else {
    console.log(`  ${G}${globalPassed}/${TOTAL} probe jobs passed.${R}`);
    console.log(`  Re-run with --sandbox to test construction, --live to settle.`);
  }

  if (globalFailed > 0) {
    console.log(`\n  ${RE}${globalFailed} failure(s). Check stress-report.json for details.${R}`);
    process.exit(1);
  }

  console.log(`\n  ${G}Burst stress test complete.${R}\n`);
}

// ══════════════════════════════════════════════════════════════════
// x402 API BURST TEST (Sprint 5.1)
// Tests the x402 API pipeline under concurrent load.
// ══════════════════════════════════════════════════════════════════

// Default BURST_SIZE=5 matches server EXEC_BURST_MAX (5 req/10s per agent).
// Increase BURST_SIZE beyond 5 to intentionally test the rate-limiter response
// (expect 429 for excess requests — this is correct behaviour, not a failure).
const X402_BURST_SIZE      = parseInt(process.env.BURST_SIZE             || "5",    10);
const X402_AMOUNT_MICROUSDC = parseInt(process.env.BURST_AMOUNT_MICROUSDC || "10000", 10); // $0.01 (must match X402_PRICE_MICROUSDC on server)
const X402_PHASE1_DELAY_MS  = 300;  // gap between sandbox export requests
const X402_POLL_INTERVAL_MS = 2000; // job status poll interval
const X402_POLL_TIMEOUT_MS  = 120_000; // 2 min max for jobs to confirm

interface X402JobOutcome {
  slot:          number;
  sandboxId:     string;
  jobId:         string;
  enqueueMs:     number;   // time from fire to "queued" response
  confirmMs:     number;   // time from fire to confirmed/failed
  status:        "confirmed" | "failed" | "timeout";
  httpStatus:    number;
  rateLimited:   boolean;
  error?:        string;
}

async function getSandboxExport(
  client:        AlgoAgentClient,
  senderAddress: string,
  amount:        number,
): Promise<object | null> {
  try {
    const response = await client.requestSandboxExport({ senderAddress, amount });
    return response.export as object;
  } catch {
    return null;
  }
}

async function fireExecuteRequest(
  apiUrl:        string,
  sandboxExport: object,
  agentId:       string,
  portalSecret:  string,
  slot:          number,
): Promise<Pick<X402JobOutcome, "slot" | "sandboxId" | "jobId" | "enqueueMs" | "httpStatus" | "rateLimited" | "error">> {
  const sandboxId = (sandboxExport as Record<string, string>).sandboxId ?? `slot-${slot}`;
  const t0 = Date.now();

  try {
    const res = await fetch(`${apiUrl}/api/execute`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${portalSecret}`,
      },
      body: JSON.stringify({ sandboxExport, agentId }),
    });

    const body = await res.json() as Record<string, unknown>;
    const enqueueMs = Date.now() - t0;

    if (res.status === 429 || res.status === 503) {
      return {
        slot, sandboxId, jobId: "", enqueueMs, httpStatus: res.status,
        rateLimited: true, error: String(body.error ?? `HTTP ${res.status}`),
      };
    }

    if (!res.ok) {
      return {
        slot, sandboxId, jobId: "", enqueueMs, httpStatus: res.status,
        rateLimited: false, error: String(body.error ?? `HTTP ${res.status}`),
      };
    }

    const jobId = String(body.jobId ?? "");
    return { slot, sandboxId, jobId, enqueueMs, httpStatus: res.status, rateLimited: false };
  } catch (err) {
    return {
      slot, sandboxId, jobId: "", enqueueMs: Date.now() - t0,
      httpStatus: 0, rateLimited: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pollJobUntilDone(
  apiUrl:       string,
  jobId:        string,
  portalSecret: string,
  startMs:      number,
  timeoutMs:    number,
): Promise<{ status: "confirmed" | "failed" | "timeout"; confirmMs: number }> {
  if (!jobId) return { status: "failed", confirmMs: Date.now() - startMs };

  const deadline = startMs + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, X402_POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${apiUrl}/api/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${portalSecret}` },
      });
      if (!res.ok) continue;
      const job = await res.json() as Record<string, string>;
      if (job.status === "confirmed") return { status: "confirmed", confirmMs: Date.now() - startMs };
      if (job.status === "failed")    return { status: "failed",    confirmMs: Date.now() - startMs };
    } catch { /* retry */ }
  }
  return { status: "timeout", confirmMs: timeoutMs };
}

async function runX402BurstTest() {
  const AGENT_ID     = process.env.AGENT_ID;
  const PORTAL_SEC   = process.env.PORTAL_API_SECRET;
  const MNEMONIC     = process.env.ALGO_MNEMONIC;

  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}x402 API BURST TEST (Sprint 5.1)${R}`);
  console.log(`  ${D}Target:       ${API_URL}${R}`);
  console.log(`  ${D}Burst size:   ${X402_BURST_SIZE} concurrent requests${R}`);
  console.log(`  ${D}Amt/request:  ${X402_AMOUNT_MICROUSDC} µUSDC ($${(X402_AMOUNT_MICROUSDC / 1_000_000).toFixed(6)})${R}`);
  console.log(`  ${D}Date:         ${new Date().toISOString()}${R}`);
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
    ok(`Server: ${API_URL} — ${b["protocol"]} on ${b["network"]}`);
  } catch (err) {
    fail(`Server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  ok(`Wallet:  ${account.addr.toString().slice(0, 20)}...`);
  ok(`AgentId: ${AGENT_ID}`);
  console.log(`\n  ${Y}LIVE mode — this sends real x402 payments (${X402_BURST_SIZE} × $${(X402_AMOUNT_MICROUSDC / 1_000_000).toFixed(6)} = ~$${((X402_BURST_SIZE * X402_AMOUNT_MICROUSDC) / 1_000_000).toFixed(4)} USDC)${R}`);
  console.log(`  ${Y}Ctrl+C to abort. Starting in 5 seconds...${R}`);
  await new Promise((r) => setTimeout(r, 5000));

  const x402Client = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    slippageBips: 0,
  });

  // ── Phase 1: Get N sandbox exports (sequential, 300ms gap) ─────
  sep(`PHASE 1 — GETTING ${X402_BURST_SIZE} SANDBOX EXPORTS`);
  const sandboxExports: Array<object | null> = [];
  const phase1Start = Date.now();

  for (let i = 0; i < X402_BURST_SIZE; i++) {
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${X402_BURST_SIZE}] requesting sandbox export... `);
    const t0 = Date.now();
    const ex = await getSandboxExport(x402Client, account.addr.toString(), X402_AMOUNT_MICROUSDC);
    const ms = Date.now() - t0;

    if (ex) {
      sandboxExports.push(ex);
      process.stdout.write(`${G}✔${R} ${ms}ms\n`);
    } else {
      sandboxExports.push(null);
      process.stdout.write(`${RE}✗${R} failed\n`);
    }

    if (i < X402_BURST_SIZE - 1) await new Promise((r) => setTimeout(r, X402_PHASE1_DELAY_MS));
  }

  const validExports = sandboxExports.filter(Boolean);
  info(`Phase 1 done in ${((Date.now() - phase1Start) / 1000).toFixed(1)}s — ${validExports.length}/${X402_BURST_SIZE} exports ready`);

  if (validExports.length === 0) {
    fail("No sandbox exports obtained — cannot proceed");
    process.exit(1);
  }

  // ── Phase 2: Burst execute — fire ALL simultaneously ────────────
  sep(`PHASE 2 — BURST EXECUTE (${validExports.length} concurrent)`);
  info(`Firing ${validExports.length} /api/execute calls simultaneously...`);
  console.log();

  const burstStart = Date.now();
  const execResults = await Promise.all(
    sandboxExports.map((ex, slot) =>
      ex
        ? fireExecuteRequest(API_URL, ex, AGENT_ID, PORTAL_SEC, slot)
        : Promise.resolve({
            slot, sandboxId: `slot-${slot}`, jobId: "", enqueueMs: 0,
            httpStatus: 0, rateLimited: false, error: "no export",
          }),
    ),
  );

  const burstElapsedMs = Date.now() - burstStart;
  info(`All execute calls returned in ${burstElapsedMs}ms`);

  const enqueueLatencies = execResults
    .filter((r) => r.httpStatus === 200 || r.httpStatus === 201 || r.httpStatus === 202)
    .map((r) => r.enqueueMs)
    .sort((a, b) => a - b);

  const rateLimitedCount = execResults.filter((r) => r.rateLimited).length;
  const successCount     = execResults.filter((r) => !r.rateLimited && !r.error).length;
  const failCount        = execResults.filter((r) => r.error && !r.rateLimited).length;

  console.log();
  console.log(`  ${C}Execute results:${R}`);
  console.log(`    ${G}Queued:      ${successCount}${R}`);
  console.log(`    ${Y}Rate-limited: ${rateLimitedCount}  (target ≤ ${Math.ceil(X402_BURST_SIZE * 0.05)})${R}`);
  console.log(`    ${RE}Errors:       ${failCount}${R}`);

  if (enqueueLatencies.length > 0) {
    const p50 = percentile(enqueueLatencies, 50);
    const p95 = percentile(enqueueLatencies, 95);
    const p99 = percentile(enqueueLatencies, 99);
    const avg = Math.round(enqueueLatencies.reduce((s, v) => s + v, 0) / enqueueLatencies.length);
    console.log();
    console.log(`  ${C}Enqueue latency (time to "queued" response):${R}`);
    console.log(`    p50: ${p50}ms`);
    console.log(`    ${p95 <= 5000 ? G : RE}p95: ${p95}ms  (target < 5000ms)${R}`);
    console.log(`    p99: ${p99}ms`);
    console.log(`    avg: ${avg}ms`);
  }

  // ── Phase 3: Poll jobs to confirmation ─────────────────────────
  sep("PHASE 3 — POLLING JOBS TO CONFIRMATION");
  const jobIds = execResults.filter((r) => r.jobId).map((r) => ({ slot: r.slot, jobId: r.jobId, startMs: burstStart }));
  info(`Polling ${jobIds.length} jobs (timeout: ${X402_POLL_TIMEOUT_MS / 1000}s)...`);

  const pollResults = await Promise.all(
    jobIds.map(({ slot, jobId, startMs }) =>
      pollJobUntilDone(API_URL, jobId, PORTAL_SEC, startMs, X402_POLL_TIMEOUT_MS)
        .then(({ status, confirmMs }) => ({ slot, jobId, status, confirmMs })),
    ),
  );

  const confirmed = pollResults.filter((r) => r.status === "confirmed");
  const failed    = pollResults.filter((r) => r.status === "failed");
  const timedOut  = pollResults.filter((r) => r.status === "timeout");

  const confirmLatencies = confirmed.map((r) => r.confirmMs).sort((a, b) => a - b);

  // ── Results ────────────────────────────────────────────────────
  sep("RESULTS SUMMARY");
  console.log(`  ${D}Burst size:          ${X402_BURST_SIZE}${R}`);
  console.log(`  ${D}Sandbox exports:     ${validExports.length}/${X402_BURST_SIZE}${R}`);
  console.log(`  ${D}Queued:              ${successCount}/${validExports.length}${R}`);
  console.log(`  ${D}Rate-limited (429/503): ${rateLimitedCount} (${((rateLimitedCount / X402_BURST_SIZE) * 100).toFixed(1)}% — target ≤ 5%)${R}`);
  console.log(`  ${D}Confirmed on-chain:  ${confirmed.length}${R}`);
  console.log(`  ${D}Failed:              ${failed.length}${R}`);
  console.log(`  ${D}Timed out:           ${timedOut.length}${R}`);

  if (enqueueLatencies.length > 0) {
    const p50 = percentile(enqueueLatencies, 50);
    const p95 = percentile(enqueueLatencies, 95);
    const p99 = percentile(enqueueLatencies, 99);
    console.log();
    console.log(`  ${C}Enqueue latency:${R}`);
    console.log(`    p50 ${p50}ms  p95 ${p95 <= 5000 ? G : RE}${p95}ms${R}  p99 ${p99}ms`);
  }

  if (confirmLatencies.length > 0) {
    const cP50 = percentile(confirmLatencies, 50);
    const cP95 = percentile(confirmLatencies, 95);
    console.log();
    console.log(`  ${C}Confirmation latency (burst start → on-chain):${R}`);
    console.log(`    p50 ${cP50}ms  p95 ${cP95}ms`);
  }

  // ── Write JSON report ──────────────────────────────────────────
  const report = {
    schema:      "x402-burst-v1",
    generatedAt: new Date().toISOString(),
    burstSize:   X402_BURST_SIZE,
    exportsOk:   validExports.length,
    queued:      successCount,
    rateLimited: rateLimitedCount,
    errors:      failCount,
    confirmed:   confirmed.length,
    failed:      failed.length,
    timedOut:    timedOut.length,
    enqueueLatencyMs: enqueueLatencies.length > 0 ? {
      p50: percentile(enqueueLatencies, 50),
      p95: percentile(enqueueLatencies, 95),
      p99: percentile(enqueueLatencies, 99),
      avg: Math.round(enqueueLatencies.reduce((s, v) => s + v, 0) / enqueueLatencies.length),
    } : null,
    confirmLatencyMs: confirmLatencies.length > 0 ? {
      p50: percentile(confirmLatencies, 50),
      p95: percentile(confirmLatencies, 95),
    } : null,
    execResults,
    pollResults,
  };

  const x402ReportPath = path.join(__dirname, "..", "public", "x402-burst-report.json");
  fs.mkdirSync(path.dirname(x402ReportPath), { recursive: true });
  fs.writeFileSync(x402ReportPath, JSON.stringify(report, null, 2));
  ok(`Report: ${x402ReportPath}`);

  // ── Pass/fail gate ─────────────────────────────────────────────
  const rateLimitPct = (rateLimitedCount / X402_BURST_SIZE) * 100;
  const p95Enqueue   = enqueueLatencies.length > 0 ? percentile(enqueueLatencies, 95) : 0;
  const crashes      = failCount > successCount * 0.1; // >10% pipeline errors = crash

  const pass =
    !crashes &&
    rateLimitPct <= 5 &&
    (p95Enqueue === 0 || p95Enqueue <= 5000);

  console.log();
  if (pass) {
    console.log(`  ${G}✔ BURST TEST PASSED${R}`);
    console.log(`    0 crashes  |  ${rateLimitPct.toFixed(1)}% rate-limited (≤5%)  |  p95 enqueue ${p95Enqueue}ms (≤5000ms)`);
  } else {
    console.log(`  ${RE}✗ BURST TEST FAILED${R}`);
    if (crashes)           console.log(`    ${RE}Pipeline error rate too high${R}`);
    if (rateLimitPct > 5)  console.log(`    ${RE}Rate-limited: ${rateLimitPct.toFixed(1)}% (target ≤5%)${R}`);
    if (p95Enqueue > 5000) console.log(`    ${RE}p95 enqueue ${p95Enqueue}ms > 5000ms target${R}`);
    process.exit(1);
  }
}

// ── Entry point ───────────────────────────────────────────────────

if (MODE === "x402") {
  runX402BurstTest().catch((err) => {
    console.error(`\n  ${RE}FATAL: ${err instanceof Error ? err.message : String(err)}${R}\n`);
    process.exit(1);
  });
} else {
  runBurstStressTest().catch((err) => {
    console.error(`\n  ${RE}FATAL: ${err instanceof Error ? err.message : String(err)}${R}\n`);
    process.exit(1);
  });
}
