import { type NextRequest, NextResponse } from "next/server";
import {
  verifyCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = await verifyCustomerSession(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  // Fetch agents owned by this address from the backend
  let agents: unknown[] = [];
  try {
    const portalSecret = process.env.PORTAL_API_SECRET || "";
    const r = await fetch(
      `${API_URL}/api/agents?owner=${encodeURIComponent(payload.ownerAddress)}`,
      {
        headers: {
          "Content-Type": "application/json",
          ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
        },
      },
    );
    if (r.ok) {
      const data = await r.json() as { agents?: unknown[] };
      agents = data.agents ?? [];
    }
  } catch { /* non-fatal — return empty list */ }

  return NextResponse.json({
    ownerAddress: payload.ownerAddress,
    agentId: payload.agentId,    // present on legacy per-agent sessions
    agents,
  });
}
