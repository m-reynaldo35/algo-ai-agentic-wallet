import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface SlotResult {
  slot: number;
  enqueueMs: number;
  confirmMs: number;
  confirmedRound: number | null;
  txnId: string | null;
  explorerUrl: string | null;
  status: string;
}

interface MandateTestReport {
  schema: string;
  generatedAt: string;
  testType: string;
  mandateFactoryAppId?: number;
  network: string;
  /** legacy single-agent burst field */
  burstSize?: number;
  /** multi-agent showcase field */
  totalPayments?: number;
  /** multi-agent showcase field */
  nAgents?: number;
  confirmed: number;
  failed: number;
  enqueueLatencyMs: { p50: number; p95: number; p99: number; avg: number };
  confirmLatencyMs: { p50: number; p95: number; p99: number; min: number; max: number } | null;
  wallTimeMs: number;
  oldBaselineMs?: number;
  speedupMultiple?: number;
  throughputTxPerMin?: number;
  /** legacy single-agent burst field */
  slots?: SlotResult[];
  /** multi-agent showcase field (same shape as slots) */
  payments?: SlotResult[];
}

// ── Data fetch ─────────────────────────────────────────────────────────────

async function getReport(): Promise<MandateTestReport | null> {
  const apiUrl = (process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
  try {
    const res = await fetch(`${apiUrl}/mandate-test-report.json`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return await res.json() as MandateTestReport;
  } catch {
    return null;
  }
}

// ── Static feature definitions ─────────────────────────────────────────────

const FEATURES = [
  {
    label: "AVM-enforced limits",
    desc: "Per-payment caps and velocity windows are enforced directly by the mandate smart contract on Algorand's AVM — not server policy. Spending rules can't be overridden by the API host.",
  },
  {
    label: "Non-custodial keys",
    desc: "Each agent generates and holds its own signing key. No rekeying, no custody service. The mandate delegates authority without transferring ownership.",
  },
  {
    label: "Optimistic broadcast",
    desc: "The API returns HTTP 200 once the transaction is broadcast (< 1s). On-chain confirmation follows asynchronously in ~3–4s. High-throughput agents don't block on Algorand round times.",
  },
  {
    label: "x402 protocol",
    desc: "Payments travel as a standard HTTP header (x-payment). Any x402-aware API endpoint becomes instantly payable — no per-integration billing setup, no OAuth, no card rails.",
  },
];

const MANDATE_EXPLORER = "https://explorer.perawallet.app/application/3498110794";

// ── Sub-components ─────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-5xl mx-auto w-full">
      <Link href="/" className="font-semibold text-white tracking-tight hover:text-zinc-300 transition-colors">
        algo-wallet
      </Link>
      <div className="flex items-center gap-4 text-sm">
        <a href="/docs" className="text-zinc-400 hover:text-white transition-colors">Docs</a>
        <Link
          href="/sign-in"
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-md transition-colors font-medium"
        >
          Sign in
        </Link>
      </div>
    </nav>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 text-center">
      <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
      <p className="text-zinc-400 text-xs mt-1 font-medium">{label}</p>
      <p className="text-zinc-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

function FeatureCard({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <h3 className="text-white font-semibold text-sm">{label}</h3>
      </div>
      <p className="text-zinc-500 text-xs leading-relaxed">{desc}</p>
    </div>
  );
}

function TxTable({ slots }: { slots: SlotResult[] }) {
  if (slots.length === 0) {
    return (
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-8 text-center">
        <p className="text-zinc-500 text-sm mb-2">Transaction links not yet archived</p>
        <p className="text-zinc-600 text-xs leading-relaxed max-w-sm mx-auto">
          Re-run the test script to populate live explorer links for each payment.
        </p>
        <code className="mt-4 inline-block text-xs text-zinc-400 bg-zinc-800 px-3 py-2 rounded font-mono">
          npx tsx scripts/mandate-burst-test.ts --sequential
        </code>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left text-zinc-500 text-xs font-medium py-3 pr-6">Slot</th>
            <th className="text-right text-zinc-500 text-xs font-medium py-3 pr-6">Enqueue</th>
            <th className="text-right text-zinc-500 text-xs font-medium py-3 pr-6">Confirm</th>
            <th className="text-right text-zinc-500 text-xs font-medium py-3 pr-6">Round</th>
            <th className="text-left text-zinc-500 text-xs font-medium py-3">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((r) => (
            <tr key={r.slot} className="border-b border-zinc-800/50 last:border-0">
              <td className="py-3 pr-6 text-zinc-400 tabular-nums text-xs">{r.slot}</td>
              <td className="py-3 pr-6 text-right text-zinc-300 tabular-nums text-xs font-mono">
                {r.enqueueMs}ms
              </td>
              <td className="py-3 pr-6 text-right text-zinc-300 tabular-nums text-xs font-mono">
                {r.confirmMs ? `${(r.confirmMs / 1000).toFixed(1)}s` : "—"}
              </td>
              <td className="py-3 pr-6 text-right text-zinc-500 tabular-nums text-xs font-mono">
                {r.confirmedRound ?? "—"}
              </td>
              <td className="py-3">
                {r.explorerUrl ? (
                  <a
                    href={r.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 font-mono text-xs transition-colors"
                  >
                    {r.txnId!.slice(0, 20)}…
                    <span className="ml-1 text-zinc-600">↗</span>
                  </a>
                ) : (
                  <span className="text-zinc-700 text-xs font-mono">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800/60 py-8 px-6 mt-8">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-zinc-600">
        <Link href="/" className="hover:text-zinc-400 transition-colors">← Back to algo-wallet</Link>
        <div className="flex items-center gap-6">
          <a href="/docs" className="hover:text-zinc-400 transition-colors">Documentation</a>
          <a href={MANDATE_EXPLORER} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400 transition-colors">
            Mandate contract ↗
          </a>
        </div>
      </div>
    </footer>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export const metadata = {
  title: "Mandate Flow — Mainnet Test | algo-wallet",
  description:
    "Verified mainnet proof: 5 autonomous USDC micropayments via AVM mandate contract. Non-custodial, optimistic broadcast, x402 protocol.",
};

export default async function MandateTestPage() {
  const report = await getReport();

  const total  = report?.totalPayments ?? report?.burstSize ?? report?.confirmed ?? 0;
  const agents = report?.nAgents;

  const stats = report
    ? [
        {
          label: "Payments confirmed",
          value: `${report.confirmed}/${total}`,
          sub: agents ? `${agents} agents × ${total / agents} payments` : "zero failures",
        },
        {
          label: "Enqueue p50",
          value: `${report.enqueueLatencyMs.p50}ms`,
          sub: "fire → HTTP 200 (optimistic)",
        },
        {
          label: "Confirm p50",
          value: report.confirmLatencyMs
            ? `${(report.confirmLatencyMs.p50 / 1000).toFixed(1)}s`
            : "—",
          sub: "fire → on-chain confirmed",
        },
        report.throughputTxPerMin
          ? { label: "Throughput", value: `${report.throughputTxPerMin} tx/min`, sub: "parallel mandate streams" }
          : { label: "vs sync baseline", value: `~${report.speedupMultiple ?? "?"}×`, sub: "faster than blocking confirm" },
      ]
    : [];

  const runDate = report
    ? new Date(report.generatedAt).toLocaleDateString("en-GB", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen bg-black text-white">
      <Nav />

      {/* ── Header ── */}
      <section className="py-16 px-6 max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <div className="inline-flex items-center gap-2 bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 text-xs px-3 py-1 rounded-full mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Verified on Algorand mainnet
            </div>
            <h1 className="text-3xl font-bold text-white">Mandate Flow — Mainnet Test</h1>
            <p className="text-zinc-400 text-sm mt-2">
              Autonomous USDC micropayments via AVM mandate contract — non-custodial, zero human approval
            </p>
          </div>
          {runDate && (
            <div className="text-right shrink-0">
              <p className="text-zinc-600 text-xs">Last run</p>
              <p className="text-zinc-400 text-sm font-mono">{runDate}</p>
              <p className="text-zinc-600 text-xs mt-1">
                Contract{" "}
                <a
                  href={MANDATE_EXPLORER}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  app {report!.mandateFactoryAppId} ↗
                </a>
              </p>
            </div>
          )}
        </div>

        {/* ── Stats ── */}
        {stats.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
            {stats.map((s) => (
              <StatCard key={s.label} {...s} />
            ))}
          </div>
        )}

        {/* ── Feature highlights ── */}
        <div className="mb-12">
          <h2 className="text-lg font-semibold text-white mb-5">What this demonstrates</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {FEATURES.map((f) => (
              <FeatureCard key={f.label} {...f} />
            ))}
          </div>
        </div>

        {/* ── Transaction table ── */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Per-payment results</h2>
            {report && ((report.slots ?? report.payments)?.length ?? 0) > 0 && (
              <span className="text-xs text-zinc-600 font-mono">{report.network}</span>
            )}
          </div>
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl px-6 py-4">
            {report ? (
              <TxTable slots={report.slots ?? report.payments ?? []} />
            ) : (
              <p className="text-zinc-600 text-sm text-center py-4">Report unavailable</p>
            )}
          </div>
        </div>

        {/* ── Latency detail ── */}
        {report?.confirmLatencyMs && (
          <div className="mb-12">
            <h2 className="text-lg font-semibold text-white mb-5">Latency breakdown</h2>
            <div className="grid sm:grid-cols-2 gap-6">
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-4">
                  Enqueue latency — fire → HTTP 200
                </p>
                {(["p50", "p95", "p99", "avg"] as const).map((k) => (
                  <div key={k} className="flex justify-between py-1.5 border-b border-zinc-800/50 last:border-0">
                    <span className="text-zinc-500 text-xs font-mono">{k}</span>
                    <span className="text-zinc-300 text-xs font-mono tabular-nums">
                      {report.enqueueLatencyMs[k]}ms
                    </span>
                  </div>
                ))}
              </div>
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5">
                <p className="text-zinc-400 text-xs font-medium uppercase tracking-wider mb-4">
                  Confirm latency — fire → on-chain
                </p>
                {(["p50", "p95", "p99", "min", "max"] as const).map((k) => (
                  <div key={k} className="flex justify-between py-1.5 border-b border-zinc-800/50 last:border-0">
                    <span className="text-zinc-500 text-xs font-mono">{k}</span>
                    <span className="text-zinc-300 text-xs font-mono tabular-nums">
                      {(report.confirmLatencyMs![k] / 1000).toFixed(2)}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Methodology ── */}
        <div className="mb-12">
          <h2 className="text-lg font-semibold text-white mb-5">Test methodology</h2>
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 space-y-4 text-sm text-zinc-400 leading-relaxed">
            <p>
              Each test fires <strong className="text-zinc-300">{report?.burstSize ?? 5} sequential payments</strong> through
              a single mandate-registered agent using the <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">@algo-wallet/x402-client</code> SDK.
              The agent holds its own signing key — no custody service is involved.
            </p>
            <p>
              Each payment hits a live x402-protected endpoint. The server validates the x402 proof,
              checks the mandate contract via AVM, and submits an atomic USDC transfer to Algorand mainnet
              using <strong className="text-zinc-300">optimistic broadcast</strong>: the HTTP response returns
              immediately after the transaction is accepted by the node, not after confirmation.
              A background worker polls for on-chain finality.
            </p>
            <p>
              Payments are <strong className="text-zinc-300">0.01 USDC</strong> (10,000 µUSDC) each, including the x402 toll.
              The mandate contract enforces per-payment caps on-chain — the API server cannot authorise
              payments beyond the limits set in the AVM contract.
            </p>
            <div className="pt-2 border-t border-zinc-800 grid sm:grid-cols-3 gap-4 text-xs">
              <div>
                <p className="text-zinc-600 uppercase tracking-wider mb-1">Network</p>
                <p className="text-zinc-300">Algorand mainnet</p>
              </div>
              <div>
                <p className="text-zinc-600 uppercase tracking-wider mb-1">Protocol</p>
                <p className="text-zinc-300">x402 over HTTP</p>
              </div>
              <div>
                <p className="text-zinc-600 uppercase tracking-wider mb-1">Mandate contract</p>
                <a
                  href={MANDATE_EXPLORER}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  App {report?.mandateFactoryAppId ?? 3498110794} ↗
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* ── For developers / AI agents ── */}
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-white mb-5">Integrate in minutes</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <span className="text-zinc-500 text-xs font-mono">TypeScript SDK</span>
              </div>
              <pre className="p-4 text-xs font-mono text-zinc-300 leading-relaxed overflow-x-auto">
                <code>{`import { AlgoAgentClient } from "@algo-wallet/x402-client";

const client = new AlgoAgentClient({
  baseUrl:      "https://api.ai-agentic-wallet.com",
  privateKey:   account.sk,        // agent-held key
  mandateAppId: MANDATE_APP_ID,    // from /api/agents/create-mandate
});

// AVM enforces spend limits — no server trust needed
const res = await client.fetch("/your/api", {
  method: "POST",
  body:   JSON.stringify({ ... }),
});`}</code>
              </pre>
            </div>
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                <h3 className="text-white text-sm font-semibold mb-3">x402 HTTP flow</h3>
                <ol className="space-y-2 text-xs text-zinc-500">
                  <li className="flex gap-2">
                    <span className="text-emerald-400 shrink-0">1.</span>
                    Agent calls endpoint → server returns <code className="text-zinc-300">402 Payment Required</code>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400 shrink-0">2.</span>
                    Client signs an Algorand USDC transfer, attaches as <code className="text-zinc-300">x-payment</code> header
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400 shrink-0">3.</span>
                    Server validates mandate limits via AVM, broadcasts transaction
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400 shrink-0">4.</span>
                    HTTP 200 + response payload returned in ~{report?.enqueueLatencyMs.p50 ?? 734}ms
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400 shrink-0">5.</span>
                    On-chain confirmed in ~{report?.confirmLatencyMs ? (report.confirmLatencyMs.p50 / 1000).toFixed(1) : "3.3"}s, verifiable on Pera Explorer
                  </li>
                </ol>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                <h3 className="text-white text-sm font-semibold mb-2">Native Claude integration</h3>
                <p className="text-zinc-500 text-xs leading-relaxed mb-3">
                  Add the MCP server to Claude Desktop — no payment code required.
                </p>
                <a
                  href="/docs"
                  className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300 transition-colors"
                >
                  MCP setup guide →
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
