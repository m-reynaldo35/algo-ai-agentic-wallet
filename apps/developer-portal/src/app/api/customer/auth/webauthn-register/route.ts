/**
 * Customer Auth — WebAuthn Registration
 *
 * POST { agentId, registrationResponse }
 *   → backend POST /api/agents/{id}/auth/webauthn-register
 *   → verifies attestation server-side
 *   → { ownerWalletId } → sign customer JWT → set cookie
 *
 * This is the first-time path — subsequent logins use /api/customer/auth/login
 * with { agentId, webauthnAssertion }.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    agentId?: string;
    registrationResponse?: unknown;
  };

  const { agentId, registrationResponse } = body;

  if (!agentId || typeof agentId !== "string") {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }
  if (!registrationResponse) {
    return NextResponse.json({ error: "registrationResponse required" }, { status: 400 });
  }

  const portalSecret = process.env.PORTAL_API_SECRET || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(portalSecret ? { "X-Portal-Key": portalSecret } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/api/agents/${agentId}/auth/webauthn-register`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ registrationResponse }),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "upstream_unavailable", detail: msg },
      { status: 502 },
    );
  }

  const data = await upstream.json().catch(() => ({})) as {
    ownerWalletId?: string;
    error?: string;
  };

  if (!upstream.ok || !data.ownerWalletId) {
    return NextResponse.json(
      { error: data.error || `Backend HTTP ${upstream.status}` },
      { status: upstream.status >= 400 ? upstream.status : 502 },
    );
  }

  const token = await signCustomerSession({ agentId, ownerAddress: data.ownerWalletId });

  const res = NextResponse.json({ ok: true, agentId, ownerAddress: data.ownerWalletId });
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
