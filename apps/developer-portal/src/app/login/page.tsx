"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import QRCode from "qrcode";

// ── WebAuthn helpers ──────────────────────────────────────────────────────

function bufToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToBuf(b64: string): ArrayBuffer {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const str = atob(padded);
  const buf = new ArrayBuffer(str.length);
  new Uint8Array(buf).forEach((_, i, a) => { a[i] = str.charCodeAt(i); });
  return buf;
}

function serializeRegistrationResponse(credential: PublicKeyCredential) {
  const resp = credential.response as AuthenticatorAttestationResponse;
  return {
    id:    credential.id,
    rawId: bufToBase64url(credential.rawId),
    type:  credential.type,
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

// ── QR countdown helper ───────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// ── Types ─────────────────────────────────────────────────────────────────

type AuthMethod = "liquid" | "webauthn";

interface LoginChallenge {
  challenge:        string;
  allowCredentials: Array<{ id: string; type: string }>;
  hasCredentials:   boolean;
  rpId:             string;
}

interface RegistrationChallenge {
  challenge:       string;
  userId:          string;
  rpId:            string;
  rpName:          string;
  userName:        string;
  userDisplayName: string;
  hasCredentials:  boolean;
}

// ── Liquid Auth QR panel ──────────────────────────────────────────────────

function LiquidAuthPanel({ onVerified }: { onVerified: (sessionId: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [msLeft,    setMsLeft]    = useState(0);
  const [status, setStatus]       = useState<"loading" | "scanning" | "verified" | "expired" | "error">("loading");
  const [errorMsg, setErrorMsg]   = useState("");

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const issueChallenge = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");
    stopTimers();

    try {
      const res = await fetch("/api/admin/auth/liquid-challenge", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { sessionId: string; qrPayload: unknown; expiresAt: number };

      setSessionId(data.sessionId);
      const expMs = data.expiresAt;
      setExpiresAt(expMs);
      setMsLeft(expMs - Date.now());
      setStatus("scanning");

      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, JSON.stringify(data.qrPayload), {
          width: 220, margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      }

      tickRef.current = setInterval(() => {
        const rem = expMs - Date.now();
        if (rem <= 0) { setMsLeft(0); setStatus("expired"); stopTimers(); }
        else           { setMsLeft(rem); }
      }, 500);

      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/admin/auth/liquid-status/${data.sessionId}`);
          if (!r.ok) return;
          const d = await r.json() as { status: string };
          if (d.status === "verified") {
            stopTimers();
            setStatus("verified");
            onVerified(data.sessionId);
          }
        } catch { /* transient — keep polling */ }
      }, 2000);

    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [onVerified, stopTimers]);

  useEffect(() => {
    issueChallenge();
    return stopTimers;
  }, [issueChallenge, stopTimers]);

  const isAmber = msLeft > 0 && msLeft < 60_000;

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-zinc-400 text-sm text-center">
        Scan with Pera or Defly to prove wallet ownership.
      </p>

      <div className="relative flex items-center justify-center bg-zinc-800 rounded-lg"
        style={{ width: 220, height: 220 }}>
        <canvas ref={canvasRef}
          style={{ display: (status === "scanning" || status === "verified") ? "block" : "none" }} />
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-7 h-7 border-2 border-zinc-600 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        )}
        {status === "expired" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 rounded-lg">
            <span className="text-zinc-400 text-sm">QR expired</span>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 rounded-lg px-3">
            <span className="text-red-400 text-xs text-center">{errorMsg}</span>
          </div>
        )}
      </div>

      {status === "scanning" && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <div className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          Waiting for wallet signature…
        </div>
      )}
      {status === "verified" && (
        <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Verified ✓
        </div>
      )}
      {status === "scanning" && expiresAt && (
        <p className={`text-xs ${isAmber ? "text-amber-400" : "text-zinc-500"}`}>
          Expires in {formatCountdown(msLeft)}
        </p>
      )}
      {(status === "expired" || status === "error") && (
        <button onClick={issueChallenge}
          className="w-full py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors">
          Refresh QR
        </button>
      )}

      {/* Unused ref suppression */}
      <span className="hidden">{sessionId}</span>
    </div>
  );
}

// ── Main login form ───────────────────────────────────────────────────────

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const from         = searchParams.get("from") || "/dashboard";

  const [authMethod,  setAuthMethod]  = useState<AuthMethod>("liquid");
  const [submitting,  setSubmitting]  = useState(false);
  const [step,        setStep]        = useState("");
  const [error,       setError]       = useState("");
  const [showQR,      setShowQR]      = useState(false);

  // Start QR immediately when liquid tab is active
  useEffect(() => {
    if (authMethod === "liquid") setShowQR(true);
    else                        setShowQR(false);
  }, [authMethod]);

  // ── Liquid Auth path ───────────────────────────────────────────────────

  const handleLiquidVerified = useCallback(async (sessionId: string) => {
    setSubmitting(true);
    setError("");
    setStep("Signing in…");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:   JSON.stringify({ liquidAuthSessionId: sessionId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      router.push(from);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShowQR(false);
    } finally {
      setSubmitting(false);
      setStep("");
    }
  }, [from, router]);

  // ── WebAuthn path ──────────────────────────────────────────────────────

  const handleWebAuthn = useCallback(async () => {
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser. Use Algorand Wallet QR instead.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      // Step 1: check for existing credential
      setStep("Checking device credentials…");
      const lcRes = await fetch("/api/admin/auth/webauthn-login-challenge", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!lcRes.ok) {
        const b = await lcRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${lcRes.status}`);
      }
      const lc = await lcRes.json() as LoginChallenge;

      if (lc.hasCredentials) {
        // ── 2a: Authenticate with existing credential ──────────────────
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
        const loginRes = await fetch("/api/auth/login", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ webauthnAssertion: serializeAssertion(assertion) }),
        });
        if (!loginRes.ok) {
          const b = await loginRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${loginRes.status}`);
        }
        router.push(from);

      } else {
        // ── 2b: Register first passkey (TOFU bootstrap) ────────────────
        setStep("Registering new admin passkey…");
        const rcRes = await fetch("/api/admin/auth/webauthn-register-challenge", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!rcRes.ok) {
          const b = await rcRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${rcRes.status}`);
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
              residentKey:      "preferred",
              userVerification: "preferred",
            },
          },
        }) as PublicKeyCredential | null;

        if (!credential) throw new Error("Passkey creation cancelled.");

        setStep("Storing credential…");
        const regRes = await fetch("/api/admin/auth/webauthn-register", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ registrationResponse: serializeRegistrationResponse(credential) }),
        });
        if (!regRes.ok) {
          const b = await regRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${regRes.status}`);
        }

        // Registration done — now log in with the new credential
        setStep("Signing in…");
        const lc2Res = await fetch("/api/admin/auth/webauthn-login-challenge", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: "{}" });
        const lc2 = await lc2Res.json() as LoginChallenge;
        const regData = await regRes.json() as { credentialId: string };

        setStep("Touch your device to confirm…");
        const assertion2 = await navigator.credentials.get({
          publicKey: {
            challenge:        base64urlToBuf(lc2.challenge),
            allowCredentials: [{ id: base64urlToBuf(regData.credentialId), type: "public-key" }],
            rpId:             lc2.rpId,
            timeout:          60_000,
            userVerification: "preferred",
          },
        }) as PublicKeyCredential | null;

        if (!assertion2) throw new Error("Passkey confirmation cancelled.");

        setStep("Verifying…");
        const loginRes = await fetch("/api/auth/login", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ webauthnAssertion: serializeAssertion(assertion2) }),
        });
        if (!loginRes.ok) {
          const b = await loginRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${loginRes.status}`);
        }
        router.push(from);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setStep("");
    }
  }, [from, router]);

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
          <h1 className="text-2xl font-bold text-white">x402 Portal</h1>
          <p className="text-zinc-500 text-sm mt-1">
            Admin access — sign in with your Algorand wallet or passkey
          </p>
        </div>

        <div className="space-y-5">

          {/* Auth method toggle */}
          <div className="flex gap-2 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
            <button
              type="button"
              onClick={() => { setAuthMethod("liquid"); setError(""); }}
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
              onClick={() => { setAuthMethod("webauthn"); setError(""); }}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                authMethod === "webauthn"
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Device Passkey
            </button>
          </div>

          {/* In-progress indicator */}
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

          {/* Liquid Auth — inline QR */}
          {authMethod === "liquid" && !submitting && (
            showQR
              ? <LiquidAuthPanel onVerified={handleLiquidVerified} />
              : (
                <button
                  type="button"
                  onClick={() => setShowQR(true)}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
                >
                  Scan QR with Pera / Defly
                </button>
              )
          )}

          {/* WebAuthn */}
          {authMethod === "webauthn" && (
            <button
              type="button"
              disabled={submitting}
              onClick={handleWebAuthn}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            >
              {submitting ? "Working…" : "Continue with Passkey"}
            </button>
          )}

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
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <LoginForm />
    </Suspense>
  );
}
