import { type NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/session";

/**
 * Portal Authentication Middleware
 *
 * Gates all portal pages and API routes behind session auth.
 * Public routes (login page, auth API, static assets, monitoring) bypass auth.
 *
 * On successful verification the request proceeds normally.
 * On failure the request is redirected to /login (pages) or rejected (API).
 */

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/monitoring", // Sentry tunnel
  "/favicon.ico",
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow public paths and static Next.js assets
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/monitoring")
  ) {
    return NextResponse.next();
  }

  // Verify session cookie
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
