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
  agentId: string;
  ownerAddress: string;
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
    if (
      typeof payload.agentId !== "string" ||
      typeof payload.ownerAddress !== "string"
    ) {
      return null;
    }
    return {
      agentId: payload.agentId,
      ownerAddress: payload.ownerAddress,
    };
  } catch {
    return null;
  }
}
