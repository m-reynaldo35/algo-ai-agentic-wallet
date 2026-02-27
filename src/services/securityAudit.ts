/**
 * Security Audit — Structured Event Emission
 *
 * Centralised logging for every security-critical operation.
 * All events go to stdout (Railway log drain) and to a Redis
 * ZSET ring buffer for portal-level querying.
 *
 * Event schema is stable — downstream consumers (SIEM, alerting)
 * can pattern-match on the `type` field.
 *
 * Redis key:
 *   x402:security-audit  ZSET  score=timestampMs  member=JSON  (last 10 000 events)
 */

import { randomUUID } from "node:crypto";
import { getRedis } from "./redis.js";
import { ingest as telemetryIngest } from "./telemetrySink.js";

// ── Instance identity ──────────────────────────────────────────────
// Stable for the lifetime of this process. Allows post-incident
// investigation to identify which region/instance emitted an event.
const INSTANCE_ID = randomUUID();
const REGION = process.env.RAILWAY_REGION ?? process.env.FLY_REGION ?? "default";

// ── Event catalogue ────────────────────────────────────────────────

export type SecurityEventType =
  | "TOKEN_ISSUED"              // Tier 1 approval token created
  | "TOKEN_CONSUMED"            // Tier 1 approval token validated + consumed
  | "TOKEN_REJECTED"            // Approval token validation failed
  | "REKEY_INITIATED"           // executeRekey lock acquired
  | "REKEY_CONFIRMED"           // on-chain auth-addr verified post-confirmation
  | "REKEY_FAILED"              // rekey txn rejected or post-verification failed
  | "CUSTODY_TRANSITION"        // any custody→custody state change
  | "VELOCITY_APPROVAL_REQUIRED"// per-agent rolling window exceeded threshold
  | "MASS_DRAIN_DETECTED"       // global outflow exceeded TVL percent
  | "DRIFT_DETECTED"            // on-chain auth-addr ≠ registry authAddr
  | "DRIFT_RESOLVED"            // drift record closed after recovery
  | "REKEY_SYNC_CORRECTION"     // reboot sync reconciled a stale lock
  | "SECURITY_ALERT"            // catch-all for high-severity anomalies
  // ── AP2 Mandate events ────────────────────────────────────────
  | "MANDATE_CREATED"           // new mandate registered (FIDO2-gated)
  | "MANDATE_REVOKED"           // mandate revoked (FIDO2-gated)
  | "MANDATE_EVALUATED"         // evaluate called (allowed or rejected)
  | "MANDATE_REJECTED"          // evaluation returned a reject code
  | "MANDATE_RETIRED_KEY"       // evaluated mandate is signed with a retired key — re-issue soon
  | "RECURRING_EXECUTED"        // recurring scheduler executed a payment
  | "RECURRING_FAILED"          // recurring scheduler execution failed
  // ── Treasury hardening events ─────────────────────────────────
  | "DAILY_CAP_BREACH"          // global daily ALGO/USDC outflow cap exceeded
  | "RECIPIENT_ANOMALY"         // transaction recipient flagged as suspicious
  | "DRAIN_VELOCITY_HALT"       // signer balance dropped too fast — guardian halted signing
  | "SWEEP_ADDR_TAMPER"         // cold wallet sweep address mismatch detected
  // ── On-chain monitor events (Module 9) ───────────────────────
  | "SIGNER_KEY_COMPROMISE";    // on-chain outflows exceed Gate 5 authorized total — key compromise suspected

// ── Event shape ────────────────────────────────────────────────────

export interface SecurityEvent {
  /** Stable machine-readable event code */
  type:       SecurityEventType;
  /** Agent this event relates to (omit for global events) */
  agentId?:   string;
  /** Wallet that triggered the event, if known */
  walletId?:  string;
  /** On-chain transaction ID, if applicable */
  txid?:      string;
  /** Structured payload — type-specific fields */
  detail:     Record<string, unknown>;
  /** ISO 8601 timestamp */
  timestamp:  string;
  /**
   * Deployment region — RAILWAY_REGION / FLY_REGION / "default".
   * Allows post-incident investigation to identify which region
   * emitted this event (e.g. which region triggered a mass drain halt).
   * Auto-populated by emitSecurityEvent(); callers do not set this.
   */
  region?:     string;
  /**
   * UUID stable for the lifetime of this process instance.
   * Correlates all events from a single instance across a multi-region
   * rolling deploy. Auto-populated by emitSecurityEvent().
   */
  instanceId?: string;
}

// ── Ring buffer policy ─────────────────────────────────────────────

const AUDIT_KEY        = "x402:security-audit";
const MAX_AUDIT_EVENTS = 10_000;

// ── Emitter ───────────────────────────────────────────────────────

/**
 * Emit a structured security event.
 *
 * Synchronous stdout write (always): JSON line with `source` tag
 * so log drain queries can filter with `source:"security-audit"`.
 *
 * Async Redis write (best-effort): stored in a ZSET ring buffer
 * capped at MAX_AUDIT_EVENTS. Never awaited — a Redis failure must
 * not block the critical path that called emitSecurityEvent.
 */
export function emitSecurityEvent(event: SecurityEvent): void {
  // Stamp with region + instanceId so events are traceable across multi-region
  // deployments without the caller needing to know the deployment topology.
  const enriched: SecurityEvent = {
    ...event,
    region:     REGION,
    instanceId: INSTANCE_ID,
  };

  // Always write to stdout first — visible in Railway even if Redis is down
  console.log(JSON.stringify({ source: "security-audit", ...enriched }));

  // Fire-and-forget to external telemetry backend (Axiom / Datadog)
  telemetryIngest({ source: "security-audit", ...enriched });

  // Best-effort ring buffer
  const redis = getRedis();
  if (!redis) return;

  const score  = Date.now();
  const member = JSON.stringify(enriched);

  redis
    .zadd(AUDIT_KEY, { score, member })
    .then(() => redis.zremrangebyrank(AUDIT_KEY, 0, -(MAX_AUDIT_EVENTS + 1)))
    .catch(() => {});
}

// ── Query helpers (for portal endpoints) ──────────────────────────

/**
 * Retrieve the most recent N security events.
 * Returns newest-first.
 */
export async function getRecentSecurityEvents(limit = 100): Promise<SecurityEvent[]> {
  const redis = getRedis();
  if (!redis) return [];

  try {
    // ZRANGE with REV returns highest scores (most recent) first
    const members = await redis.zrange(AUDIT_KEY, 0, limit - 1, { rev: true }) as string[];
    return members
      .map((m) => { try { return JSON.parse(m) as SecurityEvent; } catch { return null; } })
      .filter((e): e is SecurityEvent => e !== null);
  } catch {
    return [];
  }
}

/**
 * Retrieve security events filtered by type and optional agentId.
 * Scans the most recent `scanLimit` events (default 1000).
 */
export async function querySecurityEvents(
  type:       SecurityEventType,
  agentId?:   string,
  scanLimit = 1_000,
): Promise<SecurityEvent[]> {
  const redis = getRedis();
  if (!redis) return [];

  try {
    const members = await redis.zrange(AUDIT_KEY, 0, scanLimit - 1, { rev: true }) as string[];
    return members
      .map((m) => { try { return JSON.parse(m) as SecurityEvent; } catch { return null; } })
      .filter((e): e is SecurityEvent =>
        e !== null &&
        e.type === type &&
        (!agentId || e.agentId === agentId),
      );
  } catch {
    return [];
  }
}
