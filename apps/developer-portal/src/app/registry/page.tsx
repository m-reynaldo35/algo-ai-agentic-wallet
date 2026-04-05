"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface RegistryEntry {
  toolId:      string;
  name:        string;
  description: string;
  endpoint:    string;
  priceMicro:  number;
  category:    string;
  network:     string;
  payTo:       string;
  verified:    boolean;
  createdAt:   string;
}

const CATEGORIES = ["all", "data", "finance", "compute", "ai", "utility", "other"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_COLOURS: Record<string, string> = {
  data:    "bg-blue-950/60 text-blue-300 border-blue-800/50",
  finance: "bg-emerald-950/60 text-emerald-300 border-emerald-800/50",
  compute: "bg-purple-950/60 text-purple-300 border-purple-800/50",
  ai:      "bg-pink-950/60 text-pink-300 border-pink-800/50",
  utility: "bg-amber-950/60 text-amber-300 border-amber-800/50",
  other:   "bg-zinc-800/60 text-zinc-400 border-zinc-700/50",
};

const BAZAAR_SNIPPET = `// Claude Desktop config — x402 Bazaar
// Add this to claude_desktop_config.json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "npx",
      "args": ["-y", "@algo-wallet/x402-mcp", "bazaar"],
      "env": {
        "ALGO_MNEMONIC":          "word1 word2 ... word25",
        "MANDATE_APP_ID":         "YOUR_MANDATE_APP_ID",
        "X402_AGENT_ID":          "your-agent-id",
        "X402_PORTAL_KEY":        "pk_live_...",
        "MAX_PER_CALL_MICROUSDC": "10000"
      }
    }
  }
}`;

// ── Components ─────────────────────────────────────────────────────────────

function PriceTag({ micro }: { micro: number }) {
  const usd = (micro / 1_000_000).toFixed(micro < 1000 ? 6 : 4);
  return (
    <span className="font-mono text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-900/50 px-2 py-0.5 rounded">
      ${usd} USDC
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const colours = CATEGORY_COLOURS[category] ?? CATEGORY_COLOURS["other"]!;
  return (
    <span className={`text-xs border px-2 py-0.5 rounded-full ${colours}`}>
      {category}
    </span>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="text-xs text-emerald-400" title="/.well-known/x402 verified">✓ verified</span>
  ) : (
    <span className="text-xs text-zinc-500" title="Endpoint not yet verified">unverified</span>
  );
}

function ToolCard({ tool }: { tool: RegistryEntry }) {
  const [copied, setCopied] = useState(false);

  const copyEndpoint = () => {
    navigator.clipboard.writeText(tool.endpoint).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-3 hover:border-zinc-700 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h3 className="font-semibold text-white text-sm">{tool.name}</h3>
            <CategoryBadge category={tool.category} />
          </div>
          <p className="text-zinc-400 text-sm leading-relaxed">{tool.description}</p>
        </div>
        <PriceTag micro={tool.priceMicro} />
      </div>

      <div className="flex items-center gap-3 pt-1 border-t border-zinc-800">
        <code className="text-xs text-zinc-500 flex-1 truncate font-mono">{tool.endpoint}</code>
        <button
          onClick={copyEndpoint}
          className="text-xs text-zinc-400 hover:text-white transition-colors shrink-0"
        >
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-600">
        <VerifiedBadge verified={tool.verified} />
        <span>{tool.network}</span>
      </div>
    </div>
  );
}

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed">
        {code}
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-3 right-3 text-xs text-zinc-500 hover:text-white transition-colors"
      >
        {copied ? "✓" : "copy"}
      </button>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function RegistryPage() {
  const [tools, setTools]         = useState<RegistryEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [category, setCategory]   = useState<Category>("all");
  const [showSnippet, setShowSnippet] = useState(false);

  useEffect(() => {
    const url = category === "all"
      ? "/api/registry"
      : `/api/registry?category=${category}`;
    setLoading(true);
    setError(null);
    fetch(url)
      .then((r) => r.json() as Promise<{ tools?: RegistryEntry[]; error?: string }>)
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setTools(data.tools ?? []);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [category]);

  const verifiedCount = tools.filter((t) => t.verified).length;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-6xl mx-auto">
        <Link href="/" className="font-semibold text-white tracking-tight">algo-wallet</Link>
        <div className="flex items-center gap-6 text-sm">
          <Link href="/docs" className="text-zinc-400 hover:text-white transition-colors">Docs</Link>
          <Link href="/app/login" className="text-zinc-400 hover:text-white transition-colors">Dashboard</Link>
          <Link href="/get-started" className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors">
            Get started →
          </Link>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-14">

        {/* Header */}
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 bg-blue-950/60 border border-blue-800/50 text-blue-400 text-xs px-3 py-1 rounded-full mb-6">
            x402 API Marketplace
          </div>
          <div className="flex items-end justify-between gap-4 flex-wrap mb-4">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">API Registry</h1>
              <p className="text-zinc-400 max-w-xl">
                Every API listed here accepts x402 payments on Algorand. Your AI agent can call any
                of these endpoints autonomously — mandate limits enforce how much it spends.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={() => setShowSnippet((s) => !s)}
                className="text-sm bg-zinc-900 border border-zinc-700 hover:border-zinc-500 text-white px-4 py-2 rounded-lg transition-colors"
              >
                {showSnippet ? "Hide" : "Use"} Bazaar MCP
              </button>
              <Link
                href="/get-started"
                className="text-sm bg-white text-black font-medium px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors"
              >
                List your API →
              </Link>
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span>{tools.length} APIs listed</span>
            <span>·</span>
            <span>{verifiedCount} verified</span>
            <span>·</span>
            <span>Algorand mainnet</span>
          </div>
        </div>

        {/* Bazaar snippet */}
        {showSnippet && (
          <div className="mb-10 bg-zinc-950 border border-zinc-800 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-white mb-1">The Bazaar — one MCP, all APIs</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Add this server to Claude Desktop. Claude will automatically discover and pay for any listed
              API using your agent wallet. Mandate limits prevent overspending.
            </p>
            <CopyBlock code={BAZAAR_SNIPPET} />
          </div>
        )}

        {/* Category filter */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`text-sm px-4 py-1.5 rounded-full border transition-colors ${
                category === cat
                  ? "bg-white text-black border-white"
                  : "text-zinc-400 border-zinc-700 hover:border-zinc-500 hover:text-white"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Tool grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 h-36 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-20 text-zinc-500">
            <p className="text-sm">Could not load registry — {error}</p>
            <button
              onClick={() => setCategory(category)} // re-trigger effect
              className="mt-4 text-xs text-zinc-400 underline"
            >
              Retry
            </button>
          </div>
        ) : tools.length === 0 ? (
          <div className="text-center py-20 text-zinc-500">
            <p className="text-sm">No APIs listed in this category yet.</p>
            <Link href="/get-started" className="mt-3 block text-xs text-blue-400 hover:underline">
              Be the first to list one →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {tools.map((tool) => (
              <ToolCard key={tool.toolId} tool={tool} />
            ))}
          </div>
        )}

        {/* CTA — list your API */}
        <div className="mt-16 bg-zinc-950 border border-zinc-800 rounded-2xl p-8 text-center">
          <h2 className="text-xl font-bold text-white mb-2">Sell to AI agents</h2>
          <p className="text-zinc-400 text-sm max-w-md mx-auto mb-6">
            Your API earns USDC every time an AI agent calls it. Add three lines of middleware,
            list in the registry, and you&apos;re collecting payments from autonomous agents worldwide.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link
              href="/docs#seller"
              className="text-sm bg-white text-black font-medium px-5 py-2.5 rounded-lg hover:bg-zinc-100 transition-colors"
            >
              Seller quickstart →
            </Link>
            <a
              href="https://www.npmjs.com/package/@algo-wallet/x402-mcp"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-zinc-400 hover:text-white border border-zinc-700 px-5 py-2.5 rounded-lg transition-colors"
            >
              npm install →
            </a>
          </div>

          {/* Mini seller code snippet */}
          <div className="mt-6 text-left max-w-lg mx-auto">
            <pre className="bg-black border border-zinc-800 rounded-xl p-4 text-xs text-zinc-300 font-mono leading-relaxed overflow-x-auto">{
`import express from "express";
import { x402express } from "@algo-wallet/x402-mcp/seller";

const app = express();
app.get("/premium", x402express({ priceMicro: 1000, payTo: TREASURY }), handler);
// That's it. Agents pay, you earn USDC.`
            }</pre>
          </div>
        </div>

      </div>
    </div>
  );
}
