/**
 * Customer Auth — Session Refresh
 *
 * POST { agentId }
 *   → reads the existing customer session cookie
 *   → adds agentId to agentIds[] if not already present
 *   → issues an updated session cookie
 *
 * Called after a successful Liquid Auth (Pera/Defly) wallet binding in
 * BindWalletModal so that the newly-bound agent appears in the agent list
 * without requiring a full re-login.
 *
 * Security note: this endpoint does NOT re-verify wallet ownership — the
 * binding has already been completed and verified by the backend before
 * this route is called. It only updates the session cache; all sensitive
 * operations (mandate create/revoke) remain protected by their own
 * cryptographic checks.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  verifyCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

const MAX_AGENT_IDS = 50;

export async function POST(req: NextRequest) {
  const existingToken = req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!existingToken) {
    return NextResponse.json({ error: "No active session" }, { status: 401 });
  }

  const existing = await verifyCustomerSession(existingToken);
  if (!existing) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { agentId?: string };
  const { agentId } = body;

  if (!agentId || typeof agentId !== "string") {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }

  // Merge the new agentId into the existing accumulated list.
  const prevIds: string[] = [
    ...(existing.agentIds ?? []),
    ...(existing.agentId ? [existing.agentId] : []),
  ];
  const agentIds = Array.from(new Set([...prevIds, agentId])).slice(0, MAX_AGENT_IDS);

  const token = await signCustomerSession({
    ownerAddress: existing.ownerAddress,
    agentId:      existing.agentId ?? agentId,
    agentIds,
  });

  const res = NextResponse.json({ ok: true, agentId, agentIds });
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   30 * 24 * 60 * 60,
  });
  return res;
}
