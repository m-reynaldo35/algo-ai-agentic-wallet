"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";

const NETWORK         = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID   = NETWORK === "mainnet" ? 31566704 : 10458941;
/** 0.205 ALGO — must match MINIMUM_FUNDING_MICRO in agentRegistration.ts */
const MIN_ALGO_MICRO  = 205_000;

// ── Types ─────────────────────────────────────────────────────────────────

interface KeypairResponse {
  agentId: string;
  address: string;
  mnemonic: string;
  minimumFundingAlgo: number;
}

interface ActivateResponse {
  agentId: string;
  address: string;
  registrationTxnId: string;
  explorerUrl: string;
}

interface Balance { microAlgo: number; microUsdc: number; }

// ── Step 1 — Name your agent ───────────────────────────────────────────────

function Step1({ onNext }: { onNext: (agentId: string) => void }) {
  const [agentId, setAgentId] = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = agentId.trim();
    if (!id) { setError("Enter an agent name."); return; }
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(id)) {
      setError("3–64 characters: letters, numbers, _ or -");
      return;
    }
    setError("");
    setLoading(true);
    onNext(id);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Name your agent</h2>
        <p className="text-sm text-zinc-400">
          Choose a unique ID. You'll use this to log in to your dashboard.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">Agent ID</label>
          <input
            type="text"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="my-trading-bot"
            autoFocus
            className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30"
          />
          <p className="text-xs text-zinc-600 mt-1">Letters, numbers, _ and - · 3–64 characters</p>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-md transition-colors"
        >
          {loading ? "Generating wallet…" : "Generate Wallet"}
        </button>
      </form>
    </div>
  );
}

// ── Step 2 — Save mnemonic ─────────────────────────────────────────────────

function Step2({
  agentId,
  keypair,
  onNext,
}: {
  agentId: string;
  keypair: KeypairResponse;
  onNext: () => void;
}) {
  const [copied, setCopied]       = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function copy() {
    navigator.clipboard.writeText(keypair.mnemonic).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Save your secret phrase</h2>
        <p className="text-sm text-zinc-400">
          This is the only time you'll see it for{" "}
          <span className="font-mono text-zinc-200">{agentId}</span>.
          The server has already discarded it.
        </p>
      </div>

      <div className="flex items-start gap-2.5 bg-amber-900/30 border border-amber-700/50 rounded-md p-3">
        <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <p className="text-amber-400 text-xs leading-relaxed">
          Anyone with this phrase can access your wallet. Store it offline — password manager, paper, hardware key.
        </p>
      </div>

      <div className="relative bg-zinc-800 border border-zinc-700 rounded-md p-4">
        <p className="font-mono text-sm text-zinc-200 leading-relaxed break-words select-all">
          {keypair.mnemonic}
        </p>
        <button
          onClick={copy}
          className="absolute top-3 right-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-400 transition-colors"
        >
          {copied
            ? <><svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-emerald-400">Copied</span></>
            : <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
          }
        </button>
      </div>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/30"
        />
        <span className="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">
          I've saved my secret phrase in a secure location.
        </span>
      </label>

      <button
        onClick={onNext}
        disabled={!confirmed}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-md transition-colors"
      >
        Continue
      </button>
    </div>
  );
}

// ── Step 3 — Fund + activate ───────────────────────────────────────────────

function Step3({
  agentId,
  keypair,
  onActivated,
}: {
  agentId: string;
  keypair: KeypairResponse;
  onActivated: (result: ActivateResponse) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied]         = useState(false);
  const [balance, setBalance]       = useState<Balance | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError]           = useState("");

  const { address, mnemonic } = keypair;
  const funded = (balance?.microAlgo ?? 0) >= MIN_ALGO_MICRO;

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, `algorand://${address}?amount=${MIN_ALGO_MICRO}`, {
        width: 160, margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  }, [address]);

  const fetchBalance = useCallback(async () => {
    try {
      const res  = await fetch(`/api/customer/balance/${address}`);
      if (!res.ok) return;
      const data = await res.json() as Balance;
      setBalance(data);
    } catch { /* silent — retry on next tick */ }
  }, [address]);

  // Poll every 5s while unfunded
  useEffect(() => {
    fetchBalance();
    const id = setInterval(() => { if (!funded) fetchBalance(); }, 5_000);
    return () => clearInterval(id);
  }, [fetchBalance, funded]);

  async function activate() {
    setError("");
    setActivating(true);
    try {
      const res  = await fetch("/api/agents/register-existing", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ agentId, mnemonic }),
      });
      const data = await res.json() as ActivateResponse & { error?: string };
      if (!res.ok) { setError(data.error ?? `Activation failed (${res.status})`); return; }
      onActivated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setActivating(false);
    }
  }

  const truncated  = `${address.slice(0, 12)}…${address.slice(-10)}`;
  const algoUri    = `algorand://${address}?amount=${MIN_ALGO_MICRO}`;
  const microAlgo  = balance?.microAlgo ?? 0;
  const progress   = Math.min(100, Math.round((microAlgo / MIN_ALGO_MICRO) * 100));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Fund your wallet</h2>
        <p className="text-sm text-zinc-400">
          Send exactly <span className="text-white font-medium">{MIN_ALGO_MICRO / 1_000_000} ALGO</span> to this address.
          This covers the minimum balance, USDC opt-in, and registration fees — all paid from your own wallet.
        </p>
      </div>

      {/* Address + QR */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-5 flex gap-5 items-start">
        <canvas ref={canvasRef} style={{ width: 160, height: 160 }} className="rounded shrink-0" />
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Send ALGO to</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-200 text-xs truncate" title={address}>{truncated}</span>
              <button
                onClick={() => navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied
                  ? <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                }
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="text-xs text-zinc-500">Amount:</span>
            <span className="text-xs text-white font-medium">{MIN_ALGO_MICRO / 1_000_000} ALGO</span>
          </div>
        </div>
      </div>

      {/* Wallet deep links */}
      <div className="flex flex-wrap gap-2">
        <a href={algoUri} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
          Open in Wallet App
        </a>
        <a href="https://app.perawallet.app/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
          Pera
        </a>
        <a href="https://defly.app/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
          Defly
        </a>
      </div>

      {/* Balance + progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Balance detected</span>
          <span className={funded ? "text-emerald-400 font-medium" : "text-zinc-400"}>
            {balance === null
              ? "Checking…"
              : `${(microAlgo / 1_000_000).toFixed(4)} / ${MIN_ALGO_MICRO / 1_000_000} ALGO`
            }
          </span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${funded ? "bg-emerald-500" : "bg-zinc-600"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        {!funded && (
          <p className="text-xs text-zinc-600">Checking every 5 seconds…</p>
        )}
      </div>

      {error && (
        <p className="text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <button
        onClick={activate}
        disabled={!funded || activating}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-md transition-colors"
      >
        {activating
          ? "Activating on Algorand…"
          : funded
          ? "Activate Agent"
          : "Waiting for funds…"
        }
      </button>
    </div>
  );
}

// ── Step 4 — Success ───────────────────────────────────────────────────────

function Step4({ agentId, result }: { agentId: string; result: ActivateResponse }) {
  return (
    <div className="space-y-5 text-center">
      <div className="flex items-center justify-center w-14 h-14 mx-auto rounded-full bg-emerald-900/40 border border-emerald-800">
        <svg className="w-7 h-7 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Agent ready</h2>
        <p className="text-sm text-zinc-400">
          <span className="text-zinc-200 font-mono">{agentId}</span> is opted into USDC and
          registered. Send USDC to the address to start making payments.
        </p>
      </div>

      <div className="bg-zinc-800/60 border border-zinc-700 rounded-md p-4 text-left space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">Agent ID</span>
          <span className="font-mono text-zinc-200 text-xs">{result.agentId}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">Address</span>
          <span className="font-mono text-zinc-200 text-xs">{result.address.slice(0, 10)}…{result.address.slice(-8)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">Txn</span>
          <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer"
            className="font-mono text-emerald-400 text-xs hover:underline">
            {result.registrationTxnId.slice(0, 10)}…
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Link
          href={`/app/login?agentId=${encodeURIComponent(agentId)}`}
          className="block w-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium py-2.5 rounded-md transition-colors text-center"
        >
          Go to Dashboard →
        </Link>
        <Link
          href="/app/create"
          className="block w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm py-2.5 rounded-md transition-colors text-center"
        >
          Create another agent
        </Link>
      </div>
    </div>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`h-1.5 rounded-full transition-all ${
          i + 1 === current ? "w-6 bg-emerald-400"
          : i + 1 < current  ? "w-2 bg-emerald-700"
          : "w-2 bg-zinc-700"
        }`} />
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function CreateAgentPage() {
  const [step, setStep]         = useState(1);
  const [agentId, setAgentId]   = useState("");
  const [keypair, setKeypair]   = useState<KeypairResponse | null>(null);
  const [activated, setActivated] = useState<ActivateResponse | null>(null);
  const [genError, setGenError] = useState("");
  const [generating, setGenerating] = useState(false);

  async function handleStep1(id: string) {
    setAgentId(id);
    setGenError("");
    setGenerating(true);
    try {
      const res  = await fetch("/api/agents/create", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ agentId: id }),
      });
      const data = await res.json() as KeypairResponse & { error?: string };
      if (!res.ok) { setGenError(data.error ?? `Failed (${res.status})`); return; }
      setKeypair(data);
      setStep(2);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Network error — please try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between mb-8">
          <Link href="/app/login" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
            ← Back
          </Link>
          <StepDots current={step} total={4} />
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl">
          {step === 1 && (
            <>
              {generating
                ? <div className="flex items-center justify-center gap-3 py-10">
                    <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
                    <span className="text-sm text-zinc-400">Generating keypair…</span>
                  </div>
                : <Step1 onNext={handleStep1} />
              }
              {genError && (
                <p className="mt-4 text-red-400 text-sm bg-red-900/20 border border-red-800/50 rounded-md px-3 py-2">
                  {genError}
                </p>
              )}
            </>
          )}

          {step === 2 && keypair && (
            <Step2 agentId={agentId} keypair={keypair} onNext={() => setStep(3)} />
          )}

          {step === 3 && keypair && (
            <Step3
              agentId={agentId}
              keypair={keypair}
              onActivated={(r) => { setActivated(r); setStep(4); }}
            />
          )}

          {step === 4 && activated && (
            <Step4 agentId={agentId} result={activated} />
          )}
        </div>

        <p className="text-center text-xs text-zinc-600 mt-6">
          Already have an agent?{" "}
          <Link href="/app/login" className="text-zinc-400 hover:text-zinc-300 underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
