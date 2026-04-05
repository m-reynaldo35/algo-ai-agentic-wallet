"use client";

import Link from "next/link";
import { useState } from "react";

// ── Code snippets ──────────────────────────────────────────────────────────

const SNIPPETS = {
  express: `import express from "express";
import { x402express } from "@algo-wallet/x402-mcp/seller";

const app = express();

const TREASURY = "YOUR_ALGORAND_ADDRESS"; // USDC lands here

app.get(
  "/api/premium-data",
  x402express({ priceMicro: 1_000, payTo: TREASURY }),
  async (req, res) => {
    res.json({ data: "your valuable data here" });
  },
);

app.listen(3000);`,

  fastapi: `from fastapi import FastAPI
from algo_x402 import x402

app = FastAPI()

TREASURY = "YOUR_ALGORAND_ADDRESS"  # USDC lands here

@app.get("/api/premium-data")
@x402(price=1_000, pay_to=TREASURY)
async def premium_data():
    return {"data": "your valuable data here"}`,

  flask: `from flask import Flask, jsonify
from algo_x402 import x402_flask

app = Flask(__name__)

TREASURY = "YOUR_ALGORAND_ADDRESS"  # USDC lands here

@app.get("/api/premium-data")
@x402_flask(price=1_000, pay_to=TREASURY)
def premium_data():
    return jsonify({"data": "your valuable data here"})`,

  wellknown: `// /.well-known/x402  — lets the registry verify your endpoint
// Add this route alongside your x402 endpoints

app.get("/.well-known/x402", (_req, res) => {
  res.json({
    payment_methods: ["https://www.x402.org/"],
    network:         "algorand-mainnet",
    asset:           "USDC (ASA 31566704)",
    pay_to:          TREASURY,
  });
});`,
};

// ── Earnings calculator ────────────────────────────────────────────────────

function EarningsCalculator() {
  const [calls, setCalls]   = useState(1000);
  const [price, setPrice]   = useState(1000); // µUSDC

  const dailyUsdc    = (calls * price) / 1_000_000;
  const monthlyUsdc  = dailyUsdc * 30;
  const yearlyUsdc   = dailyUsdc * 365;

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-8">
      <h2 className="text-xl font-bold text-white mb-6">Earnings calculator</h2>

      <div className="grid sm:grid-cols-2 gap-6 mb-8">
        <div>
          <label className="block text-zinc-400 text-sm mb-2">
            Daily API calls
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={10}
              max={100_000}
              step={10}
              value={calls}
              onChange={(e) => setCalls(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
            />
            <span className="text-white font-mono text-sm w-20 text-right">
              {calls.toLocaleString()}
            </span>
          </div>
        </div>

        <div>
          <label className="block text-zinc-400 text-sm mb-2">
            Price per call
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={100}
              max={100_000}
              step={100}
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
            />
            <span className="text-white font-mono text-sm w-28 text-right">
              ${(price / 1_000_000).toFixed(4)}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Per day",  value: dailyUsdc },
          { label: "Per month", value: monthlyUsdc },
          { label: "Per year",  value: yearlyUsdc },
        ].map(({ label, value }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
            <div className="text-zinc-500 text-xs mb-1">{label}</div>
            <div className="text-emerald-400 font-bold text-lg font-mono">
              ${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(2)}
            </div>
            <div className="text-zinc-600 text-xs">USDC</div>
          </div>
        ))}
      </div>

      <p className="text-zinc-600 text-xs mt-4">
        No platform fees during beta. Payments go directly to your Algorand address.
        Settlement is on-chain — no invoicing, no chargebacks, no 30-day payment terms.
      </p>
    </div>
  );
}

// ── Code tab component ─────────────────────────────────────────────────────

const TABS = ["Node.js", "Python / FastAPI", "Python / Flask"] as const;
type Tab = (typeof TABS)[number];

function CodeBlock({ tab }: { tab: Tab }) {
  const [copied, setCopied] = useState(false);
  const code =
    tab === "Node.js" ? SNIPPETS["express"] :
    tab === "Python / FastAPI" ? SNIPPETS["fastapi"] :
    SNIPPETS["flask"];

  return (
    <div className="relative">
      <pre className="bg-black border border-zinc-800 rounded-b-xl rounded-tr-xl p-5 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed">
        {code}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-3 right-3 text-xs text-zinc-500 hover:text-white transition-colors"
      >
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}

function WellKnownBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-black border border-zinc-800 rounded-xl p-5 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed">
        {SNIPPETS["wellknown"]}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(SNIPPETS["wellknown"]).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-3 right-3 text-xs text-zinc-500 hover:text-white transition-colors"
      >
        {copied ? "✓" : "copy"}
      </button>
    </div>
  );
}

function ImplementationGuide() {
  const [activeTab, setActiveTab] = useState<Tab>("Node.js");

  return (
    <div>
      <div className="flex gap-1 mb-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`text-xs px-4 py-2 rounded-t-lg border border-b-0 transition-colors ${
              activeTab === tab
                ? "bg-black border-zinc-800 text-white"
                : "bg-zinc-900/50 border-zinc-800/50 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <CodeBlock tab={activeTab} />
    </div>
  );
}

// ── FAQ ────────────────────────────────────────────────────────────────────

const FAQ = [
  {
    q: "Do I need to know anything about Algorand or crypto?",
    a: "No. You need an Algorand address to receive USDC — create a free one at perawallet.app in two minutes. The SDK handles everything else: payment verification, transaction decoding, settlement confirmation.",
  },
  {
    q: "How does payment verification work?",
    a: "The agent sends a signed Algorand transaction in the X-PAYMENT header. The x402express middleware decodes it, verifies the amount matches your price, confirms the payTo address is yours, and submits it to the Algorand network. Your endpoint is called only after the transaction is accepted.",
  },
  {
    q: "What if an agent sends a bad or fake payment?",
    a: "The middleware rejects it before your handler runs. Invalid signature → 402. Wrong amount → 402. Wrong recipient → 402. Replay attack → 402. You never see invalid payments in your handler.",
  },
  {
    q: "When does USDC arrive in my wallet?",
    a: "Algorand blocks confirm in ~3.3 seconds. The USDC transfer is an inner transaction inside the agent's MandateContract.pay() call — it settles on-chain atomically with the payment proof.",
  },
  {
    q: "Can I set different prices for different endpoints?",
    a: "Yes. Pass a different priceMicro to each x402express() call. 1 USDC = 1,000,000 µUSDC. So 1,000 = $0.001, 10,000 = $0.01, 1,000,000 = $1.00.",
  },
  {
    q: "Do agents need to register with you to pay me?",
    a: "No. Any agent with an Algorand MandateContract can pay any x402 endpoint directly. The registry is optional — it makes your API discoverable to the Bazaar MCP aggregator, but payment works without it.",
  },
  {
    q: "Is there a platform fee?",
    a: "No platform fee during beta. Algorand transaction fees are ~$0.0001 per payment, paid by the buyer agent. USDC goes directly from the agent's MandateContract to your address.",
  },
];

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      {FAQ.map(({ q, a }, i) => (
        <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full text-left px-5 py-4 flex items-center justify-between gap-4"
          >
            <span className="text-sm text-white font-medium">{q}</span>
            <span className="text-zinc-500 shrink-0 text-lg leading-none">
              {open === i ? "−" : "+"}
            </span>
          </button>
          {open === i && (
            <div className="px-5 pb-5 text-zinc-400 text-sm leading-relaxed border-t border-zinc-800 pt-4">
              {a}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function SellPage() {
  return (
    <div className="min-h-screen bg-black text-white">

      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-6xl mx-auto">
        <Link href="/" className="font-semibold text-white tracking-tight">algo-wallet</Link>
        <div className="flex items-center gap-6 text-sm">
          <Link href="/registry" className="text-zinc-400 hover:text-white transition-colors">Registry</Link>
          <Link href="/docs" className="text-zinc-400 hover:text-white transition-colors">Docs</Link>
          <Link href="/app/login" className="bg-white text-black text-xs font-medium px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors">
            Dashboard →
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-16">

        {/* Hero */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 text-xs px-3 py-1 rounded-full mb-6">
            Sellers
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">
            Your API earns USDC<br className="hidden sm:block" />
            <span className="text-emerald-400"> every time an AI agent calls it</span>
          </h1>
          <p className="text-zinc-400 text-lg max-w-2xl mx-auto leading-relaxed mb-8">
            Add one middleware function. List in the registry. Collect USDC on Algorand — directly,
            instantly, with no invoicing, chargebacks, or 30-day payment terms.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="#setup"
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3 rounded-lg transition-colors text-sm"
            >
              Start collecting payments →
            </a>
            <Link
              href="/registry"
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Browse the registry
            </Link>
          </div>
        </div>

        {/* Why x402 */}
        <div className="grid sm:grid-cols-3 gap-4 mb-16">
          {[
            {
              icon: "⚡",
              title: "3.3s settlement",
              body: "Algorand blocks confirm in seconds. No waiting for bank transfers, no reconciliation lag.",
            },
            {
              icon: "🔒",
              title: "No chargebacks",
              body: "On-chain payments are final. The AVM verifies before your endpoint is called — bad payments never reach you.",
            },
            {
              icon: "🤖",
              title: "AI-native buyers",
              body: "Agents pay autonomously, within their mandate limits. No login, no OAuth, no API keys to manage.",
            },
          ].map(({ icon, title, body }) => (
            <div key={title} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <div className="text-2xl mb-3">{icon}</div>
              <h3 className="text-white font-semibold text-sm mb-2">{title}</h3>
              <p className="text-zinc-400 text-sm leading-relaxed">{body}</p>
            </div>
          ))}
        </div>

        {/* Earnings calculator */}
        <div className="mb-16">
          <EarningsCalculator />
        </div>

        {/* Setup steps */}
        <div id="setup" className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-2">3-step setup</h2>
          <p className="text-zinc-400 text-sm mb-10">
            From zero to collecting payments in under 10 minutes.
          </p>

          {/* Step 1 */}
          <div className="flex gap-5 mb-12">
            <div className="shrink-0 flex flex-col items-center">
              <div className="w-8 h-8 rounded-full bg-emerald-900/60 border border-emerald-800 flex items-center justify-center text-emerald-400 text-sm font-bold">
                1
              </div>
              <div className="w-px flex-1 bg-zinc-800 mt-2" />
            </div>
            <div className="flex-1 pb-12">
              <h3 className="text-white font-semibold mb-1">Install the SDK</h3>
              <p className="text-zinc-400 text-sm mb-4">One package covers Express, FastAPI, and Flask.</p>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <p className="text-zinc-500 text-xs mb-1 font-mono">Node.js</p>
                  <pre className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-xs font-mono text-zinc-300">
                    npm install @algo-wallet/x402-mcp
                  </pre>
                </div>
                <div className="flex-1">
                  <p className="text-zinc-500 text-xs mb-1 font-mono">Python</p>
                  <pre className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-xs font-mono text-zinc-300">
                    pip install algo-x402
                  </pre>
                </div>
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-5 mb-12">
            <div className="shrink-0 flex flex-col items-center">
              <div className="w-8 h-8 rounded-full bg-emerald-900/60 border border-emerald-800 flex items-center justify-center text-emerald-400 text-sm font-bold">
                2
              </div>
              <div className="w-px flex-1 bg-zinc-800 mt-2" />
            </div>
            <div className="flex-1 pb-12">
              <h3 className="text-white font-semibold mb-1">Add the paywall middleware</h3>
              <p className="text-zinc-400 text-sm mb-4">
                One function call gates your endpoint. Set <code className="text-zinc-300 bg-zinc-800 px-1 rounded text-xs">priceMicro</code> in µUSDC
                (1,000 = $0.001) and <code className="text-zinc-300 bg-zinc-800 px-1 rounded text-xs">payTo</code> to your Algorand address.
              </p>
              <ImplementationGuide />

              <div className="mt-6 bg-zinc-900/60 border border-zinc-700/50 rounded-xl px-4 py-3 flex gap-3">
                <span className="text-amber-400 text-sm shrink-0">💡</span>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  Need an Algorand address?{" "}
                  <a href="https://perawallet.app" target="_blank" rel="noreferrer" className="text-white underline">
                    Create a free one at perawallet.app
                  </a>{" "}
                  — takes two minutes. USDC will arrive there automatically after each paid call.
                </p>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-5">
            <div className="shrink-0">
              <div className="w-8 h-8 rounded-full bg-emerald-900/60 border border-emerald-800 flex items-center justify-center text-emerald-400 text-sm font-bold">
                3
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-white font-semibold mb-1">List in the registry</h3>
              <p className="text-zinc-400 text-sm mb-4">
                Add a <code className="text-zinc-300 bg-zinc-800 px-1 rounded text-xs">/.well-known/x402</code> route
                so the registry can verify your endpoint, then POST your listing.
                Once listed, AI agents using the Bazaar MCP will discover and pay for your API automatically.
              </p>

              <WellKnownBlock />

              <div className="mt-4">
                <pre className="bg-black border border-zinc-800 rounded-xl p-5 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed">
{`curl -X POST https://api.ai-agentic-wallet.com/api/registry/list \\
  -H "Content-Type: application/json" \\
  -H "X-Portal-Key: pk_live_YOUR_KEY" \\
  -d '{
    "name":        "my_premium_data",
    "description": "Description agents will use to decide when to call this",
    "endpoint":    "https://yourapi.com/api/premium-data",
    "price":       1000,
    "category":    "data",
    "payTo":       "YOUR_ALGORAND_ADDRESS"
  }'`}
                </pre>
                <p className="text-zinc-600 text-xs mt-2">
                  Don&apos;t have a portal key?{" "}
                  <Link href="/app/login" className="text-zinc-400 underline hover:text-white transition-colors">
                    Create a free account →
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-zinc-800 mb-16" />

        {/* How payment verification works */}
        <div className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-2">How payment verification works</h2>
          <p className="text-zinc-400 text-sm mb-8">
            No crypto knowledge required — the middleware handles all of this for you.
          </p>
          <div className="space-y-3">
            {[
              {
                step: "Agent calls your endpoint",
                detail: "No X-PAYMENT header → middleware returns 402 with payment terms (price, your address, network).",
                colour: "bg-zinc-800",
              },
              {
                step: "Agent signs the transaction",
                detail: "Agent builds a MandateContract.pay() Algorand app call, signs it locally. The private key never leaves the agent's machine.",
                colour: "bg-zinc-800",
              },
              {
                step: "Agent replays with X-PAYMENT header",
                detail: "Header contains base64(msgpack(SignedTransaction)). The middleware decodes and verifies it.",
                colour: "bg-zinc-800",
              },
              {
                step: "Middleware submits to Algorand",
                detail: "Valid payment → submitted to the network. Transaction confirmed in ~3.3s. USDC arrives in your address.",
                colour: "bg-emerald-900/40 border-emerald-800/50",
              },
              {
                step: "Your handler runs",
                detail: "Only after on-chain acceptance. Your response is returned to the agent. Payment is complete.",
                colour: "bg-emerald-900/40 border-emerald-800/50",
              },
            ].map(({ step, detail, colour }, i) => (
              <div key={i} className={`flex gap-4 ${colour} border border-zinc-800 rounded-xl px-5 py-4`}>
                <span className="text-zinc-500 text-sm font-mono shrink-0 w-5">{i + 1}.</span>
                <div>
                  <p className="text-white text-sm font-medium mb-0.5">{step}</p>
                  <p className="text-zinc-400 text-xs leading-relaxed">{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ */}
        <div className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-8">FAQ</h2>
          <FAQSection />
        </div>

        {/* Final CTA */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-8 sm:p-12 text-center">
          <h2 className="text-2xl font-bold text-white mb-3">Ready to start earning?</h2>
          <p className="text-zinc-400 text-sm max-w-md mx-auto mb-8">
            Install the SDK, add one middleware function, list in the registry.
            Your first paid agent call could happen today.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="#setup"
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3 rounded-lg transition-colors text-sm"
            >
              Follow the 3-step guide →
            </a>
            <a
              href="https://www.npmjs.com/package/@algo-wallet/x402-mcp"
              target="_blank"
              rel="noreferrer"
              className="text-zinc-400 hover:text-white border border-zinc-700 px-6 py-3 rounded-lg text-sm transition-colors"
            >
              View on npm →
            </a>
            <a
              href="https://pypi.org/project/algo-x402/"
              target="_blank"
              rel="noreferrer"
              className="text-zinc-400 hover:text-white border border-zinc-700 px-6 py-3 rounded-lg text-sm transition-colors"
            >
              View on PyPI →
            </a>
          </div>
        </div>

      </div>
    </div>
  );
}
