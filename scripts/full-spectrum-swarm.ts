/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HONDA SYSTEM — FULL-SPECTRUM SWARM                                      │
 * │  100 mainnet transactions demonstrating atomic data settlement and       │
 * │  cross-chain USDC efficiency.                                            │
 * │                                                                          │
 * │  Type A  (50 txns) — Atomic Data Settlement                             │
 * │    Direct Algorand USDC transfer ($0.001) with honda_v1 audit note.     │
 * │    Proves native atomic settlement without cross-chain overhead.         │
 * │                                                                          │
 * │  Type B  (50 txns) — Cross-Chain Bridge (x402 full pipeline)            │
 * │    Rotate: 80% → Base/Solana (high-freq), 20% → Ethereum/Avalanche      │
 * │    CCTP automatic relaying enabled: no destination gas required.        │
 * │                                                                          │
 * │  MODES:                                                                  │
 * │    --probe     (default) Verify handshake only. Zero spend.             │
 * │    --sandbox   Full handshake + SandboxExport. No on-chain settlement.  │
 * │    --live      Full pipeline. Real USDC and ALGO required.              │
 * │                                                                          │
 * │  ESTIMATED COST (--live):                                               │
 * │    ~1.50 USDC  (tolls + relay buffer)                                  │
 * │    ~0.50 ALGO  (tx fees for 100 transactions)                          │
 * │                                                                          │
 * │  Run:                                                                    │
 * │    npx tsx scripts/full-spectrum-swarm.ts                 # probe       │
 * │    npx tsx scripts/full-spectrum-swarm.ts --sandbox       # dry-run     │
 * │    npx tsx scripts/full-spectrum-swarm.ts --live          # mainnet     │
 * │                                                                          │
 * │  Env:                                                                    │
 * │    ALGO_MNEMONIC    — 25-word mnemonic of funded mainnet wallet          │
 * │    API_URL          — x402 server (default: https://ai-agentic-wallet.com)│
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Mode ─────────────────────────────────────────────────────────
const MODE: "probe" | "sandbox" | "live" =
  process.argv.includes("--live")    ? "live"    :
  process.argv.includes("--sandbox") ? "sandbox" :
  "probe";

// ── Config ───────────────────────────────────────────────────────
const API_URL     = (process.env.API_URL || "https://ai-agentic-wallet.com").replace(/\/+$/, "");
const ALGO_NODE   = process.env.ALGORAND_NODE_URL  || "https://mainnet-api.4160.nodely.dev";
const ALGO_IDX    = process.env.ALGORAND_INDEXER_URL || "https://mainnet-idx.4160.nodely.dev";
const USDC_ASA    = 31566704n;                 // Circle USDC on Algorand mainnet
const TREASURY    = process.env.X402_PAY_TO_ADDRESS || "";
const TOTAL       = 100;

// Type distribution
const TYPE_A_COUNT   = 50;   // native Algorand USDC data settlements
const TYPE_B_COUNT   = 50;   // x402 cross-chain bridges

// Type B chain rotation: 80% Base/Solana, 20% Ethereum/Avalanche
const HIGH_FREQ_CHAINS   = ["base", "solana"];
const PREMIUM_CHAINS     = ["ethereum", "avalanche"];

// Destination wallet addresses — generated throwaway receivers, one per chain family
const DEST = {
  ethereum:  "0x4BC2b720C33de96bC161984EFB3Dc235f0690C22",  // EVM (eth/base/avax share format)
  solana:    "BCcyPUXkLgqXnmBXVeZobgXyMUpApSSDrdHFn95HQLxy",
  base:      "0x4BC2b720C33de96bC161984EFB3Dc235f0690C22",
  avalanche: "0x4BC2b720C33de96bC161984EFB3Dc235f0690C22",
};

// Audit log path
const AUDIT_LOG_PATH = path.join(__dirname, "..", "public", "global-audit.json");

// ── ANSI helpers ─────────────────────────────────────────────────
const R  = "\x1b[0m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const C  = "\x1b[36m";
const D  = "\x1b[2m";
const RE = "\x1b[31m";
const B  = "\x1b[34m";
const M  = "\x1b[35m";

function ts()  { return `${D}${new Date().toISOString().slice(11, 23)}${R}`; }
function ok(m: string)   { console.log(`  ${ts()} ${G}✔${R} ${m}`); }
function fail(m: string) { console.log(`  ${ts()} ${RE}✗${R} ${m}`); }
function warn(m: string) { console.log(`  ${ts()} ${Y}⚠${R} ${m}`); }
function info(m: string) { console.log(`  ${ts()} ${D}  ${m}${R}`); }
function row(label: string, val: string) {
  console.log(`  ${D}${label.padEnd(22)}${R}${val}`);
}

function sep(label: string) {
  console.log(`\n${C}${"─".repeat(68)}${R}`);
  console.log(`  ${C}${label}${R}`);
  console.log(`${C}${"─".repeat(68)}${R}\n`);
}

// ── Audit Log ────────────────────────────────────────────────────

interface AuditEntry {
  index:     number;
  type:      "A" | "B";
  txType:    string;
  status:    "success" | "failed" | "dry-run";
  timestamp: string;
  route:     string;
  toll:      string;
  txId:      string;
  note:      string;
  mode:      string;
}

interface AuditLog {
  schema:     string;
  updated:    string;
  mode:       string;
  totalRuns:  number;
  entries:    AuditEntry[];
}

function loadAuditLog(): AuditLog {
  try {
    if (fs.existsSync(AUDIT_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, "utf-8")) as AuditLog;
    }
  } catch { /* fresh start */ }
  return {
    schema:    "honda-audit-v1",
    updated:   new Date().toISOString(),
    mode:      MODE,
    totalRuns: 0,
    entries:   [],
  };
}

function saveAuditLog(log: AuditLog): void {
  log.updated  = new Date().toISOString();
  log.totalRuns = log.entries.filter((e) => e.status === "success").length;
  fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify(log, null, 2));
}

function appendAudit(log: AuditLog, entry: AuditEntry): void {
  log.entries.push(entry);
  saveAuditLog(log);
}

// ── Micali Audit Note ────────────────────────────────────────────
// Format: honda_v1|{type}|{status}|{timestamp}|{source}->{dest}|{toll}
// This string is physically etched into Algorand. Cannot be faked.
function buildAuditNote(
  txType: string,
  status: "success" | "failed",
  source: string,
  dest: string,
  toll: string,
): string {
  return `honda_v1|${txType}|${status}|${new Date().toISOString()}|${source}->${dest}|${toll}`;
}

// ── X-PAYMENT Proof Builder ──────────────────────────────────────
// For probe/sandbox modes: builds a structurally-valid mock proof
// (server verifies Ed25519 signature — passes; USDC balance is only
//  checked at broadcast time so sandbox export is returned cleanly).
function buildMockProof(account: algosdk.Account): string {
  const addr = account.addr.toString();
  const params: algosdk.SuggestedParams = {
    flatFee: true,
    fee: BigInt(1000),
    minFee: BigInt(1000),
    firstValid: BigInt(1000),
    lastValid: BigInt(2000),
    genesisID: "mainnet-v1.0",
    genesisHash: new Uint8Array(32),
  };
  const t0 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: addr, receiver: addr, amount: 0n, suggestedParams: params,
  });
  const t1 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: addr, receiver: addr, amount: 0n, suggestedParams: params,
  });
  algosdk.assignGroupID([t0, t1]);
  const groupId  = Buffer.from(t0.group!).toString("base64");
  const sig      = algosdk.signBytes(Buffer.from(groupId, "base64"), account.sk);
  const proof = {
    groupId,
    transactions: [t0.signTxn(account.sk), t1.signTxn(account.sk)].map((s) =>
      Buffer.from(s).toString("base64"),
    ),
    senderAddr: addr,
    signature:  Buffer.from(sig).toString("base64"),
    timestamp:  Math.floor(Date.now() / 1000),
    nonce:      `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

// ── Type A: Atomic Data Settlement ───────────────────────────────

interface TypeAResult {
  success:   boolean;
  txId:      string;
  note:      string;
  skipped?:  string;
}

async function runTypeA(
  index: number,
  account: algosdk.Account,
  algodClient: algosdk.Algodv2 | null,
): Promise<TypeAResult> {
  const addr    = account.addr.toString();
  const dataId  = `data-${String(index).padStart(3, "0")}`;
  const amount  = 1000n;   // 1000 micro-USDC = $0.001
  const note    = buildAuditNote("data", "success", "algorand", "algorand", `${amount}musd|id:${dataId}`);

  if (MODE === "probe") {
    return { success: true, txId: `dry-run-${dataId}`, note, skipped: "probe mode" };
  }

  if (!algodClient) {
    return { success: false, txId: "", note, skipped: "algod not configured" };
  }

  if (!TREASURY) {
    warn(`Type A[${index}] — X402_PAY_TO_ADDRESS not set; skipping`);
    return { success: false, txId: "", note, skipped: "treasury not configured" };
  }

  try {
    const sp = await algodClient.getTransactionParams().do();

    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender:    addr,
      receiver:  TREASURY,
      amount,
      assetIndex: USDC_ASA,
      suggestedParams: sp,
      note: new Uint8Array(Buffer.from(note)),
    });

    if (MODE === "sandbox") {
      // Construct + sign but don't submit
      const signed = txn.signTxn(account.sk);
      const txId   = txn.txID().toString();
      info(`  Type A[${index}] [SANDBOX] signed txn ${txId.slice(0, 12)}... (not submitted)`);
      return { success: true, txId: `sandbox-${txId}`, note, skipped: "sandbox mode" };
    }

    // --live: actually submit
    // algosdk v3 returns { txid } (lowercase), use txn.txID() to be safe
    const signed = txn.signTxn(account.sk);
    const txId = txn.txID().toString();
    await algodClient.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(algodClient, txId, 4);
    return { success: true, txId, note };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txId: "", note, skipped: msg.slice(0, 80) };
  }
}

// ── Type B: Cross-Chain Bridge (x402) ────────────────────────────

interface TypeBResult {
  success:    boolean;
  txId:       string;
  sandboxId:  string;
  chain:      string;
  note:       string;
  skipped?:   string;
}

async function runTypeB(
  index: number,
  account: algosdk.Account,
  algodClient: algosdk.Algodv2 | null,
): Promise<TypeBResult> {
  // Chain rotation: 80% high-freq (Base/Solana), 20% premium (ETH/Avalanche)
  const isHighFreq = (index % 10) < 8;
  const pool       = isHighFreq ? HIGH_FREQ_CHAINS : PREMIUM_CHAINS;
  const chain      = pool[index % pool.length];
  const dest       = DEST[chain as keyof typeof DEST];
  const addr       = account.addr.toString();
  const toll       = "10000musd";
  const note       = buildAuditNote("bridge", "success", "algorand", chain, toll);

  // ── Step 1: 402 bounce ────────────────────────────────────────
  let bounceStatus: number;
  try {
    const bounce = await fetch(`${API_URL}/api/agent-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderAddress: addr }),
    });
    bounceStatus = bounce.status;
    if (bounceStatus !== 402) {
      return { success: false, txId: "", sandboxId: "", chain, note,
        skipped: `Expected 402, got ${bounceStatus}` };
    }
  } catch (err) {
    return { success: false, txId: "", sandboxId: "", chain, note,
      skipped: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (MODE === "probe") {
    // Probe: verify 402 behaviour only — do not build proof
    return { success: true, txId: "probe-only", sandboxId: "probe-only", chain, note,
      skipped: "probe mode — 402 verified, no proof built" };
  }

  // ── Step 2: Build proof + get SandboxExport ───────────────────
  const xPayment = buildMockProof(account);
  let sandboxExport: Record<string, unknown>;
  let sandboxId: string;

  try {
    const pass = await fetch(`${API_URL}/api/agent-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT":      xPayment,
        "X-SLIPPAGE-BIPS": "50",
        "x-algo-auth":    addr,   // KYA: agent declares identity before settlement
      },
      body: JSON.stringify({
        senderAddress:        addr,
        destinationChain:     chain,
        destinationRecipient: dest,
        // Circle CCTP managed relaying — no destination gas required.
        // When automatic=true, Wormhole/CCTP relayers handle destination execution.
        automatic:            true,
      }),
    });

    const body = await pass.json() as Record<string, unknown>;

    if (pass.status !== 200) {
      const detail = String((body as Record<string, unknown>).detail ?? body.error ?? pass.status);
      // Known expected failures in dev/unconfigured environments
      if (
        detail.includes("address seems to be malformed") ||
        detail.includes("Gora") ||
        detail.includes("Wormhole") ||
        detail.includes("NTT")
      ) {
        return { success: false, txId: "", sandboxId: "", chain, note,
          skipped: `Server config: ${detail.slice(0, 60)}` };
      }
      return { success: false, txId: "", sandboxId: "", chain, note,
        skipped: `HTTP ${pass.status}: ${detail.slice(0, 60)}` };
    }

    sandboxExport = (body as Record<string, unknown>).export as Record<string, unknown>;
    sandboxId     = sandboxExport.sandboxId as string;

  } catch (err) {
    return { success: false, txId: "", sandboxId: "", chain, note,
      skipped: `Proof error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (MODE === "sandbox") {
    return { success: true, txId: `sandbox-${sandboxId}`, sandboxId, chain, note,
      skipped: "sandbox mode — SandboxExport received, /api/execute not called" };
  }

  // ── Step 3: Sign with user wallet + submit directly to Algod ────
  // The SandboxExport contains unsigned txns built with senderAddress=account.addr.
  // Sign them with the user's own key and submit — bypassing the server
  // signing step (which would use the server's key and cause auth mismatch).
  if (!algodClient) {
    return { success: false, txId: "", sandboxId, chain, note,
      skipped: "algod not configured" };
  }

  try {
    const atomicGroup = (sandboxExport as Record<string, unknown>).atomicGroup as Record<string, unknown>;
    const txnBlobs = atomicGroup.transactions as string[];

    // Sign each unsigned blob with the user wallet
    const signedTxns: Uint8Array[] = txnBlobs.map((b64) => {
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const txn = algosdk.decodeUnsignedTransaction(bytes);
      return txn.signTxn(account.sk);
    });

    // Use the txID from the first txn (toll) as the settlement ID
    const firstTxn = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(txnBlobs[0], "base64"))
    );
    const txId = firstTxn.txID().toString();

    await algodClient.sendRawTransaction(signedTxns).do();
    await algosdk.waitForConfirmation(algodClient, txId, 4);

    return { success: true, txId, sandboxId, chain, note };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, txId: "", sandboxId, chain, note,
      skipped: msg.slice(0, 100) };
  }
}

// ── Main Runner ──────────────────────────────────────────────────

async function runSwarm() {

  // ── Banner ────────────────────────────────────────────────────
  console.log(`\n${C}${"═".repeat(68)}${R}`);
  console.log(`  ${C}HONDA SYSTEM — FULL-SPECTRUM SWARM${R}`);
  console.log(`  ${D}Mode:   ${MODE.toUpperCase()}${R}`);
  console.log(`  ${D}Target: ${API_URL}${R}`);
  console.log(`  ${D}Date:   ${new Date().toISOString()}${R}`);
  console.log(`${C}${"═".repeat(68)}${R}`);

  // ── Cost estimate ─────────────────────────────────────────────
  sep("COST ESTIMATE (if --live)");
  row("Type A (50 txns):",    "50 × $0.001 USDC = $0.05 USDC + 0.05 ALGO tx fees");
  row("Type B (50 txns):",    "50 × $0.01  USDC = $0.50 USDC");
  row("Bridge relay buffer:", "~$0.50 USDC (CCTP/Wormhole managed relayers)");
  row("Algo fees:",           "~0.10 ALGO total");
  row("Safety buffer:",       "+$0.45 USDC, +0.35 ALGO");
  console.log(`\n  ${Y}Total estimate: ~1.50 USDC + ~0.50 ALGO${R}`);
  console.log(`  ${D}Audit: https://mainnet-idx.algonode.cloud/v2/transactions?note-prefix=aG9uZGFfdjE=${R}`);

  if (MODE === "probe") {
    console.log(`\n  ${Y}Running in PROBE mode — zero spend, zero on-chain activity.${R}`);
    console.log(`  ${D}Add --sandbox to test the full handshake without settling.${R}`);
    console.log(`  ${D}Add --live to execute on mainnet with real funds.${R}\n`);
  } else if (MODE === "sandbox") {
    console.log(`\n  ${Y}Running in SANDBOX mode — full handshake, no /api/execute calls.${R}`);
  } else {
    console.log(`\n  ${RE}Running in LIVE mode — real mainnet transactions will be submitted!${R}`);
    // Give 5 seconds to abort
    console.log(`  ${RE}Ctrl+C to abort. Starting in 5 seconds...${R}`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── Server health check ───────────────────────────────────────
  sep("PRE-FLIGHT: Server Health");
  try {
    const h = await fetch(`${API_URL}/health`);
    const b = await h.json() as Record<string, string>;
    if (h.status !== 200) throw new Error(`HTTP ${h.status}`);
    ok(`${API_URL} — ${b.protocol} on ${b.network}`);
    if (b.node) {
      info(`Round: ${(b.node as unknown as { latestRound: number }).latestRound ?? "N/A"}`);
    }
  } catch (err) {
    fail(`Server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Algod client (Type A live/sandbox) ───────────────────────
  let algodClient: algosdk.Algodv2 | null = null;
  if (MODE !== "probe") {
    algodClient = new algosdk.Algodv2("", ALGO_NODE, "");
    try {
      const status = await algodClient.status().do();
      ok(`Algod connected — round ${status["last-round"]}`);
    } catch {
      warn("Algod unreachable — Type A transactions will be skipped");
      algodClient = null;
    }
  }

  // ── Wallet ────────────────────────────────────────────────────
  let swarmAccount: algosdk.Account;
  if (process.env.ALGO_MNEMONIC && MODE === "live") {
    try {
      swarmAccount = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC);
      ok(`Wallet loaded: ${swarmAccount.addr.toString().slice(0, 16)}...`);

      if (algodClient) {
        const info = await algodClient.accountInformation(swarmAccount.addr.toString()).do();
        const microAlgo = info.amount ?? 0;
        const assets    = (info.assets as Array<{ "asset-id": number; amount: number }>) ?? [];
        const usdc      = assets.find((a) => a["asset-id"] === Number(USDC_ASA));
        console.log(`  ${D}Balance: ${Number(microAlgo) / 1e6} ALGO | USDC: ${usdc ? Number(usdc.amount) / 1e6 : "not opted-in"}${R}`);
      }
    } catch (err) {
      fail(`Invalid ALGO_MNEMONIC: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    // Ephemeral account for probe/sandbox modes
    swarmAccount = algosdk.generateAccount();
    info(`Ephemeral wallet: ${swarmAccount.addr.toString().slice(0, 16)}... (probe/sandbox)`);
  }

  // ── Load audit log ────────────────────────────────────────────
  const auditLog = loadAuditLog();
  auditLog.mode = MODE;

  // ── Run 100 transactions ──────────────────────────────────────
  let passA = 0, passB = 0, skipA = 0, skipB = 0, failA = 0, failB = 0;
  const t0 = Date.now();

  for (let i = 0; i < TOTAL; i++) {
    const isTypeA = i < TYPE_A_COUNT;
    const idx     = isTypeA ? i : i - TYPE_A_COUNT;

    if (i === 0)               sep("TYPE A — Atomic Data Settlement (×50)");
    if (i === TYPE_A_COUNT)    sep("TYPE B — Cross-Chain Bridge ×50 (80% Base/Solana · 20% ETH/AVAX)");

    if (isTypeA) {
      // ── Type A ────────────────────────────────────────────────
      process.stdout.write(`  ${ts()} ${B}A${R}[${String(idx + 1).padStart(2)}] data-${String(idx).padStart(3, "0")} ... `);
      const result = await runTypeA(idx, swarmAccount, algodClient);

      if (result.skipped && result.success) {
        process.stdout.write(`${Y}⚡${R} ${result.skipped}\n`);
        skipA++;
      } else if (result.success) {
        process.stdout.write(`${G}✔${R} txId: ${result.txId.slice(0, 20)}...\n`);
        passA++;
      } else {
        process.stdout.write(`${RE}✗${R} ${result.skipped ?? "failed"}\n`);
        failA++;
      }

      appendAudit(auditLog, {
        index:     i,
        type:      "A",
        txType:    "data",
        status:    result.success ? (result.skipped && MODE !== "live" ? "dry-run" : "success") : "failed",
        timestamp: new Date().toISOString(),
        route:     "algorand->algorand",
        toll:      "1000musd",
        txId:      result.txId,
        note:      result.note,
        mode:      MODE,
      });

    } else {
      // ── Type B ────────────────────────────────────────────────
      const result = await runTypeB(idx, swarmAccount, algodClient);
      const tier   = ["base","solana"].includes(result.chain) ? `${D}[high-freq]${R}` : `${M}[premium]${R}`;

      process.stdout.write(`  ${ts()} ${C}B${R}[${String(idx + 1).padStart(2)}] algorand→${result.chain.padEnd(9)} ${tier} ... `);

      if (result.skipped && result.success) {
        process.stdout.write(`${Y}⚡${R} ${result.skipped}\n`);
        skipB++;
      } else if (result.success) {
        process.stdout.write(`${G}✔${R} txId: ${result.txId.slice(0, 20)}...\n`);
        passB++;
      } else {
        process.stdout.write(`${RE}✗${R} ${result.skipped ?? "failed"}\n`);
        failB++;
      }

      appendAudit(auditLog, {
        index:     i,
        type:      "B",
        txType:    "bridge",
        status:    result.success ? (result.skipped && MODE !== "live" ? "dry-run" : "success") : "failed",
        timestamp: new Date().toISOString(),
        route:     `algorand->${result.chain}`,
        toll:      "10000musd",
        txId:      result.txId,
        note:      result.note,
        mode:      MODE,
      });
    }

    // Small delay between requests to respect rate limits (100 req/min)
    if (i < TOTAL - 1) await new Promise((r) => setTimeout(r, 650));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Summary ───────────────────────────────────────────────────
  sep("RESULTS");

  console.log(`  Type A — Atomic Data Settlement`);
  console.log(`    ${G}Passed${R}  : ${passA}`);
  console.log(`    ${Y}Skipped${R} : ${skipA}`);
  console.log(`    ${RE}Failed${R}  : ${failA}`);

  console.log(`\n  Type B — Cross-Chain Bridge`);
  console.log(`    ${G}Passed${R}  : ${passB}`);
  console.log(`    ${Y}Skipped${R} : ${skipB}`);
  console.log(`    ${RE}Failed${R}  : ${failB}`);

  const totalPass = passA + passB;
  const totalFail = failA + failB;
  const totalSkip = skipA + skipB;

  console.log(`\n  ${C}Total:${R} ${totalPass} passed · ${totalSkip} skipped · ${totalFail} failed`);
  console.log(`  ${D}Elapsed: ${elapsed}s${R}`);
  console.log(`\n  Audit log: ${AUDIT_LOG_PATH}`);
  console.log(`  On-chain:  https://mainnet-idx.algonode.cloud/v2/transactions?note-prefix=aG9uZGFfdjE=`);

  if (totalFail > 0) {
    console.log(`\n  ${RE}${totalFail} failure(s) detected. Check logs above.${R}\n`);
    process.exit(1);
  }

  console.log(`\n  ${G}Swarm complete.${R}`);

  if (MODE === "probe") {
    console.log(`  ${D}Re-run with --sandbox to test full handshake, or --live for mainnet.${R}`);
  } else if (MODE === "sandbox") {
    console.log(`  ${D}Re-run with --live to execute real settlements.${R}`);
    console.log(`  ${D}Ensure ALGO_MNEMONIC, X402_PAY_TO_ADDRESS, and Rocca are configured.${R}`);
  } else {
    console.log(`  ${G}All ${totalPass} mainnet transactions settled. honda_v1 audit notes etched on-chain.${R}`);
    console.log(`\n  Verify: https://allo.info/account/${TREASURY}`);
  }

  console.log();
}

runSwarm().catch((err) => {
  console.error(`\n  ${"\x1b[31m"}FATAL: ${err.message}${"\x1b[0m"}\n`);
  if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
    console.error("  Server not reachable. Check API_URL env var.\n");
  }
  process.exit(1);
});
