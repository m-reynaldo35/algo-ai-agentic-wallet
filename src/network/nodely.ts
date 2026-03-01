import algosdk from "algosdk";
import { config } from "../config.js";
import { getRedis } from "../services/redis.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Algorand Node Client Factory — Primary + Automatic Fallback    │
 * │                                                                 │
 * │  Primary:  ALGORAND_NODE_URL  (dedicated node, fastest)         │
 * │  Fallback: ALGORAND_FALLBACK_NODE_URL (Nodely free tier)        │
 * │                                                                 │
 * │  On primary failure: auto-switches to fallback, fires Telegram  │
 * │  alert, and probes every 60 s until primary recovers.           │
 * │                                                                 │
 * │  Indexer always uses ALGORAND_INDEXER_URL (Nodely/AlgoNode).   │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Node URLs ────────────────────────────────────────────────────
const PRIMARY_URL   = config.algorand.nodeUrl;
const PRIMARY_TOKEN = config.algorand.nodeToken;
const FALLBACK_URL  = process.env.ALGORAND_FALLBACK_NODE_URL
  ?? "https://mainnet-api.4160.nodely.dev";

const RECOVERY_INTERVAL_MS = 60_000;

// ── Failover State ───────────────────────────────────────────────
let _usingFallback   = false;
let _algod: algosdk.Algodv2 | null = null;
let _indexer: algosdk.Indexer | null = null;
let _recoveryTimer: ReturnType<typeof setInterval> | null = null;

function buildAlgod(url: string, token: string): algosdk.Algodv2 {
  return new algosdk.Algodv2(token, url);
}

async function sendTelegramAlert(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch { /* non-critical */ }
}

function startRecoveryProbe(): void {
  if (_recoveryTimer) return;
  _recoveryTimer = setInterval(async () => {
    try {
      await buildAlgod(PRIMARY_URL, PRIMARY_TOKEN).status().do();
      // Primary is back
      _usingFallback = false;
      _algod = buildAlgod(PRIMARY_URL, PRIMARY_TOKEN);
      clearInterval(_recoveryTimer!);
      _recoveryTimer = null;
      console.log(`[Algod] Primary node recovered — switched back to ${PRIMARY_URL}`);
      void sendTelegramAlert(
        `✅ *Algorand primary node recovered*\nBack on: \`${PRIMARY_URL}\``,
      );
    } catch { /* still down — keep probing */ }
  }, RECOVERY_INTERVAL_MS);
}

async function activateFallback(): Promise<void> {
  if (_usingFallback) return;
  _usingFallback = true;
  _algod = buildAlgod(FALLBACK_URL, "");
  console.warn(`[Algod] Primary node unreachable — failing over to ${FALLBACK_URL}`);
  void sendTelegramAlert(
    `🚨 *Algorand primary node DOWN*\nFailing over to fallback: \`${FALLBACK_URL}\`\nPrimary: \`${PRIMARY_URL}\``,
  );
  startRecoveryProbe();
}

// ── Derive Indexer URL ───────────────────────────────────────────
function deriveIndexerUrl(): string {
  if (process.env.ALGORAND_INDEXER_URL) {
    return process.env.ALGORAND_INDEXER_URL;
  }
  return FALLBACK_URL.replace("-api.", "-idx.");
}

// ── Client Accessors ─────────────────────────────────────────────

export function getAlgodClient(): algosdk.Algodv2 {
  if (!_algod) {
    _algod = buildAlgod(PRIMARY_URL, PRIMARY_TOKEN);
  }
  return _algod;
}

export function getIndexerClient(): algosdk.Indexer {
  if (!_indexer) {
    _indexer = new algosdk.Indexer("", deriveIndexerUrl());
  }
  return _indexer;
}

/** Which node is currently active — for /health reporting */
export function getActiveNodeUrl(): string {
  return _usingFallback ? FALLBACK_URL : PRIMARY_URL;
}

export function isUsingFallback(): boolean {
  return _usingFallback;
}

// ── Params Cache ─────────────────────────────────────────────────
const PARAMS_CACHE_KEY = "x402:params:suggested";
const PARAMS_CACHE_TTL = 10; // seconds — valid for ~2 Algorand rounds

/**
 * Fetch suggested transaction parameters from the active Algod node.
 * Redis-backed cache with 10s TTL. On primary failure, auto-switches
 * to fallback and retries transparently.
 */
export async function getSuggestedParams(): Promise<algosdk.SuggestedParams> {
  // ── Cache read ────────────────────────────────────────────────
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(PARAMS_CACHE_KEY) as Record<string, string> | null;
      if (cached) {
        return {
          flatFee:     cached.flatFee === "true",
          fee:         BigInt(cached.fee),
          minFee:      BigInt(cached.minFee),
          firstValid:  BigInt(cached.firstValid),
          lastValid:   BigInt(cached.lastValid),
          genesisID:   cached.genesisID,
          genesisHash: new Uint8Array(Buffer.from(cached.genesisHash, "base64")),
        };
      }
    } catch { /* cache miss — fall through */ }
  }

  // ── Algod fetch with failover ─────────────────────────────────
  let params: algosdk.SuggestedParams;
  try {
    params = await getAlgodClient().getTransactionParams().do();
  } catch {
    // Primary failed — switch to fallback and retry once
    await activateFallback();
    try {
      params = await getAlgodClient().getTransactionParams().do();
    } catch {
      // Both failed — return safe stub so callers don't crash
      return {
        flatFee:     true,
        fee:         BigInt(1000),
        minFee:      BigInt(1000),
        firstValid:  BigInt(1000),
        lastValid:   BigInt(2000),
        genesisID:   `${config.algorand.network}-v1.0`,
        genesisHash: new Uint8Array(32),
      };
    }
  }

  // ── Cache write (fire-and-forget) ─────────────────────────────
  if (redis) {
    const payload: Record<string, string> = {
      flatFee:     String(params.flatFee),
      fee:         String(params.fee),
      minFee:      String(params.minFee),
      firstValid:  String(params.firstValid),
      lastValid:   String(params.lastValid),
      genesisID:   params.genesisID ?? "",
      genesisHash: Buffer.from(params.genesisHash ?? new Uint8Array(0)).toString("base64"),
    };
    redis.set(PARAMS_CACHE_KEY, JSON.stringify(payload), { ex: PARAMS_CACHE_TTL }).catch(() => {});
  }

  return params;
}

/**
 * Returns a brief status summary for the /health endpoint.
 */
export async function getNodeStatus(): Promise<{
  healthy: boolean;
  network: string;
  algodUrl: string;
  indexerUrl: string;
  usingFallback: boolean;
  latestRound?: number;
}> {
  const algodUrl   = getActiveNodeUrl();
  const indexerUrl = deriveIndexerUrl();

  try {
    const status = await getAlgodClient().status().do();
    return {
      healthy:       true,
      network:       `algorand-${config.algorand.network}`,
      algodUrl,
      indexerUrl,
      usingFallback: _usingFallback,
      latestRound:   Number(status.lastRound ?? 0),
    };
  } catch {
    // Primary failed during health check — trigger failover
    await activateFallback();
    return {
      healthy:       false,
      network:       `algorand-${config.algorand.network}`,
      algodUrl:      getActiveNodeUrl(),
      indexerUrl,
      usingFallback: _usingFallback,
    };
  }
}
