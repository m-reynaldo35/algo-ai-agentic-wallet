import pino from "pino";

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

interface ExecutionFailureLog {
  event: "execution.failure";
  agentId: string;
  failedStage: "validation" | "auth" | "sign" | "broadcast";
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
  const entry: ExecutionFailureLog = {
    event: "execution.failure",
    agentId,
    failedStage: stage,
    error,
    timestamp: new Date().toISOString(),
  };
  logger.error(entry, `Pipeline aborted at stage: ${stage}`);
}
