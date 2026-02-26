/**
 * Mandate Engine — Deterministic AP2 Mandate Evaluation
 *
 * Called exclusively from POST /api/execute and the recurring scheduler.
 * NEVER called from the signing service.
 *
 * ARCHITECTURAL RULE: This file must NEVER import from @simplewebauthn/*,
 * mandateService.ts WebAuthn helpers, or any FIDO2 library. Evaluation is
 * deterministic: only decoded transaction bytes determine the outcome.
 * Caller-supplied amount and recipient fields are IGNORED.
 *
 * Evaluation order (must not be reordered):
 *   1.  Load mandate from Redis       → MANDATE_NOT_FOUND if absent
 *   2.  Verify HMAC (timingSafeEqual) → integrity check before all logic
 *   3.  status === "active"           → MANDATE_REVOKED
 *   4.  expiresAt check               → MANDATE_EXPIRED
 *   5.  Decode txn bytes (algosdk)    → extract totalUsdcAxfer, recipients
 *   6.  totalUsdcAxfer ≤ maxPerTx     → MAX_PER_TX_EXCEEDED
 *   7.  recipients in allowedList     → RECIPIENT_NOT_ALLOWED
 *   8.  Rolling 10m check (Lua)       → VELOCITY_10M_EXCEEDED
 *   9.  Rolling 24h check (Lua)       → VELOCITY_24H_EXCEEDED
 *  10.  Recurring check               → RECURRING_NOT_READY / RECURRING_AMOUNT_MISMATCH
 *  11.  Atomic velocity increment (Lua)
 *  12.  return { allowed: true }
 */

import { timingSafeEqual } from "node:crypto";
import algosdk             from "algosdk";
import { getRedis }        from "./redis.js";
import { emitSecurityEvent } from "./securityAudit.js";
import { loadRawMandate, computeMandateHmac, getKeyStatus } from "./mandateService.js";
import { config }          from "../config.js";
import type { Mandate, MandateEvalResult, MandateRejectCode } from "../types/mandate.js";

// ── Redis key constants ───────────────────────────────────────────

const VEL_10M_PREFIX = "x402:mandate:vel:10m:"; // ZSET TTL 601s
const VEL_24H_PREFIX = "x402:mandate:vel:24h:"; // ZSET TTL 86401s
const RECUR_PREFIX   = "x402:mandate:recurring:";

const WIN_10M_MS  = 10 * 60 * 1_000;
const WIN_24H_MS  = 24 * 60 * 60 * 1_000;
const TTL_10M_S   = 601;
const TTL_24H_S   = 86_401;

// ── Lua atomic velocity script ────────────────────────────────────
//
// Atomically:
//   1. Prune expired entries from both windows
//   2. Sum current windows
//   3. Check ceilings (0 = unconstrained)
//   4. If both OK: ZADD to record the spend; set TTLs
//   5. Return "OK" | "VELOCITY_10M_EXCEEDED" | "VELOCITY_24H_EXCEEDED"

const VELOCITY_LUA = `
local nowMs    = tonumber(ARGV[1])
local amount   = tonumber(ARGV[2])
local w10m     = nowMs - tonumber(ARGV[3])
local w24h     = nowMs - tonumber(ARGV[4])
local max10m   = tonumber(ARGV[5])
local max24h   = tonumber(ARGV[6])
local ttl10m   = tonumber(ARGV[7])
local ttl24h   = tonumber(ARGV[8])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, w10m)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, w24h)

local function sumWindow(key)
  local members = redis.call('ZRANGE', key, 0, -1)
  local total = 0
  for _, m in ipairs(members) do
    local amt = tonumber(m:match("^(%d+):"))
    if amt then total = total + amt end
  end
  return total
end

local cur10m = sumWindow(KEYS[1])
local cur24h = sumWindow(KEYS[2])

if max10m > 0 and (cur10m + amount) > max10m then
  return "VELOCITY_10M_EXCEEDED"
end
if max24h > 0 and (cur24h + amount) > max24h then
  return "VELOCITY_24H_EXCEEDED"
end

local member = amount .. ":" .. nowMs
redis.call('ZADD', KEYS[1], nowMs, member)
redis.call('ZADD', KEYS[2], nowMs, member)
redis.call('EXPIRE', KEYS[1], ttl10m)
redis.call('EXPIRE', KEYS[2], ttl24h)
return "OK"
`;

// ── Transaction decoder ────────────────────────────────────────────

interface DecodedGroup {
  totalUsdcAxfer: bigint;
  recipients:     Set<string>;
}

/**
 * Decode unsigned transaction blobs and extract:
 *   - totalUsdcAxfer: sum of all USDC axfer amounts
 *   - recipients: unique receiver Algorand addresses from axfers
 *
 * Non-USDC and non-axfer transactions are skipped (they are permitted in
 * the group but do not count toward the mandate spend).
 */
function decodeGroup(unsignedTxns: string[]): DecodedGroup {
  const usdcAssetId = BigInt(config.x402.usdcAssetId);
  let totalUsdcAxfer = 0n;
  const recipients   = new Set<string>();

  for (const b64 of unsignedTxns) {
    const blob = new Uint8Array(Buffer.from(b64, "base64"));
    const txn  = algosdk.decodeUnsignedTransaction(blob);

    if (
      txn.type === algosdk.TransactionType.axfer &&
      txn.assetTransfer?.assetIndex === usdcAssetId &&
      txn.assetTransfer.amount > 0n
    ) {
      totalUsdcAxfer += txn.assetTransfer.amount;
      if (txn.assetTransfer.receiver) {
        recipients.add(txn.assetTransfer.receiver.toString());
      }
    }
  }

  return { totalUsdcAxfer, recipients };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Evaluate whether the given unsigned transaction group is permitted
 * by the specified mandate.
 *
 * On success, the mandate's rolling velocity windows are atomically
 * incremented before returning { allowed: true }.
 *
 * Fail-closed on Redis outage: returns MANDATE_NOT_FOUND (blocks execution).
 */
export async function evaluateMandate(
  agentId:      string,
  mandateId:    string,
  unsignedTxns: string[],
): Promise<MandateEvalResult> {
  // ── Step 1: Load mandate ──────────────────────────────────────
  const mandate = await loadRawMandate(agentId, mandateId);
  if (!mandate) {
    return reject("MANDATE_NOT_FOUND", "Mandate not found — possibly expired");
  }

  // ── Step 2: Verify HMAC — before ALL other checks ─────────────
  if (!verifyHmac(mandate)) {
    return reject("MANDATE_NOT_FOUND", "Mandate integrity check failed");
  }

  // ── Step 2b: Warn if mandate uses a retired signing key ────────
  // The mandate is still valid — retired means verify-only, not blocked.
  // Operators should track these events and prompt re-issuance before
  // the key is fully removed from the registry.
  if (getKeyStatus(mandate.kid) === "retired") {
    emitSecurityEvent({
      type:    "MANDATE_RETIRED_KEY",
      agentId,
      detail:  { mandateId, kid: mandate.kid },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Step 3: Status check ──────────────────────────────────────
  if (mandate.status !== "active") {
    return reject("MANDATE_REVOKED", "Mandate has been revoked");
  }

  // ── Step 4: Expiry check ──────────────────────────────────────
  if (mandate.expiresAt && Date.now() > mandate.expiresAt) {
    return reject("MANDATE_EXPIRED", "Mandate has expired");
  }

  // ── Step 5: Decode txn bytes authoritatively ──────────────────
  let decoded: DecodedGroup;
  try {
    decoded = decodeGroup(unsignedTxns);
  } catch (err) {
    return reject("MANDATE_NOT_FOUND", `Transaction decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { totalUsdcAxfer, recipients } = decoded;

  // ── Step 6: maxPerTx check ────────────────────────────────────
  if (mandate.maxPerTx) {
    const cap = BigInt(mandate.maxPerTx);
    if (totalUsdcAxfer > cap) {
      return reject(
        "MAX_PER_TX_EXCEEDED",
        `Transaction total ${totalUsdcAxfer} µUSDC exceeds mandate maxPerTx ${cap} µUSDC`,
      );
    }
  }

  // ── Step 7: Recipient whitelist check ─────────────────────────
  if (mandate.allowedRecipients && mandate.allowedRecipients.length > 0) {
    const allowed = new Set(mandate.allowedRecipients);
    for (const r of recipients) {
      if (!allowed.has(r)) {
        return reject(
          "RECIPIENT_NOT_ALLOWED",
          `Recipient ${r} is not in mandate allowedRecipients`,
        );
      }
    }
  }

  // ── Steps 8-9 + 11: Atomic velocity check + increment (Lua) ──
  const redis = getRedis();
  if (!redis) {
    // Fail-closed: no Redis = cannot verify velocity = block
    return reject("MANDATE_NOT_FOUND", "Redis unavailable — mandate evaluation blocked (fail-closed)");
  }

  const max10m = mandate.maxPer10Min ? Number(BigInt(mandate.maxPer10Min)) : 0;
  const max24h  = mandate.maxPerDay   ? Number(BigInt(mandate.maxPerDay))   : 0;

  // Only run velocity Lua if at least one window is constrained and there is spend
  if (totalUsdcAxfer > 0n && (max10m > 0 || max24h > 0)) {
    const luaResult = await redis.eval(
      VELOCITY_LUA,
      [
        `${VEL_10M_PREFIX}${agentId}`,
        `${VEL_24H_PREFIX}${agentId}`,
      ],
      [
        String(Date.now()),
        String(totalUsdcAxfer),
        String(WIN_10M_MS),
        String(WIN_24H_MS),
        String(max10m),
        String(max24h),
        String(TTL_10M_S),
        String(TTL_24H_S),
      ],
    ) as string;

    if (luaResult === "VELOCITY_10M_EXCEEDED") {
      return reject("VELOCITY_10M_EXCEEDED", "Mandate 10-minute rolling window exceeded");
    }
    if (luaResult === "VELOCITY_24H_EXCEEDED") {
      return reject("VELOCITY_24H_EXCEEDED", "Mandate 24-hour rolling window exceeded");
    }
  }

  // ── Step 10: Recurring check ──────────────────────────────────
  if (mandate.recurring) {
    const now      = Date.now();
    const nextExec = mandate.recurring.nextExecution;

    if (now < nextExec) {
      return reject(
        "RECURRING_NOT_READY",
        `Recurring payment not yet due. Next execution: ${new Date(nextExec).toISOString()}`,
      );
    }

    const recurAmount = BigInt(mandate.recurring.amount);
    if (totalUsdcAxfer !== recurAmount) {
      return reject(
        "RECURRING_AMOUNT_MISMATCH",
        `Recurring mandate requires exactly ${recurAmount} µUSDC; got ${totalUsdcAxfer}`,
      );
    }

    // Atomically update nextExecution
    const nextMs = now + mandate.recurring.intervalSeconds * 1_000;
    await redis.set(`${RECUR_PREFIX}${mandateId}`, String(nextMs));
  }

  // ── Step 12: Emit + return ────────────────────────────────────
  emitSecurityEvent({
    type:    "MANDATE_EVALUATED",
    agentId,
    detail: {
      mandateId,
      totalUsdcAxfer: totalUsdcAxfer.toString(),
      allowed:        true,
    },
    timestamp: new Date().toISOString(),
  });

  return { allowed: true };
}

// ── Helpers ───────────────────────────────────────────────────────

function reject(code: MandateRejectCode, message: string): MandateEvalResult {
  return { allowed: false, code, message };
}

function verifyHmac(mandate: Mandate): boolean {
  try {
    const expected = computeMandateHmac(mandate);
    const stored   = mandate.hmac ?? "";
    const expBuf   = Buffer.from(expected, "hex");
    const storedBuf = Buffer.from(stored, "hex");
    if (expBuf.length !== storedBuf.length) return false;
    return timingSafeEqual(expBuf, storedBuf);
  } catch {
    return false;
  }
}
