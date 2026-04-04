/**
 * Portal Audit Log (S.9)
 *
 * Attributable log of every operator-level action: who did what, when, and to which target.
 * Requires S.2 (per-operator API keys) to provide operator identity.
 *
 * Storage:
 *   Redis ring buffer   x402:audit:log  ZSET  score=ms  member=JSON  (max 1000 entries)
 *   pino logger         always (Railway log drain)
 *
 * Access: GET /api/portal/audit (requirePortalAuth)
 */

import { createHash } from "crypto";
import { getRedis } from "../services/redis.js";
import { logger } from "./logger.js";

export interface AuditEvent {
  timestamp:    string;
  operatorName: string;
  /** Hashed client IP — never store raw IP */
  ipHash:       string;
  action:       string;
  /** ID of the resource affected (agentId, keyId, etc.) */
  targetId?:    string;
  result:       "ok" | "error";
  metadata?:    Record<string, unknown>;
}

const AUDIT_KEY   = "x402:audit:log";
const MAX_ENTRIES = 1000;

function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? "x402-audit";
  return createHash("sha256").update(salt + ip).digest("hex").slice(0, 16);
}

export function logAuditEvent(
  operatorName: string,
  action: string,
  req: { ip?: string; socket?: { remoteAddress?: string }; header?: (h: string) => string | undefined },
  opts: { targetId?: string; result?: "ok" | "error"; metadata?: Record<string, unknown> } = {},
): void {
  const ip     = req.header?.("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? req.ip
    ?? req.socket?.remoteAddress
    ?? "unknown";

  const event: AuditEvent = {
    timestamp:    new Date().toISOString(),
    operatorName,
    ipHash:       hashIp(ip),
    action,
    targetId:     opts.targetId,
    result:       opts.result ?? "ok",
    metadata:     opts.metadata,
  };

  // Always log to stdout (Railway log drain)
  logger.info({ audit: event }, `[Audit] ${operatorName} → ${action}`);

  // Async ring-buffer write — never block the response
  const redis = getRedis();
  if (redis) {
    const score = Date.now();
    const member = JSON.stringify(event);
    redis.zadd(AUDIT_KEY, { score, member })
      .then(() => redis.zremrangebyrank(AUDIT_KEY, 0, -(MAX_ENTRIES + 1)))
      .catch(() => {});
  }
}

/** Paginated audit log read — for GET /api/portal/audit */
export async function getAuditLog(opts: {
  limit?: number;
  offset?: number;
} = {}): Promise<AuditEvent[]> {
  const redis = getRedis();
  if (!redis) return [];

  const limit  = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  // Most-recent first
  const members = await redis.zrange(AUDIT_KEY, 0, -1, { rev: true });
  const page    = members.slice(offset, offset + limit);

  return page.map((m) => {
    try { return JSON.parse(m) as AuditEvent; } catch { return null; }
  }).filter((e): e is AuditEvent => e !== null);
}
