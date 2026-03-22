"use client";

import Link from "next/link";
import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PeraWalletConnect as PeraWalletConnectType } from "@perawallet/connect";

type Status = "idle" | "connecting" | "signing" | "verifying" | "error";

function SignInForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const from         = searchParams.get("from") ?? "";

  const peraRef   = useRef<PeraWalletConnectType | null>(null);
  const [status,   setStatus]   = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    import("@perawallet/connect").then(({ PeraWalletConnect }) => {
      peraRef.current = new PeraWalletConnect();
    });
    return () => { peraRef.current?.disconnect().catch(() => {}); };
  }, []);

  const handleSignIn = useCallback(async () => {
    const pera = peraRef.current;
    if (!pera) { setStatus("error"); setErrorMsg("Wallet library not loaded — refresh the page."); return; }

    setStatus("connecting");
    setErrorMsg("");

    try {
      // 1. Get challenge
      const chalRes = await fetch("/api/admin/auth/pera-challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!chalRes.ok) throw new Error((await chalRes.json().catch(() => ({}))).error ?? `HTTP ${chalRes.status}`);
      const { challengeId, challengeB64 } = await chalRes.json() as { challengeId: string; challengeB64: string };

      // 2. Connect wallet
      const accounts = await pera.connect();
      const address  = accounts[0];

      // 3. Sign challenge
      setStatus("signing");
      const challengeBytes = Uint8Array.from(atob(challengeB64), (c) => c.charCodeAt(0));
      const signatures     = await pera.signData([{ data: challengeBytes, message: "Sign in to algo-wallet" }], address);
      const signatureB64   = btoa(String.fromCharCode(...signatures[0]));

      // 4. Verify signature on backend
      setStatus("verifying");
      const verifyRes = await fetch("/api/admin/auth/pera-verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, address, signatureB64 }),
      });
      if (!verifyRes.ok) throw new Error((await verifyRes.json().catch(() => ({}))).error ?? `HTTP ${verifyRes.status}`);
      const { verifiedSessionId } = await verifyRes.json() as { verifiedSessionId: string };

      // 5. Try admin login first
      const adminRes = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peraSessionId: verifiedSessionId }),
      });

      if (adminRes.ok) {
        // Admin — go to admin dashboard (or original destination if it was an admin route)
        const dest = from && !from.startsWith("/app/") ? from : "/dashboard";
        router.push(dest);
        return;
      }

      if (adminRes.status !== 403) {
        // Unexpected error from admin endpoint
        throw new Error((await adminRes.json().catch(() => ({}))).error ?? `HTTP ${adminRes.status}`);
      }

      // 6. Not admin — issue customer session
      const customerRes = await fetch("/api/customer/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: address }),
      });
      if (!customerRes.ok) throw new Error((await customerRes.json().catch(() => ({}))).error ?? `HTTP ${customerRes.status}`);

      // Customer — go to agent dashboard (or original destination if it was a customer route)
      const dest = from && from.startsWith("/app/") ? from : "/app/dashboard";
      router.push(dest);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Session currently disconnected") ||
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("closed")
      ) {
        setStatus("idle");
      } else {
        setStatus("error");
        setErrorMsg(msg);
      }
    }
  }, [from, router]);

  const busy = status !== "idle" && status !== "error";

  const buttonLabel: Record<Status, string> = {
    idle:       "Connect Algorand Wallet",
    connecting: "Opening wallet…",
    signing:    "Sign in Pera app…",
    verifying:  "Verifying…",
    error:      "Try again",
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo / heading */}
        <div className="text-center mb-10">
          <Link href="/" className="inline-block mb-6">
            <span className="text-white font-semibold tracking-tight">algo-wallet</span>
          </Link>
          <h1 className="text-2xl font-bold text-white">Sign in</h1>
          <p className="text-zinc-500 text-sm mt-1">Connect your Algorand wallet to continue</p>
        </div>

        {/* Connect button */}
        <div className="space-y-4">
          {status === "error" && errorMsg && (
            <div className="rounded-lg bg-red-950/50 border border-red-800 px-4 py-3 text-sm text-red-300">
              {errorMsg}
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={handleSignIn}
            className="w-full flex items-center justify-center gap-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
          >
            {busy && (
              <svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {buttonLabel[status]}
          </button>

          {status === "signing" && (
            <p className="text-zinc-500 text-xs text-center">Check your Pera app — approve the sign request</p>
          )}

          <p className="text-zinc-600 text-xs text-center">
            Works with Pera, Defly, Kibisis and any WalletConnect wallet
          </p>
        </div>

        {/* Footer */}
        <p className="text-center text-zinc-700 text-xs mt-10">
          Don&apos;t have an Algorand wallet?{" "}
          <Link href="/get-started" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors">
            Setup guide →
          </Link>
        </p>

      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <SignInForm />
    </Suspense>
  );
}
