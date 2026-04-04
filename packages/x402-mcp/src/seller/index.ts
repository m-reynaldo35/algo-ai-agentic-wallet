/**
 * @algo-wallet/x402-mcp/seller
 *
 * Seller-side SDK for adding x402 Algorand USDC payment to any API.
 *
 * Exports:
 *   x402express   — Express middleware (one-liner payment gate)
 *   x402tool      — x402-gated handler + MCP Tool definition
 *   mountX402Tools — register x402tools with an MCP Server
 *   verifyAndSubmit — low-level: verify X-PAYMENT header + submit to algod
 *
 * Quick start (Express):
 *
 *   import { x402express } from "@algo-wallet/x402-mcp/seller";
 *
 *   app.post("/api/weather",
 *     x402express({ price: 10_000, payTo: "YOUR_ALGO_ADDRESS" }),
 *     (req, res) => res.json({ weather: "sunny", paidBy: req.x402Payment?.senderAddr }),
 *   );
 *
 * Quick start (MCP server):
 *
 *   import { x402tool, mountX402Tools } from "@algo-wallet/x402-mcp/seller";
 *
 *   const weather = x402tool({
 *     name: "get_weather", description: "...",
 *     price: 10_000, payTo: "YOUR_ALGO_ADDRESS",
 *     endpoint: "https://your-api.com/api/weather",
 *     input: { city: { type: "string" } },
 *     handler: async ({ city }) => ({ weather: await fetchWeather(city) }),
 *   });
 *
 *   app.post("/api/weather", weather.httpHandler);
 *   mountX402Tools(mcpServer, [weather]);
 */

export { verifyAndSubmit }                     from "./verifier.js";
export type { VerifyOpts, VerifyResult }        from "./verifier.js";

export { x402express }                          from "./middleware.js";
export type {
  X402MiddlewareOptions,
  X402PaymentInfo,
  X402Request,
}                                               from "./middleware.js";

export { x402tool, mountX402Tools }             from "./tool.js";
export type {
  X402ToolOptions,
  X402Tool,
  InputSchema,
}                                               from "./tool.js";
