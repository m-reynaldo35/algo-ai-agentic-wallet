import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "4020", 10),

  algorand: {
    nodeUrl: process.env.ALGORAND_NODE_URL || "https://testnet-api.4160.nodely.dev",
    nodeToken: process.env.ALGORAND_NODE_TOKEN || "",
    network: process.env.ALGORAND_NETWORK || "testnet",
  },

  x402: {
    /** Price in micro-USDC (6 decimals). 100000 = $0.10 */
    priceMicroUsdc: parseInt(process.env.X402_PRICE_MICROUSDC || "100000", 10),
    payToAddress: process.env.X402_PAY_TO_ADDRESS || "",
    /** Algorand testnet USDC ASA ID */
    usdcAssetId: parseInt(process.env.X402_USDC_ASSET_ID || "10458941", 10),
  },
} as const;
