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

// ── Oracle Context ────────────────────────────────────────────
// Captures the exact Gora oracle market conditions at the
// millisecond of execution — attached to both success and
// failure logs for complete post-mortem traceability.

export interface OracleContext {
  /** The asset pair queried (e.g., "USDC/ALGO") */
  assetPair: string;
  /** The Gora consensus price as a string (serialized bigint, 6-decimal fixed-point) */
  goraConsensusPrice: string;
  /** Unix epoch timestamp of the Gora oracle assertion */
  goraTimestamp: number;
  /** ISO-8601 formatted oracle assertion time for human readability */
  goraTimestampISO: string;
  /** The mathematical deviation between the requested trade rate and the oracle price (basis points) */
  slippageDelta: number;
}

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
  oracleContext?: OracleContext;
}

interface ExecutionFailureLog {
  event: "execution.failure";
  agentId: string;
  failedStage: "validation" | "auth" | "sign" | "broadcast";
  error: string;
  timestamp: string;
  oracleContext?: OracleContext;
}

// ── Exported Log Functions ─────────────────────────────────────

/**
 * Log a successful on-chain settlement (revenue captured).
 *
 * Emitted once per confirmed Algorand atomic group. The `tollAmountMicroUsdc`
 * field represents the exact x402 toll collected in this settlement.
 * The optional `oracleContext` permanently records the Gora consensus
 * price at the exact millisecond of execution.
 */
export function logSettlementSuccess(
  txnId: string,
  agentId: string,
  tollAmount: number,
  groupId: string,
  oracleContext?: OracleContext,
): void {
  const entry: SettlementSuccessLog = {
    event: "settlement.success",
    txnId,
    agentId,
    tollAmountMicroUsdc: tollAmount,
    groupId,
    settledAt: new Date().toISOString(),
    ...(oracleContext && { oracleContext }),
  };
  logger.info(entry, "x402 toll settled on-chain");
}

/**
 * Log a pipeline stage failure (abandoned toll / failed trade).
 *
 * Emitted when any of the four pipeline stages aborts. The `failedStage`
 * field indicates the exact abort point for post-mortem analysis.
 * The optional `oracleContext` records the Gora price that caused
 * or was present at the time of the rejection.
 */
export function logExecutionFailure(
  agentId: string,
  stage: "validation" | "auth" | "sign" | "broadcast",
  error: string,
  oracleContext?: OracleContext,
): void {
  const entry: ExecutionFailureLog = {
    event: "execution.failure",
    agentId,
    failedStage: stage,
    error,
    timestamp: new Date().toISOString(),
    ...(oracleContext && { oracleContext }),
  };
  logger.error(entry, `Pipeline aborted at stage: ${stage}`);
}
