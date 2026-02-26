/**
 * Structured Rejection Logger — Phase 1.5 Operational Hardening
 *
 * Logs security-relevant rejection events from the execution pipeline
 * in a consistent machine-readable format for Railway log aggregation
 * and operational monitoring.
 *
 * Every rejection is emitted to:
 *   1. stdout  — as structured JSON (picked up by Railway log drain)
 *   2. Redis   — as a ring buffer of the last 1000 events
 *              (key: x402:rejection-log, ZSET scored by timestamp)
 *
 * Privacy rules — the following are NEVER logged:
 *   ✗  Raw transaction blobs
 *   ✗  Auth tokens or Liquid Auth credentials
 *   ✗  Cryptographic signatures
 *   ✗  Algorand mnemonics or private keys
 *   ✗  Raw IP addresses
 *   ✗  IP_HASH_SALT value
 *   ✓  Agent's public address (on-chain identifier, not secret)
 *   ✓  IP address — SHA-256(ip + IP_HASH_SALT), first 16 hex chars only
 *       Salt makes offline rainbow table attacks infeasible.
 *       16 hex chars (64 bits) is sufficient for correlation, not reconstruction.
 */

import { createHash } from "node:crypto";
import { getRedis } from "../services/redis.js";
import { ingest as telemetryIngest } from "../services/telemetrySink.js";

// ── Types ──────────────────────────────────────────────────────────

export type RejectionType =
  | "RATE_LIMIT"    // per-agent 60s window exceeded
  | "BURST_LIMIT"   // per-agent 10s burst exceeded
  | "GLOBAL_LIMIT"  // global signer window exceeded
  | "CIRCUIT_OPEN"; // circuit breaker tripped

export interface RejectionEvent {
  type:        RejectionType;
  agent:       string;
  timestamp:   string;
  ip_hash:     string;
  reason_code: string;
}

// ── Config ─────────────────────────────────────────────────────────

const REJECTION_LOG_KEY  = "x402:rejection-log";
const MAX_LOG_ENTRIES    = 1000;

// ── IP hash salt ────────────────────────────────────────────────────
//
// Read once at module load from the environment. Never generated at runtime —
// a dynamically generated salt would break correlation across process restarts
// and across Railway instances running the same service.
//
// Requirements for IP_HASH_SALT:
//   - At least 32 random bytes, base64-encoded (openssl rand -base64 32)
//   - Static per Railway environment (production, staging etc.)
//   - Identical across all instances of this service (Railway injects it to all)
//   - Never rotated casually — rotation breaks log correlation for the window
//     between old and new salt deployment
//   - Never logged, never returned in API responses
//
// Without the salt, SHA-256(ip) is precomputable for the full IPv4 space
// (~4 billion entries, trivial offline). With the salt, offline attacks are
// infeasible because the attacker cannot reproduce the hash without the secret.

const IP_HASH_SALT: string = process.env.IP_HASH_SALT ?? "";

if (!IP_HASH_SALT) {
  console.warn(
    "[RejectionLog] WARNING: IP_HASH_SALT is not set. " +
    "IP hashes are unsalted and vulnerable to offline rainbow table attacks. " +
    "Set IP_HASH_SALT to a random 32-byte base64 string (openssl rand -base64 32).",
  );
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * One-way salted hash of a raw IP address.
 * SHA-256(ip + IP_HASH_SALT) → first 16 hex characters (64 bits).
 * Sufficient for correlating requests from the same source across log entries.
 * Not sufficient to reconstruct the original IP or mount offline attacks.
 */
function hashIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  return createHash("sha256").update(ip + IP_HASH_SALT).digest("hex").slice(0, 16);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Log a rejection event.
 *
 * Emits to stdout synchronously (Railway log drain picks this up).
 * Appends to the Redis ring buffer asynchronously (fire-and-forget).
 * The async Redis write never blocks or throws — logging must not
 * affect the response path.
 *
 * @param type       - Category of the rejection
 * @param agent      - Agent's public address (or agentId if address unavailable)
 * @param ip         - Raw client IP — will be hashed before storage
 * @param reasonCode - Machine-readable rejection code (matches violation enum)
 */
export async function logRejection(
  type:       RejectionType,
  agent:      string,
  ip:         string | undefined,
  reasonCode: string,
): Promise<void> {
  const event: RejectionEvent = {
    type,
    agent,
    timestamp:   new Date().toISOString(),
    ip_hash:     hashIp(ip),
    reason_code: reasonCode,
  };

  // ── Stdout (synchronous, Railway log drain) ──────────────────
  console.warn("[RejectionLog]", JSON.stringify(event));

  // ── External telemetry (fire-and-forget) ──────────────────────
  telemetryIngest({ source: "rejection-log", ...event });

  // ── Redis ring buffer (async, fire-and-forget) ────────────────
  const redis = getRedis();
  if (redis) {
    const score  = Date.now();
    const member = JSON.stringify(event);
    redis
      .zadd(REJECTION_LOG_KEY, { score, member })
      // Trim to MAX_LOG_ENTRIES — remove the oldest entries
      .then(() => redis.zremrangebyrank(REJECTION_LOG_KEY, 0, -(MAX_LOG_ENTRIES + 1)))
      .catch(() => {/* never throw — logging must not affect execution */});
  }
}
