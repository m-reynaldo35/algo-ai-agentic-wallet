/**
 * Public registry proxy — GET /api/registry[?category=]
 *
 * Forwards to the backend public registry endpoint. No auth required.
 */

import { type NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.search ?? "";
  try {
    const upstream = await fetch(`${API_URL}/api/registry${search}`, {
      headers: { "Content-Type": "application/json" },
      signal:  AbortSignal.timeout(8_000),
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status:  upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60", // cache 60s — registry is slow-changing
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "registry_unavailable", detail: String(err) },
      { status: 502 },
    );
  }
}
