#!/usr/bin/env tsx
/**
 * End-to-end settlement test
 *
 * Flow:
 *   1. Generate a test agent account (for the X-PAYMENT proof)
 *   2. Build + sign a dummy payment atomic group
 *   3. POST /api/agent-action with X-PAYMENT header → get SandboxExport
 *   4. POST /api/execute with SandboxExport → confirm on-chain
 */

import "dotenv/config";
import algosdk from "algosdk";

const BASE_URL    = process.env.E2E_BASE_URL || "https://ai-agentic-wallet.com";
const PORTAL_KEY  = process.env.PORTAL_API_SECRET || "";
const AGENT_ID    = `e2e-test-agent-${Date.now()}`;
const SIGNER_ADDR = process.env.ALGO_SIGNER_ADDRESS || "";

const ALGOD_URL  = process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev";
const USDC_ID    = BigInt(process.env.X402_USDC_ASSET_ID || "31566704");
const PAY_TO     = process.env.X402_PAY_TO_ADDRESS || "";

const log = (msg: string, data?: unknown) => {
  console.log(`\n[e2e] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
};

// ── Step 0: Verify signer mnemonic loads ──────────────────────────
function checkSignerMnemonic(): void {
  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) {
    console.warn("[e2e] ALGO_SIGNER_MNEMONIC not set — server will use ephemeral key");
    return;
  }
  try {
    const acc = algosdk.mnemonicToSecretKey(mnemonic);
    log(`Signer mnemonic OK → ${acc.addr}`);
  } catch (err) {
    console.warn(`[e2e] WARNING: ALGO_SIGNER_MNEMONIC failed to decode: ${err instanceof Error ? err.message : err}`);
    console.warn("[e2e] Server will fall back to ephemeral key");
  }
}

// ── Step 1: Build X-PAYMENT proof ────────────────────────────────
async function buildPaymentProof(): Promise<{ header: string; agentAccount: algosdk.Account }> {
  log("Generating test agent account...");
  const agentAccount = algosdk.generateAccount();
  log(`Agent address: ${agentAccount.addr}`);

  const algod = new algosdk.Algodv2("", ALGOD_URL, 443);
  const params = await algod.getTransactionParams().do();

  // Build a minimal 1-txn group (0-ALGO self-payment as payment proof placeholder)
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:     agentAccount.addr.toString(),
    receiver:   agentAccount.addr.toString(),
    amount:     0n,
    suggestedParams: params,
    note:       new Uint8Array(Buffer.from(`x402:e2e-test:${Date.now()}`)),
  });

  // Assign a group ID
  const grouped = algosdk.assignGroupID([txn]);
  const groupId = grouped[0].group!;

  // Sign the txn
  const signedTxn = grouped[0].signTxn(agentAccount.sk);

  // Build proof: signature over groupId using agent key
  const signature = algosdk.signBytes(groupId, agentAccount.sk);

  const proof = {
    groupId:      Buffer.from(groupId).toString("base64"),
    transactions: [Buffer.from(signedTxn).toString("base64")],
    senderAddr:   agentAccount.addr.toString(),
    signature:    Buffer.from(signature).toString("base64"),
    timestamp:    Math.floor(Date.now() / 1000),
    nonce:        algosdk.generateAccount().addr.toString().slice(0, 16),
  };

  const header = Buffer.from(JSON.stringify(proof)).toString("base64");
  log("X-PAYMENT proof built", { groupId: proof.groupId.slice(0, 12) + "...", senderAddr: proof.senderAddr });

  return { header, agentAccount };
}

// ── Step 2: Call /api/agent-action ───────────────────────────────
async function callAgentAction(paymentHeader: string, senderAddr: string): Promise<unknown> {
  log("Calling /api/agent-action...");

  // senderAddress must be the server's Rocca signer address — it's the
  // account that will sign and broadcast the transactions on-chain.
  const signerAddress = SIGNER_ADDR || senderAddr;
  const body = {
    senderAddress:        signerAddress,
    amount:               1000000,    // 1 USDC (microUSDC)
    destinationChain:     "algorand",
    destinationRecipient: PAY_TO || signerAddress,
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

// ── Step 3: Call /api/execute ─────────────────────────────────────
async function callExecute(sandboxExport: unknown): Promise<unknown> {
  log("Calling /api/execute...");

  const res = await fetch(`${BASE_URL}/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${PORTAL_KEY}`,
    },
    body: JSON.stringify({
      sandboxExport,
      agentId: AGENT_ID,
    }),
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
  console.log(`  Agent:  ${AGENT_ID}`);
  console.log("══════════════════════════════════════════");

  // 0. Check signer
  checkSignerMnemonic();

  // 1. Health check
  log("Checking /health...");
  const health = await fetch(`${BASE_URL}/health`).then(r => r.json());
  log("Health", health);
  if ((health as { status: string }).status !== "ok") throw new Error("Node unhealthy");

  // 2. Build payment proof
  const { header, agentAccount } = await buildPaymentProof();

  // 3. Agent action
  const agentRes = await callAgentAction(header, agentAccount.addr.toString()) as { export: unknown };

  // 4. Execute settlement
  const result = await callExecute(agentRes.export);

  const settlement = (result as { settlement?: { txnId: string; confirmedRound: bigint | number } }).settlement;
  if (settlement) {
    console.log("\n══════════════════════════════════════════");
    console.log("  ✅ SETTLEMENT CONFIRMED ON-CHAIN");
    console.log(`  TxnID: ${settlement.txnId}`);
    console.log(`  Round: ${settlement.confirmedRound}`);
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
