/**
 * System API Proxy — Halt / Unhalt / Mass-Drain Controls
 *
 * Forwards /api/system/{path} requests to the backend at
 * API_URL/api/system/{path}, injecting the PORTAL_API_SECRET header.
 *
 * Covered routes:
 *   GET  /api/system/halt-status
 *   POST /api/system/halt          { reason, overrideKey }
 *   POST /api/system/unhalt        { overrideKey }
 *   GET  /api/system/mass-drain
 *   POST /api/system/mass-drain/clear  { overrideKey }
 */

import { type NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { path } = await ctx.params;
  const portalSecret = process.env.PORTAL_API_SECRET || "";

  const upstreamPath = path.join("/");
  const search = req.nextUrl.search ?? "";
  const upstreamUrl = `${API_URL}/api/system/${upstreamPath}${search}`;

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try { body = await req.text(); } catch { /* empty body */ }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:   req.method,
      headers:  forwardHeaders,
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
    status:  upstream.status,
    headers: {
      "Content-Type":  contentType || "application/json",
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
