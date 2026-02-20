/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HONDA SYSTEM — BURST STRESS TEST                                        │
 * │                                                                          │
 * │  460 mainnet Type A atomic settlements across 4 amount tranches.        │
 * │  Proves throughput, robustness, and settlement correctness under         │
 * │  concurrent load with random amounts.                                   │
 * │                                                                          │
 * │  Tranche breakdown:                                                      │
 * │    Micro    (200 txns)  100–500 µUSDC    ($0.0001–$0.0005)  ~$0.06     │
 * │    Standard (200 txns)  1,000–5,000 µUSDC ($0.001–$0.005)   ~$0.30     │
 * │    Bulk     (50 txns)   10,000–50,000 µUSDC ($0.01–$0.05)   ~$1.00     │
 * │    Spike    (10 txns)   100,000–500,000 µUSDC ($0.10–$0.50) ~$2.00     │
 * │    ─────────────────────────────────────────────────────────────────    │
 * │    Total    460 txns                                          ~$3.40     │
 * │                                                                          │
 * │  Architecture:                                                           │
 * │    - suggestedParams fetched ONCE, reused for all 460 txns             │
 * │    - 10 concurrent workers (Promise pool)                               │
 * │    - Cryptographically random amounts via crypto.randomInt              │
 * │    - P50/P95/P99 latency report                                         │
 * │    - JSON report written to public/stress-report.json                  │
 * │    - All txns carry honda_v1 audit note (indexer-verifiable)           │
 * │                                                                          │
 * │  MODES:                                                                  │
 * │    --probe    (default)  Dry run. No on-chain activity.                 │
 * │    --sandbox             Full construction + sign. No broadcast.        │
 * │    --live                Real mainnet settlement. Requires wallet.      │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    npx tsx scripts/burst-stress-test.ts                   # probe       │
 * │    npx tsx scripts/burst-stress-test.ts --sandbox         # dry-run     │
 * │    npx tsx scripts/burst-stress-test.ts --live            # mainnet     │
 * │                                                                          │
 * │  Env:                                                                    │
 * │    ALGO_MNEMONIC         — 25-word mnemonic of funded mainnet wallet    │
 * │    X402_PAY_TO_ADDRESS   — treasury address receiving toll payments     │
 * │    ALGORAND_NODE_URL     — Algod endpoint (default: Nodely mainnet)     │
 * │    CONCURRENCY           — worker pool size (default: 10)               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import { randomInt } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Mode ──────────────────────────────────────────────────────────
const MODE: "probe" | "sandbox" | "live" =
  process.argv.includes("--live")    ? "live"    :
  process.argv.includes("--sandbox") ? "sandbox" :
  "probe";

// ── Config ────────────────────────────────────────────────────────
const API_URL    = (process.env.API_URL || "https://ai-agentic-wallet.com").replace(/\/+$/, "");
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

runBurstStressTest().catch((err) => {
  console.error(`\n  ${RE}FATAL: ${err instanceof Error ? err.message : String(err)}${R}\n`);
  process.exit(1);
});
