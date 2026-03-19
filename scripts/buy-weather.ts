/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BUY-WEATHER — Sprint 16 End-to-End x402 Payment Test           ║
 * ║                                                                  ║
 * ║  Demonstrates a complete x402 payment cycle:                     ║
 * ║    1. Agent requests weather data                                ║
 * ║    2. Server bounces with 402 (payment required)                 ║
 * ║    3. Client builds payment proof, retries with X-PAYMENT        ║
 * ║    4. Server delivers weather data + unsigned payment sandbox     ║
 * ║    5. Client forwards sandbox to /api/execute                    ║
 * ║    6. Server signer signs + broadcasts USDC transfer on-chain    ║
 * ║    7. Payment confirmed — txnId logged + verified on explorer    ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    npx tsx scripts/buy-weather.ts                                ║
 * ║    CITY=London npx tsx scripts/buy-weather.ts                    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { requestWithPayment, X402Error } from "@algo-wallet/x402-client";
import "dotenv/config";

// ── Environment ────────────────────────────────────────────────

const API_URL      = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const MNEMONIC     = process.env.ALGO_MNEMONIC;
const PORTAL_SECRET = process.env.PORTAL_API_SECRET;
const AGENT_ID     = process.env.AGENT_ID;
const CITY         = process.env.CITY ?? "Lagos";
const EXPLORER_BASE = "https://explorer.perawallet.app/tx";

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC is required.");
  process.exit(1);
}
if (!PORTAL_SECRET || !AGENT_ID) {
  console.error("[FATAL] PORTAL_API_SECRET and AGENT_ID are required for /api/execute.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const SENDER  = account.addr.toString();

// ── Banner ─────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  BUY-WEATHER — Sprint 16 x402 End-to-End Test                   ║
╠══════════════════════════════════════════════════════════════════╣
║  Target:   ${API_URL.padEnd(50)}║
║  Agent:    ${SENDER.slice(0, 12)}...${SENDER.slice(-6)}                           ║
║  City:     ${CITY.padEnd(50)}║
║  Network:  Algorand mainnet                                     ║
║  Toll:     ${String(10_000).padEnd(50)}micro-USDC ($0.01)       ║
╚══════════════════════════════════════════════════════════════════╝
`);

// ── Step 1: Health Check ───────────────────────────────────────

async function healthCheck(): Promise<void> {
  console.log(`[BUY-WEATHER] Step 1/4: Health check → GET ${API_URL}/health`);
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

// ── Step 2+3: x402 Handshake + Weather Fetch ──────────────────

interface WeatherResponse {
  weather: {
    city:           string;
    country:        string;
    temperature_c:  number;
    wind_speed_kmh: number;
    weather_code:   number;
    timestamp:      string;
  };
  export: Record<string, unknown>;
  toll_micro_usdc: number;
  status: string;
}

async function fetchWeather(): Promise<WeatherResponse> {
  const url = `${API_URL}/api/weather`;

  console.log(`[BUY-WEATHER] Step 2/4: x402 handshake → POST /api/weather`);
  console.log(`[BUY-WEATHER]   City: ${CITY}`);
  console.log(`[BUY-WEATHER]   Sending request without X-PAYMENT (expecting 402 bounce)...`);

  const response = await requestWithPayment(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: CITY, senderAddress: SENDER }),
    },
    account.sk,
    SENDER,
  );

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: response.statusText })) as Record<string, string>;
    console.error(`[BUY-WEATHER] ABORT — Weather endpoint failed (${response.status}): ${errBody.error ?? "unknown"}`);
    process.exit(1);
  }

  const body = await response.json() as WeatherResponse;
  console.log(`[BUY-WEATHER]   ✓ 402 absorbed — payment proof accepted.`);
  console.log(`[BUY-WEATHER]   ✓ Weather data received.\n`);
  return body;
}

// ── Step 4: Settlement ─────────────────────────────────────────

interface SettlementResult {
  settlement?: {
    txnId:          string;
    confirmedRound: number;
    groupId:        string;
    txnCount:       number;
    settledAt:      string;
  };
  agentId?: string;
  failedStage?: string;
  error?: string;
}

async function settle(sandboxExport: Record<string, unknown>): Promise<SettlementResult> {
  console.log(`[BUY-WEATHER] Step 3/4: Settlement → POST /api/execute`);
  console.log(`[BUY-WEATHER]   agentId: ${AGENT_ID}`);
  console.log(`[BUY-WEATHER]   Forwarding sandbox to signer pipeline...`);

  const res = await fetch(`${API_URL}/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${PORTAL_SECRET}`,
    },
    body: JSON.stringify({ sandboxExport, agentId: AGENT_ID }),
  });

  return res.json() as Promise<SettlementResult>;
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await healthCheck();

    const { weather, export: sandbox, toll_micro_usdc } = await fetchWeather();

    const result = await settle(sandbox);

    console.log();
    if (result.settlement?.txnId) {
      const explorerUrl = `${EXPLORER_BASE}/${result.settlement.txnId}`;

      console.log(`[BUY-WEATHER] Step 4/4: COMPLETE`);
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
      console.log(`[BUY-WEATHER]      Txn ID      : ${result.settlement.txnId}`);
      console.log(`[BUY-WEATHER]      Round       : ${result.settlement.confirmedRound}`);
      console.log(`[BUY-WEATHER]      Settled At  : ${result.settlement.settledAt}`);
      console.log(`[BUY-WEATHER]      Agent       : ${result.agentId}`);
      console.log();
      console.log(`[BUY-WEATHER]   Verify on-chain:`);
      console.log(`[BUY-WEATHER]   ${explorerUrl}`);
      console.log();
      console.log(`[BUY-WEATHER]   ✓ x402 end-to-end test PASSED.`);
    } else {
      console.error(`[BUY-WEATHER] Step 4/4: SETTLEMENT FAILED`);
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
