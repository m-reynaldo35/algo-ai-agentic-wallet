"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PeraWalletConnect as PeraWalletConnectType } from "@perawallet/connect";

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

// ── Types ─────────────────────────────────────────────────────────────────

type AuthMethod = "pera" | "webauthn";

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

// ── Pera Connect panel ────────────────────────────────────────────────────

function PeraConnectPanel({ onVerified }: { onVerified: (sessionId: string) => void }) {
  const peraRef = useRef<PeraWalletConnectType | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "signing" | "verifying" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    import("@perawallet/connect").then(({ PeraWalletConnect }) => {
      peraRef.current = new PeraWalletConnect();
    });
    return () => { peraRef.current?.disconnect().catch(() => {}); };
  }, []);

  const handleConnect = useCallback(async () => {
    const pera = peraRef.current;
    if (!pera) { setStatus("error"); setErrorMsg("Wallet library not loaded — refresh the page"); return; }

    setStatus("connecting");
    setErrorMsg("");

    try {
      // 1. Get challenge
      const chalRes = await fetch("/api/admin/auth/pera-challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!chalRes.ok) {
        const b = await chalRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${chalRes.status}`);
      }
      const { challengeId, challengeB64 } = await chalRes.json() as {
        challengeId: string; challengeB64: string;
      };

      // 2. Connect — opens WalletConnect modal with QR + deeplink
      const accounts = await pera.connect();
      const address = accounts[0];

      // 3. Sign challenge
      setStatus("signing");
      const challengeBytes = Uint8Array.from(atob(challengeB64), (c) => c.charCodeAt(0));
      const signatures = await pera.signData(
        [{ data: challengeBytes, message: "Sign in to x402 Admin Portal" }],
        address,
      );
      const signatureB64 = btoa(String.fromCharCode(...signatures[0]));

      // 4. Verify on backend
      setStatus("verifying");
      const verifyRes = await fetch("/api/admin/auth/pera-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, address, signatureB64 }),
      });
      if (!verifyRes.ok) {
        const b = await verifyRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${verifyRes.status}`);
      }
      const { verifiedSessionId } = await verifyRes.json() as { verifiedSessionId: string };

      onVerified(verifiedSessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Session currently disconnected") || msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("closed")) {
        setStatus("idle");
      } else {
        setStatus("error");
        setErrorMsg(msg);
      }
    }
  }, [onVerified]);

  const busy = status === "connecting" || status === "signing" || status === "verifying";
  const buttonLabel = { idle: "Connect Pera Wallet", connecting: "Opening wallet…", signing: "Sign in Pera app…", verifying: "Verifying…", error: "Retry" }[status];

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-zinc-400 text-sm text-center">
        Connect your Algorand wallet to prove address ownership.
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={handleConnect}
        className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
      >
        {busy && (
          <svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {buttonLabel}
      </button>

      {status === "signing" && (
        <p className="text-zinc-500 text-xs text-center">Check your Pera app — approve the sign request</p>
      )}
      {status === "error" && errorMsg && (
        <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs text-red-300 text-center w-full">
          {errorMsg}
        </div>
      )}
      <p className="text-zinc-600 text-xs text-center">
        Works with Pera, Defly, Kibisis, and any WalletConnect-compatible Algorand wallet
      </p>
    </div>
  );
}

// ── Main login form ───────────────────────────────────────────────────────

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const from         = searchParams.get("from") || "/dashboard";

  const [authMethod, setAuthMethod] = useState<AuthMethod>("pera");
  const [submitting, setSubmitting] = useState(false);
  const [step,       setStep]       = useState("");
  const [error,      setError]      = useState("");

  const handlePeraVerified = useCallback(async (sessionId: string) => {
    setSubmitting(true);
    setError("");
    setStep("Signing in…");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:   JSON.stringify({ peraSessionId: sessionId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      router.push(from);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setStep("");
    }
  }, [from, router]);

  const handleWebAuthn = useCallback(async () => {
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser. Use Algorand Wallet instead.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      setStep("Checking device credentials…");
      const lcRes = await fetch("/api/admin/auth/webauthn-login-challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!lcRes.ok) {
        const b = await lcRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${lcRes.status}`);
      }
      const lc = await lcRes.json() as LoginChallenge;

      if (lc.hasCredentials) {
        setStep("Touch your security key or use biometrics…");
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge:        base64urlToBuf(lc.challenge),
            allowCredentials: lc.allowCredentials.map((c) => ({
              id: base64urlToBuf(c.id), type: c.type as PublicKeyCredentialType,
            })),
            rpId: lc.rpId, timeout: 60_000, userVerification: "preferred",
          },
        }) as PublicKeyCredential | null;
        if (!assertion) throw new Error("Passkey authentication cancelled.");

        setStep("Verifying…");
        const loginRes = await fetch("/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webauthnAssertion: serializeAssertion(assertion) }),
        });
        if (!loginRes.ok) {
          const b = await loginRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${loginRes.status}`);
        }
        router.push(from);

      } else {
        setStep("Registering new admin passkey…");
        const rcRes = await fetch("/api/admin/auth/webauthn-register-challenge", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (!rcRes.ok) {
          const b = await rcRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${rcRes.status}`);
        }
        const rc = await rcRes.json() as RegistrationChallenge;

        setStep("Create a passkey — follow your device prompt…");
        const credential = await navigator.credentials.create({
          publicKey: {
            challenge: base64urlToBuf(rc.challenge),
            rp: { id: rc.rpId, name: rc.rpName },
            user: { id: base64urlToBuf(rc.userId), name: rc.userName, displayName: rc.userDisplayName },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            timeout: 60_000, attestation: "none",
            authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          },
        }) as PublicKeyCredential | null;
        if (!credential) throw new Error("Passkey creation cancelled.");

        setStep("Storing credential…");
        const regRes = await fetch("/api/admin/auth/webauthn-register", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationResponse: serializeRegistrationResponse(credential) }),
        });
        if (!regRes.ok) {
          const b = await regRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `HTTP ${regRes.status}`);
        }

        setStep("Signing in…");
        const lc2Res = await fetch("/api/admin/auth/webauthn-login-challenge", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        const lc2 = await lc2Res.json() as LoginChallenge;
        const regData = await regRes.json() as { credentialId: string };

        setStep("Touch your device to confirm…");
        const assertion2 = await navigator.credentials.get({
          publicKey: {
            challenge: base64urlToBuf(lc2.challenge),
            allowCredentials: [{ id: base64urlToBuf(regData.credentialId), type: "public-key" }],
            rpId: lc2.rpId, timeout: 60_000, userVerification: "preferred",
          },
        }) as PublicKeyCredential | null;
        if (!assertion2) throw new Error("Passkey confirmation cancelled.");

        setStep("Verifying…");
        const loginRes = await fetch("/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webauthnAssertion: serializeAssertion(assertion2) }),
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

        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-900/50 border border-emerald-800 mb-4">
            <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">x402 Portal</h1>
          <p className="text-zinc-500 text-sm mt-1">Admin access — sign in with your Algorand wallet or passkey</p>
        </div>

        <div className="space-y-5">
          <div className="flex gap-2 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
            <button type="button" onClick={() => { setAuthMethod("pera"); setError(""); }}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${authMethod === "pera" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}>
              Algorand Wallet <span className="text-xs text-emerald-400">(Recommended)</span>
            </button>
            <button type="button" onClick={() => { setAuthMethod("webauthn"); setError(""); }}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${authMethod === "webauthn" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}>
              Device Passkey
            </button>
          </div>

          {submitting && step && (
            <div className="flex items-center gap-2 text-zinc-400 text-sm px-1">
              <svg className="animate-spin w-4 h-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {step}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-300">{error}</div>
          )}

          {authMethod === "pera" && !submitting && (
            <PeraConnectPanel onVerified={handlePeraVerified} />
          )}

          {authMethod === "webauthn" && (
            <button type="button" disabled={submitting} onClick={handleWebAuthn}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors">
              {submitting ? "Working…" : "Continue with Passkey"}
            </button>
          )}

          {authMethod === "webauthn" && !submitting && (
            <p className="text-xs text-zinc-600 text-center px-2">
              First time? A new passkey is created on your device. Returning? Your device unlocks automatically.
            </p>
          )}
        </div>

        <p className="text-center text-zinc-700 text-xs mt-8">x402 Protocol · Algorand Settlement Layer</p>
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
