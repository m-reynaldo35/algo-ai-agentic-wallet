import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
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

  const portalSecret = process.env.PORTAL_API_SECRET || "";
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

  // If ownerAddress was corrupted to a "webauthn:…" string (by an older version of
  // the webauthn-register route), attempt recovery or force re-authentication.
  let ownerAddress = payload.ownerAddress;
  let sessionHealed = false;
  if (ownerAddress.startsWith("webauthn:")) {
    let recovered = "";
    if (payload.agentId) {
      try {
        const ar = await fetch(`${API_URL}/api/agents/${encodeURIComponent(payload.agentId)}`, {
          headers: authHeaders,
        });
        if (ar.ok) {
          const agentData = await ar.json() as { ownerAddress?: string };
          if (agentData.ownerAddress && !agentData.ownerAddress.startsWith("webauthn:")) {
            recovered = agentData.ownerAddress;
          }
        }
      } catch { /* non-fatal */ }
    }

    if (recovered) {
      ownerAddress = recovered;
      sessionHealed = true;
    } else if (payload.agentId) {
      // WebAuthn-only user: no Algorand address yet. Fetch the agent directly by ID
      // so the agents list and sidebar still populate.
      let agentEntry: unknown = null;
      try {
        const ar = await fetch(`${API_URL}/api/agents/${encodeURIComponent(payload.agentId)}`, {
          headers: authHeaders,
        });
        if (ar.ok) agentEntry = await ar.json();
      } catch { /* non-fatal */ }

      return NextResponse.json({
        ownerAddress: "",
        agentId: payload.agentId,
        agents: agentEntry ? [agentEntry] : [],
      });
    } else {
      // No agentId and no recoverable address — force re-authentication
      return NextResponse.json({ error: "Session corrupted, please log in again" }, { status: 401 });
    }
  }

  // Fetch agents owned by this address from the backend
  let agents: unknown[] = [];
  try {
    const r = await fetch(
      `${API_URL}/api/agents?owner=${encodeURIComponent(ownerAddress)}`,
      { headers: authHeaders },
    );
    if (r.ok) {
      const data = await r.json() as { agents?: unknown[] };
      agents = data.agents ?? [];
    }
  } catch { /* non-fatal — return empty list */ }

  const responseBody = NextResponse.json({
    ownerAddress,
    agentId: payload.agentId,    // present on legacy per-agent sessions
    agents,
  });

  // Self-heal: write a corrected session cookie so the corruption doesn't repeat
  if (sessionHealed) {
    const healedToken = await signCustomerSession({
      agentId: payload.agentId,
      ownerAddress,
    });
    responseBody.cookies.set(CUSTOMER_SESSION_COOKIE, healedToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
  }

  return responseBody;
}
