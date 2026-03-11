/**
 * ALGO/USDC Price Oracle
 *
 * Fetches the current ALGO price in USDC via CoinGecko's free API.
 * Caches results for 60 seconds to avoid rate limits.
 *
 * Failure behaviour — IMPORTANT for treasury safety:
 *   - On oracle failure, uses the LAST KNOWN GOOD price (stale cache)
 *   - If no successful fetch has ever occurred (cold start + oracle down),
 *     throws — the caller must NOT issue an onboarding quote without a
 *     real price. Using a hardcoded floor risks under-charging when ALGO
 *     is trading well above it, allowing Sybil attackers to drain the
 *     treasury at a discount.
 *
 * Ceiling: 10.00 USDC/ALGO — sanity check against malformed API responses.
 * Staleness warning: logged when stale cache is > 10 minutes old.
 *
 * Environment variables:
 *   ALGO_PRICE_CEILING_USDC  Maximum plausible price (default: "10.0")
 */

const CACHE_TTL_MS      = 60_000;       // refresh every 60s
const STALE_WARN_MS     = 10 * 60_000;  // warn after 10 min of staleness
const PRICE_CEILING     = parseFloat(process.env.ALGO_PRICE_CEILING_USDC ?? "10.0");

interface PriceCache {
  priceUsdc: number;
  fetchedAt: number;
}

let cache: PriceCache | null = null;

/**
 * Returns the current ALGO price in USDC.
 *
 * On oracle failure:
 *   - Returns last known good price if available (logs a staleness warning)
 *   - Throws if no successful price has ever been fetched — never returns
 *     a hardcoded fallback that could under-price onboarding fees
 */
export async function getAlgoPriceUsdc(): Promise<number> {
  const now = Date.now();

  // Cache hit — price is fresh
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.priceUsdc;
  }

  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const data = await resp.json() as { algorand?: { usd?: number } };
    const price = data?.algorand?.usd;
    if (typeof price !== "number" || price <= 0 || price > PRICE_CEILING) {
      throw new Error(`Unexpected price value: ${price}`);
    }
    cache = { priceUsdc: price, fetchedAt: now };
    return price;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (cache) {
      // Use stale cache — safer than any hardcoded value
      const staleMs = now - cache.fetchedAt;
      console.warn(
        `[AlgoPrice] Oracle unavailable (${msg}) — using stale price $${cache.priceUsdc} ` +
        `(${Math.round(staleMs / 1_000)}s old)`,
      );
      if (staleMs > STALE_WARN_MS) {
        console.error(
          `[AlgoPrice] STALE PRICE WARNING — last successful fetch was ${Math.round(staleMs / 60_000)} min ago. ` +
          `Onboarding fees may be inaccurate. Check CoinGecko connectivity.`,
        );
      }
      return cache.priceUsdc;
    }

    // No prior price — refuse to quote rather than guess
    throw new Error(
      `ALGO price oracle unavailable and no prior price cached: ${msg}. ` +
      `Cannot issue onboarding quote without a real market price.`,
    );
  }
}

/** Returns true if the oracle has successfully fetched at least once. */
export function hasCachedPrice(): boolean {
  return cache !== null;
}

/** Returns the age of the current cache in milliseconds, or null if no cache. */
export function getCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.fetchedAt : null;
}

// ── Oracle-scaled gas amounts ──────────────────────────────────────────────
//
// Protocol-fixed floor (immutable, cannot be reduced):
//   100,000 µALGO  — account MBR
//   100,000 µALGO  — USDC ASA MBR
//     3,000 µALGO  — 3 tx fees (fee-pooled onto treasury txn)
//   ─────────────
//   203,000 µALGO  — hard floor
//
// Buffer tier (oracle-scaled — only the discretionary portion changes):
//   ALGO < $1.00   →  50,000 µALGO buffer  (total 253,000)
//   ALGO $1–$3     →  20,000 µALGO buffer  (total 223,000)
//   ALGO $3–$10    →   5,000 µALGO buffer  (total 208,000)
//   ALGO ≥ $10     →   3,000 µALGO buffer  (total 206,000 — bare minimum)
//
// At any price the agent receives enough ALGO to: hold MBR + USDC ASA MBR +
// a small fee buffer before the gas station's first top-up cycle (~30s).

export const REGISTRATION_FLOOR_MICRO = 203_000n;

function bufferForPrice(priceUsd: number): bigint {
  if (priceUsd < 1)   return 50_000n;
  if (priceUsd < 3)   return 20_000n;
  if (priceUsd < 10)  return  5_000n;
  return 3_000n;
}

/**
 * Total µALGO to send to a new agent wallet during treasury-sponsored
 * registration. = protocol floor + oracle-scaled buffer.
 */
export function registrationFundMicro(priceUsd: number): bigint {
  return REGISTRATION_FLOOR_MICRO + bufferForPrice(priceUsd);
}

/**
 * Oracle-scaled gas station top-up amount.
 * Fewer µALGO sent per top-up when ALGO is expensive — gas station cycles
 * more frequently but total USD spend per cycle stays roughly constant.
 *
 *   ALGO < $1.00   →  700,000 µALGO  (~700 future payment fees)
 *   ALGO $1–$3     →  500,000 µALGO  (~500)
 *   ALGO $3–$10    →  300,000 µALGO  (~300)
 *   ALGO ≥ $10     →  200,000 µALGO  (~200)
 */
export function gasTopUpMicro(priceUsd: number): bigint {
  if (priceUsd < 1)   return 700_000n;
  if (priceUsd < 3)   return 500_000n;
  if (priceUsd < 10)  return 300_000n;
  return 200_000n;
}

/**
 * Oracle-scaled gas station trigger threshold.
 * Kept proportional to the top-up amount (~70%) so the top-up cycle frequency
 * stays predictable relative to agent payment volume.
 *
 *   ALGO < $1.00   →  500,000 µALGO
 *   ALGO $1–$3     →  350,000 µALGO
 *   ALGO $3–$10    →  210,000 µALGO
 *   ALGO ≥ $10     →  210,000 µALGO  (floor: must exceed MBR + small buffer)
 */
export function gasTriggerMicro(priceUsd: number): bigint {
  if (priceUsd < 1)   return 500_000n;
  if (priceUsd < 3)   return 350_000n;
  return 210_000n;
}
