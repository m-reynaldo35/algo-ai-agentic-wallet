/**
 * mTLS Configuration — Signing Service Channel Hardening
 *
 * Replaces the bare Bearer token channel between the Main API and the Signing
 * Service with mutual TLS (mTLS), eliminating signer impersonation (Attack 6)
 * and rogue signing-service injection (Attack 8).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Architecture                                                       │
 * │                                                                     │
 * │  Main API  ──[client cert]──▶  Signing Service  ──[verify CA]──    │
 * │               (mTLS)            rejects if cert not signed by CA   │
 * │                                                                     │
 * │  Both services share a private CA. Each has its own cert/key pair. │
 * │  The signing service is configured with:                            │
 * │    requestCert: true                                                │
 * │    rejectUnauthorized: true                                         │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ── Activation (Railway) ────────────────────────────────────────────
 *
 * 1. Generate CA + service certs (run ONCE, store securely):
 *
 *   # Private CA
 *   openssl req -x509 -newkey rsa:4096 -keyout ca.key -out ca.crt \
 *     -days 3650 -nodes -subj "/CN=x402-internal-ca"
 *
 *   # Main API client cert
 *   openssl req -newkey rsa:4096 -keyout api.key -out api.csr \
 *     -nodes -subj "/CN=x402-main-api"
 *   openssl x509 -req -in api.csr -CA ca.crt -CAkey ca.key \
 *     -CAcreateserial -out api.crt -days 3650
 *
 *   # Signing Service server cert
 *   openssl req -newkey rsa:4096 -keyout svc.key -out svc.csr \
 *     -nodes -subj "/CN=x402-signing-service"
 *   openssl x509 -req -in svc.csr -CA ca.crt -CAkey ca.key \
 *     -CAcreateserial -out svc.crt -days 3650
 *
 * 2. Base64-encode each PEM file:
 *   base64 -w 0 ca.crt  → MTLS_CA_CERT
 *   base64 -w 0 api.crt → MTLS_CLIENT_CERT   (on Main API service)
 *   base64 -w 0 api.key → MTLS_CLIENT_KEY    (on Main API service)
 *   base64 -w 0 svc.crt → MTLS_SERVER_CERT   (on Signing Service)
 *   base64 -w 0 svc.key → MTLS_SERVER_KEY    (on Signing Service)
 *
 * 3. Set these env vars in Railway on the appropriate services.
 *
 * 4. Set MTLS_ENABLED=true on both services to activate.
 *
 * ── Environment Variables ────────────────────────────────────────────
 *
 *   MTLS_ENABLED       "true" to activate (default: false)
 *
 *   Main API service:
 *     MTLS_CA_CERT       base64 PEM of the internal CA cert
 *     MTLS_CLIENT_CERT   base64 PEM of the Main API client cert
 *     MTLS_CLIENT_KEY    base64 PEM of the Main API client private key
 *
 *   Signing Service:
 *     MTLS_CA_CERT       base64 PEM of the internal CA cert
 *     MTLS_SERVER_CERT   base64 PEM of the Signing Service server cert
 *     MTLS_SERVER_KEY    base64 PEM of the Signing Service server private key
 *
 * ── Current status ───────────────────────────────────────────────────
 *
 *   MTLS_ENABLED defaults to false. When false, the signing service
 *   client falls back to Bearer token auth (existing behaviour).
 *   This module is a migration path, not a flag day.
 */

import https from "node:https";

// ── Public: is mTLS active? ────────────────────────────────────────

export const MTLS_ENABLED = process.env.MTLS_ENABLED === "true";

// ── Client side (Main API → Signing Service) ──────────────────────

export interface MtlsClientConfig {
  /** x509 client certificate (PEM) */
  cert: string;
  /** Client private key (PEM) */
  key:  string;
  /** CA certificate used to verify the server's cert (PEM) */
  ca:   string;
}

/**
 * Load the Main API's mTLS client configuration from env vars.
 * Call this when MTLS_ENABLED is true.
 * Throws if any required env var is missing or fails to decode.
 */
export function loadClientMtlsConfig(): MtlsClientConfig {
  const caCertB64     = process.env.MTLS_CA_CERT;
  const clientCertB64 = process.env.MTLS_CLIENT_CERT;
  const clientKeyB64  = process.env.MTLS_CLIENT_KEY;

  if (!caCertB64 || !clientCertB64 || !clientKeyB64) {
    throw new Error(
      "mTLS is enabled (MTLS_ENABLED=true) but one or more cert env vars are missing: " +
      "MTLS_CA_CERT, MTLS_CLIENT_CERT, MTLS_CLIENT_KEY",
    );
  }

  return {
    ca:   Buffer.from(caCertB64,     "base64").toString("utf8"),
    cert: Buffer.from(clientCertB64, "base64").toString("utf8"),
    key:  Buffer.from(clientKeyB64,  "base64").toString("utf8"),
  };
}

/**
 * Build a Node.js https.Agent configured for mTLS client authentication.
 *
 * Pass the returned agent as the fetch `dispatcher` option via undici,
 * or use it with node-https directly.
 *
 * Example (signing-service client.ts, when MTLS_ENABLED):
 *   const agent = buildMtlsAgent();
 *   // Then use node https.request or a compatible fetch implementation
 */
export function buildMtlsAgent(): https.Agent {
  const mtls = loadClientMtlsConfig();
  return new https.Agent({
    cert:               mtls.cert,
    key:                mtls.key,
    ca:                 mtls.ca,
    rejectUnauthorized: true,
  });
}

// ── Server side (Signing Service HTTPS listener) ───────────────────

export interface MtlsServerConfig {
  /** x509 server certificate (PEM) */
  cert: string;
  /** Server private key (PEM) */
  key:  string;
  /** CA certificate used to verify client certs (PEM) */
  ca:   string;
}

/**
 * Load the Signing Service's mTLS server configuration from env vars.
 *
 * The signing service boot sequence should call this when MTLS_ENABLED
 * and use the result to create an https.Server instead of http.Server:
 *
 *   const server = https.createServer({
 *     ...loadServerMtlsConfig(),
 *     requestCert:        true,
 *     rejectUnauthorized: true,
 *   }, app);
 *   server.listen(port);
 */
export function loadServerMtlsConfig(): MtlsServerConfig {
  const caCertB64    = process.env.MTLS_CA_CERT;
  const serverCertB64 = process.env.MTLS_SERVER_CERT;
  const serverKeyB64  = process.env.MTLS_SERVER_KEY;

  if (!caCertB64 || !serverCertB64 || !serverKeyB64) {
    throw new Error(
      "mTLS is enabled (MTLS_ENABLED=true) but one or more server cert env vars are missing: " +
      "MTLS_CA_CERT, MTLS_SERVER_CERT, MTLS_SERVER_KEY",
    );
  }

  return {
    ca:   Buffer.from(caCertB64,     "base64").toString("utf8"),
    cert: Buffer.from(serverCertB64, "base64").toString("utf8"),
    key:  Buffer.from(serverKeyB64,  "base64").toString("utf8"),
  };
}

/**
 * Log the mTLS activation status at boot.
 * Call once during service initialisation.
 */
export function logMtlsStatus(serviceName: "main-api" | "signing-service"): void {
  if (MTLS_ENABLED) {
    console.log(`[mTLS] ACTIVE on ${serviceName} — mutual TLS client verification enabled`);
  } else {
    console.warn(
      `[mTLS] INACTIVE on ${serviceName} — falling back to Bearer token auth. ` +
      "Set MTLS_ENABLED=true with MTLS_CA_CERT/MTLS_CLIENT_CERT/MTLS_CLIENT_KEY to activate.",
    );
  }
}
