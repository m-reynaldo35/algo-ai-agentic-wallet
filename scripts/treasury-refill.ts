#!/usr/bin/env tsx
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FLYWHEEL TREASURY REFILL DAEMON                                         │
 * │                                                                          │
 * │  Monitors the signing wallet ALGO balance and automatically refills it   │
 * │  from the treasury wallet when it drops below the alert threshold.       │
 * │  Bridges the gap until full Rocca Wallet integration is live.           │
 * │                                                                          │
 * │  Flow:                                                                   │
 * │    treasury wallet ──(top-up payment)──▶ signing wallet                 │
 * │                                                                          │
 * │  Alert threshold: REFILL_ALERT_THRESHOLD (default: 40% of target)       │
 * │  On breach:  1. Fire Sentry warning                                      │
 * │              2. POST to ALERT_WEBHOOK_URL (Slack / Discord / generic)   │
 * │              3. Send exact top-up from treasury → signer                │
 * │                                                                          │
 * │  Usage:   tsx scripts/treasury-refill.ts                                 │
 * │  Daemon:  Railway / PM2 / systemd (set REFILL_CHECK_INTERVAL_S)         │
 * │                                                                          │
 * │  Required env vars:                                                      │
 * │    ALGO_TREASURY_MNEMONIC     25-word treasury wallet mnemonic           │
 * │    ALGO_SIGNER_MNEMONIC       25-word signing wallet mnemonic            │
 * │                                                                          │
 * │  Optional env vars:                                                      │
 * │    WALLET_TARGET_ALGO         Target signer balance in ALGO (default 10) │
 * │    TREASURY_MIN_RESERVE_ALGO  Min ALGO kept in treasury  (default 2)    │
 * │    REFILL_ALERT_THRESHOLD     Fraction that triggers alert (default 0.40)│
 * │    REFILL_CHECK_INTERVAL_S    Poll interval in seconds   (default 60)   │
 * │    ALERT_WEBHOOK_URL          Slack / Discord webhook URL for alerts     │
 * │    SENTRY_DSN                 Sentry DSN for captured warnings           │
 * │    ALGORAND_NODE_URL          Algod endpoint (default: Nodely mainnet)  │
 * │    ALGORAND_NODE_TOKEN        Algod auth token (default: empty)          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import "dotenv/config";
import algosdk from "algosdk";
import pino from "pino";
import * as Sentry from "@sentry/node";

// ── Constants ─────────────────────────────────────────────────────────────

const ALGO_MICRO = 1_000_000n;           // 1 ALGO in microALGO
const MIN_ACCOUNT_BALANCE = 100_000n;    // 0.1 ALGO — Algorand min balance
const TX_FEE = 1_000n;                   // 0.001 ALGO standard fee
const CONFIRMATION_ROUNDS = 4;
const ALERT_COOLDOWN_MS = 30 * 60_000;  // Re-alert at most once per 30 min

// ── Config (from env) ─────────────────────────────────────────────────────

const ALGOD_URL   = process.env.ALGORAND_NODE_URL   || "https://mainnet-api.4160.nodely.dev";
const ALGOD_TOKEN = process.env.ALGORAND_NODE_TOKEN  || "";

const TARGET_MICRO = BigInt(
  Math.round(parseFloat(process.env.WALLET_TARGET_ALGO || "10") * 1_000_000),
);
const MIN_RESERVE_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_MIN_RESERVE_ALGO || "2") * 1_000_000),
);
const ALERT_THRESHOLD = parseFloat(process.env.REFILL_ALERT_THRESHOLD || "0.40");
const CHECK_INTERVAL_MS = parseInt(process.env.REFILL_CHECK_INTERVAL_S || "60", 10) * 1000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

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

/**
 * Load an Algorand account from a 25-word mnemonic.
 * The account object (addr + sk) lives only in process memory —
 * never written to disk or logged.
 */
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

async function getBalance(algod: algosdk.Algodv2, address: string): Promise<bigint> {
  const info = await algod.accountInformation(address).do();
  return BigInt(info.amount);
}

function microToAlgo(micro: bigint): string {
  const whole = micro / ALGO_MICRO;
  const frac  = micro % ALGO_MICRO;
  return `${whole}.${frac.toString().padStart(6, "0")} ALGO`;
}

function pctStr(current: bigint, target: bigint): string {
  if (target === 0n) return "0%";
  return ((Number(current) / Number(target)) * 100).toFixed(1) + "%";
}

// ── Alert ─────────────────────────────────────────────────────────────────

let lastAlertMs = 0;

async function sendAlert(message: string, fields: Record<string, string>): Promise<void> {
  const now = Date.now();
  if (now - lastAlertMs < ALERT_COOLDOWN_MS) {
    log.debug("Alert suppressed (within cooldown window)");
    return;
  }
  lastAlertMs = now;

  const detail = Object.entries(fields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const fullMessage = `${message}\n${detail}`;

  // ── Sentry warning ────────────────────────────────────────────
  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(fullMessage, {
      level: "warning",
      tags: { component: "treasury-refill", ...Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k.toLowerCase().replace(/\s/g, "_"), v]),
      )},
    });
    log.info("Sentry alert fired");
  }

  // ── Webhook (Slack / Discord / generic) ───────────────────────
  if (ALERT_WEBHOOK_URL) {
    try {
      // Works with Slack (uses "text") and Discord (uses "content")
      const body = JSON.stringify({
        text: fullMessage,
        content: fullMessage,
        username: "x402 Treasury Monitor",
      });
      const res = await fetch(ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "x402-treasury-refill/1.0" },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        log.info("Webhook alert delivered");
      } else {
        log.warn({ status: res.status }, "Webhook alert returned non-2xx");
      }
    } catch (err) {
      log.warn({ err }, "Webhook alert failed");
    }
  }

  if (!process.env.SENTRY_DSN && !ALERT_WEBHOOK_URL) {
    log.warn("No alert channel configured — set SENTRY_DSN or ALERT_WEBHOOK_URL");
  }
}

// ── Refill Transaction ────────────────────────────────────────────────────

/**
 * Send exactly `topUpMicro` microALGO from treasury → signer.
 * Returns the confirmed transaction ID.
 */
async function sendRefill(
  algod: algosdk.Algodv2,
  treasury: algosdk.Account,
  signerAddr: string,
  topUpMicro: bigint,
): Promise<string> {
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:     treasury.addr.toString(),
    receiver:   signerAddr,
    amount:     topUpMicro,
    suggestedParams: params,
    note: new Uint8Array(
      Buffer.from(`x402:treasury-refill|${new Date().toISOString()}|${topUpMicro}uA`),
    ),
  });

  const signedTxn = txn.signTxn(treasury.sk);
  const { txid } = await algod.sendRawTransaction(signedTxn).do();

  log.info({ txid }, "Refill submitted — awaiting confirmation");
  await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);

  return txid;
}

// ── Main Check Cycle ──────────────────────────────────────────────────────

async function runCycle(
  algod: algosdk.Algodv2,
  treasury: algosdk.Account,
  signerAddr: string,
): Promise<void> {
  const signerBalance = await getBalance(algod, signerAddr);
  const pct = Number(signerBalance) / Number(TARGET_MICRO);
  const pctLabel = pctStr(signerBalance, TARGET_MICRO);

  log.info(
    {
      signer:  microToAlgo(signerBalance),
      target:  microToAlgo(TARGET_MICRO),
      fullPct: pctLabel,
    },
    "Balance check",
  );

  // ── Below threshold — alert + refill ──────────────────────────
  if (pct <= ALERT_THRESHOLD) {
    log.warn(
      { signerBalance: microToAlgo(signerBalance), pct: pctLabel },
      `Signer wallet below ${(ALERT_THRESHOLD * 100).toFixed(0)}% threshold`,
    );

    const treasuryBalance = await getBalance(algod, treasury.addr.toString());
    const topUpMicro = TARGET_MICRO - signerBalance;

    // Guard: treasury must keep its minimum reserve after covering the refill + fee
    const required = topUpMicro + MIN_RESERVE_MICRO + TX_FEE + MIN_ACCOUNT_BALANCE;

    await sendAlert(
      `⚠️  x402 Signer Wallet Low — ${pctLabel} full`,
      {
        "Signer balance":   microToAlgo(signerBalance),
        "Target balance":   microToAlgo(TARGET_MICRO),
        "Fill level":       pctLabel,
        "Top-up needed":    microToAlgo(topUpMicro),
        "Treasury balance": microToAlgo(treasuryBalance),
      },
    );

    if (treasuryBalance < required) {
      log.error(
        {
          treasuryBalance: microToAlgo(treasuryBalance),
          required: microToAlgo(required),
        },
        "Treasury balance too low to refill — manual intervention required",
      );
      await sendAlert(
        `🚨  x402 Treasury Cannot Cover Refill`,
        {
          "Treasury balance": microToAlgo(treasuryBalance),
          "Required":         microToAlgo(required),
          "Shortfall":        microToAlgo(required - treasuryBalance),
        },
      );
      return;
    }

    try {
      log.info(
        { topUp: microToAlgo(topUpMicro), from: treasury.addr.toString(), to: signerAddr },
        "Sending refill...",
      );

      const txid = await sendRefill(algod, treasury, signerAddr, topUpMicro);

      const newBalance = await getBalance(algod, signerAddr);
      log.info(
        {
          txid,
          topUp:      microToAlgo(topUpMicro),
          newBalance: microToAlgo(newBalance),
          newPct:     pctStr(newBalance, TARGET_MICRO),
        },
        "Refill confirmed ✓",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "Refill transaction failed");
      Sentry.captureException(err, { tags: { component: "treasury-refill" } });
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate required env vars up front — fail fast before entering the loop
  const treasuryMnemonic = requireEnv("ALGO_TREASURY_MNEMONIC");
  const signerMnemonic   = requireEnv("ALGO_SIGNER_MNEMONIC");

  const treasury  = loadAccount(treasuryMnemonic, "treasury");
  const signer    = loadAccount(signerMnemonic,   "signer");
  const signerAddr = signer.addr.toString();

  // Immediately wipe the signer secret key — we only need the address here.
  // The treasury sk is kept in memory for signing refill transactions.
  signer.sk.fill(0);

  if (treasury.addr.toString() === signerAddr) {
    throw new Error("ALGO_TREASURY_MNEMONIC and ALGO_SIGNER_MNEMONIC must be different wallets");
  }

  const algod = buildAlgod();

  log.info(
    {
      treasury:        treasury.addr.toString(),
      signer:          signerAddr,
      targetAlgo:      microToAlgo(TARGET_MICRO),
      minReserveAlgo:  microToAlgo(MIN_RESERVE_MICRO),
      alertThreshold:  `${(ALERT_THRESHOLD * 100).toFixed(0)}%`,
      checkIntervalS:  CHECK_INTERVAL_MS / 1000,
      alertWebhook:    ALERT_WEBHOOK_URL ? "configured" : "not set",
      sentry:          process.env.SENTRY_DSN ? "configured" : "not set",
    },
    "Treasury refill daemon starting",
  );

  // ── Graceful shutdown ─────────────────────────────────────────
  let running = true;
  const shutdown = (): void => {
    log.info("Shutting down treasury refill daemon");
    running = false;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);

  // ── Main loop ─────────────────────────────────────────────────
  while (running) {
    try {
      await runCycle(algod, treasury, signerAddr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "Cycle error — will retry next interval");
      Sentry.captureException(err, { tags: { component: "treasury-refill" } });
    }

    // Sleep between cycles using a short-circuit-safe delay
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CHECK_INTERVAL_MS);
      // Unref so the timer doesn't block Node exit on shutdown signal
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "Fatal startup error");
  process.exit(1);
});
