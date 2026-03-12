"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PeraWalletConnect as PeraWalletConnectType } from "@perawallet/connect";

// ── Pera Connect — owner-level (no agentId required) ─────────────────────

function PeraConnectButton({
  onVerified,
}: {
  onVerified: (ownerAddress: string) => void;
}) {
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
      // 1. Get owner-level challenge (not agent-scoped)
      const chalRes = await fetch("/api/owner/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!chalRes.ok) {
        const b = await chalRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${chalRes.status}`);
      }
      const { challengeId, challengeB64 } = await chalRes.json() as {
        challengeId: string; challengeB64: string;
      };

      // 2. Connect wallet
      const accounts = await pera.connect();
      const address = accounts[0];

      // 3. Sign challenge
      setStatus("signing");
      const challengeBytes = Uint8Array.from(atob(challengeB64), (c) => c.charCodeAt(0));
      const signatures = await pera.signData(
        [{ data: challengeBytes, message: "Sign in to your agent dashboard" }],
        address,
      );
      const signatureB64 = btoa(String.fromCharCode(...signatures[0]));

      // 4. Verify on backend
      setStatus("verifying");
      const verifyRes = await fetch("/api/owner/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, address, signatureB64 }),
      });
      if (!verifyRes.ok) {
        const b = await verifyRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${verifyRes.status}`);
      }
      const { ownerAddress } = await verifyRes.json() as { ownerAddress: string };
      onVerified(ownerAddress);
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
  const buttonLabel = {
    idle:       "Connect Algorand Wallet",
    connecting: "Opening wallet…",
    signing:    "Sign in Pera app…",
    verifying:  "Verifying…",
    error:      "Retry",
  }[status];

  return (
    <div className="flex flex-col gap-3">
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
        <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs text-red-300 text-center">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

// ── Main login form ───────────────────────────────────────────────

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/app/dashboard";

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  const handleVerified = useCallback(async (ownerAddress: string) => {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/customer/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress }),
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
          <h1 className="text-2xl font-bold text-white">Agent Dashboard</h1>
          <p className="text-zinc-500 text-sm mt-1">Connect your Algorand wallet to manage your agents</p>
        </div>

        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-300">{error}</div>
          )}

          {!submitting && <PeraConnectButton onVerified={handleVerified} />}

          {submitting && (
            <div className="flex items-center justify-center gap-2 py-3 text-zinc-400 text-sm">
              <svg className="animate-spin w-4 h-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Signing in…
            </div>
          )}
        </div>

        <p className="text-center text-zinc-700 text-xs mt-8">x402 Protocol · Algorand Settlement Layer</p>
      </div>
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
