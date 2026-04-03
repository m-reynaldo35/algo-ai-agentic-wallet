/**
 * setup-multi-agent-showcase — Provision N independent agents for the multi-agent test.
 *
 * For each agent:
 *   1. Generate fresh keypair
 *   2. Fund agent wallet with 0.5 ALGO from operator (tx fee reserve)
 *   3. Call POST /api/agents/create-mandate → deploy MandateContract
 *   4. Fund mandate contract with 0.6 ALGO (MBR + fee reserve)
 *   5. Agent self-calls opt_in_usdc() (permissionless — no operator cost)
 *   6. Fund mandate contract with USDC from operator (PAYMENTS_PER_AGENT × $0.01 + buffer)
 *   7. Wait for agent to go active
 *
 * Saves agent configs to scripts/showcase-agents.json for use by showcase-multi-agent-test.ts
 *
 * Usage:
 *   npx tsx scripts/setup-multi-agent-showcase.ts
 *
 * Required env:
 *   OPERATOR_MNEMONIC   — funds ALGO + USDC for all agents
 *   PORTAL_API_SECRET   — portal auth key
 *
 * Optional env:
 *   API_URL             — defaults to https://api.ai-agentic-wallet.com
 *   N_AGENTS            — number of agents to provision (default 5)
 *   PAYMENTS_PER_AGENT  — payments each agent will make (default 20)
 *   ALGO_CLIENT_NODE_URL — Algorand node URL
 */

import algosdk from "algosdk";
import fs from "fs";
import path from "path";
import "dotenv/config";

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL           = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const PORTAL_SECRET     = process.env.PORTAL_API_SECRET!;
const OPERATOR_MNEMONIC = process.env.OPERATOR_MNEMONIC!;
const NODE_URL          = process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.algonode.cloud";
const N_AGENTS          = parseInt(process.env.N_AGENTS          ?? "5",  10);
const PAYMENTS_PER_AGENT = parseInt(process.env.PAYMENTS_PER_AGENT ?? "20", 10);
const USDC_ASA_ID       = 31566704n;
const ALGO_FOR_AGENT    = 500_000n;  // 0.5 ALGO agent wallet (fee reserve for app calls)
const ALGO_FOR_CONTRACT = 600_000n;  // 0.6 ALGO contract (MBR + inner fee pool)
// USDC per agent: payments × toll + 10% buffer, minimum $0.22
const USDC_PER_AGENT    = BigInt(Math.max(220_000, Math.ceil(PAYMENTS_PER_AGENT * 10_000 * 1.1)));

const CONFIG_PATH = path.join(process.cwd(), "scripts", "showcase-agents.json");

const OPT_IN_USDC_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("opt_in_usdc()void").getSelector(),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const R  = "\x1b[0m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const C  = "\x1b[36m";
const B  = "\x1b[1m";
const RE = "\x1b[31m";
const D  = "\x1b[2m";

function ok(msg: string)   { console.log(`  ${G}✔${R} ${msg}`); }
function warn(msg: string) { console.log(`  ${Y}⚠${R} ${msg}`); }
function info(msg: string) { console.log(`  ${C}→${R} ${msg}`); }
function fail(msg: string) { console.error(`  ${RE}✗${R} ${msg}`); }
function step(n: number, total: number, label: string) {
  console.log(`\n${C}── Agent ${n}/${total}: ${label}${R}\n`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── Per-agent setup ───────────────────────────────────────────────────────────

interface AgentConfig {
  agentId:      string;
  mnemonic:     string;
  address:      string;
  mandateAppId: number;
  appAddress:   string;
}

async function setupAgent(
  index:    number,
  operator: algosdk.Account,
  algod:    algosdk.Algodv2,
): Promise<AgentConfig> {
  const agentId = `showcase-multi-${index}-${Date.now()}`;

  // 1. Generate keypair
  const newAccount  = algosdk.generateAccount();
  const newMnemonic = algosdk.secretKeyToMnemonic(newAccount.sk);
  const newAddress  = newAccount.addr.toString();
  ok(`[${index}] address: ${newAddress.slice(0, 12)}...`);

  // 2. Fund agent wallet with ALGO
  const p1      = await algod.getTransactionParams().do();
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          operator.addr.toString(),
    receiver:        newAddress,
    amount:          ALGO_FOR_AGENT,
    suggestedParams: p1,
  });
  const { txid: fundTxid } = await algod.sendRawTransaction(fundTxn.signTxn(operator.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, fundTxid, 5);
  ok(`[${index}] agent wallet funded: ${Number(ALGO_FOR_AGENT) / 1e6} ALGO`);

  // 3. Deploy MandateContract via API
  const createRes = await fetch(`${API_URL}/api/agents/create-mandate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-Portal-Key": PORTAL_SECRET },
    body:    JSON.stringify({
      agentId,
      agentKey:    newAddress,
      maxPerTx:    100_000,    // $0.10 max per tx
      velocityCap: 5_000_000,  // $5.00 / 10 min
      dailyCap:    50_000_000, // $50.00 / day
    }),
  });

  const createBody = await createRes.json() as {
    mandateAppId?: number; appAddress?: string; deployTxid?: string;
    error?: string; detail?: string;
  };

  if (!createRes.ok) {
    throw new Error(`create-mandate failed (${createRes.status}): ${createBody.error ?? ""} ${createBody.detail ?? ""}`);
  }

  const { mandateAppId, appAddress, deployTxid } = createBody;
  ok(`[${index}] mandate app: ${mandateAppId}  deploy txid: ${deployTxid!.slice(0, 12)}...`);

  // 4. Fund mandate contract with ALGO
  const p2           = await algod.getTransactionParams().do();
  const fundCtrTxn   = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          operator.addr.toString(),
    receiver:        appAddress!,
    amount:          ALGO_FOR_CONTRACT,
    suggestedParams: p2,
  });
  const { txid: fundCtrTxid } = await algod.sendRawTransaction(fundCtrTxn.signTxn(operator.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, fundCtrTxid, 5);
  ok(`[${index}] contract funded: ${Number(ALGO_FOR_CONTRACT) / 1e6} ALGO`);

  // 5. Agent self-calls opt_in_usdc()
  const p3       = await algod.getTransactionParams().do();
  const optInTxn = algosdk.makeApplicationCallTxnFromObject({
    sender:          newAddress,
    appIndex:        mandateAppId!,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [OPT_IN_USDC_SELECTOR],
    foreignAssets:   [Number(USDC_ASA_ID)],
    suggestedParams: { ...p3, fee: 2_000n, flatFee: true },
  });
  const { txid: optInTxid } = await algod.sendRawTransaction(optInTxn.signTxn(newAccount.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, optInTxid, 5);
  ok(`[${index}] contract opted-in to USDC`);

  // 6. Fund mandate contract with USDC
  const p4       = await algod.getTransactionParams().do();
  const usdcTxn  = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          operator.addr.toString(),
    receiver:        appAddress!,
    assetIndex:      USDC_ASA_ID,
    amount:          USDC_PER_AGENT,
    suggestedParams: p4,
  });
  const { txid: usdcTxid } = await algod.sendRawTransaction(usdcTxn.signTxn(operator.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, usdcTxid, 5);
  ok(`[${index}] contract funded: ${Number(USDC_PER_AGENT) / 1e6} USDC`);

  // 7. Wait for agent to go active
  let active = false;
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    try {
      const res  = await fetch(`${API_URL}/api/agents/${newAddress}`, {
        headers: { "X-Portal-Key": PORTAL_SECRET },
      });
      const body = await res.json() as { status?: string };
      if (body.status === "active") { active = true; break; }
    } catch { /* retry */ }
  }

  if (active) {
    ok(`[${index}] agent active`);
  } else {
    warn(`[${index}] agent not yet active — poller may still fire`);
  }

  return { agentId, mnemonic: newMnemonic, address: newAddress, mandateAppId: mandateAppId!, appAddress: appAddress! };
}

// ── Save progress ─────────────────────────────────────────────────────────────

function saveProgress(agents: AgentConfig[]): void {
  const data = {
    generatedAt:      new Date().toISOString(),
    network:          "mainnet",
    nAgents:          agents.length,
    paymentsPerAgent: PAYMENTS_PER_AGENT,
    totalPayments:    agents.length * PAYMENTS_PER_AGENT,
    agents,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C}${"═".repeat(70)}${R}`);
  console.log(`  ${B}${C}SETUP MULTI-AGENT SHOWCASE — ${N_AGENTS} agents × ${PAYMENTS_PER_AGENT} payments${R}`);
  console.log(`${C}${"═".repeat(70)}${R}\n`);

  if (!PORTAL_SECRET)     { fail("PORTAL_API_SECRET not set"); process.exit(1); }
  if (!OPERATOR_MNEMONIC) { fail("OPERATOR_MNEMONIC not set"); process.exit(1); }

  const operator = algosdk.mnemonicToSecretKey(OPERATOR_MNEMONIC);
  const algod    = new algosdk.Algodv2("", NODE_URL, "");

  info(`Operator:        ${operator.addr.toString()}`);
  info(`API:             ${API_URL}`);
  info(`Agents:          ${N_AGENTS}`);
  info(`Payments/agent:  ${PAYMENTS_PER_AGENT}  (${N_AGENTS * PAYMENTS_PER_AGENT} total)`);
  info(`ALGO/agent:      ${Number(ALGO_FOR_AGENT) / 1e6} wallet + ${Number(ALGO_FOR_CONTRACT) / 1e6} contract`);
  info(`USDC/agent:      ${Number(USDC_PER_AGENT) / 1e6} USDC`);
  info(`Total USDC:      ~${(N_AGENTS * Number(USDC_PER_AGENT) / 1e6).toFixed(2)} USDC`);
  console.log();

  // Load existing agents if file exists (append mode)
  let agents: AgentConfig[] = [];
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as { agents?: AgentConfig[] };
      agents = existing.agents ?? [];
      if (agents.length > 0) {
        info(`Loaded ${agents.length} existing agent(s) from ${CONFIG_PATH}`);
      }
    } catch { /* ignore parse errors */ }
  }

  for (let i = 1; i <= N_AGENTS; i++) {
    step(i + agents.length, N_AGENTS + agents.length, `provisioning agent ${i}`);
    try {
      const cfg = await setupAgent(i, operator, algod);
      agents.push(cfg);
      ok(`[${i}] done — mandateAppId=${cfg.mandateAppId}`);
    } catch (err) {
      fail(`[${i}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      // Save progress before exiting so successfully-provisioned agents aren't lost
      saveProgress(agents);
      process.exit(1);
    }
    // Save after each successful agent
    saveProgress(agents);
  }

  // ── Save config ───────────────────────────────────────────────────────────
  saveProgress(agents);

  console.log(`\n${C}${"═".repeat(70)}${R}`);
  console.log(`  ${B}${G}ALL ${agents.length} AGENTS PROVISIONED${R}`);
  console.log(`${C}${"═".repeat(70)}${R}\n`);
  console.log(`  ${D}Config saved → ${CONFIG_PATH}${R}`);
  console.log();
  console.log(`  ${B}Run the test:${R}`);
  console.log(`  npx tsx scripts/showcase-multi-agent-test.ts`);
  console.log();

  for (const a of agents) {
    console.log(`  ${D}${a.agentId}  app=${a.mandateAppId}  ${a.address.slice(0, 10)}...${R}`);
  }
  console.log();
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
