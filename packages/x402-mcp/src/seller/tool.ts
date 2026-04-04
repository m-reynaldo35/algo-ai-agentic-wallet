/**
 * x402tool — Build an x402-gated Express handler + MCP Tool definition
 *
 * Combines an Express route handler (gated by x402express) with an MCP Tool
 * object that can be listed in any MCP server. The buyer calls the HTTP
 * endpoint via @algo-wallet/x402-client; the MCP tool description tells LLMs
 * how to invoke it.
 *
 * Usage:
 *
 *   import express from "express";
 *   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
 *   import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 *   import { x402tool, mountX402Tools } from "@algo-wallet/x402-mcp/seller";
 *
 *   const app  = express();
 *   const mcpServer = new Server({ name: "weather-api", version: "1.0.0" }, { capabilities: { tools: {} } });
 *
 *   const weatherTool = x402tool({
 *     name:        "get_weather",
 *     description: "Current weather for any city. Costs $0.01 USDC.",
 *     price:       10_000,
 *     payTo:       "YOUR_ALGORAND_ADDRESS",
 *     endpoint:    "https://api.example.com/api/weather",
 *     input: {
 *       city: { type: "string", description: "City name" },
 *     },
 *     handler: async ({ city }) => {
 *       const data = await fetchWeather(city);
 *       return { weather: data };
 *     },
 *   });
 *
 *   // Mount HTTP route
 *   app.post("/api/weather", weatherTool.httpHandler);
 *
 *   // Register with MCP server
 *   mountX402Tools(mcpServer, [weatherTool]);
 */

import type { RequestHandler } from "express";
import { x402express, type X402Request } from "./middleware.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ── Types ────────────────────────────────────────────────────────

export interface InputSchema {
  [key: string]: {
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
    enum?: string[];
  };
}

export interface X402ToolOptions<TInput extends Record<string, unknown> = Record<string, unknown>> {
  /** MCP tool name (snake_case, e.g. "get_weather") */
  name: string;
  /** Human-readable description for LLMs */
  description: string;
  /** Price in µUSDC (1 USDC = 1,000,000 µUSDC) */
  price: number;
  /** Your Algorand wallet address */
  payTo: string;
  /**
   * Public HTTP URL buyers use to call this tool via x402-client.
   * Included in the MCP tool description so LLMs can direct buyers.
   */
  endpoint: string;
  /** Algorand network. Default: "mainnet" */
  network?: "mainnet" | "testnet";
  /** Override Algod endpoint */
  algodUrl?: string;
  /** Tool input parameter schema */
  input?: InputSchema;
  /** Handler called after payment is verified */
  handler: (args: TInput, payment: { txId?: string; senderAddr?: string }) => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface X402Tool {
  /** MCP Tool definition — pass to mountX402Tools() */
  tool: Tool;
  /** Express route handler — mount with app.post("/path", tool.httpHandler) */
  httpHandler: RequestHandler;
  /** Tool options (for reference) */
  opts: X402ToolOptions<Record<string, unknown>>;
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create an x402-gated tool that works as both an Express handler and
 * an entry in an MCP tool list.
 */
export function x402tool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  opts: X402ToolOptions<TInput>,
): X402Tool {
  const priceUsdc = (opts.price / 1_000_000).toFixed(4).replace(/\.?0+$/, "");

  // ── MCP Tool definition ────────────────────────────────────────
  // The description tells LLMs this tool costs money and how to pay.
  const fullDescription =
    `${opts.description}\n\n` +
    `Cost: $${priceUsdc} USDC per call (paid via x402 Algorand mandate).\n` +
    `Endpoint: POST ${opts.endpoint}\n` +
    `To call: use AlgoAgentClient.fetch("${opts.endpoint}") — payment is automatic.`;

  const inputProperties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(opts.input ?? {})) {
    const prop: Record<string, unknown> = { type: schema.type };
    if (schema.description) prop["description"] = schema.description;
    if (schema.enum)        prop["enum"]        = schema.enum;
    inputProperties[key] = prop;
    required.push(key);
  }

  const tool: Tool = {
    name:        opts.name,
    description: fullDescription,
    inputSchema: {
      type:       "object" as const,
      properties: inputProperties,
      required,
    },
  };

  // ── Express handler ────────────────────────────────────────────
  // x402express verifies payment first, then this handler runs.
  const paywall = x402express({
    price:       opts.price,
    payTo:       opts.payTo,
    network:     opts.network,
    algodUrl:    opts.algodUrl,
    name:        opts.name,
    description: opts.description,
  });

  const httpHandler: RequestHandler = async (req, res, next) => {
    // Run paywall inline
    await new Promise<void>((resolve, reject) => {
      paywall(req, res, (err?: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    }).catch(() => {
      // paywall already sent the 402 response
    });

    // If paywall sent a response, we're done
    if (res.headersSent) return;

    const x402Req   = req as X402Request;
    const payment   = x402Req.x402Payment ?? {};
    const body      = (req.body ?? {}) as TInput;

    try {
      const result = await opts.handler(body, payment);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  return { tool, httpHandler, opts: opts as X402ToolOptions };
}

// ── MCP Server integration ────────────────────────────────────────

/**
 * Register a list of x402Tools with an MCP Server instance.
 *
 * Handles ListTools and CallTools for all provided tools.
 * For CallTools, the handler makes an HTTP request to the tool's endpoint
 * using the x_payment argument provided by the buyer.
 */
export function mountX402Tools(server: Server, tools: X402Tool[]): void {
  const toolMap = new Map(tools.map((t) => [t.tool.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // The MCP caller passes an x_payment field with their signed transaction.
    // This allows LLMs to use pay_with_x402 first, then call this tool.
    const { x_payment, ...toolArgs } = args as Record<string, unknown>;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (typeof x_payment === "string") {
      headers["X-PAYMENT"] = x_payment;
    }

    try {
      const response = await fetch(tool.opts.endpoint, {
        method:  "POST",
        headers,
        body:    JSON.stringify(toolArgs),
      });

      if (response.status === 402) {
        const payJson = await response.json() as Record<string, unknown>;
        const amount  = (payJson.payment as Record<string, unknown>)?.amount ?? tool.opts.price;
        const payTo   = (payJson.payment as Record<string, unknown>)?.payTo   ?? tool.opts.payTo;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error:    "payment_required",
              message:  `This tool costs ${tool.opts.price} µUSDC. Use pay_with_x402 first.`,
              amount,
              payTo,
              endpoint: tool.opts.endpoint,
              hint:     `Call pay_with_x402 with endpoint="${tool.opts.endpoint}", then retry with x_payment=<result>`,
            }, null, 2),
          }],
          isError: true,
        };
      }

      if (!response.ok) {
        const body = await response.text();
        return {
          content: [{ type: "text" as const, text: `Tool error (${response.status}): ${body}` }],
          isError: true,
        };
      }

      const result = await response.json() as unknown;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Network error calling ${tool.opts.endpoint}: ${msg}` }],
        isError: true,
      };
    }
  });
}
