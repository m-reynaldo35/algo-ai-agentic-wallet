import Link from "next/link";

// ── Code snippet shown in the developer quickstart section ─────────────────

const SDK_SNIPPET = `import { AlgoAgentClient } from "@algo-wallet/x402-client";
import algosdk from "algosdk";

const account = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC!);

const client = new AlgoAgentClient({
  baseUrl:    "https://api.ai-agentic-wallet.com",
  privateKey: account.sk,
});

// Autonomous payment — zero human input
const result = await client.executeTrade({
  senderAddress: agentAddress,
  amount:        1_000_000,   // 1.00 USDC
});`;

// ── MCP snippet shown in native integration section ────────────────────────

const MCP_CONFIG = `// claude_desktop_config.json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "@algo-wallet/x402-mcp"],
      "env": {
        "ALGO_MNEMONIC":  "your 25-word agent mnemonic",
        "X402_AGENT_ID":  "your-agent-id",
        "X402_API_URL":   "https://api.ai-agentic-wallet.com"
      }
    }
  }
}`;

// ── Static data ────────────────────────────────────────────────────────────

const HOW_IT_WORKS = [
  {
    step: "1",
    title: "Create your agent wallet",
    body:  "Generate a fresh Algorand keypair in seconds. Save the mnemonic — the server discards it immediately.",
  },
  {
    step: "2",
    title: "Fund with USDC",
    body:  "Send USDC to your agent's address from any Algorand wallet. The agent is automatically opted in and registered on-chain.",
  },
  {
    step: "3",
    title: "Agent pays autonomously",
    body:  "Your code calls the SDK. The x402 handshake, signing, and on-chain settlement happen in milliseconds — no human approval.",
  },
];

const USE_CASES = [
  { icon: "📈", label: "Trading bots",          desc: "Execute autonomous USDC micropayments on Algorand." },
  { icon: "🔍", label: "Data agents",            desc: "Pay-per-query for premium data feeds and APIs." },
  { icon: "🔗", label: "API consumers",          desc: "Machine-to-machine USDC micropayments without card rails or gas." },
  { icon: "🤖", label: "Multi-agent pipelines",  desc: "Agents paying agents — composable payment flows across AI systems." },
];

// ── Components ─────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-6xl mx-auto w-full">
      <span className="font-semibold text-white tracking-tight">algo-wallet</span>
      <div className="flex items-center gap-4 text-sm">
        <a href="/docs" className="text-zinc-400 hover:text-white transition-colors">Docs</a>
        <Link href="/app/login" className="text-zinc-400 hover:text-white transition-colors">Sign in</Link>
        <Link
          href="/app/create"
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-md transition-colors font-medium"
        >
          Get started
        </Link>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="text-center py-20 px-6 max-w-3xl mx-auto">
      <div className="inline-flex items-center gap-2 bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 text-xs px-3 py-1 rounded-full mb-8">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Live on Algorand mainnet
      </div>

      <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">
        Autonomous AI Agents<br />
        <span className="text-emerald-400">That Pay</span>
      </h1>

      <p className="text-zinc-400 text-lg leading-relaxed mb-10 max-w-xl mx-auto">
        Give your AI agent a USDC wallet. Let it pay for APIs, data feeds, and
        on-chain services — machine-to-machine, zero human approval.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/app/create"
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3 rounded-lg transition-colors text-sm"
        >
          Create Your Agent →
        </Link>
        <a
          href="/docs"
          className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium px-6 py-3 rounded-lg transition-colors text-sm border border-zinc-700"
        >
          Read the docs
        </a>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="py-16 px-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-white text-center mb-12">How it works</h2>
      <div className="grid sm:grid-cols-3 gap-6">
        {HOW_IT_WORKS.map(({ step, title, body }) => (
          <div key={step} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="w-8 h-8 rounded-full bg-emerald-900/60 border border-emerald-800 flex items-center justify-center text-emerald-400 text-sm font-bold mb-4">
              {step}
            </div>
            <h3 className="text-white font-semibold mb-2">{title}</h3>
            <p className="text-zinc-400 text-sm leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section className="py-16 px-6 max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-white text-center mb-12">Built for AI agents</h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {USE_CASES.map(({ icon, label, desc }) => (
          <div key={label} className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
            <div className="text-2xl mb-3">{icon}</div>
            <h3 className="text-white font-semibold text-sm mb-1">{label}</h3>
            <p className="text-zinc-500 text-xs leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section className="py-16 px-6 max-w-5xl mx-auto">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 sm:p-12 text-center">
        <h2 className="text-2xl font-bold text-white mb-3">Simple pricing</h2>
        <p className="text-zinc-400 text-sm mb-8">No subscriptions. No monthly fees. Pay only when your agent pays.</p>
        <div className="inline-flex flex-col items-center">
          <div className="flex items-end gap-1.5 mb-2">
            <span className="text-5xl font-bold text-white">$0.01</span>
            <span className="text-zinc-400 text-lg mb-2">USDC</span>
          </div>
          <span className="text-zinc-500 text-sm">per transaction (x402 toll)</span>
        </div>

        <div className="mt-8 grid sm:grid-cols-3 gap-4 text-left">
          {[
            ["No gas fees",        "We handle Algorand fees from the signing infrastructure."],
            ["No chargebacks",     "On-chain settlement is final. No dispute risk."],
            ["No card rails",      "Direct USDC. Works anywhere in the world, instantly."],
          ].map(([label, desc]) => (
            <div key={label} className="flex gap-3">
              <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div>
                <p className="text-white text-sm font-medium">{label}</p>
                <p className="text-zinc-500 text-xs mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DeveloperQuickstart() {
  return (
    <section className="py-16 px-6 max-w-5xl mx-auto">
      <div className="grid lg:grid-cols-2 gap-10 items-start">
        <div>
          <h2 className="text-2xl font-bold text-white mb-4">SDK quickstart</h2>
          <p className="text-zinc-400 text-sm leading-relaxed mb-6">
            Install the SDK, hand your agent its keypair, and let it pay. The x402
            handshake, Algorand signing, and on-chain confirmation happen inside the client.
          </p>

          <div className="space-y-3 mb-8">
            <div className="flex items-start gap-3">
              <span className="text-emerald-400 font-mono text-xs mt-0.5">npm</span>
              <code className="text-zinc-300 text-xs font-mono bg-zinc-800 px-2 py-1 rounded">
                npm install @algo-wallet/x402-client
              </code>
            </div>
          </div>

          <Link
            href="/app/create"
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            Create Your Agent →
          </Link>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <span className="ml-2 text-zinc-500 text-xs font-mono">agent.ts</span>
          </div>
          <pre className="p-5 text-xs font-mono text-zinc-300 leading-relaxed overflow-x-auto">
            <code>{SDK_SNIPPET}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}


function NativeIntegrations() {
  return (
    <section className="py-16 px-6 max-w-5xl mx-auto">
      <div className="grid lg:grid-cols-2 gap-10 items-start">
        <div>
          <div className="inline-flex items-center gap-2 bg-violet-950/60 border border-violet-800/50 text-violet-400 text-xs px-3 py-1 rounded-full mb-6">
            Native Claude integration
          </div>
          <h2 className="text-2xl font-bold text-white mb-4">Built for Claude agents</h2>
          <p className="text-zinc-400 text-sm leading-relaxed mb-6">
            The official MCP server lets Claude Desktop and Claude Code agents pay for API calls,
            data feeds, and on-chain services without writing a single line of payment code.
            Add it to Claude Desktop in under two minutes.
          </p>
          <div className="space-y-3 mb-8">
            <div className="flex items-start gap-3">
              <span className="text-violet-400 font-mono text-xs mt-0.5">npx</span>
              <code className="text-zinc-300 text-xs font-mono bg-zinc-800 px-2 py-1 rounded">
                npx @algo-wallet/x402-mcp
              </code>
            </div>
          </div>
          <a
            href="/docs"
            className="inline-flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            MCP setup guide →
          </a>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <div className="w-3 h-3 rounded-full bg-zinc-700" />
            <span className="ml-2 text-zinc-500 text-xs font-mono">claude_desktop_config.json</span>
          </div>
          <pre className="p-5 text-xs font-mono text-zinc-300 leading-relaxed overflow-x-auto">
            <code>{MCP_CONFIG}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800/60 py-10 px-6 mt-8">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-600">
        <span>© 2025 algo-wallet. Built on Algorand.</span>
        <div className="flex items-center gap-6">
          <a href="/docs" className="hover:text-zinc-400 transition-colors">Documentation</a>
          <Link href="/privacy" className="hover:text-zinc-400 transition-colors">Privacy</Link>
          <Link href="/terms" className="hover:text-zinc-400 transition-colors">Terms</Link>
          <Link href="/app/login" className="hover:text-zinc-400 transition-colors">Customer login</Link>
          <Link href="/login" className="hover:text-zinc-400 transition-colors">Admin</Link>
        </div>
      </div>
    </footer>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export const metadata = {
  title: "algo-wallet — Autonomous AI Agents That Pay",
  description:
    "Give your AI agent a USDC wallet on Algorand. Machine-to-machine payments via the x402 protocol — no human approval required.",
};

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <Nav />
      <Hero />
      <HowItWorks />
      <UseCases />
      <Pricing />
      <DeveloperQuickstart />
      <NativeIntegrations />
      <Footer />
    </div>
  );
}
