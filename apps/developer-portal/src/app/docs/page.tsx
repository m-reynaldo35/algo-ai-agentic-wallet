import Link from "next/link";
import CodeBlock from "@/components/docs/CodeBlock";
import EndpointCard from "@/components/docs/EndpointCard";

export const metadata = {
  title: "Documentation — x402 Developer Portal",
  description: "x402 Protocol SDK documentation and API reference",
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Public nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-6xl mx-auto">
        <Link href="/" className="font-semibold text-white tracking-tight">algo-wallet</Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/app/login" className="text-zinc-400 hover:text-white transition-colors">Sign in</Link>
          <Link
            href="/app/create"
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-md transition-colors font-medium"
          >
            Get started
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">Documentation</h1>
          <p className="text-zinc-400 mt-2 text-lg">
            Everything you need to integrate x402-compliant AI-to-AI payments on Algorand.
          </p>
        </div>

        {/* TOC */}
        <nav className="mb-12 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-3">On this page</p>
          <ol className="space-y-1 text-sm text-zinc-400">
            {[
              ["Overview", "#overview"],
              ["Testnet vs Mainnet", "#networks"],
              ["Agent Registration", "#registration"],
              ["Install & Quick Start", "#quickstart"],
              ["402 Handshake Flow", "#handshake"],
              ["API Reference", "#api"],
              ["SDK Methods", "#sdk"],
              ["Mandates", "#mandates"],
              ["Rate Limits", "#limits"],
              ["Types", "#types"],
              ["Error Handling", "#errors"],
            ].map(([label, href]) => (
              <li key={href}>
                <a href={href} className="hover:text-white transition-colors">{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-16">

          {/* Overview */}
          <Section title="Overview" id="overview">
            <p className="text-zinc-400 leading-relaxed">
              The <code className="text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded text-sm">@algo-wallet/x402-client</code> SDK
              handles the full x402 payment handshake automatically. Your agent sends a request, receives a 402 with payment
              terms, and the SDK builds the Ed25519 proof and settles the payment on-chain — all in milliseconds, zero human approval.
            </p>
            <div className="mt-4 bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 font-mono leading-loose">
              <p className="text-white mb-1">Two-step flow:</p>
              <p>  1. <span className="text-emerald-400">POST</span> /api/agent-action &rarr; <span className="text-amber-400">402</span> (payment terms)</p>
              <p>  2. Retry with <span className="text-blue-400">X-PAYMENT</span> header &rarr; <span className="text-emerald-400">200</span> (confirmed)</p>
            </div>
          </Section>

          {/* Networks */}
          <Section title="Testnet vs Mainnet" id="networks">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Network</th>
                    <th className="text-left px-4 py-3">USDC ASA ID</th>
                    <th className="text-left px-4 py-3">Toll</th>
                    <th className="text-left px-4 py-3">baseUrl</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  <tr className="bg-zinc-950">
                    <td className="px-4 py-3 text-emerald-400 font-medium">Mainnet</td>
                    <td className="px-4 py-3 font-mono text-zinc-300">31566704</td>
                    <td className="px-4 py-3 text-zinc-300">0.01 USDC (10,000 µUSDC)</td>
                    <td className="px-4 py-3 font-mono text-zinc-400 text-xs">api.ai-agentic-wallet.com</td>
                  </tr>
                  <tr className="bg-zinc-950/50">
                    <td className="px-4 py-3 text-amber-400 font-medium">Testnet</td>
                    <td className="px-4 py-3 font-mono text-zinc-300">10458941</td>
                    <td className="px-4 py-3 text-zinc-300">0.01 USDC (10,000 µUSDC)</td>
                    <td className="px-4 py-3 font-mono text-zinc-400 text-xs">api.ai-agentic-wallet.com</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-zinc-500 text-sm mt-3">
              Testnet USDC is available from the{" "}
              <a href="https://testnet.folks.finance" className="text-emerald-400 hover:underline" target="_blank" rel="noopener noreferrer">
                Folks Finance testnet faucet
              </a>. Your agent wallet needs ≥ 0.1 ALGO minimum balance and must be opted into the USDC ASA before paying.
            </p>
          </Section>

          {/* Registration */}
          <Section title="Agent Registration" id="registration">
            <p className="text-zinc-400 leading-relaxed mb-6">
              Before making x402 payments, your agent must be registered. Registration rekeyed the wallet to Rocca (our FIDO2/seedless signer) on-chain — your private key is never sent to the server and is retained by you for signing payment proofs.
            </p>
            <p className="text-zinc-400 text-sm mb-4">
              <strong className="text-white">Prerequisites:</strong> wallet holds ≥ 0.1 ALGO, opted into USDC ASA, holds ≥ 0.01 USDC.
            </p>
            <CodeBlock
              language="typescript"
              code={`const response = await fetch("https://api.ai-agentic-wallet.com/api/agents/register-existing", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Portal-Key": YOUR_PORTAL_API_KEY,
  },
  body: JSON.stringify({
    agentId:  "my-agent-001",           // unique ID, alphanumeric + hyphens
    mnemonic: "word1 word2 ... word25", // 25-word Algorand mnemonic
    platform: "anthropic",              // optional: "openai" | "anthropic" | "custom"
  }),
});

const { agentId, address, authAddr, registrationTxnId } = await response.json();
// address    → your agent's Algorand address
// authAddr   → Rocca signer (auth-addr on-chain)
// Your original mnemonic signs x402 payment proofs going forward`}
            />
            <p className="text-zinc-500 text-sm mt-4">
              No ALGO? Use the <strong className="text-zinc-300">USDC-native onboarding</strong> flow — pay a single USDC registration fee and the protocol atomically funds your agent's ALGO reserve. See <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">POST /api/agents/onboarding-quote</code> to get started.
            </p>
          </Section>

          {/* Quick Start */}
          <Section title="Install & Quick Start" id="quickstart">
            <CodeBlock code="npm install @algo-wallet/x402-client algosdk" language="bash" />
            <div className="mt-4">
              <CodeBlock
                language="typescript"
                code={`import { AlgoAgentClient } from "@algo-wallet/x402-client";
import algosdk from "algosdk";

const account = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC!);

const client = new AlgoAgentClient({
  baseUrl:    "https://api.ai-agentic-wallet.com",
  privateKey: account.sk,  // 64-byte Uint8Array
});

const result = await client.executeTrade({
  senderAddress: account.addr.toString(),
  amount: 10000,  // micro-USDC (10000 = $0.01)
});

if (result.success) {
  console.log("Settled:", result.settlement.txnId);
  console.log("Round:", result.settlement.confirmedRound);
} else {
  console.error("Failed at stage:", result.failedStage, result.detail);
}`}
              />
            </div>
          </Section>

          {/* 402 Handshake Flow */}
          <Section title="402 Handshake Flow" id="handshake">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 font-mono text-sm leading-loose text-zinc-400">
              <p className="text-white mb-2">executeTrade()</p>
              <p>  ├─ <span className="text-emerald-400">POST</span> /api/agent-action &larr; Initial request (no proof)</p>
              <p>  │&nbsp;&nbsp;&nbsp;↳ <span className="text-amber-400">402 Payment Required</span> &larr; Server responds with pay+json terms</p>
              <p>  ├─ Parse 402 terms &larr; Extract USDC amount, payTo address, asset ID</p>
              <p>  ├─ Build toll transaction &larr; ASA transfer to treasury</p>
              <p>  ├─ Sign groupId &larr; Ed25519 signature with your key</p>
              <p>  ├─ Retry with <span className="text-blue-400">X-PAYMENT</span> header injected</p>
              <p>  │&nbsp;&nbsp;&nbsp;↳ <span className="text-emerald-400">200 SandboxExport</span> &larr; Unsigned group returned</p>
              <p>  └─ <span className="text-emerald-400">POST</span> /api/execute &larr; Forward to settlement pipeline</p>
              <p>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↳ <span className="text-emerald-400">200 SettlementResult</span> &larr; On-chain confirmation</p>
            </div>
          </Section>

          {/* API Reference */}
          <Section title="API Reference" id="api">
            <div className="space-y-4">
              <EndpointCard
                method="POST"
                path="/api/agents/register-existing"
                description="Register an existing Algorand wallet as an x402 agent. Rekeyed to Rocca on-chain; your private key is never stored. Requires X-Portal-Key header."
                params={[
                  { name: "agentId", type: "string", required: true, desc: "Unique agent ID (alphanumeric + hyphens)" },
                  { name: "mnemonic", type: "string", required: true, desc: "25-word Algorand mnemonic of funded wallet" },
                  { name: "platform", type: "string", required: false, desc: '"openai" | "anthropic" | "custom"' },
                ]}
              />
              <EndpointCard
                method="POST"
                path="/api/agent-action"
                description="Initiates a payment action. Returns 402 with payment terms on first call (no X-PAYMENT header). Returns 200 with SandboxExport when X-PAYMENT proof is present."
                params={[
                  { name: "senderAddress", type: "string", required: true, desc: "Algorand address of the agent" },
                  { name: "amount", type: "number", required: false, desc: "Micro-USDC amount (default: 10000 = $0.01)" },
                ]}
              />
              <EndpointCard
                method="POST"
                path="/api/execute"
                description="Forwards a SandboxExport to the settlement pipeline. Rocca signs and submits the atomic group on-chain."
                params={[
                  { name: "sandboxExport", type: "SandboxExport", required: true, desc: "From agent-action 200 response" },
                  { name: "agentId", type: "string", required: true, desc: "Registered agent ID" },
                ]}
              />
              <EndpointCard
                method="GET"
                path="/api/telemetry"
                description="Returns real-time protocol metrics and recent settlement events for the dashboard."
              />
              <EndpointCard
                method="GET"
                path="/health"
                description="Live status check — Algorand node connectivity, Redis, and system halt state."
              />
              <EndpointCard
                method="GET"
                path="/agent.json"
                description="Full capability manifest for agent discovery (OpenClaw, Moltbook, A2A)."
              />
            </div>
          </Section>

          {/* SDK Methods */}
          <Section title="SDK Methods" id="sdk">
            <div className="space-y-6">
              <MethodDoc
                name="new AlgoAgentClient(config)"
                params={[
                  ["baseUrl", "string", "Required", "x402 server URL"],
                  ["privateKey", "Uint8Array", "Required", "64-byte Algorand Ed25519 secret key"],
                  ["slippageBips", "number", "Optional", "Slippage tolerance (default: 50 = 0.5%)"],
                  ["maxRetries", "number", "Optional", "Max handshake retries (default: 2)"],
                  ["onProgress", "function", "Optional", "Progress callback (stage, message)"],
                ]}
              />
              <MethodDoc
                name="client.executeTrade(params)"
                params={[
                  ["senderAddress", "string", "Required", "Your Algorand address"],
                  ["amount", "number", "Optional", "Micro-USDC amount (default: x402 toll)"],
                ]}
              />
              <MethodDoc
                name="client.requestSandboxExport(params)"
                params={[]}
                description="Performs the 402 handshake only. Returns the SandboxExport for inspection before settlement."
              />
              <MethodDoc
                name="client.settle(response)"
                params={[]}
                description="Forwards a previously obtained SandboxExport to /api/execute."
              />
            </div>
          </Section>

          {/* Mandates */}
          <Section title="Mandates" id="mandates">
            <p className="text-zinc-400 leading-relaxed mb-4">
              Mandates (AP2) allow recurring or autonomous payments without a repeated x402 handshake per request. A human operator authorises a mandate once (via WebAuthn passkey or Algorand wallet QR scan), defining spend limits and expiry. Rocca then evaluates the mandate on every execution and signs automatically if within bounds.
            </p>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              {[
                ["Create mandate", "POST /api/agents/:id/mandate/create", "Requires human auth (FIDO2 or Liquid Auth QR)"],
                ["Revoke mandate", "POST /api/agents/:id/mandate/:mandateId/revoke", "Immediately stops autonomous signing"],
                ["List mandates", "GET /api/agents/:id/mandates", "Returns active mandates and usage stats"],
                ["Issue approval token", "POST /api/agents/:id/mandate/approval-token", "Short-lived token for one-off approvals"],
              ].map(([label, path, desc]) => (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-white text-sm font-medium mb-1">{label}</p>
                  <code className="text-emerald-400 text-xs">{path}</code>
                  <p className="text-zinc-500 text-xs mt-2">{desc}</p>
                </div>
              ))}
            </div>
            <p className="text-zinc-500 text-sm">
              Two auth options for mandate governance: <strong className="text-zinc-300">WebAuthn</strong> (Touch ID / Face ID / YubiKey) or <strong className="text-zinc-300">Liquid Auth QR</strong> (scan with Pera or Defly wallet). Both produce equivalent authorisation — use whichever fits your workflow.
            </p>
          </Section>

          {/* Rate Limits */}
          <Section title="Rate Limits" id="limits">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Limit</th>
                    <th className="text-left px-4 py-3">Value</th>
                    <th className="text-left px-4 py-3">Scope</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["Request rate", "100 req / min", "Per IP (sliding window)"],
                    ["Burst cap", "5 executions / 10s", "Per agent"],
                    ["Velocity cap", "$50 USDC / 10 min", "Per agent (configurable)"],
                    ["Nonce window", "60 seconds", "Replay protection"],
                    ["402 expiry", "5 minutes", "Payment proof validity"],
                  ].map(([limit, value, scope]) => (
                    <tr key={limit} className="bg-zinc-950">
                      <td className="px-4 py-3 text-zinc-300">{limit}</td>
                      <td className="px-4 py-3 font-mono text-emerald-400">{value}</td>
                      <td className="px-4 py-3 text-zinc-500">{scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-zinc-500 text-sm mt-3">
              Rate limit responses return HTTP <code className="text-amber-400">429</code>. Back off exponentially and retry after 60 seconds. Velocity cap breaches return HTTP <code className="text-amber-400">402</code> with <code className="text-zinc-300">velocityCapped: true</code> in the body.
            </p>
          </Section>

          {/* Types */}
          <Section title="Types" id="types">
            <CodeBlock
              language="typescript"
              code={`import type {
  TradeParams,
  TradeResult,
  SettlementResult,
  SettlementFailure,
  SandboxExport,
  PayJson,
} from "@algo-wallet/x402-client";`}
            />
          </Section>

          {/* Error Handling */}
          <Section title="Error Handling" id="errors">
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Meaning</th>
                    <th className="text-left px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["402", "Payment required", "Complete the handshake — attach X-PAYMENT header"],
                    ["401", "Replay detected", "Generate a fresh toll transaction (new groupId)"],
                    ["400", "Malformed request", "Check body schema"],
                    ["429", "Rate limited", "Back off exponentially; retry after 60s"],
                    ["500", "Internal error", "Check detail field; retry after 30s"],
                    ["502", "Pipeline failure", "Check failedStage: validation / auth / sign / broadcast"],
                  ].map(([status, meaning, action]) => (
                    <tr key={status} className="bg-zinc-950">
                      <td className="px-4 py-3 font-mono text-amber-400">{status}</td>
                      <td className="px-4 py-3 text-zinc-300">{meaning}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">{action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CodeBlock
              language="typescript"
              code={`import { X402Error, X402ErrorCode } from "@algo-wallet/x402-client";

try {
  const result = await client.executeTrade({ senderAddress: "AAAA...7Q" });
  if ("success" in result) {
    console.log("Settled:", result.settlement.txnId);
  } else {
    console.error("Pipeline failed at:", result.failedStage, result.detail);
  }
} catch (err) {
  if (err instanceof X402Error) {
    switch (err.code) {
      case X402ErrorCode.OFFER_EXPIRED:  // Re-initiate handshake
      case X402ErrorCode.POLICY_BREACH:  // Agent exceeded spending cap
      case X402ErrorCode.NETWORK_ERROR:  // Algorand node unreachable — retry
    }
  }
}`}
            />
          </Section>

        </div>
      </div>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id}>
      <h2 className="text-2xl font-bold mb-4 text-white">{title}</h2>
      {children}
    </section>
  );
}

function MethodDoc({
  name,
  params,
  description,
}: {
  name: string;
  params: [string, string, string, string][];
  description?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <code className="font-mono text-sm text-emerald-400">{name}</code>
      {description && <p className="text-sm text-zinc-400 mt-2">{description}</p>}
      {params.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {params.map(([pName, type, req, desc]) => (
            <div key={pName} className="flex items-baseline gap-2 text-sm">
              <code className="font-mono text-zinc-300">{pName}</code>
              <span className="text-xs text-zinc-600">{type}</span>
              <span className={`text-xs ${req === "Required" ? "text-red-400" : "text-zinc-600"}`}>{req}</span>
              <span className="text-zinc-500 text-xs">{desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
