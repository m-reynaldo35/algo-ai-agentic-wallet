/**
 * Live API Proxy — Catch-All REST Forwarder
 *
 * Forwards all /api/live/{path} requests to the backend at
 * API_URL/api/portal/{path}, injecting the PORTAL_API_SECRET header.
 *
 * This keeps credentials server-side (never exposed to the browser) and
 * lets every portal component call /api/live/* without knowing the
 * backend URL or secret.
 *
 * Supported methods: GET, POST, PUT, PATCH, DELETE
 *
 * Environment:
 *   API_URL            Backend base URL (default: https://api.ai-agentic-wallet.com)
 *   PORTAL_API_SECRET  Bearer secret forwarded as X-Portal-Key header
 *
 * Note: SSE streaming is handled by the dedicated /api/live/stream route.
 * This catch-all handles standard JSON REST calls only.
 */

import { type NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { path } = await ctx.params;
  const portalSecret = process.env.PORTAL_API_SECRET || "";

  // Reconstruct path + query string
  const upstreamPath = path.join("/");
  const search = req.nextUrl.search ?? "";
  const upstreamUrl = `${API_URL}/api/portal/${upstreamPath}${search}`;

  // Forward headers — strip host/connection to avoid upstream confusion
  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

  // Forward authorization from the browser session if present
  const authHeader = req.headers.get("authorization");
  if (authHeader) forwardHeaders["Authorization"] = authHeader;

  // Forward body for mutating methods
  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.text();
    } catch {
      // Empty body — fine
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  req.method,
      headers: forwardHeaders,
      body,
      // Don't follow redirects — surface them to the client
      redirect: "manual",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "upstream_unavailable", detail: msg },
      { status: 502 },
    );
  }

  // Pipe JSON or text response back to browser
  const contentType = upstream.headers.get("content-type") ?? "";
  const responseBody = await upstream.text();

  const responseHeaders: Record<string, string> = {
    "Content-Type": contentType || "application/json",
    // Prevent the browser from caching live data
    "Cache-Control": "no-store",
  };

  return new NextResponse(responseBody, {
    status:  upstream.status,
    headers: responseHeaders,
  });
}

export const GET    = proxy;
export const POST   = proxy;
export const PUT    = proxy;
export const PATCH  = proxy;
export const DELETE = proxy;

// Ensure this route always runs fresh — never cached
export const dynamic = "force-dynamic";
