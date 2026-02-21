import pino from "pino";
import { getRedis } from "./redis.js";
import { dispatchWebhooks } from "./webhook.js";

// Lazy import to avoid circular dependency — index.ts registers the function after boot
let _broadcastSSE: ((event: string, data: unknown) => void) | null = null;
export function registerSSEBroadcaster(fn: (event: string, data: unknown) => void): void {
  _broadcastSSE = fn;
}
function emitSSE(event: string, data: unknown): void {
  _broadcastSSE?.(event, data);
}

// ── Logger Instance ────────────────────────────────────────────
// Strict JSON in production for log aggregators (Datadog, ELK, etc.).
// Pretty-printed in dev for human readability.
const logger = pino({
  name: "x402-audit",
  level: "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
    },
  }),
});

// ── Strictly Typed Log Schemas ─────────────────────────────────
// These interfaces define the exact JSON shape emitted per event,
// ensuring downstream dashboards can query fields deterministically.

interface SettlementSuccessLog {
  event: "settlement.success";
  txnId: string;
  agentId: string;
  tollAmountMicroUsdc: number;
  groupId: string;
  settledAt: string;
}

type FailureReason = "VALIDATION_ERROR" | "AUTH_ERROR" | "SIGN_ERROR" | "BROADCAST_ERROR" | "POLICY_BREACH";

interface ExecutionFailureLog {
  event: "execution.failure";
  agentId: string;
  failedStage: "validation" | "auth" | "sign" | "broadcast";
  failureReason: FailureReason;
  error: string;
  timestamp: string;
}

// ── Exported Log Functions ─────────────────────────────────────

/**
 * Log a successful on-chain settlement (revenue captured).
 *
 * Emitted once per confirmed Algorand atomic group. The `tollAmountMicroUsdc`
 * field represents the exact x402 toll collected in this settlement.
 */
export function logSettlementSuccess(
  txnId: string,
  agentId: string,
  tollAmount: number,
  groupId: string,
): void {
  const entry: SettlementSuccessLog = {
    event: "settlement.success",
    txnId,
    agentId,
    tollAmountMicroUsdc: tollAmount,
    groupId,
    settledAt: new Date().toISOString(),
  };
  logger.info(entry, "x402 toll settled on-chain");

  // Fire-and-forget: Redis dual-write + outbound webhooks
  const redis = getRedis();
  if (redis) {
    const score = Date.now();
    redis
      .zadd("x402:settlements", { score, member: JSON.stringify(entry) })
      .then(() => redis.zremrangebyrank("x402:settlements", 0, -1001))
      .catch(() => {});
  }
  dispatchWebhooks("settlement.success", entry as unknown as Record<string, unknown>).catch(() => {});
  emitSSE("settlement.success", entry);
}

/**
 * Detect whether an error message indicates a TEAL LogicSig policy breach.
 * The Algod client returns these specific strings when a stateless
 * Smart Signature rejects a transaction at the AVM consensus level.
 */
function detectPolicyBreach(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("logic eval failed") || lower.includes("rejected by logic");
}

/**
 * Log a pipeline stage failure (abandoned toll / failed trade).
 *
 * Emitted when any of the four pipeline stages aborts. The `failedStage`
 * field indicates the exact abort point for post-mortem analysis.
 */
export function logExecutionFailure(
  agentId: string,
  stage: "validation" | "auth" | "sign" | "broadcast",
  error: string,
): void {
  const isPolicyBreach = detectPolicyBreach(error);

  const stageToReason: Record<typeof stage, FailureReason> = {
    validation: "VALIDATION_ERROR",
    auth: "AUTH_ERROR",
    sign: "SIGN_ERROR",
    broadcast: "BROADCAST_ERROR",
  };

  const failureReason: FailureReason = isPolicyBreach ? "POLICY_BREACH" : stageToReason[stage];

  const entry: ExecutionFailureLog = {
    event: "execution.failure",
    agentId,
    failedStage: stage,
    failureReason,
    error,
    timestamp: new Date().toISOString(),
  };

  if (isPolicyBreach) {
    logger.error(entry, `TEAL POLICY BREACH: Agent ${agentId} exceeded LogicSig spending bounds`);
  } else {
    logger.error(entry, `Pipeline aborted at stage: ${stage}`);
  }

  // Fire-and-forget: Redis dual-write + outbound webhooks
  const redis = getRedis();
  if (redis) {
    const score = Date.now();
    redis
      .zadd("x402:events", { score, member: JSON.stringify(entry) })
      .then(() => redis.zremrangebyrank("x402:events", 0, -1001))
      .catch(() => {});
  }
  dispatchWebhooks("execution.failure", entry as unknown as Record<string, unknown>).catch(() => {});
  emitSSE("execution.failure", entry);
}
