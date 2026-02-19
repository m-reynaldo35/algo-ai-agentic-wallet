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

  gora: {
    /** Gora Oracle main application ID */
    appId: BigInt(process.env.GORA_APP_ID || "1275319623"),
    /** Gora Oracle request fee in microAlgos */
    requestFeeMicroAlgo: BigInt(process.env.GORA_REQUEST_FEE || "100000"),
    /** Maximum oracle data age in seconds before rejection */
    maxStalenessSeconds: parseInt(process.env.GORA_MAX_STALENESS_SECONDS || "60", 10),
    /** USDC/ALGO price feed key (Gora feed identifier) */
    priceFeedKey: process.env.GORA_PRICE_FEED_KEY || "USDC/ALGO",
  },

  folksFinance: {
    /** Folks Finance NTT application ID (Mainnet) */
    nttAppId: BigInt(process.env.FOLKS_NTT_APP_ID || "0"),
    /** Wormhole Core bridge application ID (Mainnet: 842125965) */
    wormholeCoreAppId: BigInt(process.env.WORMHOLE_CORE_APP_ID || "842125965"),
    /** Wormhole Token Bridge application ID (Mainnet: 842126029) */
    wormholeTokenBridgeAppId: BigInt(process.env.WORMHOLE_TOKEN_BRIDGE_APP_ID || "842126029"),
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
