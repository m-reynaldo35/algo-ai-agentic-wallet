/**
 * Environment Guard — Phase 1.5 Operational Hardening
 *
 * Boot-time safety assertions. Call runBootGuards() once at process start,
 * before any routes are registered. Throws on misconfiguration — fail fast,
 * never degrade silently into an unsafe state.
 *
 * Covers:
 *   Section 1  — Redis credentials required in production (Railway or Upstash)
 *   Section 7  — Treasury address required; config frozen at runtime
 *   Section 8  — Signer mnemonic refused outside production unless explicitly allowed
 *   Section 9  — mTLS env validation when MTLS_ENABLED=true
 *   Section 10 — Cross-region treasury hash consistency check
 */

import { createHash } from "node:crypto";
import { config } from "../config.js";

// ── Section 1: Redis credentials ──────────────────────────────────

/**
 * Require Redis credentials in production.
 * Without Redis, rate limiting and the circuit breaker are degraded
 * to in-memory fallbacks — acceptable for dev, not for production.
 *
 * Accepts any of the supported Redis connection methods (priority order):
 *   REDIS_PRIVATE_URL  — Railway internal network (preferred)
 *   REDIS_URL          — Railway public URL / local dev
 *   UPSTASH_REDIS_REST_URL + TOKEN — legacy Upstash HTTP REST fallback
 */
export function assertRedisCredentials(): void {
  if (process.env.NODE_ENV !== "production") return;

  const hasRailwayRedis = !!(process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL);
  const hasUpstash      = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

  if (!hasRailwayRedis && !hasUpstash) {
    throw new Error(
      "BOOT FAILURE: No Redis credentials configured in production. " +
      "Rate limiting and the signer circuit breaker require Redis. " +
      "Set REDIS_PRIVATE_URL (Railway internal) or REDIS_URL, " +
      "or provision an Upstash database and set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.",
    );
  }
}

// ── Section 7: Treasury address freeze ────────────────────────────

/**
 * Require the treasury pay-to address to be configured and freeze the
 * entire config object to prevent runtime mutation.
 *
 * TypeScript `as const` enforces immutability at the type level only.
 * Object.freeze() enforces it at runtime — any mutation attempt in
 * strict mode will throw; in sloppy mode it silently fails.
 */
export function assertAndFreezeTreasury(): void {
  if (!config.x402.payToAddress) {
    throw new Error(
      "BOOT FAILURE: X402_PAY_TO_ADDRESS must be set. " +
      "The signing service cannot validate toll payments without a treasury address. " +
      "Set X402_PAY_TO_ADDRESS to the Algorand address that receives x402 fees.",
    );
  }

  // Deep-freeze the config object — no route or module may mutate it after boot.
  deepFreeze(config);
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const name of Object.getOwnPropertyNames(obj)) {
    const value = (obj as Record<string, unknown>)[name];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj;
}

// ── Section 8: Signer environment guard ───────────────────────────

/**
 * Refuse to load the signer mnemonic outside of a production environment.
 *
 * WHY RAILWAY_ENVIRONMENT IS REQUIRED
 * ------------------------------------
 * The signing service runs with NODE_ENV=undefined on Railway. Railway does
 * not automatically inject NODE_ENV. Relying solely on NODE_ENV would mean
 * the production signing service has no valid production signal at all — the
 * check would silently pass for the wrong reason (undefined !== "production"
 * is true, making the service appear non-production when it is not).
 *
 * WHY NODE_ENV ALONE IS INSUFFICIENT
 * ------------------------------------
 * NODE_ENV is a convention, not a guarantee. It can be omitted, mistyped, or
 * intentionally set to any string. On Railway it is not set at all on services
 * that do not explicitly configure it. RAILWAY_ENVIRONMENT is injected by the
 * platform itself and cannot be spoofed by the application's own env config.
 *
 * WHY THE GUARD RUNS BEFORE MNEMONIC DECODING
 * --------------------------------------------
 * assertSignerEnvironment() must be called before getSignerAccount().
 * getSignerAccount() calls algosdk.mnemonicToSecretKey(), which decodes the
 * 25-word mnemonic into a raw Ed25519 secret key in memory. Once the key is
 * in memory as a Uint8Array, exposure risk increases. The guard prevents it
 * from ever reaching that state if the environment is invalid.
 *
 * WHY PREVIEW DEPLOYMENTS MUST NEVER LOAD THE SIGNER
 * ---------------------------------------------------
 * Railway PR preview deployments can inherit environment variables from the
 * production service definition. A preview deployment with ALGO_SIGNER_MNEMONIC
 * could sign arbitrary Algorand transactions. The treasury validation (Step 9b)
 * is a second line of defence — but the key must never be decoded at all in a
 * non-production environment, regardless of what other guards exist downstream.
 *
 * VALID PRODUCTION SIGNALS (either is sufficient):
 *   RAILWAY_ENVIRONMENT === "production"   (signing service on Railway)
 *   NODE_ENV === "production"              (conventional Node.js production flag)
 *
 * ONLY PERMITTED OVERRIDE:
 *   DEV_SIGNER_ALLOWED === "true"          (local integration testing only)
 *   This must never appear in any Railway service variable set.
 */
export function assertSignerEnvironment(): void {
  // Services without a mnemonic (e.g. main API) have nothing to protect.
  if (!process.env.ALGO_SIGNER_MNEMONIC) return;

  const isRailwayProd = process.env.RAILWAY_ENVIRONMENT === "production";
  const isNodeProd    = process.env.NODE_ENV === "production";
  const devOverride   = process.env.DEV_SIGNER_ALLOWED === "true";

  if (isRailwayProd || isNodeProd) return;

  if (devOverride) {
    // Permitted for local integration testing. Log a clear warning so this
    // state is visible in any log output — it must never appear in Railway logs.
    console.warn(
      "[envGuard] WARNING: DEV_SIGNER_ALLOWED=true — signer key loaded outside production. " +
      "This must never appear in a Railway service deployment.",
    );
    return;
  }

  throw new Error("Signer key load blocked: not running in production environment.");
}

// ── Section 7: Signer Redis isolation guard ────────────────────────

/**
 * Warn in production when the signing service has no dedicated Redis
 * database configured. For isolation, the signing service should use
 * SIGNER_REDIS_PRIVATE_URL / SIGNER_REDIS_URL (separate Railway Redis plugin)
 * rather than sharing the main-API Redis instance.
 *
 * This is a warning, not a hard failure — sharing a single Redis database is
 * acceptable in development or single-instance deployments.
 */
export function assertSignerRedis(): void {
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  if (!isProd) return;

  const hasDedicatedRedis = !!(
    process.env.SIGNER_REDIS_PRIVATE_URL ||
    process.env.SIGNER_REDIS_URL ||
    process.env.SIGNER_REDIS_REST_URL
  );

  if (!hasDedicatedRedis) {
    console.warn(
      "[envGuard] WARNING: No dedicated signer Redis configured (SIGNER_REDIS_PRIVATE_URL / SIGNER_REDIS_URL). " +
      "The signing service will share the main API Redis database. " +
      "For production isolation: add a second Railway Redis plugin to the signing service " +
      "and set SIGNER_REDIS_PRIVATE_URL + SIGNER_REDIS_URL.",
    );
  }
}

// ── Section 9: mTLS environment guard ─────────────────────────────

/**
 * When MTLS_ENABLED=true, all three cert env vars must be present.
 * Failing to set them would silently degrade to an insecure channel.
 *
 * Called on the main-API service (client cert) and the signing service
 * (server cert). Each service only needs to check its own vars.
 *
 * Main API requires: MTLS_CA_CERT, MTLS_CLIENT_CERT, MTLS_CLIENT_KEY
 * Signing service requires: MTLS_CA_CERT, MTLS_SERVER_CERT, MTLS_SERVER_KEY
 */
export function assertMtlsEnv(side: "client" | "server"): void {
  if (process.env.MTLS_ENABLED !== "true") return;

  const caCert = process.env.MTLS_CA_CERT;
  if (!caCert) {
    throw new Error(
      "BOOT FAILURE: MTLS_ENABLED=true but MTLS_CA_CERT is not set. " +
      "Set MTLS_CA_CERT to the base64-encoded PEM of the internal CA certificate.",
    );
  }

  if (side === "client") {
    if (!process.env.MTLS_CLIENT_CERT || !process.env.MTLS_CLIENT_KEY) {
      throw new Error(
        "BOOT FAILURE: MTLS_ENABLED=true but MTLS_CLIENT_CERT or MTLS_CLIENT_KEY is not set. " +
        "Run scripts/gen-mtls-certs.sh to generate certificates.",
      );
    }
  } else {
    if (!process.env.MTLS_SERVER_CERT || !process.env.MTLS_SERVER_KEY) {
      throw new Error(
        "BOOT FAILURE: MTLS_ENABLED=true but MTLS_SERVER_CERT or MTLS_SERVER_KEY is not set. " +
        "Run scripts/gen-mtls-certs.sh to generate certificates.",
      );
    }
  }
}

// ── Section 9: mTLS activation guard ──────────────────────────────

/**
 * Validates mTLS configuration at boot.
 *
 * Two behaviours:
 *   - MTLS_ENABLED=true:  calls assertMtlsEnv(side) which throws if any
 *     required cert env var is missing. Prevents half-configured mTLS
 *     from silently falling back to insecure mode.
 *   - MTLS_ENABLED=false: emits a prominent WARNING in production so the
 *     security gap is visible in deployment logs without blocking the boot.
 *     Operators can enable mTLS at their own pace.
 *
 * Called from runBootGuards() with side="client" for the Main API.
 * The Signing Service calls assertMtlsEnv("server") directly.
 */
export function assertMtlsProduction(side: "client" | "server"): void {
  // Validate certs are present when MTLS_ENABLED=true (reuse existing guard).
  // This function exists in the same file (see Section 9 above).
  assertMtlsEnv(side);

  if (process.env.MTLS_ENABLED !== "true") {
    const isProd =
      process.env.NODE_ENV === "production" ||
      process.env.RAILWAY_ENVIRONMENT === "production";
    if (isProd) {
      console.warn(
        "[envGuard] WARNING: MTLS_ENABLED is not set — Main API → Signing Service " +
        "channel is bearer-token only. Set MTLS_ENABLED=true with " +
        "MTLS_CA_CERT / MTLS_CLIENT_CERT / MTLS_CLIENT_KEY to harden this channel.",
      );
    }
  }
}

// ── Section 10: Cross-region treasury hash check ───────────────────

/**
 * Publish a SHA-256 hash of the configured treasury pay-to address to Redis.
 * On subsequent boots (other instances or rolling deploys), compare against
 * the stored hash. A mismatch indicates X402_PAY_TO_ADDRESS differs across
 * regions — payments in the misconfigured region flow to the wrong address.
 *
 * Uses SET NX so the first instance to boot wins. A mismatch is a hard
 * boot failure — a misconfigured treasury in production is critical.
 *
 * Skipped if Redis is unavailable (single-instance / local dev).
 *
 * Must be called AFTER assertAndFreezeTreasury() and assertRedisCredentials().
 */
export async function assertCrossRegionTreasuryHash(): Promise<void> {
  const { getRedis } = await import("../services/redis.js");
  const redis = getRedis();
  if (!redis) return; // Redis not configured — skip

  const HASH_KEY   = "x402:config:treasury-hash";
  const actualHash = createHash("sha256").update(config.x402.payToAddress).digest("hex");

  // SET NX — only set if key does not exist (first instance wins)
  const result = await redis.set(HASH_KEY, actualHash, { nx: true });

  if (result !== null) {
    // We just wrote it — this is the reference instance, nothing to compare
    return;
  }

  // Key already existed — compare with stored hash
  const storedHash = await redis.get<string>(HASH_KEY);
  if (storedHash && storedHash !== actualHash) {
    throw new Error(
      `BOOT FAILURE: Treasury address mismatch across regions. ` +
      `This instance has X402_PAY_TO_ADDRESS hash ${actualHash.slice(0, 16)}… ` +
      `but Redis records hash ${storedHash.slice(0, 16)}…. ` +
      `Ensure X402_PAY_TO_ADDRESS is identical across all deployment regions. ` +
      `To reset: delete the Redis key "${HASH_KEY}" and restart all instances.`,
    );
  }
}

// ── Section 11: Treasury hardening env validation ──────────────────

/**
 * Warn if treasury hardening env vars are missing in production.
 * These are not hard failures — the guards fail open/closed gracefully —
 * but missing configuration in production should be visible in logs.
 */
export function assertTreasuryHardeningEnv(): void {
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  if (!isProd) return;

  if (!process.env.TREASURY_DAILY_CAP_ALGO || !process.env.TREASURY_DAILY_CAP_USDC) {
    console.warn(
      "[envGuard] WARNING: TREASURY_DAILY_CAP_ALGO / TREASURY_DAILY_CAP_USDC not set. " +
      "Using defaults (10,000 ALGO / $50,000 USDC per day). " +
      "Set these to match your actual expected daily volume.",
    );
  }

  if (!process.env.VELOCITY_TVL_MICROUSDC) {
    throw new Error(
      "BOOT FAILURE: VELOCITY_TVL_MICROUSDC is required in production. " +
      "Set to the total value locked in microUSDC (e.g. 10000000000 = $10,000 USDC). " +
      "Without this, the mass drain circuit breaker is completely disabled.",
    );
  }

  if (process.env.VAULT_ADDR && (!process.env.VAULT_TOKEN || !process.env.VAULT_TRANSIT_KEY)) {
    throw new Error(
      "BOOT FAILURE: VAULT_ADDR is set but VAULT_TOKEN or VAULT_TRANSIT_KEY is missing. " +
      "Either set all three Vault variables (VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_KEY) " +
      "or remove VAULT_ADDR to fall back to the env-mnemonic signer adapter.",
    );
  }
}

// ── Composite boot guard ───────────────────────────────────────────

/**
 * Run all boot guards in order.
 * Call once at process start, before app.listen().
 * Sync guards throw synchronously; async guards must be awaited.
 * Any failure throws — the process will not start.
 */
export function runBootGuards(): void {
  assertRedisCredentials();
  assertAndFreezeTreasury();
  assertSignerEnvironment();
  assertMtlsProduction("client");
  assertTreasuryHardeningEnv();
  // Note: assertCrossRegionTreasuryHash() is async — call it separately
  // in the boot sequence with: await assertCrossRegionTreasuryHash();
}
