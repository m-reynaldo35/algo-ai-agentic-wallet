import { SignJWT, jwtVerify } from "jose";

const SESSION_COOKIE = "x402_portal_session";
const SESSION_DURATION = 8 * 60 * 60; // 8 hours in seconds

function getSecret(): Uint8Array {
  const raw = process.env.PORTAL_SESSION_SECRET || process.env.PORTAL_API_SECRET || "dev-secret-change-in-production";
  return new TextEncoder().encode(raw);
}

export async function signSession(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export { SESSION_COOKIE };
