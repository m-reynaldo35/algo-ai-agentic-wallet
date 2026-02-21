#!/usr/bin/env tsx
/**
 * End-to-end settlement test — rekeyed agent architecture
 *
 * Flow:
 *   0. Verify Rocca signer mnemonic loads
 *   1. Health check
 *   2. Get or register the e2e test agent (stable agentId, rekeyed to Rocca signer)
 *   3. Build X-PAYMENT proof signed by the Rocca signer key (auth-addr of the agent)
 *   4. POST /api/agent-action with agent's address as senderAddress → SandboxExport
 *   5. POST /api/execute with agentId → confirm on-chain settlement
 */

import "dotenv/config";
import algosdk from "algosdk";

const BASE_URL   = process.env.E2E_BASE_URL || "https://ai-agentic-wallet.com";
const PORTAL_KEY = process.env.PORTAL_API_SECRET || "";
const ALGOD_URL  = process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev";
const PAY_TO     = process.env.X402_PAY_TO_ADDRESS || "";

// Stable agentId for e2e — same agent reused across runs
const E2E_AGENT_ID = "e2e-test-agent";

const log = (msg: string, data?: unknown) => {
  console.log(`\n[e2e] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
};

// ── Step 0: Load Rocca signer ─────────────────────────────────────
// The Rocca signer is the auth-addr for all registered agents.
// It signs the X-PAYMENT proof and the on-chain transactions.
function getRoccaSigner(): algosdk.Account {
  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_SIGNER_MNEMONIC not set");
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  log(`Rocca signer loaded → ${account.addr}`);
  return account;
}

// ── Step 1: Get or register e2e agent ────────────────────────────
interface AgentRecord {
  agentId: string;
  address: string;
  cohort: string;
  authAddr: string;
  status: string;
}

async function getOrRegisterAgent(): Promise<AgentRecord> {
  // Try to fetch existing agent
  const getRes = await fetch(`${BASE_URL}/api/agents/${E2E_AGENT_ID}`, {
    headers: { "Authorization": `Bearer ${PORTAL_KEY}` },
  });

  if (getRes.ok) {
    const agent = await getRes.json() as AgentRecord;
    log(`Using existing agent`, {
      agentId: agent.agentId,
      address: agent.address,
      cohort:  agent.cohort,
      authAddr: agent.authAddr,
    });
    return agent;
  }

  // Not found — register fresh
  log(`Agent not found — registering ${E2E_AGENT_ID}...`);
  const regRes = await fetch(`${BASE_URL}/api/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${PORTAL_KEY}`,
    },
    body: JSON.stringify({ agentId: E2E_AGENT_ID, platform: "e2e" }),
  });

  const reg = await regRes.json() as AgentRecord & { registrationTxnId: string; explorerUrl: string };

  if (!regRes.ok) {
    throw new Error(`Agent registration failed (${regRes.status}): ${JSON.stringify(reg)}`);
  }

  log(`Agent registered on-chain`, {
    agentId:            reg.agentId,
    address:            reg.address,
    cohort:             reg.cohort,
    authAddr:           reg.authAddr,
    registrationTxnId: (reg as { registrationTxnId?: string }).registrationTxnId,
    explorerUrl:        (reg as { explorerUrl?: string }).explorerUrl,
  });

  return reg;
}

// ── Step 2: Build X-PAYMENT proof ────────────────────────────────
// Signed by the Rocca signer key — it is the auth-addr for the agent's
// account, so it is the legitimate signing authority.
async function buildPaymentProof(rocca: algosdk.Account): Promise<string> {
  log("Building X-PAYMENT proof (signed by Rocca signer)...");

  const algod  = new algosdk.Algodv2("", ALGOD_URL, 443);
  const params = await algod.getTransactionParams().do();

  // Minimal 1-txn group — 0-ALGO self-payment as the proof payload
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          rocca.addr.toString(),
    receiver:        rocca.addr.toString(),
    amount:          0n,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(`x402:e2e-test:${Date.now()}`)),
  });

  const grouped   = algosdk.assignGroupID([txn]);
  const groupId   = grouped[0].group!;
  const signedTxn = grouped[0].signTxn(rocca.sk);
  const signature = algosdk.signBytes(groupId, rocca.sk);

  const proof = {
    groupId:      Buffer.from(groupId).toString("base64"),
    transactions: [Buffer.from(signedTxn).toString("base64")],
    senderAddr:   rocca.addr.toString(),
    signature:    Buffer.from(signature).toString("base64"),
    timestamp:    Math.floor(Date.now() / 1000),
    nonce:        algosdk.generateAccount().addr.toString().slice(0, 16),
  };

  const header = Buffer.from(JSON.stringify(proof)).toString("base64");
  log("X-PAYMENT proof built", {
    senderAddr: proof.senderAddr,
    groupId:    proof.groupId.slice(0, 12) + "...",
  });

  return header;
}

// ── Step 3: Call /api/agent-action ───────────────────────────────
// senderAddress = registered agent's address (rekeyed to Rocca signer)
async function callAgentAction(
  paymentHeader: string,
  agentAddress: string,
): Promise<unknown> {
  log(`Calling /api/agent-action (sender: ${agentAddress})...`);

  const body = {
    senderAddress:        agentAddress,
    amount:               10000,       // 0.01 USDC (config default)
    destinationChain:     "algorand",
    destinationRecipient: PAY_TO || agentAddress,
  };

  const res = await fetch(`${BASE_URL}/api/agent-action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT":    paymentHeader,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok) {
    log(`agent-action failed (${res.status})`, json);
    throw new Error(`agent-action returned ${res.status}`);
  }

  log(`agent-action OK (${res.status})`, {
    status:    (json as { status: string }).status,
    sandboxId: (json as { export?: { sandboxId?: string } }).export?.sandboxId,
    txnCount:  (json as { export?: { atomicGroup?: { txnCount?: number } } }).export?.atomicGroup?.txnCount,
  });

  return json;
}

// ── Step 4: Call /api/execute ─────────────────────────────────────
async function callExecute(sandboxExport: unknown, agentId: string): Promise<unknown> {
  log(`Calling /api/execute (agentId: ${agentId})...`);

  const res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${PORTAL_KEY}`,
    },
    body: JSON.stringify({ sandboxExport, agentId }),
  });

  const json = await res.json();

  if (!res.ok) {
    log(`execute failed (${res.status})`, json);
    throw new Error(`execute returned ${res.status}`);
  }

  log(`execute OK (${res.status})`, json);
  return json;
}

// ── Main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════");
  console.log("  x402 AI Wallet — End-to-End Test");
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Agent:  ${E2E_AGENT_ID}`);
  console.log("══════════════════════════════════════════");

  // 0. Load Rocca signer
  const rocca = getRoccaSigner();

  // 1. Health check
  log("Checking /health...");
  const health = await fetch(`${BASE_URL}/health`).then(r => r.json());
  log("Health", health);
  if ((health as { status: string }).status !== "ok") throw new Error("Node unhealthy");

  // 2. Get or register e2e agent
  const agent = await getOrRegisterAgent();

  // 3. Build X-PAYMENT proof (Rocca signer = auth-addr of agent)
  const header = await buildPaymentProof(rocca);

  // 4. Agent action — use agent's registered address as sender
  const agentRes = await callAgentAction(header, agent.address) as { export: unknown };

  // 5. Execute settlement — Rocca signer signs on-chain for the agent
  const result = await callExecute(agentRes.export, agent.agentId);

  const settlement = (result as {
    settlement?: { txnId: string; confirmedRound: bigint | number };
  }).settlement;

  if (settlement) {
    console.log("\n══════════════════════════════════════════");
    console.log("  ✅ SETTLEMENT CONFIRMED ON-CHAIN");
    console.log(`  Agent:  ${agent.agentId}`);
    console.log(`  Addr:   ${agent.address}`);
    console.log(`  TxnID:  ${settlement.txnId}`);
    console.log(`  Round:  ${settlement.confirmedRound}`);
    console.log(`  Explorer: https://allo.info/tx/${settlement.txnId}`);
    console.log("══════════════════════════════════════════\n");
  } else {
    console.log("\n[e2e] Pipeline ran but no settlement returned — check logs above");
  }
}

main().catch(err => {
  console.error("\n[e2e] FAILED:", err.message);
  process.exit(1);
});
