"use client";

import { useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import LiquidAuthQRModal from "@/components/mandates/LiquidAuthQRModal";

// ── WebAuthn helpers ──────────────────────────────────────────────

function bufToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToBuf(b64: string): ArrayBuffer {
  const padded = b64
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const str = atob(padded);
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
  return buf;
}

function serializeRegistrationResponse(credential: PublicKeyCredential) {
  const resp = credential.response as AuthenticatorAttestationResponse;
  return {
    id:   credential.id,
    rawId: bufToBase64url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bufToBase64url(resp.attestationObject),
      clientDataJSON:    bufToBase64url(resp.clientDataJSON),
      transports:        resp.getTransports?.() ?? [],
    },
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults:  credential.getClientExtensionResults(),
  };
}

function serializeAssertion(assertion: PublicKeyCredential) {
  const resp = assertion.response as AuthenticatorAssertionResponse;
  return {
    id:    assertion.id,
    rawId: bufToBase64url(assertion.rawId),
    type:  assertion.type,
    response: {
      authenticatorData: bufToBase64url(resp.authenticatorData),
      clientDataJSON:    bufToBase64url(resp.clientDataJSON),
      signature:         bufToBase64url(resp.signature),
      userHandle:        resp.userHandle ? bufToBase64url(resp.userHandle) : null,
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────

type AuthMethod = "liquid" | "webauthn";

interface RegistrationChallenge {
  challenge:       string;
  userId:          string;
  rpId:            string;
  rpName:          string;
  userName:        string;
  userDisplayName: string;
  hasCredentials:  boolean;
}

interface LoginChallenge {
  challenge:        string;
  allowCredentials: Array<{ id: string; type: string }>;
  hasCredentials:   boolean;
  rpId:             string;
}

// ── Main login form ───────────────────────────────────────────────

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/app/dashboard";

  const [agentIdInput, setAgentIdInput] = useState(searchParams.get("agentId") ?? "");
  const [authMethod,   setAuthMethod]   = useState<AuthMethod>("liquid");
  const [showQR,       setShowQR]       = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [step,         setStep]         = useState<string>("");
  const [error,        setError]        = useState("");

  const agentId = agentIdInput.trim();

  // ── Liquid Auth path ────────────────────────────────────────────

  async function handleLiquidVerified(sessionId: string) {
    setShowQR(false);
    setSubmitting(true);
    setError("");
    setStep("Signing in…");
    try {
      const res = await fetch("/api/customer/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, liquidAuthSessionId: sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      router.push(from);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setStep("");
    }
  }

  // ── WebAuthn path ────────────────────────────────────────────────
  //
  // Flow:
  //   1. GET login challenge → hasCredentials?
  //   2a. hasCredentials=true  → navigator.credentials.get() → POST login
  //   2b. hasCredentials=false → GET register challenge → navigator.credentials.create()
  //                           → POST webauthn-register (stores credential + sets JWT)

  const handleWebAuthn = useCallback(async () => {
    if (!agentId) { setError("Enter your Agent ID first."); return; }
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser. Use Algorand Wallet QR instead.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      // ── Step 1: probe for existing credential ─────────────────
      setStep("Checking device credentials…");
      const lcRes = await fetch(`/api/agents/${agentId}/auth/webauthn-login-challenge`, {
        method: "POST",
      });
      if (!lcRes.ok) {
        const b = await lcRes.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error || `HTTP ${lcRes.status}`);
      }
      const lc = await lcRes.json() as LoginChallenge;

      if (lc.hasCredentials) {
        // ── 2a: Authenticate with existing credential ──────────
        setStep("Touch your security key or use biometrics…");
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge:        base64urlToBuf(lc.challenge),
            allowCredentials: lc.allowCredentials.map((c) => ({
              id:   base64urlToBuf(c.id),
              type: c.type as PublicKeyCredentialType,
            })),
            rpId:             lc.rpId,
            timeout:          60_000,
            userVerification: "preferred",
          },
        }) as PublicKeyCredential | null;

        if (!assertion) throw new Error("Passkey authentication cancelled.");

        setStep("Verifying…");
        const loginRes = await fetch("/api/customer/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, webauthnAssertion: serializeAssertion(assertion) }),
        });
        if (!loginRes.ok) {
          const b = await loginRes.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error || `HTTP ${loginRes.status}`);
        }
        router.push(from);

      } else {
        // ── 2b: Register a new credential (first time) ─────────
        setStep("Registering new passkey…");
        const rcRes = await fetch(
          `/api/agents/${agentId}/auth/webauthn-register-challenge`,
          { method: "POST" },
        );
        if (!rcRes.ok) {
          const b = await rcRes.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error || `HTTP ${rcRes.status}`);
        }
        const rc = await rcRes.json() as RegistrationChallenge;

        setStep("Create a passkey — follow your device prompt…");
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge:     base64urlToBuf(rc.challenge),
            rp:            { id: rc.rpId, name: rc.rpName },
            user: {
              id:          base64urlToBuf(rc.userId),
              name:        rc.userName,
              displayName: rc.userDisplayName,
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7   }, // ES256
              { type: "public-key", alg: -257  }, // RS256
            ],
            timeout:          60_000,
            attestation:      "none",
            authenticatorSelection: {
              residentKey:       "preferred",
              userVerification:  "preferred",
            },
          },
        }) as PublicKeyCredential | null;

        if (!credential) throw new Error("Passkey creation cancelled.");

        setStep("Storing credential…");
        const regRes = await fetch("/api/customer/auth/webauthn-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            registrationResponse: serializeRegistrationResponse(credential),
          }),
        });
        if (!regRes.ok) {
          const b = await regRes.json().catch(() => ({}));
          throw new Error((b as { error?: string }).error || `HTTP ${regRes.status}`);
        }
        // Registration also sets the customer session cookie
        router.push(from);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setStep("");
    }
  }, [agentId, from, router]);

  const canProceed = agentId.length > 0 && !submitting;

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-900/50 border border-emerald-800 mb-4">
            <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Agent Dashboard</h1>
          <p className="text-zinc-500 text-sm mt-1">Sign in with your Algorand wallet or device passkey</p>
        </div>

        <div className="space-y-5">

          {/* Agent ID */}
          <div>
            <label htmlFor="agentId" className="block text-xs text-zinc-400 uppercase tracking-wider mb-2">
              Agent ID
            </label>
            <input
              id="agentId"
              type="text"
              value={agentIdInput}
              onChange={(e) => setAgentIdInput(e.target.value)}
              placeholder="sdk-abc123…"
              autoFocus
              autoComplete="off"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-white font-mono placeholder-zinc-600 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>

          {/* Auth method toggle */}
          <div className="flex gap-2 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
            <button
              type="button"
              onClick={() => setAuthMethod("liquid")}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                authMethod === "liquid"
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Algorand Wallet QR{" "}
              <span className="text-xs text-emerald-400">(Recommended)</span>
            </button>
            <button
              type="button"
              onClick={() => setAuthMethod("webauthn")}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                authMethod === "webauthn"
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Device Passkey
            </button>
          </div>

          {/* In-progress step indicator */}
          {submitting && step && (
            <div className="flex items-center gap-2 text-zinc-400 text-sm px-1">
              <svg className="animate-spin w-4 h-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {step}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Action button */}
          {authMethod === "liquid" ? (
            <button
              type="button"
              disabled={!canProceed}
              onClick={() => { setError(""); setShowQR(true); }}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            >
              Scan QR with Pera / Defly
            </button>
          ) : (
            <button
              type="button"
              disabled={!canProceed}
              onClick={handleWebAuthn}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            >
              {submitting ? "Working…" : "Continue with Passkey"}
            </button>
          )}

          {/* WebAuthn hint text */}
          {authMethod === "webauthn" && !submitting && (
            <p className="text-xs text-zinc-600 text-center px-2">
              First time? A new passkey is created on your device. Returning? Your device unlocks automatically.
            </p>
          )}
        </div>

        <p className="text-center text-zinc-700 text-xs mt-8">
          x402 Protocol · Algorand Settlement Layer
        </p>
      </div>

      {showQR && agentId && (
        <LiquidAuthQRModal
          agentId={agentId}
          intent="register"
          onVerified={handleLiquidVerified}
          onClose={() => setShowQR(false)}
        />
      )}
    </div>
  );
}

export default function CustomerLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <LoginForm />
    </Suspense>
  );
}
