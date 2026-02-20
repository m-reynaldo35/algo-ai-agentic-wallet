#!/usr/bin/env tsx
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FLYWHEEL TREASURY REFILL DAEMON                                         │
 * │                                                                          │
 * │  Three-stage hot wallet management bridging the gap until Rocca is live.│
 * │                                                                          │
 * │  Stage 1 — ALGO Refill (bottom pressure)                                │
 * │    When the signing wallet drops below REFILL_ALERT_THRESHOLD (40%),    │
 * │    automatically top it up from the treasury to WALLET_TARGET_ALGO.     │
 * │                                                                          │
 * │  Stage 2a — ALGO Cold Ceiling Sweep (top pressure)                      │
 * │    When the treasury ALGO exceeds TREASURY_CEILING_ALGO, sweep the      │
 * │    excess to the cold wallet. Ceiling must be > target.                 │
 * │                                                                          │
 * │  Stage 2b — USDC Cold Ceiling Sweep (top pressure)                      │
 * │    When the treasury USDC exceeds TREASURY_USDC_CEILING, sweep the      │
 * │    excess to the cold wallet (ASA transfer, cold must be opted in).     │
 * │                                                                          │
 * │  Alerts — Telegram + Webhook                                             │
 * │    Low signer balance, treasury can't cover refill, and sweeps all      │
 * │    fire instant Telegram messages (set TELEGRAM_BOT_TOKEN +             │
 * │    TELEGRAM_CHAT_ID) and/or a generic webhook (Slack / Discord).        │
 * │                                                                          │
 * │  Flow:                                                                   │
 * │                                                                          │
 * │    Cold wallet (Ledger / paper — opted in to USDC ASA 31566704)         │
 * │         ↑  ALGO sweep when treasury > TREASURY_CEILING_ALGO             │
 * │         ↑  USDC sweep when treasury > TREASURY_USDC_CEILING             │
 * │    Treasury wallet  ← max ALGO at-risk = ALGO ceiling                  │
 * │                     ← max USDC at-risk = USDC ceiling                  │
 * │         ↓  ALGO refill when signer < 40% of target                     │
 * │    Signing wallet   ← max ALGO at-risk = target                        │
 * │                                                                          │
 * │  Usage:   tsx scripts/treasury-refill.ts                                 │
 * │  Daemon:  Railway / PM2 / systemd                                        │
 * │                                                                          │
 * │  Required env vars:                                                      │
 * │    ALGO_TREASURY_MNEMONIC     25-word treasury wallet mnemonic           │
 * │    ALGO_SIGNER_MNEMONIC       25-word signing wallet mnemonic            │
 * │                                                                          │
 * │  Optional env vars:                                                      │
 * │    TELEGRAM_BOT_TOKEN         Bot token from @BotFather                  │
 * │    TELEGRAM_CHAT_ID           Your personal chat ID (see setup below)   │
 * │    ALERT_WEBHOOK_URL          Slack / Discord webhook URL                │
 * │    COLD_WALLET_ADDRESS        Cold wallet address for all sweeps         │
 * │    TREASURY_CEILING_ALGO      Max ALGO in treasury     (default 1000)   │
 * │    TREASURY_USDC_CEILING      Max USDC in treasury     (default 100)    │
 * │    WALLET_TARGET_ALGO         Target signer balance    (default 500)    │
 * │    TREASURY_MIN_RESERVE_ALGO  Min ALGO kept in treasury (default 10)    │
 * │    REFILL_ALERT_THRESHOLD     Alert fraction           (default 0.40)   │
 * │    REFILL_CHECK_INTERVAL_S    Poll interval in seconds (default 10)     │
 * │    SENTRY_DSN                 Sentry DSN for error reporting             │
 * │    ALGORAND_NODE_URL          Algod endpoint (default: Nodely mainnet)  │
 * │    ALGORAND_NODE_TOKEN        Algod auth token (default: empty)          │
 * │                                                                          │
 * │  Telegram setup (2 minutes):                                             │
 * │    1. Message @BotFather on Telegram → /newbot → follow prompts         │
 * │    2. Copy the bot token into TELEGRAM_BOT_TOKEN                        │
 * │    3. Message your new bot once (say anything)                           │
 * │    4. Visit: https://api.telegram.org/bot{TOKEN}/getUpdates             │
 * │    5. Copy "id" from the "chat" object → TELEGRAM_CHAT_ID               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import pino from "pino";
import * as Sentry from "@sentry/node";

// ── Constants ─────────────────────────────────────────────────────────────

const ALGO_MICRO          = 1_000_000n;  // 1 ALGO in microALGO
const USDC_MICRO          = 1_000_000n;  // 1 USDC in microUSDC (6 decimals)
const USDC_ASA_ID         = 31566704n;   // Circle USDC on Algorand mainnet
const MIN_ACCOUNT_BALANCE = 100_000n;    // 0.1 ALGO — Algorand min balance
const TX_FEE              = 1_000n;      // 0.001 ALGO standard fee
const CONFIRMATION_ROUNDS = 4;
const ALERT_COOLDOWN_MS   = 30 * 60_000; // Re-alert at most once per 30 min

// ── Config (from env) ─────────────────────────────────────────────────────

const ALGOD_URL   = process.env.ALGORAND_NODE_URL   || "https://mainnet-api.4160.nodely.dev";
const ALGOD_TOKEN = process.env.ALGORAND_NODE_TOKEN || "";

const TARGET_MICRO = BigInt(
  Math.round(parseFloat(process.env.WALLET_TARGET_ALGO || "500") * 1_000_000),
);
const ALGO_CEILING_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_CEILING_ALGO || "1000") * 1_000_000),
);
const USDC_CEILING_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_USDC_CEILING || "100") * 1_000_000),
);
const MIN_RESERVE_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_MIN_RESERVE_ALGO || "10") * 1_000_000),
);
const ALERT_THRESHOLD   = parseFloat(process.env.REFILL_ALERT_THRESHOLD || "0.40");
const CHECK_INTERVAL_MS = parseInt(process.env.REFILL_CHECK_INTERVAL_S || "10", 10) * 1000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const COLD_ADDRESS      = process.env.COLD_WALLET_ADDRESS || "";

// ── Telegram config ───────────────────────────────────────────────────────

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || "";

// ── Logger ────────────────────────────────────────────────────────────────

const log = pino({
  name: "treasury-refill",
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
  log.info("Sentry initialised");
}

// ── Env Validation ────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// ── Account Loader ────────────────────────────────────────────────────────

function loadAccount(mnemonic: string, label: string): algosdk.Account {
  try {
    return algosdk.mnemonicToSecretKey(mnemonic);
  } catch {
    throw new Error(`Invalid mnemonic for ${label} wallet`);
  }
}

// ── Algod Client ──────────────────────────────────────────────────────────

function buildAlgod(): algosdk.Algodv2 {
  return new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL);
}

// ── Balance Helpers ───────────────────────────────────────────────────────

interface TreasuryBalances {
  algo: bigint;
  usdc: bigint;
}

async function getTreasuryBalances(
  algod: algosdk.Algodv2,
  address: string,
): Promise<TreasuryBalances> {
  const info = await algod.accountInformation(address).do();
  const algo = BigInt(info.amount);
  const usdcAsset = (info.assets ?? []).find(
    (a: { assetId: bigint }) => a.assetId === USDC_ASA_ID,
  );
  const usdc = usdcAsset ? BigInt(usdcAsset.amount) : 0n;
  return { algo, usdc };
}

async function getAlgoBalance(algod: algosdk.Algodv2, address: string): Promise<bigint> {
  const info = await algod.accountInformation(address).do();
  return BigInt(info.amount);
}

function microToAlgo(micro: bigint): string {
  const whole = micro / ALGO_MICRO;
  const frac  = micro % ALGO_MICRO;
  return `${whole}.${frac.toString().padStart(6, "0")} ALGO`;
}

function microToUsdc(micro: bigint): string {
  const whole = micro / USDC_MICRO;
  const frac  = micro % USDC_MICRO;
  return `$${whole}.${frac.toString().padStart(6, "0")} USDC`;
}

function pctStr(current: bigint, target: bigint): string {
  if (target === 0n) return "0%";
  return ((Number(current) / Number(target)) * 100).toFixed(1) + "%";
}

// ── Telegram ──────────────────────────────────────────────────────────────

/**
 * Send a Telegram message directly to your phone.
 * Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 * Never throws — failures are logged but don't break the daemon.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot
 *   2. Copy token → TELEGRAM_BOT_TOKEN
 *   3. Message your bot once, then visit:
 *      https://api.telegram.org/bot{TOKEN}/getUpdates
 *   4. Copy "id" from the "chat" object → TELEGRAM_CHAT_ID
 */
async function sendTelegram(message: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  try {
    const url  = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    TG_CHAT_ID,
      text:       message,
      parse_mode: "HTML",
    });

    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  AbortSignal.timeout(8_000),
    });

    if (res.ok) {
      log.info("Telegram alert delivered");
    } else {
      const err = await res.text().catch(() => "");
      log.warn({ status: res.status, err }, "Telegram delivery failed");
    }
  } catch (err) {
    log.warn({ err }, "Telegram request failed");
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────

function buildMessageBody(message: string, fields: Record<string, string>): string {
  const detail = Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return `${message}\n${detail}`;
}

async function postWebhook(message: string, fields: Record<string, string>): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;

  const text = buildMessageBody(message, fields);
  try {
    const body = JSON.stringify({ text, content: text, username: "x402 Treasury Monitor" });
    const res  = await fetch(ALERT_WEBHOOK_URL, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":   "x402-treasury-refill/1.0",
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      log.info("Webhook notification delivered");
    } else {
      log.warn({ status: res.status }, "Webhook returned non-2xx");
    }
  } catch (err) {
    log.warn({ err }, "Webhook delivery failed");
  }
}

// ── Unified notification dispatch ────────────────────────────────────────
// All notifications go through here — Telegram + webhook fired in parallel.

async function notify(
  message: string,
  fields:  Record<string, string>,
  level:   "alert" | "info" = "info",
): Promise<void> {
  const body = buildMessageBody(message, fields);

  await Promise.allSettled([
    sendTelegram(body),
    postWebhook(message, fields),
    level === "alert" && process.env.SENTRY_DSN
      ? Promise.resolve(
          Sentry.captureMessage(body, {
            level: "warning",
            tags: {
              component: "treasury-refill",
              ...Object.fromEntries(
                Object.entries(fields).map(([k, v]) => [
                  k.toLowerCase().replace(/\s/g, "_"),
                  v,
                ]),
              ),
            },
          }),
        )
      : Promise.resolve(),
  ]);

  if (level === "alert" && !TG_TOKEN && !ALERT_WEBHOOK_URL && !process.env.SENTRY_DSN) {
    log.warn("No alert channel configured — set TELEGRAM_BOT_TOKEN/CHAT_ID, ALERT_WEBHOOK_URL, or SENTRY_DSN");
  }
}

// ── Alert (warning-level, 30-min cooldown) ────────────────────────────────

let lastAlertMs = 0;

async function sendAlert(message: string, fields: Record<string, string>): Promise<void> {
  const now = Date.now();
  if (now - lastAlertMs < ALERT_COOLDOWN_MS) {
    log.debug("Alert suppressed (within cooldown window)");
    return;
  }
  lastAlertMs = now;
  await notify(message, fields, "alert");
}

// ── Notify (info-level, no cooldown) ─────────────────────────────────────

async function sendNotify(message: string, fields: Record<string, string>): Promise<void> {
  await notify(message, fields, "info");
}

// ── Signed ALGO Payment ───────────────────────────────────────────────────

async function sendAlgoPayment(
  algod:    algosdk.Algodv2,
  from:     algosdk.Account,
  to:       string,
  amount:   bigint,
  noteText: string,
): Promise<string> {
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          from.addr.toString(),
    receiver:        to,
    amount,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(noteText)),
  });

  const signedTxn = txn.signTxn(from.sk);
  const { txid }  = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);

  return txid;
}

// ── Signed USDC (ASA) Transfer ────────────────────────────────────────────

async function sendUsdcTransfer(
  algod:    algosdk.Algodv2,
  from:     algosdk.Account,
  to:       string,
  amount:   bigint,
  noteText: string,
): Promise<string> {
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          from.addr.toString(),
    receiver:        to,
    amount,
    assetIndex:      USDC_ASA_ID,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(noteText)),
  });

  const signedTxn = txn.signTxn(from.sk);
  const { txid }  = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);

  return txid;
}

// ── Stage 1: ALGO Refill signer from treasury ─────────────────────────────

async function maybeRefillSigner(
  algod:         algosdk.Algodv2,
  treasury:      algosdk.Account,
  signerAddr:    string,
  signerBalance: bigint,
): Promise<void> {
  const pct      = Number(signerBalance) / Number(TARGET_MICRO);
  const pctLabel = pctStr(signerBalance, TARGET_MICRO);

  if (pct > ALERT_THRESHOLD) return;

  log.warn(
    { signerBalance: microToAlgo(signerBalance), pct: pctLabel },
    `Signer wallet below ${(ALERT_THRESHOLD * 100).toFixed(0)}% threshold`,
  );

  const treasuryAlgo = await getAlgoBalance(algod, treasury.addr.toString());
  const topUpMicro   = TARGET_MICRO - signerBalance;
  const required     = topUpMicro + MIN_RESERVE_MICRO + TX_FEE + MIN_ACCOUNT_BALANCE;

  await sendAlert(
    `⚠️ x402 Signer Wallet Low — ${pctLabel} full`,
    {
      "Signer balance": microToAlgo(signerBalance),
      "Target":         microToAlgo(TARGET_MICRO),
      "Fill level":     pctLabel,
      "Top-up needed":  microToAlgo(topUpMicro),
      "Treasury ALGO":  microToAlgo(treasuryAlgo),
    },
  );

  if (treasuryAlgo < required) {
    log.error(
      { treasuryAlgo: microToAlgo(treasuryAlgo), required: microToAlgo(required) },
      "Treasury ALGO too low to refill — manual top-up required",
    );
    await sendAlert(
      `🚨 ACTION REQUIRED — Treasury Cannot Cover Refill\nPlease deposit ALGO to treasury wallet immediately.`,
      {
        "Treasury wallet": treasury.addr.toString(),
        "Treasury ALGO":   microToAlgo(treasuryAlgo),
        "Required":        microToAlgo(required),
        "Shortfall":       microToAlgo(required - treasuryAlgo),
      },
    );
    return;
  }

  log.info(
    { topUp: microToAlgo(topUpMicro), to: signerAddr },
    "Sending ALGO refill...",
  );

  const txid = await sendAlgoPayment(
    algod, treasury, signerAddr, topUpMicro,
    `x402:treasury-refill|${new Date().toISOString()}|${topUpMicro}uA`,
  );

  const newBalance = await getAlgoBalance(algod, signerAddr);
  log.info(
    {
      txid,
      topUp:      microToAlgo(topUpMicro),
      newBalance: microToAlgo(newBalance),
      newPct:     pctStr(newBalance, TARGET_MICRO),
    },
    "ALGO refill confirmed ✓",
  );
}

// ── Stage 2a: ALGO cold ceiling sweep ────────────────────────────────────

async function maybeSweepAlgoToCold(
  algod:        algosdk.Algodv2,
  treasury:     algosdk.Account,
  treasuryAlgo: bigint,
): Promise<void> {
  if (!COLD_ADDRESS) return;
  if (treasuryAlgo <= ALGO_CEILING_MICRO) return;

  // Post-sweep treasury = ALGO_CEILING_MICRO; fee comes out of the excess.
  const sweepAmount = treasuryAlgo - ALGO_CEILING_MICRO - TX_FEE;
  if (sweepAmount <= 0n) {
    log.debug("ALGO sweep skipped — excess too small to cover fee");
    return;
  }

  log.info(
    {
      treasuryAlgo: microToAlgo(treasuryAlgo),
      ceiling:      microToAlgo(ALGO_CEILING_MICRO),
      sweepAmount:  microToAlgo(sweepAmount),
      to:           COLD_ADDRESS,
    },
    "ALGO above ceiling — sweeping to cold wallet...",
  );

  const txid = await sendAlgoPayment(
    algod, treasury, COLD_ADDRESS, sweepAmount,
    `x402:cold-sweep-algo|${new Date().toISOString()}|${sweepAmount}uA`,
  );

  const post = await getAlgoBalance(algod, treasury.addr.toString());
  log.info({ txid, swept: microToAlgo(sweepAmount), treasuryPost: microToAlgo(post) }, "ALGO cold sweep confirmed ✓");

  await sendNotify(
    `🧊 x402 ALGO Cold Sweep — ${microToAlgo(sweepAmount)} secured`,
    {
      "Swept":          microToAlgo(sweepAmount),
      "Cold wallet":    COLD_ADDRESS,
      "Treasury after": microToAlgo(post),
      "Txn ID":         txid,
    },
  );
}

// ── Stage 2b: USDC cold ceiling sweep ────────────────────────────────────

async function maybeSweepUsdcToCold(
  algod:        algosdk.Algodv2,
  treasury:     algosdk.Account,
  treasuryUsdc: bigint,
  treasuryAlgo: bigint,
): Promise<void> {
  if (!COLD_ADDRESS) return;
  if (treasuryUsdc <= USDC_CEILING_MICRO) return;

  const sweepAmount = treasuryUsdc - USDC_CEILING_MICRO;

  if (treasuryAlgo < MIN_ACCOUNT_BALANCE + TX_FEE) {
    log.error(
      { treasuryAlgo: microToAlgo(treasuryAlgo) },
      "Treasury has insufficient ALGO to pay USDC sweep fee — skipping",
    );
    await sendAlert(
      `🚨 Treasury Cannot Pay USDC Sweep Fee`,
      {
        "Treasury ALGO": microToAlgo(treasuryAlgo),
        "Fee required":  microToAlgo(TX_FEE),
        "USDC pending":  microToUsdc(sweepAmount),
      },
    );
    return;
  }

  log.info(
    {
      treasuryUsdc: microToUsdc(treasuryUsdc),
      ceiling:      microToUsdc(USDC_CEILING_MICRO),
      sweepAmount:  microToUsdc(sweepAmount),
      to:           COLD_ADDRESS,
    },
    "USDC above ceiling — sweeping to cold wallet...",
  );

  const txid = await sendUsdcTransfer(
    algod, treasury, COLD_ADDRESS, sweepAmount,
    `x402:cold-sweep-usdc|${new Date().toISOString()}|${sweepAmount}uUSDC`,
  );

  const postBalances = await getTreasuryBalances(algod, treasury.addr.toString());
  log.info(
    { txid, swept: microToUsdc(sweepAmount), treasuryUsdcPost: microToUsdc(postBalances.usdc) },
    "USDC cold sweep confirmed ✓",
  );

  await sendNotify(
    `🧊 x402 USDC Cold Sweep — ${microToUsdc(sweepAmount)} secured`,
    {
      "Swept":          microToUsdc(sweepAmount),
      "Cold wallet":    COLD_ADDRESS,
      "Treasury after": microToUsdc(postBalances.usdc),
      "Txn ID":         txid,
    },
  );
}

// ── Main Check Cycle ──────────────────────────────────────────────────────

async function runCycle(
  algod:      algosdk.Algodv2,
  treasury:   algosdk.Account,
  signerAddr: string,
): Promise<void> {
  const [signerAlgo, treasuryBalances] = await Promise.all([
    getAlgoBalance(algod, signerAddr),
    getTreasuryBalances(algod, treasury.addr.toString()),
  ]);

  log.info(
    {
      signer:       microToAlgo(signerAlgo),
      fillPct:      pctStr(signerAlgo, TARGET_MICRO),
      treasury:     microToAlgo(treasuryBalances.algo),
      treasuryUsdc: microToUsdc(treasuryBalances.usdc),
      algoCeiling:  COLD_ADDRESS ? microToAlgo(ALGO_CEILING_MICRO) : "disabled",
      usdcCeiling:  COLD_ADDRESS ? microToUsdc(USDC_CEILING_MICRO) : "disabled",
    },
    "Balance check",
  );

  await maybeRefillSigner(algod, treasury, signerAddr, signerAlgo);
  await maybeSweepAlgoToCold(algod, treasury, treasuryBalances.algo);
  await maybeSweepUsdcToCold(algod, treasury, treasuryBalances.usdc, treasuryBalances.algo);
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const treasuryMnemonic = requireEnv("ALGO_TREASURY_MNEMONIC");
  const signerMnemonic   = requireEnv("ALGO_SIGNER_MNEMONIC");

  const treasury   = loadAccount(treasuryMnemonic, "treasury");
  const signer     = loadAccount(signerMnemonic,   "signer");
  const signerAddr = signer.addr.toString();

  signer.sk.fill(0);

  if (treasury.addr.toString() === signerAddr) {
    throw new Error("ALGO_TREASURY_MNEMONIC and ALGO_SIGNER_MNEMONIC must be different wallets");
  }

  // Guard: ceiling must be larger than target so treasury can always fund a full refill
  if (ALGO_CEILING_MICRO <= TARGET_MICRO) {
    throw new Error(
      `TREASURY_CEILING_ALGO (${microToAlgo(ALGO_CEILING_MICRO)}) must be greater than WALLET_TARGET_ALGO (${microToAlgo(TARGET_MICRO)})`,
    );
  }

  if (COLD_ADDRESS) {
    if (!algosdk.isValidAddress(COLD_ADDRESS)) {
      throw new Error(`COLD_WALLET_ADDRESS is not a valid Algorand address: ${COLD_ADDRESS}`);
    }
    if (COLD_ADDRESS === treasury.addr.toString()) {
      throw new Error("COLD_WALLET_ADDRESS must differ from treasury address");
    }
    if (COLD_ADDRESS === signerAddr) {
      throw new Error("COLD_WALLET_ADDRESS must differ from signer address");
    }
  }

  const algod = buildAlgod();

  const telegramStatus = TG_TOKEN && TG_CHAT_ID
    ? `configured (chat ${TG_CHAT_ID})`
    : TG_TOKEN
      ? "token set but TELEGRAM_CHAT_ID missing"
      : "not configured";

  log.info(
    {
      treasury:        treasury.addr.toString(),
      signer:          signerAddr,
      coldWallet:      COLD_ADDRESS || "not configured",
      targetAlgo:      microToAlgo(TARGET_MICRO),
      algoCeiling:     COLD_ADDRESS ? microToAlgo(ALGO_CEILING_MICRO) : "disabled",
      usdcCeiling:     COLD_ADDRESS ? microToUsdc(USDC_CEILING_MICRO) : "disabled",
      minReserveAlgo:  microToAlgo(MIN_RESERVE_MICRO),
      alertThreshold:  `${(ALERT_THRESHOLD * 100).toFixed(0)}%`,
      checkIntervalS:  CHECK_INTERVAL_MS / 1000,
      telegram:        telegramStatus,
      webhook:         ALERT_WEBHOOK_URL ? "configured" : "not set",
      sentry:          process.env.SENTRY_DSN ? "configured" : "not set",
    },
    "Treasury refill daemon starting",
  );

  if (!TG_TOKEN && !ALERT_WEBHOOK_URL && !process.env.SENTRY_DSN) {
    log.warn("No alert channel configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to receive phone alerts");
  }

  if (!COLD_ADDRESS) {
    log.warn("Cold sweeps disabled — set COLD_WALLET_ADDRESS to enable ALGO + USDC ceiling sweeps");
  }

  let running = true;
  const shutdown = (): void => {
    log.info("Shutting down treasury refill daemon");
    running = false;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);

  while (running) {
    try {
      await runCycle(algod, treasury, signerAddr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "Cycle error — will retry next interval");
      Sentry.captureException(err, { tags: { component: "treasury-refill" } });
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CHECK_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "Fatal startup error");
  process.exit(1);
});
