/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MANDATE BURST TEST — Optimistic Broadcast Concurrency Proof    ║
 * ║                                                                  ║
 * ║  Fires N POST /api/weather requests through the new optimistic   ║
 * ║  broadcast path and measures:                                   ║
 * ║    • Enqueue latency: time from fire to 200 OK response         ║
 * ║    • Confirm latency: time from fire to on-chain confirmation   ║
 * ║    • Wall time for all N requests (sequential or concurrent)    ║
 * ║                                                                  ║
 * ║  Two modes (same agent):                                        ║
 * ║    --sequential  Each request fires after previous 200 OK       ║
 * ║                  Proves lock held for broadcast only (~200ms)   ║
 * ║                  Old: N × 7s   New: N × 200ms                  ║
 * ║    --concurrent  All N fire at once (default)                   ║
 * ║                  4/5 will 429 (lock working) — demonstrates     ║
 * ║                  200ms lock window vs 30s old TTL               ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    npx tsx scripts/mandate-burst-test.ts --sequential           ║
 * ║    BURST_SIZE=5 npx tsx scripts/mandate-burst-test.ts           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { AlgoAgentClient } from "@algo-wallet/x402-client";
import "dotenv/config";

// ── Config ─────────────────────────────────────────────────────────

const API_URL       = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const MNEMONIC      = process.env.ALGO_MNEMONIC;
const PORTAL_SECRET = process.env.PORTAL_API_SECRET;
const MANDATE_APP_ID = parseInt(process.env.MANDATE_APP_ID ?? "0", 10);
const BURST_SIZE    = parseInt(process.env.BURST_SIZE ?? "5", 10);
const SEQUENTIAL    = process.argv.includes("--sequential");
const CITY          = process.env.CITY ?? "Lagos";
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS  = 60_000;

// ── ANSI helpers ───────────────────────────────────────────────────
const R  = "\x1b[0m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const C  = "\x1b[36m";
const D  = "\x1b[2m";
const RE = "\x1b[31m";

const ts   = () => `${D}${new Date().toISOString().slice(11, 23)}${R}`;
const ok   = (m: string) => console.log(`  ${ts()} ${G}✔${R} ${m}`);
const fail = (m: string) => console.log(`  ${ts()} ${RE}✗${R} ${m}`);
const info = (m: string) => console.log(`  ${ts()} ${D}  ${m}${R}`);
const sep  = (label: string) => {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
};

// ── Validation ─────────────────────────────────────────────────────

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC is required.");
  process.exit(1);
}
if (!PORTAL_SECRET) {
  console.error("[FATAL] PORTAL_API_SECRET is required.");
  process.exit(1);
}
if (!MANDATE_APP_ID) {
  console.error("[FATAL] MANDATE_APP_ID is required.");
  process.exit(1);
}

// ── Percentile helper ──────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Types ──────────────────────────────────────────────────────────

interface SlotResult {
  slot:         number;
  enqueueMs:    number;
  confirmMs:    number;
  httpStatus:   number;
  jobId:        string;
  txnId:        string;
  confirmedRound?: number;
  status:       "confirmed" | "failed" | "timeout" | "error";
  error?:       string;
}

interface JobStatus {
  jobId:           string;
  status:          "queued" | "broadcasting" | "confirmed" | "failed";
  txnId?:          string;
  confirmedRound?: number;
  settledAt?:      string;
  error?:          string;
}

// ── Single slot: fire payment request, return jobId + enqueue time ─

async function fireSlot(
  client:    AlgoAgentClient,
  slot:      number,
): Promise<{ slot: number; enqueueMs: number; httpStatus: number; jobId: string; error?: string }> {
  const t0 = Date.now();
  try {
    const response = await client.fetch("/api/weather", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ city: CITY }),
    });

    const enqueueMs  = Date.now() - t0;
    const httpStatus = response.status;

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, string>;
      return { slot, enqueueMs, httpStatus, jobId: "", error: body.error ?? `HTTP ${httpStatus}` };
    }

    const body   = await response.json() as { jobId?: string; status?: string };
    const jobId  = body.jobId ?? "";
    return { slot, enqueueMs, httpStatus, jobId };

  } catch (err) {
    return {
      slot,
      enqueueMs:  Date.now() - t0,
      httpStatus: 0,
      jobId:      "",
      error:      err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Poll job to confirmed/failed ───────────────────────────────────

async function pollJob(
  jobId:   string,
  startMs: number,
): Promise<{ status: SlotResult["status"]; confirmMs: number; txnId: string; confirmedRound?: number }> {
  if (!jobId) {
    return { status: "error", confirmMs: Date.now() - startMs, txnId: "" };
  }

  const deadline = startMs + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${API_URL}/api/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${PORTAL_SECRET}` },
      });
      if (!res.ok) continue;
      const job = await res.json() as JobStatus;
      if (job.status === "confirmed") {
        return {
          status:         "confirmed",
          confirmMs:      Date.now() - startMs,
          txnId:          job.txnId ?? "",
          confirmedRound: job.confirmedRound,
        };
      }
      if (job.status === "failed") {
        return { status: "failed", confirmMs: Date.now() - startMs, txnId: job.txnId ?? "" };
      }
    } catch { /* retry */ }
  }
  return { status: "timeout", confirmMs: POLL_TIMEOUT_MS, txnId: "" };
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const account = algosdk.mnemonicToSecretKey(MNEMONIC!);
  const sender  = account.addr.toString();

  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}MANDATE BURST TEST — Optimistic Broadcast${R}`);
  console.log(`${C}${"═".repeat(68)}${R}`);
  console.log(`  ${D}Target:       ${API_URL}${R}`);
  console.log(`  ${D}Agent:        ${sender.slice(0, 12)}...${sender.slice(-6)}${R}`);
  console.log(`  ${D}Mandate App:  ${MANDATE_APP_ID}${R}`);
  console.log(`  ${D}Burst Size:   ${BURST_SIZE} requests (${SEQUENTIAL ? "sequential" : "concurrent"})${R}`);
  console.log(`  ${D}City:         ${CITY}${R}`);
  console.log(`${C}${"═".repeat(68)}${R}\n`);

  // ── Health check ───────────────────────────────────────────────
  sep("PRE-FLIGHT");
  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    fail(`Server unhealthy: HTTP ${health.status}`);
    process.exit(1);
  }
  const healthBody = await health.json() as { status: string; network: string };
  ok(`Server: ${healthBody.status} on ${healthBody.network}`);

  // Single client — same signing key for all slots
  const client = new AlgoAgentClient({
    baseUrl:      API_URL,
    privateKey:   account.sk,
    mandateAppId: MANDATE_APP_ID,
  });

  // ── Phase 1: Fire N payments (sequential or concurrent) ───────
  const modeLabel = SEQUENTIAL ? "SEQUENTIAL" : "CONCURRENT";
  sep(`PHASE 1 — FIRING ${BURST_SIZE} ${modeLabel} PAYMENTS`);

  if (SEQUENTIAL) {
    info(`Each request fires immediately after the previous 200 OK.`);
    info(`Key metric: total wall time ≈ N × enqueue latency.`);
    info(`Old design: N × ~7000ms.  New design: N × ~200ms.`);
  } else {
    info(`All ${BURST_SIZE} requests fired at the same instant.`);
    info(`Per-agent lock: only 1 wins; others 429 (expected — lock held ~200ms).`);
  }
  console.log();

  let fireStart: number;
  let fireResults: Awaited<ReturnType<typeof fireSlot>>[];
  let wallEnqueueMs: number;

  if (SEQUENTIAL) {
    fireStart = Date.now();
    fireResults = [];
    for (let i = 1; i <= BURST_SIZE; i++) {
      const result = await fireSlot(client, i);
      fireResults.push(result);
      if (result.error) {
        fail(`Slot ${result.slot}: HTTP ${result.httpStatus} in ${result.enqueueMs}ms — ${result.error}`);
      } else {
        ok(`Slot ${result.slot}: HTTP ${result.httpStatus} in ${result.enqueueMs}ms — jobId: ${result.jobId.slice(0, 12)}...`);
      }
    }
    wallEnqueueMs = Date.now() - fireStart;
  } else {
    fireStart = Date.now();
    const firePromises = Array.from({ length: BURST_SIZE }, (_, i) => fireSlot(client, i + 1));
    fireResults = await Promise.all(firePromises);
    wallEnqueueMs = Date.now() - fireStart;

    for (const r of fireResults) {
      if (r.error) {
        fail(`Slot ${r.slot}: HTTP ${r.httpStatus} in ${r.enqueueMs}ms — ${r.error}`);
      } else {
        ok(`Slot ${r.slot}: HTTP ${r.httpStatus} in ${r.enqueueMs}ms — jobId: ${r.jobId.slice(0, 12)}...`);
      }
    }
  }

  for (const r of fireResults) {
    if (r.error) {
      fail(`Slot ${r.slot}: HTTP ${r.httpStatus} in ${r.enqueueMs}ms — ${r.error}`);
    } else {
      ok(`Slot ${r.slot}: HTTP ${r.httpStatus} in ${r.enqueueMs}ms — jobId: ${r.jobId.slice(0, 12)}...`);
    }
  }

  const successFires = fireResults.filter((r) => !r.error && r.jobId);
  const failedFires  = fireResults.filter((r) => r.error || !r.jobId);

  console.log();
  info(`Wall time for all ${BURST_SIZE} responses: ${wallEnqueueMs}ms`);
  info(`Success: ${successFires.length}/${BURST_SIZE} got job IDs`);
  if (failedFires.length > 0) {
    for (const f of failedFires) {
      fail(`Slot ${f.slot} failed at enqueue: ${f.error}`);
    }
  }

  if (successFires.length === 0) {
    fail("No successful fires — aborting.");
    process.exit(1);
  }

  // ── Phase 2: Poll all jobs to confirmation ─────────────────────
  sep("PHASE 2 — POLLING FOR ON-CHAIN CONFIRMATION");
  info(`Polling ${successFires.length} jobs (interval: ${POLL_INTERVAL_MS}ms, timeout: ${POLL_TIMEOUT_MS / 1000}s)`);
  process.stdout.write("  Waiting");

  const confirmStart = Date.now();
  const pollPromises = successFires.map(async (fire) => {
    const result = await pollJob(fire.jobId, fire.enqueueMs > 0 ? confirmStart - fire.enqueueMs : confirmStart);
    process.stdout.write(".");
    const slotResult: SlotResult = {
      slot:           fire.slot,
      enqueueMs:      fire.enqueueMs,
      confirmMs:      result.confirmMs,
      httpStatus:     fire.httpStatus,
      jobId:          fire.jobId,
      txnId:          result.txnId,
      confirmedRound: result.confirmedRound,
      status:         result.status,
    };
    return slotResult;
  });

  const slotResults = await Promise.all(pollPromises);
  process.stdout.write("\n\n");

  // ── Phase 3: Results ───────────────────────────────────────────
  sep("RESULTS");

  const confirmed = slotResults.filter((r) => r.status === "confirmed");
  const failed    = slotResults.filter((r) => r.status !== "confirmed");

  const enqueueTimes = fireResults.map((r) => r.enqueueMs).sort((a, b) => a - b);
  const confirmTimes = confirmed.map((r) => r.confirmMs).sort((a, b) => a - b);

  // Per-slot table
  const colPad = (s: string | number, w: number) => String(s).padStart(w);
  console.log(`  ${C}${"Slot".padEnd(5)}  ${"HTTP".padStart(4)}  ${"Enqueue".padStart(9)}  ${"Confirm".padStart(9)}  ${"Status".padEnd(9)}  ${"TxID"}${R}`);
  console.log(`  ${"─".repeat(70)}`);

  for (const r of slotResults) {
    const statusColor = r.status === "confirmed" ? G : RE;
    const txShort = r.txnId ? `${r.txnId.slice(0, 12)}...` : "—";
    console.log(
      `  ${colPad(r.slot, 5)}` +
      `  ${colPad(r.httpStatus, 4)}` +
      `  ${colPad(r.enqueueMs + "ms", 9)}` +
      `  ${colPad(r.confirmMs + "ms", 9)}` +
      `  ${statusColor}${r.status.padEnd(9)}${R}` +
      `  ${D}${txShort}${R}`
    );
  }

  console.log(`  ${"─".repeat(70)}`);
  console.log();

  // Latency stats
  console.log(`  ${C}Enqueue Latency (time to 200 OK):${R}`);
  console.log(`    p50:  ${pct(enqueueTimes, 50)}ms`);
  console.log(`    p95:  ${pct(enqueueTimes, 95)}ms`);
  console.log(`    p99:  ${pct(enqueueTimes, 99)}ms`);
  console.log(`    wall: ${wallEnqueueMs}ms  (all ${BURST_SIZE} responses received)`);
  console.log();

  if (confirmTimes.length > 0) {
    console.log(`  ${C}Confirm Latency (time to on-chain confirmation):${R}`);
    console.log(`    p50:  ${pct(confirmTimes, 50)}ms`);
    console.log(`    p95:  ${pct(confirmTimes, 95)}ms`);
    console.log(`    p99:  ${pct(confirmTimes, 99)}ms`);
    console.log(`    min:  ${confirmTimes[0]}ms`);
    console.log(`    max:  ${confirmTimes[confirmTimes.length - 1]}ms`);
    console.log();
  }

  console.log(`  ${C}Throughput:${R}`);
  console.log(`    ${BURST_SIZE} payments received responses in ${wallEnqueueMs}ms`);
  console.log(`    Avg enqueue rate: ${(BURST_SIZE / (wallEnqueueMs / 1000)).toFixed(1)} payments/sec`);
  console.log();

  // Comparison note
  console.log(`  ${D}Old sync-confirm baseline: ${BURST_SIZE} × 7000ms = ~${BURST_SIZE * 7}s wall time${R}`);
  console.log(`  ${D}New optimistic broadcast:  ${wallEnqueueMs}ms wall time  (${Math.round(BURST_SIZE * 7000 / wallEnqueueMs)}× faster)${R}`);
  console.log();

  // Summary
  sep("SUMMARY");
  if (confirmed.length === BURST_SIZE) {
    ok(`${confirmed.length}/${BURST_SIZE} payments CONFIRMED on-chain.`);
    ok(`Optimistic broadcast test PASSED.`);
    console.log();
    for (const r of confirmed) {
      const explorerUrl = `https://explorer.perawallet.app/tx/${r.txnId}`;
      console.log(`  ${D}Slot ${r.slot}:  ${explorerUrl}${R}`);
    }
  } else {
    console.log(`  ${G}${confirmed.length}/${BURST_SIZE} confirmed.${R}`);
    if (failed.length > 0) {
      console.log(`  ${RE}${failed.length} failed/timeout:${R}`);
      for (const f of failed) {
        console.log(`    Slot ${f.slot}: ${f.status}${f.error ? ` — ${f.error}` : ""}`);
      }
    }
    if (confirmed.length < BURST_SIZE) {
      process.exit(1);
    }
  }

  console.log();
}

main().catch((err) => {
  console.error("\n[BURST] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
