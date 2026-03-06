/**
 * Admin Auth Proxy — public catch-all forwarder
 *
 * Forwards /api/admin/auth/* to the backend WITHOUT injecting PORTAL_API_SECRET.
 * These endpoints are pre-authentication (admin is not yet logged in),
 * so they must be unauthenticated on both portal and backend sides.
 *
 * Supported routes (all public on backend):
 *   POST /api/admin/auth/liquid-challenge
 *   POST /api/admin/auth/liquid-sign
 *   GET  /api/admin/auth/liquid-status/:sessionId
 *   POST /api/admin/auth/liquid-consume
 *   POST /api/admin/auth/webauthn-register-challenge
 *   POST /api/admin/auth/webauthn-register
 *   POST /api/admin/auth/webauthn-login-challenge
 *   POST /api/admin/auth/webauthn-login
 */

import { type NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { path } = await ctx.params;

  const upstreamPath = path.join("/");
  const search       = req.nextUrl.search ?? "";
  const upstreamUrl  = `${API_URL}/api/admin/auth/${upstreamPath}${search}`;

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try { body = await req.text(); } catch { /* empty */ }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  req.method,
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "manual",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "upstream_unavailable", detail: msg }, { status: 502 });
  }

  const contentType  = upstream.headers.get("content-type") ?? "";
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
export const dynamic = "force-dynamic";
