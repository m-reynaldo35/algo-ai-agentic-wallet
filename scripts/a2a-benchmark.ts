/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  A2A PAYMENT BENCHMARK — Real-World AI Agent Payment Simulation     ║
 * ║                                                                      ║
 * ║  Simulates realistic AI agent payment patterns:                      ║
 * ║    • Poisson arrivals (exponential random inter-payment intervals)   ║
 * ║    • Burst clusters  (3-6 concurrent payments, 25% probability)      ║
 * ║    • Fully async settlement tracking via SSE (no polling)            ║
 * ║    • Budget-based termination (runs until USDC exhausted)            ║
 * ║                                                                      ║
 * ║  Metrics reported:                                                   ║
 * ║    • x402 handshake latency  (402 bounce → data received)           ║
 * ║    • Settlement latency      (enqueue → on-chain confirmed)          ║
 * ║    • End-to-end latency      (fire → confirmed)                      ║
 * ║    • p50 / p95 / p99 for all three                                   ║
 * ║    • Throughput, peak concurrency, success rate                      ║
 * ║                                                                      ║
 * ║  Usage:                                                              ║
 * ║    npx tsx scripts/a2a-benchmark.ts                                  ║
 * ║    BUDGET_MICRO_USDC=500000 LAMBDA=2.0 npx tsx scripts/a2a-benchmark.ts ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { requestWithPayment, X402Error } from "@algo-wallet/x402-client";
import "dotenv/config";

// ── Config ─────────────────────────────────────────────────────────────

const API_URL       = (process.env.API_URL       ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const MNEMONIC      = process.env.ALGO_MNEMONIC!;
const PORTAL_SECRET = process.env.PORTAL_API_SECRET!;
const AGENT_ID      = process.env.AGENT_ID!;
const EXPLORER_BASE = "https://explorer.perawallet.app/tx";

// Budget: default 1 USDC = 100 payments at $0.01 each
const BUDGET_MICRO_USDC = parseInt(process.env.BUDGET_MICRO_USDC ?? "1000000", 10);
const TOLL_MICRO_USDC   = 10_000;
const MAX_PAYMENTS      = Math.floor(BUDGET_MICRO_USDC / TOLL_MICRO_USDC);

// Poisson arrival rate — average payments per second
// λ=1.5 → avg 670ms between firings → ~100 payments in ~67s
const LAMBDA = parseFloat(process.env.LAMBDA ?? "1.5");

// Burst cluster config
const BURST_PROB     = 0.25;  // 25% chance of burst cluster instead of single
const BURST_MIN      = 3;
const BURST_MAX_SIZE = 6;
const BURST_GAP_MS   = 80;    // ms between payments within a burst

// Cities to vary requests (more realistic than identical calls)
const CITIES = [
  "Lagos", "London", "New York", "Tokyo", "Sydney",
  "Dubai", "Singapore", "Paris", "Berlin", "Mumbai",
  "São Paulo", "Seoul", "Toronto", "Amsterdam", "Nairobi",
];

if (!MNEMONIC || !PORTAL_SECRET || !AGENT_ID) {
  console.error("[FATAL] ALGO_MNEMONIC, PORTAL_API_SECRET and AGENT_ID are required.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const SENDER  = account.addr.toString();

// ── Types ───────────────────────────────────────────────────────────────

interface PaymentResult {
  id:       number;
  city:     string;
  tFire:    number;   // payment initiated
  tProof:   number;   // x402 handshake complete, data received
  tEnqueue: number;   // job enqueued on server
  tConfirm: number;   // on-chain confirmed (or failed)
  status:   "confirmed" | "failed";
  txnId?:   string;
  error?:   string;
}

interface SseResult {
  status:         string;
  txnId?:         string;
  confirmedRound?: number;
  settledAt?:     string;
  error?:         string;
}

interface WeatherResponse {
  export:          Record<string, unknown>;
  toll_micro_usdc: number;
}

interface QueuedJob {
  queued:  boolean;
  jobId:   string;
}

interface DirectSettlement {
  settlement?: { txnId: string };
  error?:      string;
}

// ── SSE client ─────────────────────────────────────────────────────────

async function waitForJobSSE(jobId: string, timeoutMs = 60_000): Promise<SseResult> {
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`SSE timeout: job ${jobId}`));
    }, timeoutMs);

    fetch(`${API_URL}/api/jobs/${jobId}/stream`, {
      headers: { Authorization: `Bearer ${PORTAL_SECRET}` },
      signal:  controller.signal,
    })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        clearTimeout(timer);
        reject(new Error(`SSE connect failed: HTTP ${res.status}`));
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf        = "";
      let eventType  = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ") && eventType) {
              try {
                const data = JSON.parse(line.slice(6)) as SseResult & { message?: string };
                if (eventType === "done") {
                  clearTimeout(timer);
                  reader.cancel().catch(() => {});
                  resolve(data);
                  return;
                }
                if (eventType === "error" || eventType === "timeout") {
                  clearTimeout(timer);
                  reader.cancel().catch(() => {});
                  reject(new Error(data.error ?? data.message ?? `SSE ${eventType}`));
                  return;
                }
              } catch { /* skip unparseable line */ }
              eventType = "";
            } else if (line === "") {
              eventType = "";
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) { clearTimeout(timer); reject(err); }
      }
    })
    .catch((err) => {
      if (!controller.signal.aborted) { clearTimeout(timer); reject(err); }
    });
  });
}

// ── Single payment ──────────────────────────────────────────────────────

async function makePayment(id: number): Promise<PaymentResult> {
  const city   = CITIES[id % CITIES.length];
  const tFire  = Date.now();

  // Step 1: x402 handshake — 402 bounce + payment proof + data
  let weatherBody: WeatherResponse;
  try {
    const res = await requestWithPayment(
      `${API_URL}/api/weather`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ city, senderAddress: SENDER }),
      },
      account.sk,
      SENDER,
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
      return { id, city, tFire, tProof: Date.now(), tEnqueue: Date.now(), tConfirm: Date.now(), status: "failed", error: `weather ${res.status}: ${err.error}` };
    }

    weatherBody = await res.json() as WeatherResponse;
  } catch (err) {
    const msg = err instanceof X402Error ? err.message : err instanceof Error ? err.message : String(err);
    return { id, city, tFire, tProof: Date.now(), tEnqueue: Date.now(), tConfirm: Date.now(), status: "failed", error: `handshake: ${msg}` };
  }

  const tProof = Date.now();

  // Step 2: Submit settlement (retry once on 503 circuit-open — clears within 60s)
  let execBody: QueuedJob | DirectSettlement;
  try {
    const doExec = () => fetch(`${API_URL}/api/execute`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${PORTAL_SECRET}`,
      },
      body: JSON.stringify({ sandboxExport: weatherBody.export, agentId: AGENT_ID }),
    });

    let execRes = await doExec();

    // Retry transient signing failures with backoff:
    //   502 = signing service briefly unavailable (cold start / hiccup)
    //   503 SIGNER_CIRCUIT_OPEN = circuit open; poll until it clears (max 65s)
    if (execRes.status === 502 || execRes.status === 503) {
      const errBody = await execRes.json().catch(() => ({})) as { error?: string };
      const isCircuitOpen = execRes.status === 503 && errBody.error === "SIGNER_CIRCUIT_OPEN";

      if (isCircuitOpen) {
        // Wait for the circuit cooldown to expire (up to 65s, polling every 5s)
        let cleared = false;
        for (let waited = 0; waited < 65; waited += 5) {
          await new Promise(r => setTimeout(r, 5_000));
          const probe = await fetch(`${API_URL}/health`);
          const h = await probe.json() as { circuit?: { open: boolean } };
          if (!h.circuit?.open) { cleared = true; break; }
        }
        if (cleared) execRes = await doExec();
      } else if (execRes.status === 502) {
        // Brief wait for signing service to recover
        await new Promise(r => setTimeout(r, 3_000));
        execRes = await doExec();
      }
    }

    execBody = await execRes.json() as QueuedJob | DirectSettlement;

    if (!execRes.ok) {
      return { id, city, tFire, tProof, tEnqueue: Date.now(), tConfirm: Date.now(), status: "failed", error: `execute ${execRes.status}: ${(execBody as { error?: string }).error ?? "unknown"}` };
    }
  } catch (err) {
    return { id, city, tFire, tProof, tEnqueue: Date.now(), tConfirm: Date.now(), status: "failed", error: `execute: ${err instanceof Error ? err.message : String(err)}` };
  }

  const tEnqueue = Date.now();

  // Step 3: Wait for on-chain confirmation via SSE
  if ((execBody as QueuedJob).queued) {
    const jobId = (execBody as QueuedJob).jobId;
    try {
      const result = await waitForJobSSE(jobId);
      return {
        id, city, tFire, tProof, tEnqueue,
        tConfirm: Date.now(),
        status:   result.status === "confirmed" ? "confirmed" : "failed",
        txnId:    result.txnId,
        error:    result.error,
      };
    } catch (err) {
      return { id, city, tFire, tProof, tEnqueue, tConfirm: Date.now(), status: "failed", error: `sse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Direct synchronous settlement path
  const direct = execBody as DirectSettlement;
  return {
    id, city, tFire, tProof, tEnqueue,
    tConfirm: Date.now(),
    status:   direct.settlement?.txnId ? "confirmed" : "failed",
    txnId:    direct.settlement?.txnId,
    error:    direct.error,
  };
}

// ── Metrics helpers ─────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function ms(n: number): string { return `${n.toFixed(0)}ms`; }
function s(n: number):  string { return `${(n / 1000).toFixed(2)}s`; }

function printProgress(r: PaymentResult, inFlight: number, done: number, tStart: number): void {
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  const handshake = r.tProof - r.tFire;
  const settle    = r.tConfirm - r.tEnqueue;
  const e2e       = r.tConfirm - r.tFire;
  const icon      = r.status === "confirmed" ? "✓" : "✗";
  const txShort   = r.txnId ? r.txnId.slice(0, 8) + "…" : (r.error ?? "failed");
  console.log(
    `  [+${elapsed.padStart(5)}s] #${String(r.id + 1).padStart(3)} ${icon} ` +
    `${r.city.padEnd(12)} ` +
    `handshake=${ms(handshake).padStart(7)}  settle=${ms(settle).padStart(7)}  e2e=${ms(e2e).padStart(7)}  ` +
    `in-flight=${inFlight}  ${txShort}`,
  );
}

function printSummary(results: PaymentResult[], tStart: number): void {
  const total    = results.length;
  const ok       = results.filter(r => r.status === "confirmed");
  const failed   = results.filter(r => r.status === "failed");
  const elapsed  = (Date.now() - tStart) / 1000;
  const tpm      = (ok.length / elapsed * 60).toFixed(1);

  const handshakes = ok.map(r => r.tProof   - r.tFire).sort((a, b) => a - b);
  const settles    = ok.map(r => r.tConfirm - r.tEnqueue).sort((a, b) => a - b);
  const e2es       = ok.map(r => r.tConfirm - r.tFire).sort((a, b) => a - b);

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  A2A BENCHMARK RESULTS                                               ║
╠══════════════════════════════════════════════════════════════════════╣
║  Duration    : ${s(elapsed * 1000).padEnd(10)}  Payments fired : ${String(total).padEnd(10)}          ║
║  Confirmed   : ${String(ok.length).padEnd(10)}  Failed         : ${String(failed.length).padEnd(10)}          ║
║  Throughput  : ${(tpm + " tx/min").padEnd(10)}  USDC spent     : $${(ok.length * TOLL_MICRO_USDC / 1_000_000).toFixed(2).padEnd(9)}        ║
╠══════════════════════════════════════════════════════════════════════╣
║  Latency                  p50           p95           p99            ║
╠══════════════════════════════════════════════════════════════════════╣
║  x402 handshake    ${ms(pct(handshakes, 50)).padStart(10)}  ${ms(pct(handshakes, 95)).padStart(10)}  ${ms(pct(handshakes, 99)).padStart(10)}        ║
║  Settlement        ${ms(pct(settles,    50)).padStart(10)}  ${ms(pct(settles,    95)).padStart(10)}  ${ms(pct(settles,    99)).padStart(10)}        ║
║  End-to-end        ${ms(pct(e2es,       50)).padStart(10)}  ${ms(pct(e2es,       95)).padStart(10)}  ${ms(pct(e2es,       99)).padStart(10)}        ║
╠══════════════════════════════════════════════════════════════════════╣`);

  if (failed.length > 0) {
    console.log("║  Failures:                                                           ║");
    failed.slice(0, 5).forEach(r =>
      console.log(`║    #${r.id + 1}: ${(r.error ?? "unknown").slice(0, 60).padEnd(62)}║`),
    );
  }
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
}

// ── Exponential interarrival (Poisson process) ──────────────────────────

function nextIntervalMs(): number {
  return -Math.log(1 - Math.random()) / LAMBDA * 1000;
}

// ── Pre-flight: check balance ────────────────────────────────────────────

async function checkBalance(): Promise<void> {
  const INDEXER = "https://mainnet-idx.4160.nodely.dev";
  const USDC_ID = 31566704;
  const res  = await fetch(`${INDEXER}/v2/accounts/${SENDER}`);
  const data = await res.json() as { account: { assets?: { "asset-id": number; amount: number }[] } };
  const usdc = data.account.assets?.find(a => a["asset-id"] === USDC_ID);
  const bal  = usdc?.amount ?? 0;

  console.log(`  Agent:   ${SENDER}`);
  console.log(`  USDC:    ${bal} µUSDC ($${(bal / 1_000_000).toFixed(4)})`);
  console.log(`  Budget:  ${BUDGET_MICRO_USDC} µUSDC (${MAX_PAYMENTS} payments × $${(TOLL_MICRO_USDC / 1_000_000).toFixed(2)})`);

  if (bal < BUDGET_MICRO_USDC) {
    console.error(`\n[ABORT] Insufficient USDC. Need ${BUDGET_MICRO_USDC} µUSDC, have ${bal} µUSDC.`);
    process.exit(1);
  }
  console.log(`  λ:       ${LAMBDA} payments/s  (avg interval ${(1000 / LAMBDA).toFixed(0)}ms)`);
  console.log(`  Bursts:  ${(BURST_PROB * 100).toFixed(0)}% chance, ${BURST_MIN}–${BURST_MAX_SIZE} payments per cluster\n`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  A2A PAYMENT BENCHMARK — Algorand Mainnet                            ║
╚══════════════════════════════════════════════════════════════════════╝
`);

  await checkBalance();

  const res = await fetch(`${API_URL}/health`);
  const health = await res.json() as { status: string; network: string };
  if (health.status !== "ok") { console.error("[ABORT] Server unhealthy"); process.exit(1); }
  console.log(`  Server: ${health.status} (${health.network})\n`);
  console.log("  Starting benchmark...\n");

  const tStart       = Date.now();
  const results:     PaymentResult[] = [];
  const promises:    Promise<void>[] = [];
  const inFlight     = new Set<number>();
  let paymentsFired  = 0;
  let peakConcurrency = 0;

  while (paymentsFired < MAX_PAYMENTS) {
    // Decide burst cluster or single payment
    const isBurst     = Math.random() < BURST_PROB;
    const clusterSize = isBurst
      ? BURST_MIN + Math.floor(Math.random() * (BURST_MAX_SIZE - BURST_MIN + 1))
      : 1;

    for (let i = 0; i < clusterSize && paymentsFired < MAX_PAYMENTS; i++) {
      const id = paymentsFired++;
      inFlight.add(id);
      peakConcurrency = Math.max(peakConcurrency, inFlight.size);

      const p = makePayment(id).then((result) => {
        inFlight.delete(id);
        results.push(result);
        printProgress(result, inFlight.size, results.length, tStart);
      });
      promises.push(p);

      // Small gap between payments within a burst
      if (isBurst && i < clusterSize - 1) {
        await new Promise(r => setTimeout(r, BURST_GAP_MS + Math.random() * 80));
      }
    }

    if (paymentsFired >= MAX_PAYMENTS) break;

    // Exponential interarrival to next cluster
    await new Promise(r => setTimeout(r, nextIntervalMs()));
  }

  // Wait for all in-flight settlements to confirm
  console.log(`\n  All ${MAX_PAYMENTS} payments fired. Waiting for settlements...\n`);
  await Promise.all(promises);

  const confirmedCount = results.filter(r => r.status === "confirmed").length;
  const peakConc       = peakConcurrency;
  console.log(`\n  Peak concurrency: ${peakConc} in-flight settlements`);

  printSummary(results, tStart);

  // Print explorer links for first 3 confirmed payments
  const confirmed = results.filter(r => r.txnId).slice(0, 3);
  if (confirmed.length) {
    console.log("\n  Sample transactions:");
    confirmed.forEach(r =>
      console.log(`    #${r.id + 1}: ${EXPLORER_BASE}/${r.txnId}`),
    );
  }

  // POST results to /api/admin/benchmark/record so /api/benchmark stays current
  if (PORTAL_SECRET) {
    const okResults  = results.filter(r => r.status === "confirmed");
    const handshakes = okResults.map(r => r.tProof   - r.tFire).sort((a, b) => a - b);
    const settles    = okResults.map(r => r.tConfirm - r.tEnqueue).sort((a, b) => a - b);
    const e2es       = okResults.map(r => r.tConfirm - r.tFire).sort((a, b) => a - b);
    const payload = {
      network:       "algorand-mainnet",
      runDate:       new Date().toISOString(),
      durationMs:    Date.now() - tStart,
      total:         results.length,
      confirmed:     okResults.length,
      failed:        results.length - okResults.length,
      successRate:   okResults.length / results.length,
      throughputTpm: parseFloat((okResults.length / ((Date.now() - tStart) / 1000) * 60).toFixed(1)),
      peakConcurrency: peakConc,
      usdcSpent:     (okResults.length * TOLL_MICRO_USDC / 1_000_000).toFixed(2),
      latency: {
        handshake: { p50: pct(handshakes, 50), p95: pct(handshakes, 95), p99: pct(handshakes, 99) },
        settlement: { p50: pct(settles, 50),   p95: pct(settles, 95),   p99: pct(settles, 99) },
        e2e:        { p50: pct(e2es, 50),       p95: pct(e2es, 95),       p99: pct(e2es, 99) },
      },
      sampleTxns: confirmed.map(r => ({ id: r.id + 1, txnId: r.txnId, explorerUrl: `${EXPLORER_BASE}/${r.txnId}` })),
    };
    try {
      const r = await fetch(`${API_URL}/api/admin/benchmark/record`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PORTAL_SECRET}` },
        body:    JSON.stringify(payload),
      });
      if (r.ok) console.log("\n  Results saved to /api/benchmark");
    } catch { /* non-fatal */ }
  }
}

main().catch(err => {
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
