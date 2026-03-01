/**
 * Customer Auth — Login
 *
 * Handles two auth paths:
 *
 * Liquid Auth:
 *   POST { agentId, liquidAuthSessionId }
 *   → backend POST /api/agents/{id}/auth/liquid-register
 *   → { ownerWalletId } → sign JWT → set cookie
 *
 * WebAuthn (authentication, not registration):
 *   POST { agentId, webauthnAssertion }
 *   → backend POST /api/agents/{id}/auth/webauthn-login
 *   → { ownerWalletId } → sign JWT → set cookie
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

const API_URL = process.env.API_URL || "https://api.ai-agentic-wallet.com";

function portalHeaders(): Record<string, string> {
  const secret = process.env.PORTAL_API_SECRET || "";
  return {
    "Content-Type": "application/json",
    ...(secret ? { "X-Portal-Key": secret } : {}),
  };
}

async function callBackend(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ownerWalletId?: string; error?: string; status: number }> {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: portalHeaders(),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: `upstream_unavailable: ${err instanceof Error ? err.message : String(err)}`, status: 502 };
  }

  const data = await upstream.json().catch(() => ({})) as { ownerWalletId?: string; error?: string };
  return { ...data, status: upstream.status };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    agentId?: string;
    liquidAuthSessionId?: string;
    webauthnAssertion?: unknown;
  };

  const { agentId, liquidAuthSessionId, webauthnAssertion } = body;

  if (!agentId || typeof agentId !== "string") {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }
  if (!liquidAuthSessionId && !webauthnAssertion) {
    return NextResponse.json(
      { error: "liquidAuthSessionId or webauthnAssertion required" },
      { status: 400 },
    );
  }

  let result: { ownerWalletId?: string; error?: string; status: number };

  if (liquidAuthSessionId) {
    // Liquid Auth path: liquid-register accepts sessionId or liquidAuthSessionId
    result = await callBackend(
      `${API_URL}/api/agents/${agentId}/auth/liquid-register`,
      { liquidAuthSessionId },
    );
  } else {
    // WebAuthn authentication path: verify assertion server-side
    result = await callBackend(
      `${API_URL}/api/agents/${agentId}/auth/webauthn-login`,
      { assertion: webauthnAssertion },
    );
  }

  if (result.status !== 200 || !result.ownerWalletId) {
    return NextResponse.json(
      { error: result.error || `Backend HTTP ${result.status}` },
      { status: result.status >= 400 ? result.status : 502 },
    );
  }

  const token = await signCustomerSession({ agentId, ownerAddress: result.ownerWalletId });

  const res = NextResponse.json({ ok: true, agentId, ownerAddress: result.ownerWalletId });
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
