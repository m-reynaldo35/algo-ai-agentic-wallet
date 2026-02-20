#!/usr/bin/env tsx
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  FLYWHEEL TREASURY REFILL DAEMON                                         │
 * │                                                                          │
 * │  Two-stage hot wallet management bridging the gap until Rocca is live.  │
 * │                                                                          │
 * │  Stage 1 — Refill (bottom pressure)                                     │
 * │    When the signing wallet drops below REFILL_ALERT_THRESHOLD (40%),    │
 * │    automatically top it up from the treasury to WALLET_TARGET_ALGO.     │
 * │                                                                          │
 * │  Stage 2 — Cold Ceiling Sweep (top pressure)                            │
 * │    When the treasury exceeds TREASURY_CEILING_ALGO, sweep the excess    │
 * │    to a cold wallet address. The cold wallet address is public-only —   │
 * │    its private key never touches this process. This bounds the maximum  │
 * │    funds at risk in the hot zone to ceiling + target ALGO.              │
 * │                                                                          │
 * │  Flow:                                                                   │
 * │                                                                          │
 * │    Cold wallet (Ledger / paper)                                          │
 * │         ↑  auto-sweep when treasury > TREASURY_CEILING_ALGO             │
 * │    Treasury wallet  ← max at-risk = ceiling                             │
 * │         ↓  auto-refill when signer < 40% of target                      │
 * │    Signing wallet   ← max at-risk = target                              │
 * │                                                                          │
 * │  Usage:   tsx scripts/treasury-refill.ts                                 │
 * │  Daemon:  Railway / PM2 / systemd (set REFILL_CHECK_INTERVAL_S)         │
 * │                                                                          │
 * │  Required env vars:                                                      │
 * │    ALGO_TREASURY_MNEMONIC     25-word treasury wallet mnemonic           │
 * │    ALGO_SIGNER_MNEMONIC       25-word signing wallet mnemonic            │
 * │                                                                          │
 * │  Optional env vars:                                                      │
 * │    COLD_WALLET_ADDRESS        Cold wallet address for ceiling sweeps     │
 * │    TREASURY_CEILING_ALGO      Max ALGO to keep in treasury  (default 50)│
 * │    WALLET_TARGET_ALGO         Target signer balance in ALGO (default 10) │
 * │    TREASURY_MIN_RESERVE_ALGO  Min ALGO kept in treasury    (default 2)  │
 * │    REFILL_ALERT_THRESHOLD     Fraction that triggers alert (default 0.40)│
 * │    REFILL_CHECK_INTERVAL_S    Poll interval in seconds     (default 60) │
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

const ALGO_MICRO          = 1_000_000n;  // 1 ALGO in microALGO
const MIN_ACCOUNT_BALANCE = 100_000n;    // 0.1 ALGO — Algorand min balance
const TX_FEE              = 1_000n;      // 0.001 ALGO standard fee
const CONFIRMATION_ROUNDS = 4;
const ALERT_COOLDOWN_MS   = 30 * 60_000; // Re-alert at most once per 30 min

// ── Config (from env) ─────────────────────────────────────────────────────

const ALGOD_URL   = process.env.ALGORAND_NODE_URL   || "https://mainnet-api.4160.nodely.dev";
const ALGOD_TOKEN = process.env.ALGORAND_NODE_TOKEN || "";

const TARGET_MICRO = BigInt(
  Math.round(parseFloat(process.env.WALLET_TARGET_ALGO || "10") * 1_000_000),
);
const CEILING_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_CEILING_ALGO || "50") * 1_000_000),
);
const MIN_RESERVE_MICRO = BigInt(
  Math.round(parseFloat(process.env.TREASURY_MIN_RESERVE_ALGO || "2") * 1_000_000),
);
const ALERT_THRESHOLD   = parseFloat(process.env.REFILL_ALERT_THRESHOLD || "0.40");
const CHECK_INTERVAL_MS = parseInt(process.env.REFILL_CHECK_INTERVAL_S || "60", 10) * 1000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const COLD_ADDRESS      = process.env.COLD_WALLET_ADDRESS || "";

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

// ── Alert (warning-level, 30-min cooldown) ────────────────────────────────

let lastAlertMs = 0;

async function sendAlert(message: string, fields: Record<string, string>): Promise<void> {
  const now = Date.now();
  if (now - lastAlertMs < ALERT_COOLDOWN_MS) {
    log.debug("Alert suppressed (within cooldown window)");
    return;
  }
  lastAlertMs = now;

  await postWebhook(message, fields);

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(buildMessageBody(message, fields), {
      level: "warning",
      tags: {
        component: "treasury-refill",
        ...Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k.toLowerCase().replace(/\s/g, "_"), v]),
        ),
      },
    });
    log.info("Sentry alert fired");
  }

  if (!process.env.SENTRY_DSN && !ALERT_WEBHOOK_URL) {
    log.warn("No alert channel configured — set SENTRY_DSN or ALERT_WEBHOOK_URL");
  }
}

// ── Notify (info-level, no cooldown) ─────────────────────────────────────
// Used for sweep confirmations — these are working-as-designed events,
// not warnings. Each one carries a unique txid so there is no spam risk.

async function sendNotify(message: string, fields: Record<string, string>): Promise<void> {
  await postWebhook(message, fields);
}

// ── Shared webhook POST ───────────────────────────────────────────────────

function buildMessageBody(message: string, fields: Record<string, string>): string {
  const detail = Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return `${message}\n${detail}`;
}

async function postWebhook(message: string, fields: Record<string, string>): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;

  const text = buildMessageBody(message, fields);
  try {
    // Works with Slack (uses "text") and Discord (uses "content")
    const body = JSON.stringify({ text, content: text, username: "x402 Treasury Monitor" });
    const res  = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "x402-treasury-refill/1.0",
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

// ── Signed Payment Helper ─────────────────────────────────────────────────

async function sendPayment(
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

// ── Stage 1: Refill signer from treasury ─────────────────────────────────

async function maybeRefillSigner(
  algod:           algosdk.Algodv2,
  treasury:        algosdk.Account,
  signerAddr:      string,
  signerBalance:   bigint,
): Promise<void> {
  const pct      = Number(signerBalance) / Number(TARGET_MICRO);
  const pctLabel = pctStr(signerBalance, TARGET_MICRO);

  if (pct > ALERT_THRESHOLD) return; // Healthy — nothing to do

  log.warn(
    { signerBalance: microToAlgo(signerBalance), pct: pctLabel },
    `Signer wallet below ${(ALERT_THRESHOLD * 100).toFixed(0)}% threshold`,
  );

  const treasuryBalance = await getBalance(algod, treasury.addr.toString());
  const topUpMicro      = TARGET_MICRO - signerBalance;

  // Guard: treasury must retain its minimum reserve + fee after refill
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
      { treasuryBalance: microToAlgo(treasuryBalance), required: microToAlgo(required) },
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

  log.info(
    { topUp: microToAlgo(topUpMicro), from: treasury.addr.toString(), to: signerAddr },
    "Sending refill...",
  );

  const txid = await sendPayment(
    algod, treasury, signerAddr, topUpMicro,
    `x402:treasury-refill|${new Date().toISOString()}|${topUpMicro}uA`,
  );

  const newBalance = await getBalance(algod, signerAddr);
  log.info(
    { txid, topUp: microToAlgo(topUpMicro), newBalance: microToAlgo(newBalance), newPct: pctStr(newBalance, TARGET_MICRO) },
    "Refill confirmed ✓",
  );
}

// ── Stage 2: Sweep treasury excess to cold wallet ────────────────────────

async function maybeSweepToCold(
  algod:           algosdk.Algodv2,
  treasury:        algosdk.Account,
  treasuryBalance: bigint,
): Promise<void> {
  if (!COLD_ADDRESS) return; // Cold sweep not configured — skip silently

  if (treasuryBalance <= CEILING_MICRO) return; // Below ceiling — nothing to sweep

  // sweepAmount: bring treasury exactly down to ceiling after paying the tx fee.
  //   post-sweep treasury = treasuryBalance - sweepAmount - TX_FEE = CEILING_MICRO
  //   ∴ sweepAmount = treasuryBalance - CEILING_MICRO - TX_FEE
  const sweepAmount = treasuryBalance - CEILING_MICRO - TX_FEE;

  if (sweepAmount <= 0n) {
    // The excess is too small to cover even the fee — nothing to do.
    log.debug({ excess: microToAlgo(treasuryBalance - CEILING_MICRO) }, "Sweep skipped — excess too small to cover fee");
    return;
  }

  log.info(
    {
      treasuryBalance: microToAlgo(treasuryBalance),
      ceiling:         microToAlgo(CEILING_MICRO),
      sweepAmount:     microToAlgo(sweepAmount),
      coldAddress:     COLD_ADDRESS,
    },
    "Treasury above ceiling — sweeping excess to cold wallet...",
  );

  const txid = await sendPayment(
    algod, treasury, COLD_ADDRESS, sweepAmount,
    `x402:cold-sweep|${new Date().toISOString()}|${sweepAmount}uA`,
  );

  const postSweepBalance = await getBalance(algod, treasury.addr.toString());
  log.info(
    {
      txid,
      swept:              microToAlgo(sweepAmount),
      coldAddress:        COLD_ADDRESS,
      treasuryPostSweep:  microToAlgo(postSweepBalance),
    },
    "Cold sweep confirmed ✓",
  );

  await sendNotify(
    `🧊  x402 Cold Sweep — ${microToAlgo(sweepAmount)} secured`,
    {
      "Swept":                microToAlgo(sweepAmount),
      "Cold wallet":          COLD_ADDRESS,
      "Treasury post-sweep":  microToAlgo(postSweepBalance),
      "Txn ID":               txid,
    },
  );
}

// ── Main Check Cycle ──────────────────────────────────────────────────────

async function runCycle(
  algod:       algosdk.Algodv2,
  treasury:    algosdk.Account,
  signerAddr:  string,
): Promise<void> {
  // Fetch both balances in parallel — minimise algod round-trips
  const [signerBalance, treasuryBalance] = await Promise.all([
    getBalance(algod, signerAddr),
    getBalance(algod, treasury.addr.toString()),
  ]);

  log.info(
    {
      signer:   microToAlgo(signerBalance),
      treasury: microToAlgo(treasuryBalance),
      target:   microToAlgo(TARGET_MICRO),
      ceiling:  COLD_ADDRESS ? microToAlgo(CEILING_MICRO) : "disabled",
      fillPct:  pctStr(signerBalance, TARGET_MICRO),
    },
    "Balance check",
  );

  // Stage 1 — refill signing wallet if low
  await maybeRefillSigner(algod, treasury, signerAddr, signerBalance);

  // Stage 2 — sweep treasury excess to cold if above ceiling
  // Re-use the already-fetched treasuryBalance. If a refill just ran, treasury
  // went DOWN, making a sweep even less likely — safe to use the pre-refill value.
  await maybeSweepToCold(algod, treasury, treasuryBalance);
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate required env vars up front — fail fast before entering the loop
  const treasuryMnemonic = requireEnv("ALGO_TREASURY_MNEMONIC");
  const signerMnemonic   = requireEnv("ALGO_SIGNER_MNEMONIC");

  const treasury  = loadAccount(treasuryMnemonic, "treasury");
  const signer    = loadAccount(signerMnemonic,   "signer");
  const signerAddr = signer.addr.toString();

  // Immediately wipe the signer secret key — only the address is needed here.
  // The treasury sk is retained for signing refill and sweep transactions.
  signer.sk.fill(0);

  if (treasury.addr.toString() === signerAddr) {
    throw new Error("ALGO_TREASURY_MNEMONIC and ALGO_SIGNER_MNEMONIC must be different wallets");
  }

  // Validate cold wallet address if provided
  if (COLD_ADDRESS) {
    if (!algosdk.isValidAddress(COLD_ADDRESS)) {
      throw new Error(`COLD_WALLET_ADDRESS is not a valid Algorand address: ${COLD_ADDRESS}`);
    }
    if (COLD_ADDRESS === treasury.addr.toString()) {
      throw new Error("COLD_WALLET_ADDRESS must differ from ALGO_TREASURY_MNEMONIC address");
    }
    if (COLD_ADDRESS === signerAddr) {
      throw new Error("COLD_WALLET_ADDRESS must differ from ALGO_SIGNER_MNEMONIC address");
    }
    if (CEILING_MICRO < MIN_ACCOUNT_BALANCE + TX_FEE) {
      throw new Error(
        `TREASURY_CEILING_ALGO too low — must be at least ${microToAlgo(MIN_ACCOUNT_BALANCE + TX_FEE)}`,
      );
    }
  }

  const algod = buildAlgod();

  log.info(
    {
      treasury:        treasury.addr.toString(),
      signer:          signerAddr,
      targetAlgo:      microToAlgo(TARGET_MICRO),
      minReserveAlgo:  microToAlgo(MIN_RESERVE_MICRO),
      alertThreshold:  `${(ALERT_THRESHOLD * 100).toFixed(0)}%`,
      ceiling:         COLD_ADDRESS ? microToAlgo(CEILING_MICRO) : "disabled (no COLD_WALLET_ADDRESS)",
      coldWallet:      COLD_ADDRESS || "not configured",
      checkIntervalS:  CHECK_INTERVAL_MS / 1000,
      alertWebhook:    ALERT_WEBHOOK_URL ? "configured" : "not set",
      sentry:          process.env.SENTRY_DSN ? "configured" : "not set",
    },
    "Treasury refill daemon starting",
  );

  if (!COLD_ADDRESS) {
    log.warn("Cold ceiling sweep disabled — set COLD_WALLET_ADDRESS + TREASURY_CEILING_ALGO to enable");
  }

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

    // Sleep between cycles — unref so the timer doesn't block Node exit on shutdown
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
