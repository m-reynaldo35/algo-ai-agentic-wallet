import { type NextRequest, NextResponse } from "next/server";
import { signSession, SESSION_COOKIE } from "@/lib/session";
import crypto from "crypto";

export const runtime = "nodejs";

const API_URL         = process.env.API_URL || "https://api.ai-agentic-wallet.com";
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || "";

// Comma-separated list of Algorand addresses allowed to administer the portal.
// If empty, Liquid Auth is unrestricted (dev mode only).
const ADMIN_WALLET_ADDRESSES = (process.env.ADMIN_WALLET_ADDRESSES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminAddress(address: string): boolean {
  if (ADMIN_WALLET_ADDRESSES.length === 0) return true; // dev: no whitelist → open
  return ADMIN_WALLET_ADDRESSES.includes(address);
}

async function issueAdminSession(): Promise<NextResponse> {
  const token = await signSession({ authenticated: true, ts: Date.now() });
  const res   = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   8 * 60 * 60, // 8 hours
  });
  return res;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  // ── Path 1: Liquid Auth — exchange verified sessionId for admin JWT ────────

  if (typeof body.liquidAuthSessionId === "string") {
    const sessionId = body.liquidAuthSessionId;

    // Consume the verified session on the backend
    let address: string;
    try {
      const r = await fetch(`${API_URL}/api/admin/auth/liquid-consume`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        return NextResponse.json({ error: err.error ?? `Upstream ${r.status}` }, { status: r.status });
      }
      const data = await r.json() as { address: string };
      address = data.address;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Upstream unreachable: ${msg}` }, { status: 502 });
    }

    if (!isAdminAddress(address)) {
      return NextResponse.json(
        { error: "Access denied — this Algorand address is not on the admin whitelist." },
        { status: 403 },
      );
    }

    return issueAdminSession();
  }

  // ── Path 2: WebAuthn — verify assertion, issue JWT ────────────────────────

  if (body.webauthnAssertion && typeof body.webauthnAssertion === "object") {
    const assertion = body.webauthnAssertion;

    try {
      const r = await fetch(`${API_URL}/api/admin/auth/webauthn-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ assertion }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        return NextResponse.json({ error: err.error ?? `Upstream ${r.status}` }, { status: r.status });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Upstream unreachable: ${msg}` }, { status: 502 });
    }

    return issueAdminSession();
  }

  // ── Path 3: Password (legacy / machine-to-machine fallback) ──────────────

  if (typeof body.password === "string") {
    const { password } = body;

    if (!PORTAL_PASSWORD) {
      return NextResponse.json(
        { error: "Portal password not configured (set PORTAL_PASSWORD env var)" },
        { status: 503 },
      );
    }

    const passwordBuf = Buffer.from(password);
    const expectedBuf = Buffer.from(PORTAL_PASSWORD);
    const valid =
      passwordBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(passwordBuf, expectedBuf);

    if (!valid) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    return issueAdminSession();
  }

  return NextResponse.json(
    { error: "Provide liquidAuthSessionId, webauthnAssertion, or password" },
    { status: 400 },
  );
}
