import algosdk from "algosdk";
import { requestWithPayment, X402Error } from "./interceptor.js";
import type {
  ClientConfig,
  TradeParams,
  BatchTradeParams,
  AgentActionResponse,
  BatchActionResponse,
  SettlementResult,
  SettlementFailure,
  TradeResult,
  ProgressCallback,
} from "./types.js";
import { X402ErrorCode } from "./types.js";

const DEFAULT_SLIPPAGE_BIPS = 50;
const MAX_BATCH_SIZE = 16;

/**
 * AlgoAgentClient — x402 SDK for AI-to-AI settlement on Algorand
 *
 * Encapsulates the full x402 handshake:
 *   402 bounce → proof generation → sandbox export → settlement
 *
 * Features:
 *   - Automatic 402 handshake absorption
 *   - Retry with exponential backoff
 *   - Cross-chain USDC routing (Ethereum, Solana, Base)
 *   - Batched atomic settlement (up to 16 trades)
 *   - Progress callbacks for streaming pipeline status
 *   - Typed error codes for deterministic error handling
 */
export class AlgoAgentClient {
  private readonly baseUrl: string;
  private readonly privateKey: Uint8Array;
  private readonly senderAddress: string;
  private readonly slippageBips: number;
  private readonly agentId: string;
  private readonly maxRetries: number;
  private readonly onProgress: ProgressCallback | undefined;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) {
      throw new X402Error("baseUrl is required", X402ErrorCode.CONFIG_ERROR);
    }
    if (!config.privateKey || config.privateKey.length !== 64) {
      throw new X402Error(
        "privateKey must be a 64-byte Algorand secret key",
        X402ErrorCode.CONFIG_ERROR,
      );
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.privateKey = config.privateKey;
    this.slippageBips = config.slippageBips ?? DEFAULT_SLIPPAGE_BIPS;
    this.maxRetries = config.maxRetries ?? 2;
    this.onProgress = config.onProgress;

    // Derive Algorand address: sk is 64 bytes [seed(32) | pubkey(32)]
    this.senderAddress = algosdk.encodeAddress(config.privateKey.slice(32));
    this.agentId = `sdk-${this.senderAddress.slice(0, 8)}`;
  }

  // ── Single Trade ─────────────────────────────────────────────

  /**
   * Execute a full x402 trade: handshake → sandbox → settlement.
   * Fires onProgress callbacks at each stage if configured.
   */
  async executeTrade(params: TradeParams): Promise<TradeResult> {
    this.emit("handshake", "Initiating x402 handshake...");

    const sandboxResponse = await this.requestSandboxExport(params);

    this.emit("sandbox_ready", "Sandbox sealed — forwarding to executor", {
      sandboxId: sandboxResponse.export.sandboxId,
      txnCount: String(sandboxResponse.export.atomicGroup.txnCount),
    });

    return this.settle(sandboxResponse);
  }

  /**
   * Step 1+2: Hit /api/agent-action, absorb the 402, return the SandboxExport.
   * Useful if you want to inspect the atomic group before settling.
   */
  async requestSandboxExport(params: TradeParams): Promise<AgentActionResponse> {
    const url = `${this.baseUrl}/api/agent-action`;
    const reqBody = JSON.stringify({
      senderAddress: params.senderAddress,
      ...(params.amount !== undefined && { amount: params.amount }),
      ...(params.destinationChain && { destinationChain: params.destinationChain }),
      ...(params.destinationRecipient && { destinationRecipient: params.destinationRecipient }),
    });

    let response: Response;
    try {
      response = await requestWithPayment(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SLIPPAGE-BIPS": String(this.slippageBips),
          },
          body: reqBody,
        },
        this.privateKey,
        params.senderAddress,
        this.maxRetries,
      );
    } catch (err) {
      const error = err instanceof X402Error ? err : new X402Error(
        err instanceof Error ? err.message : String(err),
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", `Sandbox request failed: ${error.message}`, { code: error.code });
      throw error;
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: response.statusText }));
      const msg = (errBody as Record<string, string>).error ?? "unknown";
      const error = new X402Error(
        `agent-action failed (${response.status}): ${msg}`,
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", error.message, { statusCode: String(response.status) });
      throw error;
    }

    this.emit("proof_built", "x402 payment proof accepted by server");
    return response.json() as Promise<AgentActionResponse>;
  }

  /**
   * Step 3: Forward a SandboxExport to /api/execute for on-chain settlement.
   */
  async settle(agentActionResponse: AgentActionResponse): Promise<TradeResult> {
    this.emit("settling", "Executing settlement pipeline on-chain...");

    const response = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxExport: agentActionResponse.export,
        agentId: this.agentId,
      }),
    });

    const result = (await response.json()) as TradeResult;

    if (!response.ok || (result as SettlementFailure).error) {
      const failure = result as SettlementFailure;
      const isPolicyBreach = failure.error?.includes("POLICY_BREACH");
      this.emit("failed", failure.error ?? "Settlement failed", {
        stage: failure.failedStage ?? "",
        code: isPolicyBreach ? X402ErrorCode.POLICY_BREACH : X402ErrorCode.SETTLEMENT_ERROR,
      });
      return result;
    }

    const success = result as SettlementResult;
    this.emit("confirmed", "Settlement confirmed on-chain", {
      txnId: success.settlement?.txnId ?? "",
      confirmedRound: String(success.settlement?.confirmedRound ?? ""),
    });

    return result;
  }

  // ── Batch Trade ──────────────────────────────────────────────

  /**
   * Execute multiple trades as a single atomic group.
   * All trades succeed or all revert — zero partial execution risk.
   * Max 16 intents (Algorand atomic group limit).
   */
  async executeBatch(params: BatchTradeParams): Promise<TradeResult> {
    if (params.intents.length > MAX_BATCH_SIZE) {
      throw new X402Error(
        `Batch size ${params.intents.length} exceeds Algorand atomic group limit of ${MAX_BATCH_SIZE}`,
        X402ErrorCode.BATCH_SIZE_EXCEEDED,
      );
    }

    this.emit("handshake", `Initiating batched x402 handshake (${params.intents.length} intents)...`);

    const batchResponse = await this.requestBatchSandboxExport(params);

    this.emit("sandbox_ready", `Batch sealed — ${batchResponse.batchSize} trades in one atomic group`, {
      sandboxId: batchResponse.export.sandboxId,
      batchSize: String(batchResponse.batchSize),
    });

    return this.settle({
      status: batchResponse.status,
      export: batchResponse.export,
      instructions: batchResponse.instructions,
    });
  }

  async requestBatchSandboxExport(params: BatchTradeParams): Promise<BatchActionResponse> {
    const url = `${this.baseUrl}/api/batch-action`;
    const reqBody = JSON.stringify({
      senderAddress: params.senderAddress,
      intents: params.intents,
    });

    let response: Response;
    try {
      response = await requestWithPayment(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SLIPPAGE-BIPS": String(this.slippageBips),
          },
          body: reqBody,
        },
        this.privateKey,
        params.senderAddress,
        this.maxRetries,
      );
    } catch (err) {
      const error = err instanceof X402Error ? err : new X402Error(
        err instanceof Error ? err.message : String(err),
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", `Batch sandbox request failed: ${error.message}`, { code: error.code });
      throw error;
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: response.statusText }));
      const msg = (errBody as Record<string, string>).error ?? "unknown";
      const error = new X402Error(
        `batch-action failed (${response.status}): ${msg}`,
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", error.message, { statusCode: String(response.status) });
      throw error;
    }

    this.emit("proof_built", "Batched x402 payment proof accepted by server");
    return response.json() as Promise<BatchActionResponse>;
  }

  // ── Utilities ────────────────────────────────────────────────

  /** The Algorand address derived from this client's private key */
  get address(): string {
    return this.senderAddress;
  }

  /** The deterministic agent ID used in audit logs */
  get id(): string {
    return this.agentId;
  }

  private emit(
    stage: Parameters<ProgressCallback>[0]["stage"],
    message: string,
    data?: Record<string, string>,
  ): void {
    this.onProgress?.({ stage, message, ...(data && { data }) });
  }
}
