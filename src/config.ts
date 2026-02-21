import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "4020", 10),

  algorand: {
    /** Nodely free tier Algod endpoint (no API key required) */
    nodeUrl: process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev",
    /** Nodely free tier Indexer endpoint (auto-derived from nodeUrl if not set) */
    indexerUrl: process.env.ALGORAND_INDEXER_URL || "https://mainnet-idx.4160.nodely.dev",
    nodeToken: process.env.ALGORAND_NODE_TOKEN || "",
    network: process.env.ALGORAND_NETWORK || "mainnet",
  },

  x402: {
    /** Price in micro-USDC (6 decimals). 10000 = $0.01 */
    priceMicroUsdc: parseInt(process.env.X402_PRICE_MICROUSDC || "10000", 10),
    payToAddress: process.env.X402_PAY_TO_ADDRESS || "",
    /** USDC ASA ID — Mainnet: 31566704 (Circle), Testnet: 10458941 */
    usdcAssetId: parseInt(process.env.X402_USDC_ASSET_ID || "31566704", 10),
  },

  liquidAuth: {
    /** Liquid Auth FIDO2 server URL. Empty = dev mock mode. */
    serverUrl: process.env.LIQUID_AUTH_SERVER_URL || "",
    /** FIDO2 Relying Party identifier */
    rpId: process.env.FIDO2_RP_ID || "",
  },

  rocca: {
    /** Rocca API key for authenticated SDK calls */
    apiKey: process.env.ROCCA_API_KEY || "",
    /** Rocca environment: "sandbox" | "production" */
    environment: process.env.ROCCA_ENVIRONMENT || "production",
    /** Rocca webhook secret for signature confirmation callbacks */
    webhookSecret: process.env.ROCCA_WEBHOOK_SECRET || "",
  },
} as const;
