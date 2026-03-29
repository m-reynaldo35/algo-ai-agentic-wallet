/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BUY-WEATHER — x402 Atomic Payment End-to-End Test              ║
 * ║                                                                  ║
 * ║  Demonstrates atomic payment-then-deliver:                       ║
 * ║    1. Agent requests weather data                                ║
 * ║    2. Server bounces with 402 (payment required)                 ║
 * ║    3. Client builds payment proof, retries with X-PAYMENT        ║
 * ║    4. Server settles USDC toll inline (sign → enqueue)           ║
 * ║    5. Weather data returned — payment already committed          ║
 * ║    6. Client polls job to get confirmed on-chain txnId           ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    npx tsx scripts/buy-weather.ts                                ║
 * ║    CITY=London npx tsx scripts/buy-weather.ts                    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { AlgoAgentClient, X402Error } from "@algo-wallet/x402-client";
import "dotenv/config";

// ── Environment ────────────────────────────────────────────────

const API_URL        = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const MNEMONIC       = process.env.ALGO_MNEMONIC;
const PORTAL_SECRET  = process.env.PORTAL_API_SECRET;
const CITY           = process.env.CITY ?? "Lagos";
const EXPLORER_BASE  = "https://explorer.perawallet.app/tx";
const MANDATE_APP_ID = parseInt(process.env.MANDATE_APP_ID ?? "0", 10);

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC is required.");
  process.exit(1);
}
if (!PORTAL_SECRET) {
  console.error("[FATAL] PORTAL_API_SECRET is required to poll job status.");
  process.exit(1);
}
if (!MANDATE_APP_ID) {
  console.error("[FATAL] MANDATE_APP_ID is required — set the MandateContract app ID.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const SENDER  = account.addr.toString();

const client = new AlgoAgentClient({ baseUrl: API_URL, privateKey: account.sk, mandateAppId: MANDATE_APP_ID });

// ── Banner ─────────────────────────────────────────────────────

const W = 68;
function row(label: string, value: string): string {
  const content = `  ${label.padEnd(10)}${value}`;
  return `║${content.padEnd(W - 2)}║`;
}

console.log(`
╔${"═".repeat(W - 2)}╗
║${"  BUY-WEATHER — x402 Atomic Payment Test".padEnd(W - 2)}║
╠${"═".repeat(W - 2)}╣
${row("Target:", API_URL)}
${row("Agent:", `${SENDER.slice(0, 12)}...${SENDER.slice(-6)}`)}
${row("City:", CITY)}
${row("Network:", "Algorand mainnet")}
${row("Toll:", "10,000 micro-USDC ($0.01)")}
╚${"═".repeat(W - 2)}╝
`);

// ── Step 1: Health Check ───────────────────────────────────────

async function healthCheck(): Promise<void> {
  console.log(`[BUY-WEATHER] Step 1/3: Health check → GET ${API_URL}/health`);
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) {
    console.error(`[BUY-WEATHER] ABORT — Health returned ${res.status}`);
    process.exit(1);
  }
  const body = await res.json() as { status: string; network: string };
  console.log(`[BUY-WEATHER]   Status:  ${body.status}`);
  console.log(`[BUY-WEATHER]   Network: ${body.network}`);
  if (body.status !== "ok") {
    console.error(`[BUY-WEATHER] ABORT — Server not healthy.`);
    process.exit(1);
  }
  console.log(`[BUY-WEATHER]   ✓ Server is live.\n`);
}

// ── Step 2: x402 Handshake + Atomic Payment + Weather ─────────

interface WeatherResponse {
  weather: {
    city:           string;
    country:        string;
    temperature_c:  number;
    wind_speed_kmh: number;
    weather_code:   number;
    timestamp:      string;
  };
  status:          string;
  jobId:           string;
  agentId:         string;
  toll_micro_usdc: number;
  pollUrl:         string;
}

async function buyWeather(): Promise<WeatherResponse> {
  console.log(`[BUY-WEATHER] Step 2/3: x402 handshake + atomic payment → POST /api/weather`);
  console.log(`[BUY-WEATHER]   City: ${CITY}`);
  console.log(`[BUY-WEATHER]   Sending request without X-PAYMENT (expecting 402 bounce)...`);

  const response = await client.fetch("/api/weather", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ city: CITY }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: response.statusText })) as Record<string, string>;
    console.error(`[BUY-WEATHER] ABORT — Weather endpoint failed (${response.status}): ${errBody.error ?? "unknown"}`);
    process.exit(1);
  }

  const body = await response.json() as WeatherResponse;
  console.log(`[BUY-WEATHER]   ✓ 402 absorbed — payment proof accepted.`);
  console.log(`[BUY-WEATHER]   ✓ USDC toll committed on server (jobId: ${body.jobId}).`);
  console.log(`[BUY-WEATHER]   ✓ Weather data received.\n`);
  return body;
}

// ── Step 3: Poll for on-chain confirmation ─────────────────────

interface JobStatus {
  jobId:           string;
  status:          "queued" | "processing" | "confirmed" | "failed";
  agentId:         string;
  sandboxId:       string;
  txnId?:          string;
  confirmedRound?: number;
  groupId?:        string;
  txnCount?:       number;
  settledAt?:      string;
  error?:          string;
  failedStage?:    string;
}

async function pollJob(jobId: string, maxWaitMs = 30_000): Promise<JobStatus> {
  console.log(`[BUY-WEATHER] Step 3/3: Polling for on-chain confirmation...`);
  process.stdout.write(`[BUY-WEATHER]   Waiting`);

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const res = await fetch(`${API_URL}/api/jobs/${jobId}`, {
      headers: { "Authorization": `Bearer ${PORTAL_SECRET}` },
    });
    const job = await res.json() as JobStatus;
    process.stdout.write(".");
    if (job.status === "confirmed" || job.status === "failed") {
      process.stdout.write("\n");
      return job;
    }
  }
  throw new Error(`Job ${jobId} did not complete within ${maxWaitMs}ms`);
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await healthCheck();

    const { weather, jobId, agentId, toll_micro_usdc } = await buyWeather();

    const result = await pollJob(jobId);

    console.log();
    if (result.status === "confirmed" && result.txnId) {
      const explorerUrl = `${EXPLORER_BASE}/${result.txnId}`;

      console.log(`[BUY-WEATHER] COMPLETE`);
      console.log(`[BUY-WEATHER] ════════════════════════════════════════════════════`);
      console.log(`[BUY-WEATHER]   WEATHER DELIVERED + PAYMENT CONFIRMED ON ALGORAND`);
      console.log(`[BUY-WEATHER] ════════════════════════════════════════════════════`);
      console.log();
      console.log(`[BUY-WEATHER]   ☁  Weather — ${weather.city}, ${weather.country}`);
      console.log(`[BUY-WEATHER]      Temperature : ${weather.temperature_c}°C`);
      console.log(`[BUY-WEATHER]      Wind Speed  : ${weather.wind_speed_kmh} km/h`);
      console.log(`[BUY-WEATHER]      Weather Code: ${weather.weather_code}`);
      console.log(`[BUY-WEATHER]      Retrieved   : ${weather.timestamp}`);
      console.log();
      console.log(`[BUY-WEATHER]   💳 Payment`);
      console.log(`[BUY-WEATHER]      Toll        : ${toll_micro_usdc} micro-USDC ($${(toll_micro_usdc / 1_000_000).toFixed(4)})`);
      console.log(`[BUY-WEATHER]      Txn ID      : ${result.txnId}`);
      console.log(`[BUY-WEATHER]      Round       : ${result.confirmedRound ?? "—"}`);
      console.log(`[BUY-WEATHER]      Settled At  : ${result.settledAt ?? "—"}`);
      console.log(`[BUY-WEATHER]      Agent       : ${agentId}`);
      console.log();
      console.log(`[BUY-WEATHER]   Verify on-chain:`);
      console.log(`[BUY-WEATHER]   ${explorerUrl}`);
      console.log();
      console.log(`[BUY-WEATHER]   ✓ x402 atomic payment test PASSED.`);
    } else {
      console.error(`[BUY-WEATHER] SETTLEMENT FAILED`);
      console.error(`[BUY-WEATHER]   Stage: ${result.failedStage ?? "unknown"}`);
      console.error(`[BUY-WEATHER]   Error: ${result.error ?? JSON.stringify(result)}`);
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof X402Error) {
      console.error(`\n[BUY-WEATHER] x402 PROTOCOL ERROR: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`\n[BUY-WEATHER] ERROR: ${err.message}`);
    } else {
      console.error(`\n[BUY-WEATHER] UNEXPECTED ERROR:`, err);
    }
    process.exit(1);
  }
}

main();
