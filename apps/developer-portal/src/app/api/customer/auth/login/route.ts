/**
 * Customer Auth — Login
 *
 * Single auth path (Algorand wallet):
 *   POST { ownerAddress }
 *   → sign JWT with ownerAddress → set cookie → return { ok: true, ownerAddress }
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  signCustomerSession,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customerSession";

export const runtime = "nodejs";

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
  };

  if (!body.ownerAddress || typeof body.ownerAddress !== "string") {
    return NextResponse.json({ error: "ownerAddress required" }, { status: 400 });
  }

  const token = await signCustomerSession({ ownerAddress: body.ownerAddress });
  const res = NextResponse.json({ ok: true, ownerAddress: body.ownerAddress });
  setCookie(res, token);
  return res;
}
