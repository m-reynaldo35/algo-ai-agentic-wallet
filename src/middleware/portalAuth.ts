import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Portal Authentication Middleware
 *
 * Protects all /api/portal/* endpoints with a shared portal API secret.
 *
 * Auth methods (checked in order):
 *   1. Bearer token in Authorization header:   Authorization: Bearer <PORTAL_API_SECRET>
 *   2. X-Portal-Key header:                    X-Portal-Key: <PORTAL_API_SECRET>
 *
 * The PORTAL_API_SECRET env var must be set in production. In development
 * (NODE_ENV !== "production"), portal auth is bypassed with a warning.
 *
 * The developer portal proxy passes the secret as a bearer token on all
 * /api/live/* → /api/portal/* rewrites using the PORTAL_SECRET env var.
 */

const PORTAL_SECRET = process.env.PORTAL_API_SECRET;

export function requirePortalAuth(req: Request, res: Response, next: NextFunction): void {
  // Dev bypass
  if (process.env.NODE_ENV !== "production") {
    if (!PORTAL_SECRET) {
      next();
      return;
    }
  }

  if (!PORTAL_SECRET) {
    // Secret not configured — fail closed
    res.status(503).json({ error: "Portal authentication not configured" });
    return;
  }

  // Extract token from Authorization header or X-Portal-Key header
  const authHeader = req.header("Authorization") ?? "";
  const xPortalKey = req.header("X-Portal-Key") ?? "";

  let provided = "";
  if (authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7).trim();
  } else if (xPortalKey) {
    provided = xPortalKey.trim();
  }

  if (!provided) {
    res.status(401).json({ error: "Portal authentication required" });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  const secretBuf = Buffer.from(PORTAL_SECRET);
  const providedBuf = Buffer.from(provided);

  if (
    secretBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(secretBuf, providedBuf)
  ) {
    res.status(403).json({ error: "Invalid portal credentials" });
    return;
  }

  next();
}
