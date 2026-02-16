import algosdk from "algosdk";
import { requestWithPayment, X402Error } from "./interceptor.js";
import type {
  ClientConfig,
  TradeParams,
  AgentActionResponse,
  SettlementResult,
  SettlementFailure,
  TradeResult,
} from "./types.js";

const DEFAULT_SLIPPAGE_BIPS = 50;

/**
 * AlgoAgentClient — x402 SDK for AI-to-AI settlement on Algorand
 *
 * Encapsulates the full x402 handshake:
 *   402 bounce → proof generation → sandbox export → settlement
 *
 * The consuming agent calls `executeTrade()` and receives a confirmed
 * on-chain settlement or a typed failure. Zero protocol knowledge required.
 */
export class AlgoAgentClient {
  private readonly baseUrl: string;
  private readonly privateKey: Uint8Array;
  private readonly senderAddress: string;
  private readonly slippageBips: number;
  private readonly agentId: string;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) throw new X402Error("baseUrl is required");
    if (!config.privateKey || config.privateKey.length !== 64) {
      throw new X402Error("privateKey must be a 64-byte Algorand secret key");
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.privateKey = config.privateKey;
    this.slippageBips = config.slippageBips ?? DEFAULT_SLIPPAGE_BIPS;

    // Derive Algorand address: sk is 64 bytes [seed(32) | pubkey(32)]
    this.senderAddress = algosdk.encodeAddress(config.privateKey.slice(32));

    // Deterministic agent ID from address for audit trail
    this.agentId = `sdk-${this.senderAddress.slice(0, 8)}`;
  }

  /**
   * Execute a full x402 trade: handshake → sandbox → settlement.
   *
   * Returns a `SettlementResult` on success or a `SettlementFailure`
   * if any pipeline stage aborts.
   */
  async executeTrade(params: TradeParams): Promise<TradeResult> {
    const sandboxExport = await this.requestSandboxExport(params);
    return this.settle(sandboxExport);
  }

  /**
   * Step 1+2: Hit /api/agent-action, absorb the 402, return the SandboxExport.
   * Useful if you want to inspect the atomic group before settling.
   */
  async requestSandboxExport(params: TradeParams): Promise<AgentActionResponse> {
    const url = `${this.baseUrl}/api/agent-action`;

    const body = JSON.stringify({
      senderAddress: params.senderAddress,
      ...(params.amount !== undefined && { amount: params.amount }),
      ...(params.destinationChain && { destinationChain: params.destinationChain }),
      ...(params.destinationRecipient && { destinationRecipient: params.destinationRecipient }),
    });

    const response = await requestWithPayment(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SLIPPAGE-BIPS": String(this.slippageBips),
        },
        body,
      },
      this.privateKey,
      params.senderAddress,
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new X402Error(
        `agent-action failed (${response.status}): ${(err as Record<string, string>).error ?? "unknown"}`,
      );
    }

    return response.json() as Promise<AgentActionResponse>;
  }

  /**
   * Step 3: Forward a SandboxExport to /api/execute for on-chain settlement.
   */
  async settle(agentActionResponse: AgentActionResponse): Promise<TradeResult> {
    const url = `${this.baseUrl}/api/execute`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxExport: agentActionResponse.export,
        agentId: this.agentId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return result as SettlementFailure;
    }

    return result as SettlementResult;
  }
}
