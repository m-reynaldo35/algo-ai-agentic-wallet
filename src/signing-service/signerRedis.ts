import { RedisShim } from "../services/redis.js";

/**
 * Isolated Redis client for the Signing Service.
 *
 * Uses a dedicated database so the main API's Redis connection cannot
 * read or write signing-service replay keys, and vice versa (Module 7).
 *
 * Connection priority:
 *   1. SIGNER_REDIS_PRIVATE_URL — Railway internal network (preferred)
 *   2. SIGNER_REDIS_URL         — Railway public URL
 *   3. REDIS_PRIVATE_URL        — shared Railway internal network
 *   4. REDIS_URL                — shared Railway public URL
 *   5. Legacy Upstash (SIGNER_REDIS_REST_URL + TOKEN or main UPSTASH_* vars)
 *
 * Returns null when no credentials are set (dev / mock mode).
 * Callers handle the null case explicitly.
 *
 * Module 7 — Redis ACL & Key Isolation
 */

let signerRedis: RedisShim | null = null;
let signerChecked = false;

export function getSignerRedis(): RedisShim | null {
  if (signerChecked) return signerRedis;

  const privateUrl = process.env.SIGNER_REDIS_PRIVATE_URL;
  const publicUrl  = process.env.SIGNER_REDIS_URL;
  const sharedPriv = process.env.REDIS_PRIVATE_URL;
  const sharedPub  = process.env.REDIS_URL;

  const url = privateUrl || publicUrl || sharedPriv || sharedPub;

  if (url) {
    signerRedis = new RedisShim(url);
    signerChecked = true;

    // Warn if using the shared connection (reduced isolation)
    if (!privateUrl && !publicUrl) {
      console.warn(
        "[SignerRedis] Using shared REDIS_* URL — " +
        "provision a dedicated Redis database and set SIGNER_REDIS_PRIVATE_URL " +
        "to enforce database isolation (Module 7).",
      );
    } else {
      const label = privateUrl ? "SIGNER_REDIS_PRIVATE_URL" : "SIGNER_REDIS_URL";
      console.log(`[SignerRedis] Connected via ${label}`);
    }
    return signerRedis;
  }

  // Legacy Upstash fallback
  const signerUpstashUrl   = process.env.SIGNER_REDIS_REST_URL;
  const signerUpstashToken = process.env.SIGNER_REDIS_REST_TOKEN;
  const mainUpstashUrl     = process.env.UPSTASH_REDIS_REST_URL;
  const mainUpstashToken   = process.env.UPSTASH_REDIS_REST_TOKEN;

  const upstashUrl   = signerUpstashUrl   || mainUpstashUrl;
  const upstashToken = signerUpstashToken || mainUpstashToken;

  if (upstashUrl && upstashToken) {
    // Warn if the signer is sharing the main API's database
    if (upstashUrl === mainUpstashUrl && signerUpstashUrl !== mainUpstashUrl) {
      console.warn(
        "[SignerRedis] WARNING: falling back to main API Upstash database. " +
        "Provision a separate database and set SIGNER_REDIS_PRIVATE_URL for isolation.",
      );
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Redis: UpstashRedis } = require("@upstash/redis");
      signerRedis = new UpstashRedis({ url: upstashUrl, token: upstashToken }) as unknown as RedisShim;
      signerChecked = true;
      console.warn("[SignerRedis] Using legacy Upstash HTTP client — switch to SIGNER_REDIS_PRIVATE_URL");
      return signerRedis;
    } catch {
      console.error("[SignerRedis] @upstash/redis not available for legacy fallback");
    }
  }

  signerChecked = true;
  console.warn(
    "[SignerRedis] No credentials configured — " +
    "signing-service replay protection is disabled.",
  );
  return null;
}
