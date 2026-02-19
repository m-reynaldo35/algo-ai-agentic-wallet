import { type NextRequest } from "next/server";

const API_URL = process.env.API_URL || "https://ai-agentic-wallet.com";

/**
 * SSE Proxy — streams real-time events from the backend to the portal client.
 *
 * Next.js rewrites buffer responses, so SSE requires a dedicated route
 * that manually pipes the upstream event stream through to the browser.
 *
 * Runtime: edge — fastest cold-start, supports streaming natively.
 */
export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const portalSecret = process.env.PORTAL_API_SECRET || "";
  const upstream = await fetch(`${API_URL}/api/portal/stream`, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
    },
    // @ts-expect-error — Next.js edge runtime supports duplex
    duplex: "half",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream SSE unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
