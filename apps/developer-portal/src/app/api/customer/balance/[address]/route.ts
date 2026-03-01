/**
 * Customer Balance Proxy
 *
 * GET /api/customer/balance/{address}
 *
 * Proxies to AlgoNode public indexer. Returns:
 *   { microAlgo: number, microUsdc: number }
 *
 * Env:
 *   ALGORAND_NETWORK  "testnet" | "mainnet" (default: "testnet")
 *
 * USDC asset IDs:
 *   testnet  = 10458941
 *   mainnet  = 31566704
 */

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const USDC_ASSET_IDS: Record<string, number> = {
  testnet: 10458941,
  mainnet: 31566704,
};

const INDEXER_BASES: Record<string, string> = {
  testnet: "https://testnet-idx.algonode.cloud",
  mainnet: "https://mainnet-idx.algonode.cloud",
};

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { address } = await ctx.params;

  const network = (process.env.ALGORAND_NETWORK || "testnet").toLowerCase();
  const usdcId = USDC_ASSET_IDS[network] ?? USDC_ASSET_IDS.testnet;
  const indexerBase = INDEXER_BASES[network] ?? INDEXER_BASES.testnet;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${indexerBase}/v2/accounts/${address}?exclude=created-assets,apps-local-state,created-apps,none`,
      { headers: { Accept: "application/json" }, next: { revalidate: 30 } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "indexer_unavailable", detail: msg },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    if (upstream.status === 404) {
      // Account not yet funded — return zero balances
      return NextResponse.json({ microAlgo: 0, microUsdc: 0 });
    }
    return NextResponse.json(
      { error: `Indexer HTTP ${upstream.status}` },
      { status: upstream.status },
    );
  }

  const data = await upstream.json() as {
    account?: {
      amount?: number;
      assets?: Array<{ "asset-id": number; amount: number }>;
    };
  };

  const account = data.account;
  const microAlgo = account?.amount ?? 0;

  const usdcHolding = account?.assets?.find((a) => a["asset-id"] === usdcId);
  const microUsdc = usdcHolding?.amount ?? 0;

  return NextResponse.json({ microAlgo, microUsdc });
}
