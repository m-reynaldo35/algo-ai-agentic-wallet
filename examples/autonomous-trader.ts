/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AUTONOMOUS TRADER — x402 AI Agent Demo                        ║
 * ║                                                                  ║
 * ║  An autonomous AI agent that:                                    ║
 * ║    1. Evaluates cross-chain liquidity opportunities              ║
 * ║    2. Decides whether to execute a trade                         ║
 * ║    3. Pays the x402 toll (machine-to-machine, zero human input)  ║
 * ║    4. Settles an atomic Algorand → Solana bridge via NTT         ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    X402_API_URL=http://localhost:4020 \                          ║
 * ║    ALGO_MNEMONIC="your 25-word mnemonic" \                       ║
 * ║    npx tsx examples/autonomous-trader.ts                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import {
  AlgoAgentClient,
  X402Error,
  type TradeResult,
  type SettlementResult,
} from "@m-reynaldo35/x402-client";

// ── Agent Identity ─────────────────────────────────────────────
// The agent derives its keypair from a mnemonic stored in the
// environment. In production, this lives inside a TEE or Rocca
// Wallet — never in plaintext.

const MNEMONIC = process.env.ALGO_MNEMONIC;
const API_URL = process.env.X402_API_URL || "http://localhost:4020";

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC environment variable is required.");
  console.error("        Export your 25-word Algorand mnemonic and re-run.");
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const SENDER = account.addr.toString();

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  x402 AUTONOMOUS TRADING AGENT v0.1.0                           ║
╠══════════════════════════════════════════════════════════════════╣
║  Identity:  ${SENDER.slice(0, 12)}...${SENDER.slice(-6)}                           ║
║  Endpoint:  ${API_URL.padEnd(49)}║
║  Protocol:  x402-v1 (HTTP 402 Payment Required)                 ║
║  Network:   Algorand Testnet → Solana (Wormhole NTT)            ║
╚══════════════════════════════════════════════════════════════════╝
`);

// ── SDK Client ─────────────────────────────────────────────────
// One-time initialization. The SDK derives the sender address
// from the private key and handles all x402 negotiation internally.

const client = new AlgoAgentClient({
  baseUrl: API_URL,
  privateKey: account.sk,
  slippageBips: 75, // 0.75% tolerance for cross-chain volatility
});

// ── Simulated LLM Decision Engine ──────────────────────────────
// In production, this function would call an LLM (Claude, GPT, etc.)
// to analyze on-chain liquidity data, DEX spreads, and bridging
// costs. Here we simulate it with weighted randomness.

interface MarketSignal {
  shouldTrade: boolean;
  confidence: number;
  reasoning: string;
  amount: number;
  destinationChain: string;
}

function evaluateMarketOpportunity(): MarketSignal {
  const confidence = Math.random();
  const threshold = 0.4; // 60% chance of finding an opportunity

  if (confidence >= threshold) {
    const pools = [
      "Folks Finance USDC/ALGO",
      "Tinyman USDC/goBTC",
      "Pact USDC/goETH",
    ];
    const pool = pools[Math.floor(Math.random() * pools.length)];

    return {
      shouldTrade: true,
      confidence,
      reasoning: `Arbitrage detected on ${pool} pool. Solana DEX spread is 12bps wider than Algorand. Net profit after x402 toll: +$0.83.`,
      amount: 1_000_000, // 1.00 USDC in micro-units
      destinationChain: "solana",
    };
  }

  return {
    shouldTrade: false,
    confidence,
    reasoning: "Cross-chain spreads within normal range. No profitable arbitrage detected.",
    amount: 0,
    destinationChain: "solana",
  };
}

// ── Type Guard ─────────────────────────────────────────────────

function isSettlementSuccess(result: TradeResult): result is SettlementResult {
  return "success" in result && result.success === true;
}

// ── Main Execution Loop ────────────────────────────────────────
// The agent runs a single evaluation cycle. In production, this
// would be a polling loop or event-driven trigger from a price feed.

async function main(): Promise<void> {
  const runId = crypto.randomUUID().slice(0, 8);

  console.log(`[AGENT] ════════════════════════════════════════════════`);
  console.log(`[AGENT] Run ${runId} — Evaluating market conditions...`);
  console.log(`[AGENT] ════════════════════════════════════════════════\n`);

  // ── Phase 1: Market Analysis ─────────────────────────────────
  console.log(`[AGENT] Phase 1: MARKET ANALYSIS`);
  console.log(`[AGENT]   Scanning Algorand DEX pools...`);
  console.log(`[AGENT]   Comparing Solana Wormhole bridge rates...`);
  console.log(`[AGENT]   Factoring x402 toll cost into profit model...`);

  const signal = evaluateMarketOpportunity();

  console.log(`[AGENT]   Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
  console.log(`[AGENT]   Verdict:    ${signal.reasoning}`);
  console.log();

  if (!signal.shouldTrade) {
    console.log(`[AGENT] Decision: SKIP — no profitable opportunity this cycle.`);
    console.log(`[AGENT] Agent idling. Will re-evaluate on next trigger.\n`);
    return;
  }

  // ── Phase 2: x402 Toll Payment & Trade Execution ─────────────
  console.log(`[AGENT] Decision: EXECUTE TRADE`);
  console.log(`[AGENT]   Amount:      ${(signal.amount / 1_000_000).toFixed(2)} USDC`);
  console.log(`[AGENT]   Destination: Algorand → ${signal.destinationChain} (Wormhole NTT)`);
  console.log(`[AGENT]   Slippage:    75 bips (0.75%)\n`);

  console.log(`[AGENT] Phase 2: x402 PAYMENT HANDSHAKE`);
  console.log(`[AGENT]   Sending POST /api/agent-action...`);
  console.log(`[AGENT]   Expecting HTTP 402 Payment Required bounce...`);

  try {
    // ── Step 1: Request sandbox export (SDK absorbs the 402) ───
    console.log(`[AGENT]   → 402 intercepted. SDK parsing pay+json terms...`);
    console.log(`[AGENT]   → Building Algorand atomic group (ASA toll transfer)...`);
    console.log(`[AGENT]   → Signing groupId with Ed25519 key...`);
    console.log(`[AGENT]   → Injecting X-PAYMENT header, retrying request...`);

    const sandboxResponse = await client.requestSandboxExport({
      senderAddress: SENDER,
      amount: signal.amount,
      destinationChain: signal.destinationChain,
    });

    const { export: sandbox } = sandboxResponse;

    console.log(`[AGENT]   ✓ x402 handshake complete.`);
    console.log(`[AGENT]   Sandbox ID:  ${sandbox.sandboxId}`);
    console.log(`[AGENT]   Group ID:    ${sandbox.atomicGroup.groupId.slice(0, 16)}...`);
    console.log(`[AGENT]   Txn count:   ${sandbox.atomicGroup.txnCount}`);
    console.log(`[AGENT]   Manifest:`);
    for (const line of sandbox.atomicGroup.manifest) {
      console.log(`[AGENT]     ${line}`);
    }
    console.log();

    // ── Step 2: Forward to settlement pipeline ─────────────────
    console.log(`[AGENT] Phase 3: ON-CHAIN SETTLEMENT`);
    console.log(`[AGENT]   Forwarding SandboxExport to /api/execute...`);
    console.log(`[AGENT]   Pipeline: Validate → Auth (FIDO2) → Sign (Rocca) → Broadcast`);

    const result = await client.settle(sandboxResponse);

    // ── Step 3: Evaluate result ────────────────────────────────
    if (isSettlementSuccess(result)) {
      console.log(`\n[AGENT] ════════════════════════════════════════════════`);
      console.log(`[AGENT] SETTLEMENT CONFIRMED`);
      console.log(`[AGENT] ════════════════════════════════════════════════`);
      console.log(`[AGENT]   Txn ID:    ${result.settlement.txnId}`);
      console.log(`[AGENT]   Round:     ${result.settlement.confirmedRound}`);
      console.log(`[AGENT]   Group:     ${result.settlement.groupId}`);
      console.log(`[AGENT]   Txns:      ${result.settlement.txnCount} (atomic)`);
      console.log(`[AGENT]   Settled:   ${result.settlement.settledAt}`);
      console.log(`[AGENT]   Agent:     ${result.agentId}`);
      console.log(`[AGENT] ════════════════════════════════════════════════`);
      console.log(`[AGENT]`);
      console.log(`[AGENT]   Machine paid machine. Zero human intervention.`);
      console.log(`[AGENT]   x402 toll collected. Wormhole bridge initiated.`);
      console.log(`[AGENT]   ${(signal.amount / 1_000_000).toFixed(2)} USDC routed: Algorand → ${signal.destinationChain}`);
      console.log();
    } else {
      console.log(`\n[AGENT] SETTLEMENT FAILED`);
      console.log(`[AGENT]   Stage:  ${result.failedStage}`);
      console.log(`[AGENT]   Error:  ${result.detail}`);
      console.log(`[AGENT]   The atomic group was NOT submitted. No funds moved.`);
      console.log(`[AGENT]   Agent will retry on next evaluation cycle.\n`);
    }
  } catch (err) {
    if (err instanceof X402Error) {
      console.error(`\n[AGENT] x402 PROTOCOL ERROR: ${err.message}`);
    } else {
      console.error(`\n[AGENT] UNEXPECTED ERROR:`, err);
    }
    console.error(`[AGENT] Trade aborted. No funds at risk (atomic guarantees).\n`);
  }
}

// ── Boot ───────────────────────────────────────────────────────
main().catch(console.error);
