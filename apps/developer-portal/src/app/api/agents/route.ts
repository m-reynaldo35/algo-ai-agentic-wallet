/**
 * Agent API Proxy — Base Route
 *
 * Handles /api/agents (no sub-path) — forwards to API_URL/api/agents
 * with optional query string intact.
 */

import { type NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

async function proxy(req: NextRequest): Promise<NextResponse> {
  const portalSecret = process.env.PORTAL_API_SECRET || "";
  const search = req.nextUrl.search ?? "";
  const upstreamUrl = `${API_URL}/api/agents${search}`;

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

  const authHeader = req.headers.get("authorization");
  if (authHeader) forwardHeaders["Authorization"] = authHeader;

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try { body = await req.text(); } catch { /* empty body */ }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  req.method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "upstream_unavailable", detail: msg }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const responseBody = await upstream.text();

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType || "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const GET    = proxy;
export const POST   = proxy;
export const PUT    = proxy;
export const PATCH  = proxy;
export const DELETE = proxy;

export const dynamic = "force-dynamic";
