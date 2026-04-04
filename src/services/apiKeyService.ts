/**
 * Per-Operator API Key Service (S.2)
 *
 * Replaces the single shared PORTAL_API_SECRET with scoped, per-operator
 * keys so every portal action has an identity and audit trail.
 *
 * Key format:  pk_live_<32-byte-hex>   (64 hex chars after prefix)
 * Storage:     x402:api-keys:{sha256(plaintext)} → ApiKeyRecord (JSON)
 *              x402:api-keys:index                → set of keyIds
 *
 * The plaintext is returned exactly once on creation. Only the SHA-256 hash
 * is stored in Redis — a Redis breach does not expose working keys.
 *
 * Scopes:
 *   portal:read    — GET /api/portal/* (read-only)
 *   portal:write   — POST/PATCH /api/portal/* (state changes)
 *   agents:manage  — suspend/unsuspend agents
 *   system:halt    — POST /api/system/halt|unhalt
 */

import crypto from "crypto";
import { getRedis } from "./redis.js";

// ── Types ─────────────────────────────────────────────────────────────

export type ApiKeyScope =
  | "portal:read"
  | "portal:write"
  | "agents:manage"
  | "system:halt";

export interface ApiKeyRecord {
  /** Stable UUID — used in list/revoke operations */
  keyId:       string;
  /** Human-readable label set at creation */
  name:        string;
  scopes:      ApiKeyScope[];
  createdAt:   string;
  lastUsedAt?: string;
}

// ── Redis keys ─────────────────────────────────────────────────────────

const KEY_PREFIX   = "x402:api-keys:";
const INDEX_KEY    = "x402:api-keys:index";

function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

function storageKey(hash: string): string {
  return `${KEY_PREFIX}${hash}`;
}

// ── CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a new API key.
 * Returns the plaintext once — callers must store it securely.
 */
export async function createApiKey(
  name: string,
  scopes: ApiKeyScope[],
): Promise<{ plaintext: string; record: ApiKeyRecord }> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis not available");

  const rawBytes  = crypto.randomBytes(32).toString("hex");
  const plaintext = `pk_live_${rawBytes}`;
  const hash      = hashKey(plaintext);
  const keyId     = crypto.randomUUID();

  const record: ApiKeyRecord = {
    keyId,
    name,
    scopes,
    createdAt: new Date().toISOString(),
  };

  await Promise.all([
    redis.set(storageKey(hash), JSON.stringify(record)),
    redis.sadd(INDEX_KEY, `${hash}:${keyId}`),
  ]);

  return { plaintext, record };
}

/**
 * Look up a key by its plaintext and return the record + update lastUsedAt.
 * Returns null if the key is not found (wrong key or already revoked).
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyRecord | null> {
  const redis = getRedis();
  if (!redis) return null;

  const hash = hashKey(plaintext);
  const raw  = await redis.get<ApiKeyRecord>(storageKey(hash));
  if (!raw) return null;

  // Update lastUsedAt fire-and-forget — never block the auth path
  const updated: ApiKeyRecord = { ...raw, lastUsedAt: new Date().toISOString() };
  redis.set(storageKey(hash), JSON.stringify(updated)).catch(() => {});

  return raw;
}

/** List all active API keys (names + scopes — never plaintext). */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const redis = getRedis();
  if (!redis) return [];

  const entries = await redis.smembers(INDEX_KEY);
  if (!entries.length) return [];

  const records = await Promise.all(
    entries.map(async (entry) => {
      const hash = entry.split(":")[0];
      return redis.get<ApiKeyRecord>(storageKey(hash));
    }),
  );

  return records.filter((r): r is ApiKeyRecord => r !== null);
}

/**
 * Revoke a key by keyId.
 * Scans the index to find the hash, deletes the record, removes from index.
 */
export async function revokeApiKey(keyId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;

  const entries = await redis.smembers(INDEX_KEY);
  const entry   = entries.find((e) => e.endsWith(`:${keyId}`));
  if (!entry) return false;

  const hash = entry.split(":")[0];
  await Promise.all([
    redis.del(storageKey(hash)),
    redis.srem(INDEX_KEY, entry),
  ]);

  return true;
}
