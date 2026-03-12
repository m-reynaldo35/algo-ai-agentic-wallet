import { SignJWT, jwtVerify } from "jose";

export const CUSTOMER_SESSION_COOKIE = "x402_customer_session";
const SESSION_DURATION = 30 * 24 * 60 * 60; // 30 days in seconds

function getSecret(): Uint8Array {
  const raw =
    process.env.CUSTOMER_SESSION_SECRET ||
    process.env.PORTAL_SESSION_SECRET ||
    process.env.PORTAL_API_SECRET ||
    "dev-secret-change-in-production";
  return new TextEncoder().encode(raw);
}

export interface CustomerSessionPayload {
  ownerAddress: string;
  /** Legacy: single-agent sessions include agentId. Portfolio sessions omit it. */
  agentId?: string;
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
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    };
  } catch {
    return null;
  }
}
