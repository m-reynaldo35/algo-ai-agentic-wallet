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
 * │    ALGO_SIGNER_ADDRESS      Signer wallet address (monitoring only)     │
 * │                                                                          │
 * │  Optional env vars (sweeps only — omit for monitoring-only mode):       │
 * │    ALGO_TREASURY_MNEMONIC   25-word treasury mnemonic (signs sweeps)    │
 * │                                                                          │
 * │  Optional env vars:                                                      │
 * │    SIGNER_LOW_ALERT_ALGO    Alert threshold in ALGO    (default 200)    │
 * │    --test-alert             Fire a test Telegram/webhook alert and exit │
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
import http from "node:http";
import { createHash } from "node:crypto";
import algosdk from "algosdk";
import pino from "pino";
import * as Sentry from "@sentry/node";
import { Redis } from "@upstash/redis";

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

// ── Module 2: Drain velocity auto-halt ───────────────────────────
// If signer balance drops faster than SIGNER_DRAIN_VELOCITY_ALGO
// microALGO per SIGNER_DRAIN_WINDOW_S seconds, trigger an emergency halt.
const DRAIN_VELOCITY_MICRO = BigInt(
  Math.round(parseFloat(process.env.SIGNER_DRAIN_VELOCITY_ALGO || "50") * 1_000_000),
); // default: 50 ALGO per window = suspicious
const DRAIN_WINDOW_S = parseInt(process.env.SIGNER_DRAIN_WINDOW_S || "60", 10);

// ── Module 5: Sweep destination anchoring ────────────────────────
// SHA-256 of COLD_WALLET_ADDRESS stored in Redis at first boot.
// Any subsequent mismatch → abort sweep + alert + halt.
const COLD_WALLET_HASH_KEY = "x402:config:cold-wallet-hash";

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

// ── Redis ─────────────────────────────────────────────────────────────────

let _redis: Redis | null = null;

function getGuardianRedis(): Redis | null {
  if (_redis) return _redis;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Set the emergency halt flag in Redis directly using NX semantics.
 *
 * NX (first halt wins): if the system is already halted for a different
 * reason, this call is a no-op — the original halt context is preserved.
 * The detection event is always logged regardless of whether the flag was
 * written, so alerts fire even when signing is already blocked.
 *
 * Mirrors the behaviour of setHalt() in agentRegistry.ts without
 * importing the full service layer into this standalone script.
 */
async function setHaltFlag(reason: string): Promise<void> {
  const redis = getGuardianRedis();
  if (!redis) {
    log.error("Cannot set halt flag — Redis not configured");
    return;
  }
  const haltRecord = {
    reason,
    region:     process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "guardian",
    instanceId: "wallet-guardian",
    timestamp:  new Date().toISOString(),
  };

  // NX — only write if no halt is already active (first halt wins)
  const wrote = await redis.set("x402:halt", JSON.stringify(haltRecord), { nx: true });

  if (wrote !== null) {
    log.error({ haltRecord }, "Emergency halt flag SET in Redis — signing blocked system-wide");
  } else {
    // Already halted — log the new detection but preserve the original context
    const existing = await redis.get("x402:halt") as string | null;
    log.error(
      { newReason: reason, existingHalt: existing ? JSON.parse(existing) : null },
      "Drain detected but halt flag already set — signing already blocked",
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optionalAccount(mnemonic: string | undefined, label: string): algosdk.Account | null {
  if (!mnemonic) return null;
  try { return algosdk.mnemonicToSecretKey(mnemonic); }
  catch { throw new Error(`Invalid mnemonic for ${label} wallet`); }
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

  // ── Module 2: Drain velocity check ────────────────────────────
  //
  // Uses a Redis ZSET (x402:guardian:signer-bal-history) to store a
  // rolling window of balance readings with millisecond timestamps as
  // scores. On each cycle, we:
  //   1. ZADD the current balance at score=nowMs
  //   2. Prune entries older than 2× the window
  //   3. ZRANGEBYSCORE to find the entry nearest to (nowMs - DRAIN_WINDOW_MS)
  //      with a ±(2 × CHECK_INTERVAL_MS) tolerance — robust to timing jitter
  //      from slow algod responses, process restarts, or variable load
  //   4. If oldest candidate's balance > current + DRAIN_VELOCITY_MICRO → halt
  //
  // Why ZSET instead of exact-second key lookup:
  //   Exact keys fail when cycle timing has >1s jitter (slow algod, GC pauses).
  //   ZSET nearest-neighbor is monotonic: the correct comparison point is
  //   always found as long as the guardian ran at least once in the window,
  //   regardless of when exactly.
  //
  // Monotonicity note: balance readings are from the Algorand chain. Chain
  // balances can only decrease (spending) or increase (deposits) — they do
  // not oscillate rapidly. A comparison point from ±tolerance of the target
  // window boundary gives a conservative (slightly under-counts drops) result,
  // which is correct: we would rather miss a slow drain than halt on noise.
  const DRAIN_HISTORY_KEY = "x402:guardian:signer-bal-history";
  const redis = getGuardianRedis();
  if (redis) {
    try {
      const nowMs       = Date.now();
      const windowMs    = DRAIN_WINDOW_S * 1_000;
      const toleranceMs = CHECK_INTERVAL_MS * 2; // robust to 2× normal cycle jitter
      const historyTtlS = Math.ceil((windowMs * 2) / 1_000);

      // Record current reading: score = timestamp, member = "{balance}:{nowMs}"
      const member = `${balance.toString()}:${nowMs}`;
      await redis.zadd(DRAIN_HISTORY_KEY, { score: nowMs, member });
      await redis.expire(DRAIN_HISTORY_KEY, historyTtlS);

      // Prune entries older than 2× the window
      await redis.zremrangebyscore(DRAIN_HISTORY_KEY, 0, nowMs - windowMs * 2);

      // Find entries nearest to the target comparison point (nowMs - windowMs)
      const targetMin = nowMs - windowMs - toleranceMs;
      const targetMax = nowMs - windowMs + toleranceMs;
      const candidates = await redis.zrangebyscore(DRAIN_HISTORY_KEY, targetMin, targetMax) as string[];

      if (candidates.length > 0) {
        // Take the oldest candidate in the tolerance window — most conservative comparison
        const oldestMember = candidates[0];
        const oldBalStr    = oldestMember.split(":")[0];
        const oldBal       = BigInt(oldBalStr);
        const drop         = oldBal - balance; // positive = balance dropped

        if (drop > DRAIN_VELOCITY_MICRO) {
          const reason =
            `DRAIN_VELOCITY: signer balance dropped ${microToAlgo(drop)} ` +
            `in ~${DRAIN_WINDOW_S}s (threshold: ${microToAlgo(DRAIN_VELOCITY_MICRO)}). ` +
            `From ${microToAlgo(oldBal)} → ${microToAlgo(balance)}. ` +
            `Active drain suspected — signing halted by wallet guardian.`;

          log.error(
            { drop: microToAlgo(drop), from: microToAlgo(oldBal), to: microToAlgo(balance) },
            "DRAIN VELOCITY EXCEEDED — triggering emergency halt",
          );

          // Critical alert — no cooldown (this is an emergency, fire unconditionally)
          const body = buildBody(`🚨🚨 x402 DRAIN DETECTED — Signing HALTED`, {
            "Balance drop":   microToAlgo(drop),
            "Window":         `${DRAIN_WINDOW_S}s`,
            "Threshold":      microToAlgo(DRAIN_VELOCITY_MICRO),
            "Balance before": microToAlgo(oldBal),
            "Balance now":    microToAlgo(balance),
            "Signer":         signerAddr,
            "Action":         "Signing halted. POST /api/system/unhalt to resume.",
          });
          await Promise.allSettled([sendTelegram(body), sendWebhook(body)]);
          if (process.env.SENTRY_DSN) {
            Sentry.captureMessage(reason, {
              level: "fatal",
              tags: { component: "wallet-guardian", event: "DRAIN_VELOCITY_HALT" },
            });
          }

          await setHaltFlag(reason);
          return;
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Drain velocity check error — skipping");
    }
  }

  // ── Low balance alert ──────────────────────────────────────────
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

// ── Module 5: Sweep destination hash anchor ───────────────────────────────

/**
 * Anchor the cold wallet address as a SHA-256 hash in Redis on first boot.
 * On every subsequent call, compare the current COLD_ADDRESS against the
 * stored hash. A mismatch means the cold wallet address has been changed
 * (env var tampered, misconfiguration, or active attack) — abort all sweeps
 * and trigger an emergency halt.
 *
 * Uses the same pattern as assertCrossRegionTreasuryHash() in envGuard.ts.
 * Returns true if the address is verified safe, false if compromised/error.
 */
async function verifyColdWalletAnchor(coldAddr: string): Promise<boolean> {
  const redis = getGuardianRedis();
  if (!redis) {
    log.warn("Redis not configured — skipping cold wallet hash anchor verification");
    return true; // cannot verify but not blocking sweeps in non-Redis mode
  }

  try {
    const actualHash = createHash("sha256").update(coldAddr).digest("hex");

    // SET NX — first writer wins; subsequent instances compare
    const wrote = await redis.set(COLD_WALLET_HASH_KEY, actualHash, { nx: true });

    if (wrote !== null) {
      // We just wrote it — this instance established the reference
      log.info({ coldAddr, hash: actualHash.slice(0, 16) + "…" }, "Cold wallet hash anchored in Redis");
      return true;
    }

    // Key already exists — compare with stored hash
    const storedHash = await redis.get(COLD_WALLET_HASH_KEY) as string | null;
    if (!storedHash) return true; // key expired between SET and GET — harmless

    if (storedHash !== actualHash) {
      const reason =
        `SWEEP_ADDR_TAMPER: COLD_WALLET_ADDRESS hash mismatch. ` +
        `Expected ${storedHash.slice(0, 16)}… but this instance has ${actualHash.slice(0, 16)}…. ` +
        `Possible env var tampering or misconfiguration. All sweeps blocked.`;

      log.fatal({ storedHash: storedHash.slice(0, 16), actualHash: actualHash.slice(0, 16) },
        "COLD WALLET ADDRESS TAMPERED — sweeps blocked, halt triggered");

      const body = buildBody(`🚨🚨 x402 COLD WALLET TAMPERED — Sweeps BLOCKED`, {
        "Stored hash (first 16)":  storedHash.slice(0, 16) + "…",
        "Current hash (first 16)": actualHash.slice(0, 16) + "…",
        "COLD_WALLET_ADDRESS":     coldAddr,
        "Action": "All sweeps blocked. Investigate immediately. POST /api/system/unhalt to resume.",
      });
      await Promise.allSettled([sendTelegram(body), sendWebhook(body)]);
      if (process.env.SENTRY_DSN) {
        Sentry.captureMessage(reason, { level: "fatal", tags: { component: "wallet-guardian", event: "SWEEP_ADDR_TAMPER" } });
      }

      await setHaltFlag(reason);
      return false;
    }

    return true; // hash matches — address is verified
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Cold wallet hash anchor check error — allowing sweep");
    return true; // fail open on Redis error
  }
}

// ── Job 2a: Treasury ALGO cold sweep ──────────────────────────────────────

async function sweepAlgo(
  algod: algosdk.Algodv2, treasury: algosdk.Account, treasuryAlgo: bigint,
): Promise<void> {
  if (!COLD_ADDRESS || treasuryAlgo <= ALGO_CEILING_MICRO) return;

  // Module 5: verify cold wallet address hasn't been tampered
  const anchorOk = await verifyColdWalletAnchor(COLD_ADDRESS);
  if (!anchorOk) {
    log.error("Sweep aborted — cold wallet address anchor verification failed");
    return;
  }

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

  // Module 5: verify cold wallet address hasn't been tampered
  const anchorOk = await verifyColdWalletAnchor(COLD_ADDRESS);
  if (!anchorOk) {
    log.error("USDC sweep aborted — cold wallet address anchor verification failed");
    return;
  }

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
  algod: algosdk.Algodv2, treasury: algosdk.Account | null, signerAddr: string,
): Promise<void> {
  if (treasury) {
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
  } else {
    const signerAlgo = await getAlgoBalance(algod, signerAddr);

    log.info({
      signer:     microToAlgo(signerAlgo),
      alertBelow: microToAlgo(SIGNER_ALERT_MICRO),
      sweeps:     "disabled (no ALGO_TREASURY_MNEMONIC)",
    }, "Guardian check");

    await checkSigner(algod, signerAddr);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const testAlert  = process.argv.includes("--test-alert");
  const signerAddr = requireEnv("ALGO_SIGNER_ADDRESS");
  const treasury   = optionalAccount(process.env.ALGO_TREASURY_MNEMONIC, "treasury");

  if (!algosdk.isValidAddress(signerAddr)) {
    throw new Error(`ALGO_SIGNER_ADDRESS is not a valid Algorand address: ${signerAddr}`);
  }
  if (COLD_ADDRESS && !algosdk.isValidAddress(COLD_ADDRESS)) {
    throw new Error(`COLD_WALLET_ADDRESS is not a valid Algorand address: ${COLD_ADDRESS}`);
  }
  if (COLD_ADDRESS && treasury && COLD_ADDRESS === treasury.addr.toString()) {
    throw new Error("COLD_WALLET_ADDRESS must differ from treasury address");
  }
  if (COLD_ADDRESS && !treasury) {
    throw new Error("COLD_WALLET_ADDRESS is set but ALGO_TREASURY_MNEMONIC is missing — sweeps require the treasury mnemonic");
  }

  const algod = buildAlgod();

  log.info({
    signerMonitor:   signerAddr,
    alertBelow:      microToAlgo(SIGNER_ALERT_MICRO),
    mode:            treasury ? "monitor + sweeps" : "monitor-only",
    treasury:        treasury ? treasury.addr.toString() : "not configured",
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
  if (!treasury) {
    log.warn("Running in monitor-only mode — set ALGO_TREASURY_MNEMONIC to enable cold sweeps");
  }

  // ── --test-alert: fire a test message and exit ──────────────────────────
  if (testAlert) {
    const balance = await getAlgoBalance(algod, signerAddr);
    await notify("✅ x402 Wallet Guardian — test alert", {
      "Mode":           treasury ? "monitor + sweeps" : "monitor-only",
      "Signer address": signerAddr,
      "Current balance": microToAlgo(balance),
      "Alert threshold": microToAlgo(SIGNER_ALERT_MICRO),
      "Telegram":       TG_TOKEN && TG_CHAT_ID ? "configured" : "not configured",
    });
    log.info("Test alert sent — exiting");
    return;
  }

  // ── Health server (Railway requires a bound PORT) ───────────────────────
  const port = parseInt(process.env.PORT || "8080", 10);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "wallet-guardian" }));
  });
  server.listen(port, () => log.info({ port }, "Health server listening"));

  let running = true;
  process.on("SIGTERM", () => { log.info("Shutting down"); running = false; server.close(); });
  process.on("SIGINT",  () => { log.info("Shutting down"); running = false; server.close(); });

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
