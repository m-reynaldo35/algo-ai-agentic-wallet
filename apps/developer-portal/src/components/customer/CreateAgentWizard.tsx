"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import QRCode from "qrcode";

const NETWORK        = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID  = NETWORK === "mainnet" ? 31566704 : 10458941;
const MIN_ALGO_MICRO = 500_000;

// ── Types ──────────────────────────────────────────────────────────────────

interface CreateResponse {
  agentId:  string;
  address:  string;
  mnemonic: string;
  warning?: string;
}

interface Balance { microAlgo: number; microUsdc: number; }

interface Props {
  ownerAddress?: string;
  onClose:   () => void;
  onCreated: () => void;
}

// ── Step dots ──────────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`h-1 rounded-full transition-all ${
          i + 1 === current ? "w-5 bg-emerald-400"
          : i + 1 < current  ? "w-2 bg-emerald-700"
          : "w-2 bg-zinc-700"
        }`} />
      ))}
    </div>
  );
}

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
    <div className="space-y-5">
      {/* Two-wallet explainer */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-3.5 space-y-2.5">
        <p className="text-xs text-zinc-400 font-medium">How this works</p>
        <div className="flex items-start gap-2.5">
          <span className="w-5 h-5 rounded bg-violet-900/50 border border-violet-700 flex items-center justify-center text-violet-400 text-xs font-bold shrink-0 mt-0.5">P</span>
          <p className="text-xs text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Your Pera wallet</span> — identity &amp; governance. Signs you in, approves spending limits.
          </p>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="w-5 h-5 rounded bg-emerald-900/50 border border-emerald-700 flex items-center justify-center text-emerald-400 text-xs font-bold shrink-0 mt-0.5">A</span>
          <p className="text-xs text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Your agent wallet</span> — separate address where your AI&apos;s USDC lives. Pays autonomously within your limits.
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-white mb-1">Name your agent</h2>
        <p className="text-sm text-zinc-400">Choose a unique ID for this agent.</p>
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
          {loading ? "Creating…" : "Create Agent"}
        </button>
      </form>
    </div>
  );
}

// ── Step 2 — Save signing key ──────────────────────────────────────────────

function Step2({
  agentId,
  mnemonic,
  onNext,
}: {
  agentId:  string;
  mnemonic: string;
  onNext:   () => void;
}) {
  const [copied, setCopied]       = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function copy() {
    navigator.clipboard.writeText(mnemonic).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-white mb-1">Save your agent&apos;s signing key</h2>
        <p className="text-sm text-zinc-400">
          This is the signing key for <span className="font-mono text-zinc-200">{agentId}</span>.
          Your AI application uses it to authorise x402 payments.
        </p>
      </div>

      <div className="flex items-start gap-2.5 bg-amber-900/30 border border-amber-700/50 rounded-md p-3">
        <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <p className="text-amber-400 text-xs leading-relaxed">
          Copy this into your app&apos;s <code className="font-mono">.env</code> file as{" "}
          <code className="font-mono">ALGO_MNEMONIC=&quot;...&quot;</code>. The server discards it immediately — this is the only time you&apos;ll see it.
        </p>
      </div>

      <div className="relative bg-zinc-800 border border-zinc-700 rounded-md p-4">
        <p className="font-mono text-xs text-zinc-200 leading-relaxed break-words select-all">
          {mnemonic}
        </p>
        <button
          onClick={copy}
          className="absolute top-3 right-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-400 transition-colors"
        >
          {copied
            ? <><svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-emerald-400">Copied</span></>
            : <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy</>
          }
        </button>
      </div>

      <div className="bg-zinc-800/40 border border-zinc-700/60 rounded-md px-3 py-2">
        <code className="text-xs text-zinc-400 font-mono">ALGO_MNEMONIC=&quot;{mnemonic.slice(0, 18)}…&quot;</code>
      </div>

      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/30"
        />
        <span className="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">
          I&apos;ve saved the signing key for my application.
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

// ── Step 3 — Fund agent: Phase 1 = ALGO, Phase 2 = USDC ──────────────────

function Step3({
  agentId,
  address,
  onDone,
}: {
  agentId:  string;
  address:  string;
  onDone:   () => void;
}) {
  const canvasRef               = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied]     = useState(false);
  const [balance, setBalance]   = useState<Balance | null>(null);
  const [activated, setActivated] = useState(false);
  const [checking, setChecking] = useState(false);

  // Phase: "algo" until activated, then "usdc"
  const phase   = activated ? "usdc" : "algo";
  const activeUri = phase === "algo"
    ? `algorand://${address}?amount=${MIN_ALGO_MICRO}`
    : `algorand://${address}?asset=${USDC_ASSET_ID}`;
  const truncated = `${address.slice(0, 10)}…${address.slice(-8)}`;
  const algoFunded   = (balance?.microAlgo ?? 0) >= MIN_ALGO_MICRO;
  const algoProgress = Math.min(100, Math.round(((balance?.microAlgo ?? 0) / MIN_ALGO_MICRO) * 100));

  // Re-render QR whenever the URI changes (phase switch or address)
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, activeUri, {
        width: 160, margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  }, [activeUri]);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch(`/api/customer/balance/${address}`);
      if (res.ok) setBalance(await res.json() as Balance);
    } catch { /* silent */ }
  }, [address]);

  const checkActivated = useCallback(async () => {
    if (checking || activated) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`);
      if (res.ok) setActivated(true);
    } catch { /* silent */ }
    setChecking(false);
  }, [agentId, activated, checking]);

  useEffect(() => {
    fetchBalance();
    checkActivated();
    const balId = setInterval(fetchBalance,   5_000);
    const actId = setInterval(checkActivated, 5_000);
    return () => { clearInterval(balId); clearInterval(actId); };
  }, [fetchBalance, checkActivated]);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-4">

      {/* Phase indicator */}
      <div className="flex items-center gap-3">
        <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
          activated
            ? "bg-emerald-900/30 border-emerald-700/50 text-emerald-400"
            : "bg-zinc-800 border-zinc-700 text-white"
        }`}>
          {activated
            ? <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg> ALGO sent</>
            : "1 — Send ALGO"
          }
        </div>
        <svg className="w-3 h-3 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
          activated
            ? "bg-zinc-800 border-zinc-700 text-white"
            : "border-zinc-800 text-zinc-600"
        }`}>
          2 — Deposit USDC
        </div>
      </div>

      {/* Heading */}
      <div>
        {activated ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-emerald-400 text-xs font-medium">{agentId} is active — opted into USDC</span>
            </div>
            <h2 className="text-base font-semibold text-white mb-1">Deposit USDC</h2>
            <p className="text-sm text-zinc-400">
              Your agent is ready to receive USDC. Deposit any amount to start spending.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-white mb-1">Send ALGO to activate</h2>
            <p className="text-sm text-zinc-400">
              Send at least <span className="text-white font-medium">0.5 ALGO</span> to your agent&apos;s address.
              This activates the wallet and opts it into USDC automatically.
            </p>
          </>
        )}
      </div>

      {/* Single QR — switches URI on activation */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-4 flex gap-4 items-center">
        <div className="bg-white rounded-lg p-1.5 shrink-0">
          <canvas key={phase} ref={canvasRef} style={{ width: 160, height: 160, display: "block" }} />
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <p className="text-xs text-zinc-500 mb-1">{activated ? "Deposit USDC to" : "Send ALGO to"}</p>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-200 text-xs truncate">{truncated}</span>
              <button onClick={copyAddress} className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors">
                {copied
                  ? <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                }
              </button>
            </div>
          </div>

          <a
            href={activeUri}
            className="flex items-center justify-center gap-1.5 w-full px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-lg transition-colors font-medium"
          >
            Open in Pera
          </a>

          {/* ALGO progress bar (phase 1 only) */}
          {!activated && (
            <div className="space-y-1">
              <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${algoFunded ? "bg-emerald-500" : "bg-zinc-500"}`}
                  style={{ width: `${algoProgress}%` }}
                />
              </div>
              <p className="text-xs text-zinc-600">
                {balance === null ? "Checking balance…" : `${(balance.microAlgo / 1_000_000).toFixed(3)} / 0.5 ALGO received`}
              </p>
            </div>
          )}

          {/* USDC balance (phase 2) */}
          {activated && (
            <p className="text-xs text-zinc-500">
              {balance !== null && balance.microUsdc > 0
                ? `${(balance.microUsdc / 1_000_000).toFixed(2)} USDC deposited`
                : "No USDC yet — deposit any amount"
              }
            </p>
          )}
        </div>
      </div>

      <button
        onClick={onDone}
        disabled={!activated}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-md transition-colors"
      >
        {activated ? "Go to dashboard →" : "Waiting for ALGO deposit…"}
      </button>

      {activated && (
        <p className="text-center text-xs text-zinc-500">
          You can top up USDC any time from your dashboard.
        </p>
      )}
    </div>
  );
}

// ── Modal shell ────────────────────────────────────────────────────────────

export default function CreateAgentWizard({ ownerAddress, onClose, onCreated }: Props) {
  const [step, setStep]             = useState(1);
  const [agentId, setAgentId]       = useState("");
  const [createData, setCreateData] = useState<CreateResponse | null>(null);
  const [genError, setGenError]     = useState("");
  const [generating, setGenerating] = useState(false);

  const totalSteps = 3;

  function handleClose() {
    const msg = step >= 3
      ? "Your agent is already active on-chain. Exit anyway?"
      : "Are you sure you want to cancel? Your agent will remain pending until you fund it.";
    if (window.confirm(msg)) {
      onClose();
    }
  }

  async function handleStep1(id: string) {
    setAgentId(id);
    setGenError("");
    setGenerating(true);
    try {
      const res  = await fetch("/api/agents/create", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          agentId: id,
          ownerAddress,
          ...(ownerAddress ? { ownerWalletId: ownerAddress } : {}),
        }),
      });
      const data = await res.json() as CreateResponse & { error?: string };
      if (!res.ok) { setGenError(data.error ?? `Failed (${res.status})`); setGenerating(false); return; }
      setCreateData(data);
      setStep(2);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Network error — please retry.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-0">
          <StepDots current={step} total={totalSteps} />
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-red-900/30 hover:bg-red-900/60 text-red-400 hover:text-red-300 transition-colors"
            title="Cancel wizard"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 pt-4">
          {step === 1 && (
            <>
              {generating
                ? <div className="flex items-center justify-center gap-3 py-10">
                    <div className="w-5 h-5 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
                    <span className="text-sm text-zinc-400">Creating agent…</span>
                  </div>
                : <Step1 onNext={handleStep1} />
              }
              {genError && (
                <p className="mt-4 text-red-400 text-xs bg-red-900/20 border border-red-800/50 rounded-md px-3 py-2">
                  {genError}
                </p>
              )}
            </>
          )}

          {step === 2 && createData && (
            <Step2
              agentId={agentId}
              mnemonic={createData.mnemonic}
              onNext={() => setStep(3)}
            />
          )}

          {step === 3 && createData && (
            <Step3
              agentId={agentId}
              address={createData.address}
              onDone={() => onCreated()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
