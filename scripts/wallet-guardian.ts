#!/usr/bin/env tsx
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WALLET GUARDIAN                                                         │
 * │                                                                          │
 * │  Two jobs:                                                               │
 * │                                                                          │
 * │  1. Signer Monitor                                                       │
 * │     Watches the signing wallet ALGO balance. When it drops below        │
 * │     SIGNER_LOW_ALERT_ALGO, fires an alert to your phone (Telegram)      │
 * │     with the signer address so you can deposit immediately.             │
 * │     No auto-refill — you top it up manually.                            │
 * │                                                                          │
 * │  2. Treasury Cold Sweep                                                  │
 * │     When treasury ALGO exceeds TREASURY_CEILING_ALGO, sweeps excess     │
 * │     to the cold wallet. Same for USDC > TREASURY_USDC_CEILING.         │
 * │     Keeps hot wallet exposure bounded regardless of revenue volume.     │
 * │                                                                          │
 * │  Flow:                                                                   │
 * │                                                                          │
 * │    You ──(manual deposit when alerted)──▶ Signing wallet                │
 * │                                                                          │
 * │    Cold wallet (Ledger / paper)                                          │
 * │         ↑  ALGO sweep  when treasury > TREASURY_CEILING_ALGO            │
 * │         ↑  USDC sweep  when treasury > TREASURY_USDC_CEILING            │
 * │    Treasury wallet                                                       │
 * │                                                                          │
 * │  Usage:   tsx scripts/wallet-guardian.ts                                 │
 * │  Daemon:  Railway / PM2 / systemd                                        │
 * │                                                                          │
 * │  Required env vars:                                                      │
 * │    ALGO_TREASURY_MNEMONIC   25-word treasury mnemonic (signs sweeps)    │
 * │    ALGO_SIGNER_ADDRESS      Signer wallet address (monitoring only)     │
 * │                                                                          │
 * │  Optional env vars:                                                      │
 * │    SIGNER_LOW_ALERT_ALGO    Alert threshold in ALGO    (default 200)    │
 * │    COLD_WALLET_ADDRESS      Cold wallet address for sweeps              │
 * │    TREASURY_CEILING_ALGO    Max ALGO to keep in treasury (default 1000) │
 * │    TREASURY_USDC_CEILING    Max USDC to keep in treasury (default 100)  │
 * │    TELEGRAM_BOT_TOKEN       Bot token from @BotFather                   │
 * │    TELEGRAM_CHAT_ID         Your personal Telegram chat ID              │
 * │    ALERT_WEBHOOK_URL        Slack / Discord webhook URL                 │
 * │    SENTRY_DSN               Sentry DSN for error reporting              │
 * │    CHECK_INTERVAL_S         Poll interval in seconds     (default 10)   │
 * │    ALGORAND_NODE_URL        Algod endpoint (default: Nodely mainnet)    │
 * │    ALGORAND_NODE_TOKEN      Algod auth token (default: empty)           │
 * │                                                                          │
 * │  Telegram setup (2 minutes):                                             │
 * │    1. Message @BotFather → /newbot → copy token → TELEGRAM_BOT_TOKEN   │
 * │    2. Message your bot once, then visit:                                 │
 * │       https://api.telegram.org/bot{TOKEN}/getUpdates                    │
 * │    3. Copy "id" from the "chat" object → TELEGRAM_CHAT_ID               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import pino from "pino";
import * as Sentry from "@sentry/node";

// ── Constants ─────────────────────────────────────────────────────────────

const ALGO_MICRO  = 1_000_000n;
const USDC_MICRO  = 1_000_000n;
const USDC_ASA_ID = 31566704n;   // Circle USDC — Algorand mainnet
const TX_FEE      = 1_000n;      // 0.001 ALGO standard fee
const MIN_BALANCE = 100_000n;    // 0.1 ALGO Algorand minimum
const CONFIRMATION_ROUNDS  = 4;
const ALERT_COOLDOWN_MS    = 30 * 60_000; // max one alert per 30 min

// ── Config ────────────────────────────────────────────────────────────────

const ALGOD_URL   = process.env.ALGORAND_NODE_URL   || "https://mainnet-api.4160.nodely.dev";
const ALGOD_TOKEN = process.env.ALGORAND_NODE_TOKEN || "";

const SIGNER_ALERT_MICRO = BigInt(
  Math.round(parseFloat(process.env.SIGNER_LOW_ALERT_ALGO || "200") * 1_000_000),
);
const ALGO_CEILING_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_CEILING_ALGO || "1000") * 1_000_000),
);
const USDC_CEILING_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_USDC_CEILING || "100") * 1_000_000),
);
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_S || "10", 10) * 1000;
const COLD_ADDRESS      = process.env.COLD_WALLET_ADDRESS || "";
const TG_TOKEN          = process.env.TELEGRAM_BOT_TOKEN  || "";
const TG_CHAT_ID        = process.env.TELEGRAM_CHAT_ID    || "";
const WEBHOOK_URL       = process.env.ALERT_WEBHOOK_URL   || "";

// ── Logger ────────────────────────────────────────────────────────────────

const log = pino({
  name: "wallet-guardian",
  level: "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
    },
  }),
});

// ── Sentry ────────────────────────────────────────────────────────────────

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function loadAccount(mnemonic: string, label: string): algosdk.Account {
  try { return algosdk.mnemonicToSecretKey(mnemonic); }
  catch { throw new Error(`Invalid mnemonic for ${label} wallet`); }
}

function microToAlgo(micro: bigint): string {
  return `${micro / ALGO_MICRO}.${(micro % ALGO_MICRO).toString().padStart(6, "0")} ALGO`;
}
function microToUsdc(micro: bigint): string {
  return `$${micro / USDC_MICRO}.${(micro % USDC_MICRO).toString().padStart(6, "0")} USDC`;
}

// ── Algod ─────────────────────────────────────────────────────────────────

function buildAlgod(): algosdk.Algodv2 {
  return new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL);
}

async function getAlgoBalance(algod: algosdk.Algodv2, address: string): Promise<bigint> {
  const info = await algod.accountInformation(address).do();
  return BigInt(info.amount);
}

interface Balances { algo: bigint; usdc: bigint; }

async function getBalances(algod: algosdk.Algodv2, address: string): Promise<Balances> {
  const info = await algod.accountInformation(address).do();
  const usdcAsset = (info.assets ?? []).find(
    (a: { assetId: bigint }) => a.assetId === USDC_ASA_ID,
  );
  return {
    algo: BigInt(info.amount),
    usdc: usdcAsset ? BigInt(usdcAsset.amount) : 0n,
  };
}

// ── Notifications ─────────────────────────────────────────────────────────

let lastAlertMs = 0;

function buildBody(message: string, fields: Record<string, string>): string {
  return `${message}\n${Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`;
}

async function sendTelegram(text: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok) log.info("Telegram delivered");
    else log.warn({ status: res.status }, "Telegram failed");
  } catch (err) {
    log.warn({ err }, "Telegram error");
  }
}

async function sendWebhook(text: string): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "x402-wallet-guardian/1.0" },
      body:    JSON.stringify({ text, content: text, username: "x402 Wallet Guardian" }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.ok) log.info("Webhook delivered");
    else log.warn({ status: res.status }, "Webhook failed");
  } catch (err) {
    log.warn({ err }, "Webhook error");
  }
}

/** Warning alert with 30-min cooldown — for low-balance conditions. */
async function alert(message: string, fields: Record<string, string>): Promise<void> {
  const now = Date.now();
  if (now - lastAlertMs < ALERT_COOLDOWN_MS) { log.debug("Alert in cooldown"); return; }
  lastAlertMs = now;

  const body = buildBody(message, fields);
  log.warn(body);
  await Promise.allSettled([sendTelegram(body), sendWebhook(body)]);

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(body, { level: "warning", tags: { component: "wallet-guardian" } });
  }
}

/** Info notification, no cooldown — for sweep confirmations (unique txid each time). */
async function notify(message: string, fields: Record<string, string>): Promise<void> {
  const body = buildBody(message, fields);
  log.info(body);
  await Promise.allSettled([sendTelegram(body), sendWebhook(body)]);
}

// ── Signed transactions ───────────────────────────────────────────────────

async function sendAlgo(
  algod: algosdk.Algodv2, from: algosdk.Account, to: string, amount: bigint, note: string,
): Promise<string> {
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(), receiver: to, amount,
    suggestedParams: params, note: new Uint8Array(Buffer.from(note)),
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(from.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);
  return txid;
}

async function sendUsdc(
  algod: algosdk.Algodv2, from: algosdk.Account, to: string, amount: bigint, note: string,
): Promise<string> {
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(), receiver: to, amount, assetIndex: USDC_ASA_ID,
    suggestedParams: params, note: new Uint8Array(Buffer.from(note)),
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(from.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);
  return txid;
}

// ── Job 1: Signer monitor ─────────────────────────────────────────────────

async function checkSigner(algod: algosdk.Algodv2, signerAddr: string): Promise<void> {
  const balance = await getAlgoBalance(algod, signerAddr);

  if (balance >= SIGNER_ALERT_MICRO) return; // Healthy

  await alert(
    `🚨 x402 Signer Wallet Low — Top Up Required`,
    {
      "Deposit ALGO to": signerAddr,
      "Current balance": microToAlgo(balance),
      "Alert threshold": microToAlgo(SIGNER_ALERT_MICRO),
      "Suggested top-up": microToAlgo(500n * ALGO_MICRO - balance),
    },
  );
}

// ── Job 2a: Treasury ALGO cold sweep ──────────────────────────────────────

async function sweepAlgo(
  algod: algosdk.Algodv2, treasury: algosdk.Account, treasuryAlgo: bigint,
): Promise<void> {
  if (!COLD_ADDRESS || treasuryAlgo <= ALGO_CEILING_MICRO) return;

  // Sweep brings treasury exactly to ceiling; fee is taken from the excess.
  //   treasuryAlgo - sweepAmount - TX_FEE = ALGO_CEILING_MICRO
  const sweepAmount = treasuryAlgo - ALGO_CEILING_MICRO - TX_FEE;
  if (sweepAmount <= 0n) return;

  log.info({ sweepAmount: microToAlgo(sweepAmount) }, "Sweeping ALGO to cold wallet...");

  const txid = await sendAlgo(
    algod, treasury, COLD_ADDRESS, sweepAmount,
    `x402:cold-sweep-algo|${new Date().toISOString()}`,
  );

  const post = await getAlgoBalance(algod, treasury.addr.toString());
  await notify(`🧊 ALGO Cold Sweep — ${microToAlgo(sweepAmount)} secured`, {
    "Swept":          microToAlgo(sweepAmount),
    "Cold wallet":    COLD_ADDRESS,
    "Treasury after": microToAlgo(post),
    "Txn ID":         txid,
  });
}

// ── Job 2b: Treasury USDC cold sweep ──────────────────────────────────────

async function sweepUsdc(
  algod: algosdk.Algodv2, treasury: algosdk.Account,
  treasuryUsdc: bigint, treasuryAlgo: bigint,
): Promise<void> {
  if (!COLD_ADDRESS || treasuryUsdc <= USDC_CEILING_MICRO) return;

  const sweepAmount = treasuryUsdc - USDC_CEILING_MICRO;

  if (treasuryAlgo < MIN_BALANCE + TX_FEE) {
    log.error({ treasuryAlgo: microToAlgo(treasuryAlgo) }, "Insufficient ALGO for USDC sweep fee");
    await alert(`🚨 Treasury Needs ALGO for USDC Sweep Fee`, {
      "Treasury ALGO":  microToAlgo(treasuryAlgo),
      "USDC pending":   microToUsdc(sweepAmount),
      "ALGO needed":    microToAlgo(MIN_BALANCE + TX_FEE),
    });
    return;
  }

  log.info({ sweepAmount: microToUsdc(sweepAmount) }, "Sweeping USDC to cold wallet...");

  const txid = await sendUsdc(
    algod, treasury, COLD_ADDRESS, sweepAmount,
    `x402:cold-sweep-usdc|${new Date().toISOString()}`,
  );

  const post = await getBalances(algod, treasury.addr.toString());
  await notify(`🧊 USDC Cold Sweep — ${microToUsdc(sweepAmount)} secured`, {
    "Swept":          microToUsdc(sweepAmount),
    "Cold wallet":    COLD_ADDRESS,
    "Treasury after": microToUsdc(post.usdc),
    "Txn ID":         txid,
  });
}

// ── Main cycle ────────────────────────────────────────────────────────────

async function runCycle(
  algod: algosdk.Algodv2, treasury: algosdk.Account, signerAddr: string,
): Promise<void> {
  const [signerAlgo, treasuryBal] = await Promise.all([
    getAlgoBalance(algod, signerAddr),
    getBalances(algod, treasury.addr.toString()),
  ]);

  log.info({
    signer:          microToAlgo(signerAlgo),
    alertBelow:      microToAlgo(SIGNER_ALERT_MICRO),
    treasury:        microToAlgo(treasuryBal.algo),
    treasuryUsdc:    microToUsdc(treasuryBal.usdc),
    algoCeiling:     COLD_ADDRESS ? microToAlgo(ALGO_CEILING_MICRO) : "disabled",
    usdcCeiling:     COLD_ADDRESS ? microToUsdc(USDC_CEILING_MICRO) : "disabled",
  }, "Guardian check");

  await checkSigner(algod, signerAddr);
  await sweepAlgo(algod, treasury, treasuryBal.algo);
  await sweepUsdc(algod, treasury, treasuryBal.usdc, treasuryBal.algo);
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const treasury   = loadAccount(requireEnv("ALGO_TREASURY_MNEMONIC"), "treasury");
  const signerAddr = requireEnv("ALGO_SIGNER_ADDRESS");

  if (!algosdk.isValidAddress(signerAddr)) {
    throw new Error(`ALGO_SIGNER_ADDRESS is not a valid Algorand address: ${signerAddr}`);
  }
  if (COLD_ADDRESS && !algosdk.isValidAddress(COLD_ADDRESS)) {
    throw new Error(`COLD_WALLET_ADDRESS is not a valid Algorand address: ${COLD_ADDRESS}`);
  }
  if (COLD_ADDRESS && COLD_ADDRESS === treasury.addr.toString()) {
    throw new Error("COLD_WALLET_ADDRESS must differ from treasury address");
  }

  const algod = buildAlgod();

  log.info({
    signerMonitor:   signerAddr,
    alertBelow:      microToAlgo(SIGNER_ALERT_MICRO),
    treasury:        treasury.addr.toString(),
    coldWallet:      COLD_ADDRESS || "not configured",
    algoCeiling:     COLD_ADDRESS ? microToAlgo(ALGO_CEILING_MICRO) : "disabled",
    usdcCeiling:     COLD_ADDRESS ? microToUsdc(USDC_CEILING_MICRO) : "disabled",
    checkIntervalS:  CHECK_INTERVAL_MS / 1000,
    telegram:        TG_TOKEN && TG_CHAT_ID ? `configured (chat ${TG_CHAT_ID})` : "not configured",
    webhook:         WEBHOOK_URL ? "configured" : "not set",
  }, "Wallet guardian starting");

  if (!TG_TOKEN && !WEBHOOK_URL && !process.env.SENTRY_DSN) {
    log.warn("No alert channel configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID");
  }
  if (!COLD_ADDRESS) {
    log.warn("Cold sweeps disabled — set COLD_WALLET_ADDRESS to enable");
  }

  let running = true;
  process.on("SIGTERM", () => { log.info("Shutting down"); running = false; });
  process.on("SIGINT",  () => { log.info("Shutting down"); running = false; });

  while (running) {
    try {
      await runCycle(algod, treasury, signerAddr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "Cycle error — retrying next interval");
      Sentry.captureException(err, { tags: { component: "wallet-guardian" } });
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, CHECK_INTERVAL_MS);
      if (typeof t.unref === "function") t.unref();
    });
  }
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "Fatal error");
  process.exit(1);
});
