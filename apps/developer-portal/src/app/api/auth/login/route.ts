import { type NextRequest, NextResponse } from "next/server";
import { signSession, SESSION_COOKIE } from "@/lib/session";
import crypto from "crypto";

export const runtime = "nodejs";

const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || "";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { password?: string };
  const { password } = body;

  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  if (!PORTAL_PASSWORD) {
    return NextResponse.json(
      { error: "Portal password not configured (set PORTAL_PASSWORD env var)" },
      { status: 503 },
    );
  }

  // Constant-time comparison to prevent timing attacks
  const passwordBuf  = Buffer.from(password);
  const expectedBuf  = Buffer.from(PORTAL_PASSWORD);
  const valid =
    passwordBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(passwordBuf, expectedBuf);

  if (!valid) {
    // Small delay to slow brute force
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await signSession({ authenticated: true, ts: Date.now() });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60, // 8 hours
  });

  return res;
}
