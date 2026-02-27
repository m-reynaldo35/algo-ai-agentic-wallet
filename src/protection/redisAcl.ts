/**
 * Redis ACL Enforcement — Application-Layer Key Scope Guard
 *
 * Mirrors the Upstash database-level ACL rules in application code.
 * Two enforcement layers working together:
 *
 *   Layer 1 (this file) — application code throws before any Redis call
 *                          if the key is outside the role's allowed scope.
 *   Layer 2 (Upstash)   — even if Layer 1 is bypassed, the database token
 *                          has command+key restrictions configured via ACL.
 *
 * ── Role Scopes ─────────────────────────────────────────────────────
 *
 *   SIGNER
 *     Only allowed to touch signing-service replay guard keys.
 *     Cannot read agent records, rate-limit counters, or auth tokens.
 *     Upstash ACL: +get +set ~x402:sign:*
 *
 *   MAIN_API
 *     Full access to all x402: namespaces on the main-API database.
 *     Cannot write to x402:sign:* (signing-service isolated DB).
 *
 *   AGENT_READ (future: per-agent Upstash tokens)
 *     Can only GET x402:agents:{agentId} for its own registered agentId.
 *     Cannot delete rate-limit keys, cannot read other agents' records.
 *     Upstash ACL: +get ~x402:agents:{agentId}
 *
 * ── Upstash ACL Setup ────────────────────────────────────────────────
 *
 * Run scripts/setup-upstash-acls.sh to print the exact ACL rules to
 * configure in the Upstash console for each database.
 *
 * For the signing-service DB (SIGNER_REDIS_REST_URL):
 *   1. Log in to console.upstash.com
 *   2. Select the signing-service database
 *   3. Go to Details → Access Control
 *   4. Create a new ACL token with:
 *        Allowed commands: GET SET (no DEL, no KEYS, no FLUSHDB)
 *        Key pattern:      x402:sign:*
 *   5. Use that restricted token as SIGNER_REDIS_REST_TOKEN
 *
 * For the main-API DB (UPSTASH_REDIS_REST_URL):
 *   - The main API token retains full access.
 *   - Future: create a restricted AGENT_READ token for per-agent access.
 *
 * Module 7 — Redis ACL & Key Isolation
 */

// ── Key scope definitions ──────────────────────────────────────────

/** Keys the signing service is allowed to touch (replay guards only). */
const SIGNER_KEY_PREFIXES = [
  "x402:sign:replay:",    // requestId nonce (SET nx, GET)
  "x402:sign:groupid:",   // group ID seen flag (SET nx, GET)
] as const;

/** All valid x402: key prefixes in the main-API database. */
const MAIN_API_KEY_PREFIXES = [
  "x402:agents:",
  "x402:agent-addr:",
  "x402:rotation:",
  "x402:drift:",
  "x402:halt",
  "x402:security-audit",
  "x402:rejection-log",
  "x402:settlements",
  "x402:events",
  "x402:idempotent:",
  "x402:vel:",
  "x402:auth:",
  "x402:rate:",
  "x402:circuit:",
  "x402:api-keys",
  "x402:api-key-index:",
  "x402:custody-audit",
  "x402:mandate:",
  "x402:treasury:",
  "x402:recipient:",
  "x402:guardian:",
] as const;

// ── Service role type ─────────────────────────────────────────────

export type RedisRole = "signer" | "main-api";

// ── Public: assert a key is within scope ──────────────────────────

/**
 * Assert that `key` is within the allowed scope for `role`.
 *
 * Throws synchronously if the key is out of scope — callers should never
 * catch this; it indicates a programming error or a security violation.
 *
 * Usage:
 *   assertKeyScope("signer", `x402:sign:replay:${requestId}`); // ok
 *   assertKeyScope("signer", `x402:agents:${agentId}`);        // throws
 */
export function assertKeyScope(role: RedisRole, key: string): void {
  const allowed =
    role === "signer"
      ? SIGNER_KEY_PREFIXES.some((p) => key.startsWith(p))
      : MAIN_API_KEY_PREFIXES.some((p) => key.startsWith(p)) ||
        key === "x402:halt"; // exact match for the halt singleton key

  if (!allowed) {
    const scopeList =
      role === "signer"
        ? SIGNER_KEY_PREFIXES.join(", ")
        : "(all x402: namespaces)";

    const msg =
      `[RedisACL] VETO: role="${role}" attempted access to key "${key}" ` +
      `which is outside its allowed scope. Permitted prefixes: ${scopeList}`;

    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Assert that `key` is within the SIGNER scope.
 * Convenience wrapper for the signing-service replay guard.
 */
export function assertSignerKeyScope(key: string): void {
  assertKeyScope("signer", key);
}

// ── Upstash ACL rule generator ────────────────────────────────────

/**
 * Return the Upstash ACL configuration strings for each database role.
 * Print these in the Upstash console → Details → Access Control.
 *
 * Called by scripts/setup-upstash-acls.sh.
 */
export function getUpstashAclRules(): {
  signerDb: { commands: string; keyPattern: string; description: string };
  mainApiDb: { commands: string; keyPattern: string; description: string };
} {
  return {
    signerDb: {
      commands:    "+get +set",
      keyPattern:  "x402:sign:*",
      description:
        "Signing-service token: read/write only the replay guard namespace. " +
        "No DEL, no KEYS, no FLUSHDB. Cannot touch agent records or rate-limit keys.",
    },
    mainApiDb: {
      commands:    "+@all",
      keyPattern:  "x402:*",
      description:
        "Main-API token: full access to the main-API database within the x402: namespace. " +
        "Cannot access the signing-service database (separate Upstash DB).",
    },
  };
}
