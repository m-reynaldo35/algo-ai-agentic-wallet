import { SignJWT, jwtVerify } from "jose";

export const CUSTOMER_SESSION_COOKIE = "x402_customer_session";
const SESSION_DURATION = 30 * 24 * 60 * 60; // 30 days in seconds

function getSecret(): Uint8Array {
  const raw =
    process.env.CUSTOMER_SESSION_SECRET ||
    process.env.PORTAL_SESSION_SECRET ||
    "dev-secret-change-in-production";
  if (process.env.NODE_ENV === "production" && raw === "dev-secret-change-in-production") {
    // Loud warning — operator must set CUSTOMER_SESSION_SECRET in production.
    // Do NOT fall back to PORTAL_API_SECRET: the two secrets must be independent
    // so rotating one does not silently invalidate the other.
    console.error("[SECURITY] CUSTOMER_SESSION_SECRET is not configured. Customer sessions are insecure.");
  }
  return new TextEncoder().encode(raw);
}

export interface CustomerSessionPayload {
  ownerAddress: string;
  /** Legacy: single-agent sessions include agentId. Portfolio sessions omit it. */
  agentId?: string;
  /** Multi-agent WebAuthn sessions accumulate agentIds here. */
  agentIds?: string[];
}

export async function signCustomerSession(
  payload: CustomerSessionPayload,
): Promise<string> {
  return new SignJWT({ ...payload, authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getSecret());
}

export async function verifyCustomerSession(
  token: string,
): Promise<CustomerSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.ownerAddress !== "string") return null;
    return {
      ownerAddress: payload.ownerAddress,
      agentId:  typeof payload.agentId === "string" ? payload.agentId : undefined,
      agentIds: Array.isArray(payload.agentIds)
        ? (payload.agentIds as string[]).filter((id) => typeof id === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}
