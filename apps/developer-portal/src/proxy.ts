import { type NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/session";
import { verifyCustomerSession, CUSTOMER_SESSION_COOKIE } from "@/lib/customerSession";

/**
 * Portal Authentication Middleware
 *
 * Gates all portal pages and API routes behind session auth.
 * Public routes (login page, auth API, static assets, monitoring) bypass auth.
 *
 * /app/* and /api/customer/* use x402_customer_session (Liquid Auth JWT).
 * All other protected routes use x402_portal_session (admin password JWT).
 *
 * Both sessions can coexist in the same browser simultaneously.
 */

const PUBLIC_PATHS = new Set([
  "/",              // landing page — always public
  "/login",
  "/privacy",
  "/terms",
  "/api/auth/login",
  "/api/auth/logout",
  "/app/login",
  "/app/create",          // new agent creation wizard (no session required)
  "/api/customer/auth/login",
  "/api/customer/auth/logout",
  "/api/customer/auth/webauthn-register",
  "/docs",
  "/monitoring", // Sentry tunnel
  "/favicon.ico",
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow public paths and static Next.js assets
  // Also allow balance lookups from the unauthenticated wizard (/app/create)
  // and all admin auth routes (pre-authentication — admin is not yet logged in)
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/monitoring") ||
    pathname.startsWith("/api/customer/balance/") ||
    pathname.startsWith("/api/admin/auth/") ||
    // Agent creation wizard — called from public /app/create (no session)
    pathname === "/api/agents/create" ||
    pathname === "/api/agents/register-existing" ||
    // Agent auth endpoints are called during login — before any session exists
    /^\/api\/agents\/[^/]+\/auth\//.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Customer session check — covers /app/*, /api/customer/*, and /api/agents/*
  // (dashboard fetches agent/mandate/settlement data under /api/agents/)
  const customerToken = req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (customerToken) {
    const payload = await verifyCustomerSession(customerToken);
    if (payload) return NextResponse.next();
  }

  // Customer-only routes — reject if no valid customer session
  if (pathname.startsWith("/app/") || pathname.startsWith("/api/customer/")) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/app/login";
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Admin portal routes — check portal session
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const payload = await verifySession(token);
    if (payload?.authenticated) {
      return NextResponse.next();
    }
  }

  // Unauthenticated — redirect API calls to 401, pages to /login
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Match all routes except static files and _next internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
