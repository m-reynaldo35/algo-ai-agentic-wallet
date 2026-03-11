/**
 * Health proxy — fetches the backend /health endpoint (public, no auth needed)
 * and returns the full response to the dashboard.
 */

import { NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/health`, {
      next: { revalidate: 0 },
    });
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unavailable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export const dynamic = "force-dynamic";
