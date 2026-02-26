import { Redis } from "@upstash/redis";

/**
 * Isolated Redis client for the Signing Service.
 *
 * Uses SIGNER_REDIS_REST_URL / SIGNER_REDIS_REST_TOKEN — a separate
 * Upstash database from the one the main API uses. This enforces
 * database-level isolation: a compromised main-API Redis connection
 * cannot read or write signing-service replay keys, and vice versa.
 *
 * Falls back to null when credentials are not set (dev / mock mode).
 * Returns null should never block the signing pipeline — callers handle
 * the null case explicitly.
 *
 * Module 7 — Redis ACL & Key Isolation
 */

let signerRedis: Redis | null = null;
let signerChecked = false;

export function getSignerRedis(): Redis | null {
  if (signerChecked) return signerRedis;

  const url   = process.env.SIGNER_REDIS_REST_URL;
  const token = process.env.SIGNER_REDIS_REST_TOKEN;

  if (!url || !token) {
    signerChecked = true;
    console.warn(
      "[SignerRedis] SIGNER_REDIS credentials not set — " +
      "signing-service replay protection uses main Redis (not isolated).",
    );
    return null;
  }

  // Boot-time safety check: warn if the signer is using the same database
  // as the main API. Different databases are the Module 7 security goal.
  const mainUrl = process.env.UPSTASH_REDIS_REST_URL;
  if (mainUrl && mainUrl === url) {
    console.warn(
      "[SignerRedis] WARNING: SIGNER_REDIS_REST_URL === UPSTASH_REDIS_REST_URL. " +
      "The signing service and main API are sharing the same Redis database. " +
      "Provision a separate Upstash database for the signing service and set " +
      "SIGNER_REDIS_REST_URL / SIGNER_REDIS_REST_TOKEN to enforce database isolation.",
    );
  }

  signerRedis = new Redis({ url, token });
  signerChecked = true;
  return signerRedis;
}
