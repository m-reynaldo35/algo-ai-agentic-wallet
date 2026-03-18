/**
 * Customer Auth — Login
 *
 * Three auth paths:
 *
 * 1. Owner-level (wallet-first, no agentId):
 *    POST { ownerAddress }
 *    → sign JWT with ownerAddress only → set cookie
 *
 * 2. Pera Connect (legacy per-agent):
 *    POST { agentId, peraSessionId }
 *    → backend POST /api/agents/{id}/auth/pera-register
 *    → { ownerWalletId } → sign JWT → set cookie
 *
 * 3. WebAuthn (legacy per-agent):
 *    POST { agentId, webauthnAssertion }
 *    → backend POST /api/agents/{id}/auth/webauthn-login
 *    → { ownerWalletId } → sign JWT → set cookie
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  verifyCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

const MAX_AGENT_IDS = 50;

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

function setCookie(res: NextResponse, token: string) {
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    ownerAddress?: string;
    agentId?: string;
    peraSessionId?: string;
    webauthnAssertion?: unknown;
    // Owner-level passkey login (no agentId)
    webauthnOwnerAssertion?: unknown;
    challengeId?: string;
  };

  // ── Path 1: Owner-level (wallet-first, no agentId) ───────────────
  // ownerAddress is already verified by the backend /api/owner/auth/verify
  // before this route is called. The portal trusts the address it received.
  if (body.ownerAddress && !body.agentId && !body.peraSessionId && !body.webauthnAssertion) {
    const token = await signCustomerSession({ ownerAddress: body.ownerAddress });
    const res = NextResponse.json({ ok: true, ownerAddress: body.ownerAddress });
    setCookie(res, token);
    return res;
  }

  // ── Path 4: Owner-level WebAuthn (passkey login, no agentId) ────
  if (body.webauthnOwnerAssertion && body.challengeId) {
    let upstream: Response;
    try {
      upstream = await fetch(`${API_URL}/api/owner/auth/webauthn-login`, {
        method:  "POST",
        headers: portalHeaders(),
        body:    JSON.stringify({ challengeId: body.challengeId, assertion: body.webauthnOwnerAssertion }),
      });
    } catch (err) {
      return NextResponse.json({ error: `upstream_unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
    }

    const data = await upstream.json().catch(() => ({})) as { ownerWalletId?: string; error?: string };
    if (!upstream.ok || !data.ownerWalletId) {
      return NextResponse.json(
        { error: data.error || `Backend HTTP ${upstream.status}` },
        { status: upstream.status >= 400 ? upstream.status : 502 },
      );
    }

    const token = await signCustomerSession({ ownerAddress: data.ownerWalletId });
    const res   = NextResponse.json({ ok: true, ownerAddress: data.ownerWalletId });
    setCookie(res, token);
    return res;
  }

  // ── Path 2 & 3: Legacy per-agent (needs agentId) ─────────────────
  const { agentId, peraSessionId, webauthnAssertion } = body;

  if (!agentId || typeof agentId !== "string") {
    return NextResponse.json({ error: "agentId or ownerAddress required" }, { status: 400 });
  }
  if (!peraSessionId && !webauthnAssertion) {
    return NextResponse.json(
      { error: "peraSessionId or webauthnAssertion required" },
      { status: 400 },
    );
  }

  let result: { ownerWalletId?: string; error?: string; status: number };

  if (peraSessionId) {
    result = await callBackend(
      `${API_URL}/api/agents/${agentId}/auth/pera-register`,
      { peraSessionId },
    );
  } else {
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

  // Preserve agentIds accumulated in the existing session so that logging in
  // with one agent does not wipe the full multi-agent list from the cookie.
  const existingToken = req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  const existingSession = existingToken ? await verifyCustomerSession(existingToken) : null;
  const prevIds: string[] = [
    ...(existingSession?.agentIds ?? []),
    ...(existingSession?.agentId ? [existingSession.agentId] : []),
  ];
  const agentIds = Array.from(new Set([...prevIds, agentId])).slice(0, MAX_AGENT_IDS);

  const token = await signCustomerSession({ agentId, agentIds, ownerAddress: result.ownerWalletId });
  const res = NextResponse.json({ ok: true, agentId, ownerAddress: result.ownerWalletId });
  setCookie(res, token);
  return res;
}
