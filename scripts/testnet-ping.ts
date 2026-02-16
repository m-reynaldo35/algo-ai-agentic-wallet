/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  TESTNET PING — Live x402 Infrastructure Verification           ║
 * ║                                                                  ║
 * ║  Executes a real x402 handshake against the live Vercel          ║
 * ║  deployment using Algorand Testnet USDC.                         ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    LIVE_API_URL=https://your-project.vercel.app \                ║
 * ║    ALGO_MNEMONIC="your 25-word testnet mnemonic" \               ║
 * ║    npx tsx scripts/testnet-ping.ts                               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import {
  AlgoAgentClient,
  X402Error,
  type TradeResult,
  type SettlementResult,
} from "@m-reynaldo35/x402-client";

// ── Environment ────────────────────────────────────────────────

const LIVE_API_URL = process.env.LIVE_API_URL;
const MNEMONIC = process.env.ALGO_MNEMONIC;

if (!LIVE_API_URL) {
  console.error("[FATAL] LIVE_API_URL is required.");
  console.error("        Example: LIVE_API_URL=https://your-project.vercel.app");
  process.exit(1);
}

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC is required.");
  console.error("        Export your 25-word Algorand Testnet mnemonic.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const SENDER = account.addr.toString();
const EXPLORER_BASE = "https://testnet.explorer.perawallet.app/tx";

// ── Preflight ──────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  x402 TESTNET PING                                              ║
╠══════════════════════════════════════════════════════════════════╣
║  Target:   ${LIVE_API_URL.padEnd(50)}║
║  Sender:   ${SENDER.slice(0, 12)}...${SENDER.slice(-6)}                           ║
║  Network:  Algorand Testnet                                     ║
║  Toll:     100,000 micro-USDC ($0.10)                           ║
╚══════════════════════════════════════════════════════════════════╝
`);

// ── Type Guard ─────────────────────────────────────────────────

function isSuccess(result: TradeResult): result is SettlementResult {
  return "success" in result && result.success === true;
}

// ── Health Check ───────────────────────────────────────────────

async function healthCheck(): Promise<void> {
  console.log(`[PING] Step 1/4: Health check → GET ${LIVE_API_URL}/health`);

  const res = await fetch(`${LIVE_API_URL}/health`);

  if (!res.ok) {
    console.error(`[PING] ABORT — Health endpoint returned ${res.status}`);
    console.error(`[PING] Is the Vercel deployment live? Check the URL and redeploy.`);
    process.exit(1);
  }

  const body = await res.json();
  console.log(`[PING]   Status:   ${body.status}`);
  console.log(`[PING]   Protocol: ${body.protocol}`);
  console.log(`[PING]   Network:  ${body.network}`);

  if (body.status !== "ok") {
    console.error(`[PING] ABORT — Server health is not "ok".`);
    process.exit(1);
  }

  console.log(`[PING]   ✓ Server is live.\n`);
}

// ── x402 Handshake + Settlement ────────────────────────────────

async function executePing(): Promise<void> {
  const client = new AlgoAgentClient({
    baseUrl: LIVE_API_URL!,
    privateKey: account.sk,
    slippageBips: 50,
  });

  // ── Step 2: x402 Handshake ────────────────────────────────
  console.log(`[PING] Step 2/4: x402 handshake → POST /api/agent-action`);
  console.log(`[PING]   Sending request without X-PAYMENT (expecting 402 bounce)...`);

  const sandboxResponse = await client.requestSandboxExport({
    senderAddress: SENDER,
    amount: 100_000, // $0.10 USDC toll
  });

  const { export: sandbox } = sandboxResponse;

  console.log(`[PING]   ✓ Handshake complete.`);
  console.log(`[PING]   Sandbox:  ${sandbox.sandboxId}`);
  console.log(`[PING]   Group:    ${sandbox.atomicGroup.groupId.slice(0, 20)}...`);
  console.log(`[PING]   Txns:     ${sandbox.atomicGroup.txnCount}`);
  for (const line of sandbox.atomicGroup.manifest) {
    console.log(`[PING]     ${line}`);
  }
  console.log();

  // ── Step 3: Settlement Pipeline ───────────────────────────
  console.log(`[PING] Step 3/4: Settlement → POST /api/execute`);
  console.log(`[PING]   Forwarding to pipeline: Validate → Auth → Sign → Broadcast...`);

  const result = await client.settle(sandboxResponse);

  // ── Step 4: Verification ──────────────────────────────────
  console.log();
  if (isSuccess(result)) {
    const explorerUrl = `${EXPLORER_BASE}/${result.settlement.txnId}`;

    console.log(`[PING] Step 4/4: VERIFICATION`);
    console.log(`[PING] ════════════════════════════════════════════════════`);
    console.log(`[PING]   SETTLEMENT CONFIRMED ON ALGORAND TESTNET`);
    console.log(`[PING] ════════════════════════════════════════════════════`);
    console.log(`[PING]   Txn ID:  ${result.settlement.txnId}`);
    console.log(`[PING]   Round:   ${result.settlement.confirmedRound}`);
    console.log(`[PING]   Group:   ${result.settlement.groupId}`);
    console.log(`[PING]   Txns:    ${result.settlement.txnCount} (atomic)`);
    console.log(`[PING]   Time:    ${result.settlement.settledAt}`);
    console.log(`[PING]   Agent:   ${result.agentId}`);
    console.log(`[PING] ════════════════════════════════════════════════════`);
    console.log(`[PING]`);
    console.log(`[PING]   Verify on-chain:`);
    console.log(`[PING]   ${explorerUrl}`);
    console.log(`[PING]`);
    console.log(`[PING]   x402 infrastructure is LIVE. Toll collected.`);
    console.log();
  } else {
    console.error(`[PING] Step 4/4: SETTLEMENT FAILED`);
    console.error(`[PING]   Stage:  ${result.failedStage}`);
    console.error(`[PING]   Error:  ${result.detail}`);
    console.error(`[PING]   No funds moved (atomic abort). Debug the failed stage above.`);
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await healthCheck();
    await executePing();
  } catch (err) {
    if (err instanceof X402Error) {
      console.error(`\n[PING] x402 PROTOCOL ERROR: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`\n[PING] ERROR: ${err.message}`);
    } else {
      console.error(`\n[PING] UNEXPECTED ERROR:`, err);
    }
    console.error(`[PING] Ping failed. Check deployment logs: npx vercel logs`);
    process.exit(1);
  }
}

main();
