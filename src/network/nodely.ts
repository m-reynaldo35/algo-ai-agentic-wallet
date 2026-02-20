import algosdk from "algosdk";
import { config } from "../config.js";
import { getRedis } from "../services/redis.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Nodely — Centralized Algorand Node Client Factory              │
 * │                                                                 │
 * │  All Algod and Indexer connections route through this module.    │
 * │  Uses Nodely's free tier (no API key required):                 │
 * │    - Cloudflare load-balanced across 21+ global locations       │
 * │    - 50ms artificial latency on free tier                       │
 * │    - Token field left empty (Nodely free needs no auth)         │
 * │                                                                 │
 * │  Endpoints:                                                     │
 * │    Mainnet Algod:   https://mainnet-api.4160.nodely.dev         │
 * │    Mainnet Indexer: https://mainnet-idx.4160.nodely.dev         │
 * │    Testnet Algod:   https://testnet-api.4160.nodely.dev         │
 * │    Testnet Indexer: https://testnet-idx.4160.nodely.dev         │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Derive Indexer URL from Algod URL ────────────────────────────
// Nodely pattern: {network}-api.4160.nodely.dev → {network}-idx.4160.nodely.dev
function deriveIndexerUrl(): string {
  if (process.env.ALGORAND_INDEXER_URL) {
    return process.env.ALGORAND_INDEXER_URL;
  }
  return config.algorand.nodeUrl.replace("-api.", "-idx.");
}

// ── Singleton Clients ────────────────────────────────────────────
// Reuse a single client per process to avoid redundant connection setup.

let _algod: algosdk.Algodv2 | null = null;
let _indexer: algosdk.Indexer | null = null;

/**
 * Returns a shared Algod v2 client configured for the current network.
 * Nodely free tier requires no token — pass empty string.
 */
export function getAlgodClient(): algosdk.Algodv2 {
  if (!_algod) {
    _algod = new algosdk.Algodv2(
      config.algorand.nodeToken,
      config.algorand.nodeUrl,
    );
  }
  return _algod;
}

/**
 * Returns a shared Indexer client configured for the current network.
 * Used for transaction lookups, account queries, and asset searches.
 */
export function getIndexerClient(): algosdk.Indexer {
  if (!_indexer) {
    _indexer = new algosdk.Indexer(
      config.algorand.nodeToken,
      deriveIndexerUrl(),
    );
  }
  return _indexer;
}

const PARAMS_CACHE_KEY = "x402:params:suggested";
const PARAMS_CACHE_TTL = 30; // seconds — valid for ~7 Algorand rounds

/**
 * Fetch suggested transaction parameters from the Algod node.
 *
 * Redis-backed cache with 30s TTL: one Algod round-trip per ~7 rounds
 * instead of one per transaction. bigint fields are serialized as strings.
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
    } catch {
      // Cache miss or Redis error — fall through to Algod
    }
  }

  // ── Algod fetch ───────────────────────────────────────────────
  try {
    const params = await getAlgodClient().getTransactionParams().do();

    // ── Cache write (fire-and-forget) ─────────────────────────
    if (redis) {
      const payload: Record<string, string> = {
        flatFee:     String(params.flatFee),
        fee:         String(params.fee),
        minFee:      String(params.minFee),
        firstValid:  String(params.firstValid),
        lastValid:   String(params.lastValid),
        genesisID:   params.genesisID,
        genesisHash: Buffer.from(params.genesisHash).toString("base64"),
      };
      redis.set(PARAMS_CACHE_KEY, JSON.stringify(payload), { ex: PARAMS_CACHE_TTL }).catch(() => {});
    }

    return params;
  } catch {
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

/**
 * Returns a brief status summary of the Nodely connection.
 * Useful for health checks and the /health endpoint.
 */
export async function getNodeStatus(): Promise<{
  healthy: boolean;
  network: string;
  algodUrl: string;
  indexerUrl: string;
  latestRound?: number;
}> {
  const algodUrl = config.algorand.nodeUrl;
  const indexerUrl = deriveIndexerUrl();

  try {
    const status = await getAlgodClient().status().do();
    return {
      healthy: true,
      network: `algorand-${config.algorand.network}`,
      algodUrl,
      indexerUrl,
      latestRound: Number(status.lastRound ?? 0),
    };
  } catch {
    return {
      healthy: false,
      network: `algorand-${config.algorand.network}`,
      algodUrl,
      indexerUrl,
    };
  }
}
