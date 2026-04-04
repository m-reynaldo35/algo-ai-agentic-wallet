import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { lookupApiKey } from "../services/apiKeyService.js";
import type { ApiKeyScope } from "../services/apiKeyService.js";

/**
 * Portal Authentication Middleware (updated for S.2)
 *
 * Two authentication paths (checked in order):
 *
 *   1. Scoped API key  — `pk_live_<hex>` issued via POST /api/portal/api-keys
 *      Stored as HMAC-SHA256 in Redis with name + scopes.
 *      Preferred for all new integrations.
 *
 *   2. Root secret     — PORTAL_API_SECRET env var.
 *      Retained as a root key during transition. Grants all scopes.
 *      Deprecated — rotate out once scoped keys are provisioned.
 *
 * On success, `req.operatorName` is set for downstream audit logging.
 *
 * Auth header forms (checked in order):
 *   Authorization: Bearer <key>
 *   X-Portal-Key: <key>
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operatorName?: string;
      operatorScopes?: ApiKeyScope[];
    }
  }
}

const PORTAL_SECRET = process.env.PORTAL_API_SECRET;

function extractToken(req: Request): string {
  const authHeader = req.header("Authorization") ?? "";
  const xPortalKey = req.header("X-Portal-Key") ?? "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (xPortalKey) return xPortalKey.trim();
  return "";
}

export function requirePortalAuth(req: Request, res: Response, next: NextFunction): void {
  // Explicit dev bypass — only when DISABLE_PORTAL_AUTH=true AND no secret configured.
  if (process.env.DISABLE_PORTAL_AUTH === "true" && !PORTAL_SECRET) {
    console.warn("[PortalAuth] WARNING: Auth bypassed via DISABLE_PORTAL_AUTH=true — never use in production");
    req.operatorName   = "dev-bypass";
    req.operatorScopes = ["portal:read", "portal:write", "agents:manage", "system:halt"];
    next();
    return;
  }

  const provided = extractToken(req);
  if (!provided) {
    res.status(401).json({ error: "Portal authentication required" });
    return;
  }

  // ── Path 1: scoped API key (pk_live_...) ─────────────────────────
  if (provided.startsWith("pk_live_")) {
    lookupApiKey(provided)
      .then((record) => {
        if (!record) {
          res.status(403).json({ error: "Invalid or revoked API key" });
          return;
        }
        req.operatorName   = record.name;
        req.operatorScopes = record.scopes;
        next();
      })
      .catch(() => {
        res.status(503).json({ error: "Auth service unavailable" });
      });
    return;
  }

  // ── Path 2: root PORTAL_API_SECRET ───────────────────────────────
  if (!PORTAL_SECRET) {
    res.status(503).json({ error: "Portal authentication not configured" });
    return;
  }

  const secretBuf  = Buffer.from(PORTAL_SECRET);
  const providedBuf = Buffer.from(provided);
  if (
    secretBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(secretBuf, providedBuf)
  ) {
    res.status(403).json({ error: "Invalid portal credentials" });
    return;
  }

  req.operatorName   = "root";
  req.operatorScopes = ["portal:read", "portal:write", "agents:manage", "system:halt"];
  next();
}

/**
 * Scope guard — wrap around routes that require a specific scope.
 * Must be used AFTER requirePortalAuth in the middleware chain.
 */
export function requireScope(scope: ApiKeyScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scopes = req.operatorScopes ?? [];
    if (!scopes.includes(scope)) {
      res.status(403).json({ error: `Insufficient scope — requires ${scope}` });
      return;
    }
    next();
  };
}
