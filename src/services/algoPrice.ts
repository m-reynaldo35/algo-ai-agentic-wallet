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
