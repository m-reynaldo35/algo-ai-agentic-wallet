/**
 * Signing Service HTTP Client
 *
 * Called by the executor when SIGNING_SERVICE_URL is configured.
 * Translates the internal signing contract into HTTP calls to the
 * signing microservice, and maps the response back to SignedGroupResult.
 *
 * Dev fallback: when SIGNING_SERVICE_URL is absent, the executor calls
 * roccaWallet.signAtomicGroup() directly (key in same process).
 *
 * Module 9 — mTLS client:
 * When MTLS_ENABLED=true, all outbound requests to the signing service
 * are sent over HTTPS using a Node.js https.Agent configured with the
 * Main API's client certificate and private key. The signing service
 * verifies this cert against the shared internal CA (requestCert: true,
 * rejectUnauthorized: true). Connections without a valid client cert are
 * rejected at the TLS handshake — the Bearer token is an additional
 * application-layer check on top of mTLS.
 *
 * When MTLS_ENABLED=false (default), plain HTTP with Bearer token is used.
 */

import https from "node:https";
import http from "node:http";
import type { AuthToken } from "../auth/liquidAuth.js";
import type { SignedGroupResult } from "../signer/roccaWallet.js";
import type { SignRequest, SignResponse, SignError } from "./server.js";
import { MTLS_ENABLED, buildMtlsAgent } from "../protection/mtlsConfig.js";

// ── mTLS agent (built once at module load, reused across calls) ────
//
// https.Agent is expensive to create (reads certs from env, allocates TLS
// context). Build it once and keep it alive across requests.
let _mtlsAgent: https.Agent | undefined;

function getMtlsAgent(): https.Agent | undefined {
  if (!MTLS_ENABLED) return undefined;
  if (!_mtlsAgent) {
    _mtlsAgent = buildMtlsAgent();
  }
  return _mtlsAgent;
}

// ── Service config ─────────────────────────────────────────────────

function getServiceUrl(): string {
  const url = process.env.SIGNING_SERVICE_URL;
  if (!url) throw new Error("SIGNING_SERVICE_URL not configured");
  return url.replace(/\/$/, ""); // strip trailing slash
}

function getApiKey(): string {
  const key = process.env.SIGNING_SERVICE_API_KEY;
  if (!key) throw new Error("SIGNING_SERVICE_API_KEY not configured");
  return key;
}

// ── mTLS-aware fetch wrapper ───────────────────────────────────────
//
// When MTLS_ENABLED, routes through https.request with the mTLS agent
// so the client cert is presented during the TLS handshake. This
// avoids the undici dependency while using only Node.js built-ins.
//
// The global fetch() does not support a custom https.Agent. We use
// https.request directly for the mTLS path and global fetch for plain HTTP.

interface FetchLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

async function fetchWithAgent(
  url: string,
  options: {
    method:  string;
    headers: Record<string, string>;
    body:    string;
    signal:  AbortSignal;
  },
): Promise<FetchLike> {
  const agent = getMtlsAgent();

  if (!agent) {
    // Plain HTTP path — use global fetch (Node 20+)
    return fetch(url, options) as Promise<FetchLike>;
  }

  // mTLS HTTPS path — use https.request with the client cert agent
  return new Promise<FetchLike>((resolve, reject) => {
    const parsed = new URL(url);

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || "443",
      path:     parsed.pathname + parsed.search,
      method:   options.method,
      headers:  options.headers,
      agent,
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const status   = res.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          json() {
            try { return Promise.resolve(JSON.parse(bodyText)); }
            catch { return Promise.reject(new Error("Response is not valid JSON")); }
          },
        });
      });
    });

    req.on("error", reject);

    // Honour the AbortSignal
    options.signal.addEventListener("abort", () => {
      req.destroy(new Error("Request aborted"));
      reject(new Error("Request aborted by signal"));
    }, { once: true });

    req.write(options.body);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Call the signing microservice to sign an atomic group.
 *
 * @param unsignedBlobs - Raw unsigned transaction bytes
 * @param authToken     - Verified Liquid Auth credential
 * @param agentId       - Registered agent identifier
 * @returns SignedGroupResult with signed blobs ready for broadcast
 */
export async function callSigningService(
  unsignedBlobs: Uint8Array[],
  authToken: AuthToken,
  agentId: string,
): Promise<SignedGroupResult> {
  const serviceUrl = getServiceUrl();
  const apiKey     = getApiKey();
  const requestId  = crypto.randomUUID();

  const body: SignRequest = {
    requestId,
    agentId,
    authToken,
    unsignedTransactions: unsignedBlobs.map((b) =>
      Buffer.from(b).toString("base64"),
    ),
  };

  let res: FetchLike;
  try {
    res = await fetchWithAgent(`${serviceUrl}/sign`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), // 30 s hard timeout
    });
  } catch (err) {
    throw new Error(
      `Signing service unreachable: ${err instanceof Error ? err.message : err}`,
    );
  }

  const json = (await res.json()) as SignResponse | SignError;

  if (!res.ok) {
    const errBody = json as SignError;
    throw new Error(
      `Signing service error ${res.status}: ${errBody.error ?? "unknown"}`,
    );
  }

  const ok = json as SignResponse;
  return {
    signedTransactions: ok.signedTransactions.map(
      (b64) => new Uint8Array(Buffer.from(b64, "base64")),
    ),
    signerAddress: ok.signerAddress,
    txnCount:      ok.txnCount,
  };
}
