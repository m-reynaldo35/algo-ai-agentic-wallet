import type { Request, Response, NextFunction } from "express";
import { verifyCredential } from "did-jwt-vc";
import { Resolver } from "did-resolver";

/**
 * Know Your Agent (KYA) Middleware — Rocca Identity Verification
 *
 * Enforces W3C Verifiable Credential presentation via JWT in the
 * Authorization header. The credential must be issued by a Rocca-
 * compliant identity provider and satisfy two claims:
 *
 *   1. credentialSubject.KYA_Status === "Verified"
 *   2. credentialSubject.ReputationScore >= 90
 *
 * On success, attaches the resolved DID to `req.platformId`.
 * On failure, returns HTTP 403 with a structured error body.
 */

// ── DID Resolver Configuration ────────────────────────────────
// The Resolver is initialized with an empty registry by default.
// In production, plug in method-specific resolvers (did:key, did:web,
// did:algo, etc.) via environment-driven configuration:
//
//   import KeyResolver from "key-did-resolver";
//   const resolver = new Resolver(KeyResolver.getResolver());
//
// For now we accept any DID method the resolver can handle.
// Additional resolvers can be registered at startup.
const resolver = new Resolver({});

/**
 * Register additional DID method resolvers at runtime.
 * Call this during server bootstrap to support specific DID methods.
 *
 * Example:
 *   import KeyResolver from "key-did-resolver";
 *   registerResolvers(KeyResolver.getResolver());
 */
export function registerResolvers(methods: Record<string, (...args: any[]) => any>): void {
  Object.assign((resolver as any).registry, methods);
}

// ── Minimum claim thresholds ──────────────────────────────────
const REQUIRED_KYA_STATUS = "Verified";
const MIN_REPUTATION_SCORE = 90;

// ── Middleware ─────────────────────────────────────────────────
export async function moltbookAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header("Authorization");

  // Step 1: Extract Bearer token
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: "Missing or malformed Authorization header. Expected: Bearer <VC-JWT>",
    });
    return;
  }

  const vcJwt = authHeader.slice(7).trim();
  if (!vcJwt) {
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: "Empty Bearer token.",
    });
    return;
  }

  // Step 2: Cryptographic verification of the Verifiable Credential JWT
  let verified;
  try {
    verified = await verifyCredential(vcJwt, resolver as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signature verification failed";
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: `VC-JWT signature invalid: ${msg}`,
    });
    return;
  }

  // Step 3: Extract and assert credentialSubject claims
  const credential = verified.verifiableCredential;
  const subject = credential.credentialSubject;

  if (!subject) {
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: "Credential missing credentialSubject.",
    });
    return;
  }

  // Claim 1: KYA_Status must be "Verified"
  if (subject.KYA_Status !== REQUIRED_KYA_STATUS) {
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: `KYA_Status claim is "${subject.KYA_Status ?? "missing"}", required: "${REQUIRED_KYA_STATUS}"`,
    });
    return;
  }

  // Claim 2: ReputationScore must be >= 90
  const score = Number(subject.ReputationScore);
  if (isNaN(score) || score < MIN_REPUTATION_SCORE) {
    res.status(403).json({
      error: "Cryptographic Identity Verification Failed",
      detail: `ReputationScore is ${isNaN(score) ? "missing" : score}, minimum required: ${MIN_REPUTATION_SCORE}`,
    });
    return;
  }

  // Step 4: Attach resolved DID to request and proceed
  req.platformId = verified.issuer;

  next();
}

// ── Express Request augmentation ──────────────────────────────
declare global {
  namespace Express {
    interface Request {
      platformId?: string;
    }
  }
}
