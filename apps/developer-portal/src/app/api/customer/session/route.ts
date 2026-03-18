import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  verifyCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";
const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours

/** Attach a refreshed session cookie if the current token expires within 4 hours. */
async function maybeRefreshCookie(
  res: NextResponse,
  payload: import("@/lib/customerSession").CustomerSessionPayload,
): Promise<void> {
  const exp = payload.exp;
  if (!exp) return;
  const secsRemaining = exp - Math.floor(Date.now() / 1000);
  if (secsRemaining < 4 * 60 * 60) {
    const newToken = await signCustomerSession({
      ownerAddress: payload.ownerAddress,
    });
    res.cookies.set(CUSTOMER_SESSION_COOKIE, newToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      path:     "/",
      maxAge:   SESSION_MAX_AGE,
    });
  }
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = await verifyCustomerSession(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const ownerAddress = payload.ownerAddress;

  // Stale session from old WebAuthn-based flow — force re-authentication
  if (!ownerAddress || ownerAddress.startsWith("webauthn:")) {
    return NextResponse.json({ error: "Stale session — please sign in again" }, { status: 401 });
  }

  const portalSecret = process.env.PORTAL_API_SECRET || "";
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

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

  const responseBody = NextResponse.json({ ownerAddress, agents });

  // Silent refresh: extend session if it expires within 4 hours
  await maybeRefreshCookie(responseBody, payload);

  return responseBody;
}
