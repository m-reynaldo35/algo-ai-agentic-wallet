/**
 * Customer Auth — Session Refresh
 *
 * POST { agentId }
 *   → reads the existing customer session cookie
 *   → issues an updated session cookie (ownerAddress preserved)
 *
 * Called after a successful Liquid Auth (Pera/Defly) wallet binding so that
 * the session cookie is refreshed. The agent list is derived at runtime from
 * the backend owner index rather than stored in the JWT.
 *
 * Security note: this endpoint does NOT re-verify wallet ownership — the
 * binding has already been completed and verified by the backend before
 * this route is called.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  verifyCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

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

  const token = await signCustomerSession({
    ownerAddress: existing.ownerAddress,
  });

  const res = NextResponse.json({ ok: true, agentId });
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   30 * 24 * 60 * 60,
  });
  return res;
}
