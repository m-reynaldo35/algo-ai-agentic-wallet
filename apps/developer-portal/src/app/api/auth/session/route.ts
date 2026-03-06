import { type NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/auth/session
 * Returns the remaining TTL (seconds) of the admin portal session.
 * Used by the Sidebar to show a session expiry warning.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ authenticated: false, expiresAt: null });
  }

  const payload = await verifySession(token);
  if (!payload) {
    return NextResponse.json({ authenticated: false, expiresAt: null });
  }

  // jose sets standard JWT `exp` claim (seconds epoch)
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null;
  return NextResponse.json({ authenticated: true, expiresAt: exp });
}
