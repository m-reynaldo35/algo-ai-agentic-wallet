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
          <Link href="/sign-in" className="text-zinc-400 hover:text-white transition-colors">Sign in</Link>
          <Link
            href="/app/dashboard"
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
              ["Who is this for?", "#who"],
              ["Overview", "#overview"],
              ["Testnet vs Mainnet", "#networks"],
              ["Agent Onboarding", "#registration"],
              ["Install & Quick Start", "#quickstart"],
              ["402 Handshake Flow", "#handshake"],
              ["Gas Headers", "#gas"],
              ["API Reference", "#api"],
              ["SDK Methods", "#sdk"],
              ["Mandates", "#mandates"],
              ["Rate Limits", "#limits"],
              ["Types", "#types"],
              ["Error Handling", "#errors"],
              ["CLI Reference", "#cli"],
              ["Claude MCP Integration", "#mcp"],
              ["Performance", "#performance"],
            ].map(([label, href]) => (
              <li key={href}>
                <a href={href} className="hover:text-white transition-colors">{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-16">

          {/* Who is this for? */}
          <Section title="Who is this for?" id="who">
            <div className="grid sm:grid-cols-3 gap-4">
              {[
                {
                  label: "Algorand wallet holders",
                  color: "emerald",
                  items: [
                    "Have Pera or Defly installed",
                    "Sign in with your wallet",
                    "Create an agent via the dashboard",
                    "Fund it with ALGO + USDC from Pera",
                  ],
                  cta: { label: "Sign in →", href: "/app/login" },
                },
                {
                  label: "Developers / AI agents",
                  color: "violet",
                  items: [
                    "Use the REST API directly",
                    "POST /api/agents/create → get mnemonic",
                    "Send 0.5 ALGO to activate",
                    "Use SDK or MCP in your code",
                  ],
                  cta: { label: "Jump to quickstart →", href: "#quickstart" },
                },
                {
                  label: "New to Algorand?",
                  color: "amber",
                  items: [
                    "Install Pera Wallet",
                    "Buy ALGO on Coinbase / Binance",
                    "Get USDC on Algorand",
                    "Then come back and sign in",
                  ],
                  cta: { label: "Setup guide →", href: "/get-started" },
                },
              ].map(({ label, color, items, cta }) => (
                <div key={label} className={`bg-zinc-900 border border-zinc-800 rounded-xl p-5`}>
                  <p className={`text-sm font-semibold mb-3 ${
                    color === "emerald" ? "text-emerald-400"
                    : color === "violet" ? "text-violet-400"
                    : "text-amber-400"
                  }`}>{label}</p>
                  <ul className="space-y-1.5 mb-4">
                    {items.map(item => (
                      <li key={item} className="flex items-start gap-2 text-xs text-zinc-400">
                        <svg className="w-3 h-3 text-zinc-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        {item}
                      </li>
                    ))}
                  </ul>
                  <a href={cta.href} className={`text-xs font-medium hover:underline ${
                    color === "emerald" ? "text-emerald-400"
                    : color === "violet" ? "text-violet-400"
                    : "text-amber-400"
                  }`}>{cta.label}</a>
                </div>
              ))}
            </div>
          </Section>

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
          <Section title="Agent Onboarding" id="registration">
            <p className="text-zinc-400 leading-relaxed mb-6">
              Agents are non-custodial. You generate your own keypair, the operator deploys a MandateContract with your spend limits, you register with the server, and fund the contract app account with ALGO (gas) and USDC (spending power). No rekeying. You hold the signing key forever.
            </p>

            <p className="text-white text-sm font-medium mb-2">Step 1 — Create the agent</p>
            <CodeBlock
              language="typescript"
              code={`const res = await fetch("https://api.ai-agentic-wallet.com/api/agents/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Portal-Key": YOUR_PORTAL_API_KEY,
  },
  body: JSON.stringify({
    agentId:      "my-agent-001",  // unique ID, alphanumeric + hyphens
    ownerAddress: "PERA_ADDR...",  // optional — links agent to your wallet identity
    platform:     "anthropic",    // optional: "openai" | "anthropic" | "custom"
  }),
});

const { agentId, address, mnemonic } = await res.json();
// address  → your agent's Algorand address (fund this)
// mnemonic → 25-word signing key — save to ALGO_MNEMONIC in your .env`}
            />

            <p className="text-white text-sm font-medium mt-6 mb-2">Step 2 — Save the signing key</p>
            <p className="text-zinc-400 text-sm mb-3">
              The server discards the mnemonic immediately. Copy it into your application&apos;s environment:
            </p>
            <CodeBlock language="bash" code={`ALGO_MNEMONIC="word1 word2 ... word25"  # in your .env file`} />

            <p className="text-white text-sm font-medium mt-6 mb-2">Step 3 — Send 0.5 ALGO to activate</p>
            <p className="text-zinc-400 text-sm mb-3">
              Send at least <strong className="text-white">0.5 ALGO</strong> to the <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">address</code> returned above.
              The server polls the MandateContract app account every 10 seconds. When it detects USDC &gt; 0, the agent status changes to <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">active</code>.
            </p>
            <CodeBlock
              language="typescript"
              code={`// Poll until active (typically 10–30 seconds after deposit)
let agent;
do {
  await new Promise(r => setTimeout(r, 5000));
  const r = await fetch(\`https://api.ai-agentic-wallet.com/api/agents/\${agentId}\`, {
    headers: { "X-Portal-Key": YOUR_PORTAL_API_KEY },
  });
  agent = await r.json();
} while (agent.status !== "active");

console.log("Agent active:", agent.address);`}
            />

            <p className="text-white text-sm font-medium mt-6 mb-2">Step 4 — Deposit USDC</p>
            <p className="text-zinc-400 text-sm">
              Send USDC (ASA <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">31566704</code> mainnet /{" "}
              <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">10458941</code> testnet) to the same agent address.
              The agent is already opted in — it can receive USDC immediately after activation.
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
  baseUrl:      "https://api.ai-agentic-wallet.com",
  privateKey:   account.sk,               // 64-byte Uint8Array
  mandateAppId: Number(process.env.MANDATE_APP_ID!),  // from register-mandate
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
              <p className="mt-3 text-zinc-500 text-xs">Atomic endpoints (e.g. /api/weather) skip the separate /api/execute step — settlement is committed inline before data is returned.</p>
            </div>
          </Section>

          {/* Gas Headers */}
          <Section title="Gas Headers" id="gas">
            <p className="text-zinc-400 leading-relaxed mb-4">
              Every payment response includes gas status headers so your agent can monitor its own ALGO balance and alert before it runs dry.
            </p>
            <CodeBlock
              language="bash"
              code={`X-Agent-Gas-Status:    ok | low | critical
X-Agent-Gas-Remaining: 847   # estimated transactions remaining`}
            />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Meaning</th>
                    <th className="text-left px-4 py-3">Threshold</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["ok",       "Sufficient ALGO for many more transactions", "≥ 200,000 µALGO above MBR"],
                    ["low",      "Refuel soon — limited transactions remaining", "< 200,000 µALGO above MBR"],
                    ["critical", "Refuel immediately — may fail soon", "< 50,000 µALGO above MBR"],
                  ].map(([status, meaning, threshold]) => (
                    <tr key={status} className="bg-zinc-950">
                      <td className={`px-4 py-3 font-mono text-sm font-medium ${
                        status === "ok" ? "text-emerald-400" : status === "low" ? "text-amber-400" : "text-red-400"
                      }`}>{status}</td>
                      <td className="px-4 py-3 text-zinc-300 text-xs">{meaning}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs font-mono">{threshold}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-zinc-500 text-sm mt-4">Use <code className="text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">parseGasInfo()</code> from the SDK to read these headers automatically:</p>
            <CodeBlock
              language="typescript"
              code={`import { AlgoAgentClient, parseGasInfo } from "@algo-wallet/x402-client";

const client = new AlgoAgentClient({ baseUrl, privateKey: account.sk });
const response = await client.fetch("/api/your-endpoint", { method: "POST", body: ... });
const gas = parseGasInfo(response);

if (gas?.status === "critical") {
  console.warn(\`Gas critical — only \${gas.remaining} transactions remaining\`);
  // trigger a refuel flow or alert your operator
}`}
            />
          </Section>

          {/* API Reference */}
          <Section title="API Reference" id="api">
            <div className="space-y-4">
              <EndpointCard
                method="POST"
                path="/api/agents/register-mandate"
                description="Register a non-custodial mandate agent. Provide your address and mandateAppId. The server stores the record — no on-chain ops, no rekeying. Requires X-Portal-Key header."
                params={[
                  { name: "agentId", type: "string", required: true, desc: "Unique agent ID (alphanumeric + hyphens)" },
                  { name: "address", type: "string", required: true, desc: "Agent Algorand address (58-char base32)" },
                  { name: "mandateAppId", type: "number", required: true, desc: "MandateContract application ID" },
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
                description="Forwards a SandboxExport to the settlement pipeline. The server verifies factory provenance and submits the signed atomic group on-chain."
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
                  ["mandateAppId", "number", "Required", "MandateContract application ID for this agent"],
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
              <MethodDoc
                name="parseGasInfo(response)"
                params={[
                  ["response", "Response", "Required", "Fetch Response object from a payment call"],
                ]}
                description="Reads X-Agent-Gas-Status and X-Agent-Gas-Remaining headers. Returns { status, remaining } or null if headers are absent."
              />
            </div>
          </Section>

          {/* Mandates */}
          <Section title="Mandates" id="mandates">
            <p className="text-zinc-400 leading-relaxed mb-4">
              MandateContracts are on-chain Algorand smart contracts that enforce spend limits at the AVM level — per-transaction cap, 10-minute velocity window, and a 24-hour daily cap. A human operator deploys the contract with the desired limits once. The agent then signs its own <code className="text-emerald-400 text-xs bg-zinc-800 px-1 py-0.5 rounded">pay()</code> calls; the AVM rejects anything that exceeds the caps.
            </p>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              {[
                ["Create mandate", "POST /api/agents/:id/mandate/create", "Requires human auth via Pera Connect QR scan"],
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
              Mandate governance uses <strong className="text-zinc-300">Pera Connect</strong> (scan WalletConnect QR with Pera or Defly). Your wallet signature authorises the mandate on-chain — no email or password required.
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

          <Section title="CLI Reference" id="cli">
            <p className="text-zinc-400 mb-4 text-sm leading-relaxed">
              The <code className="text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded text-sm">@algo-wallet/x402-cli</code> lets
              you inspect agents, mandates, and transaction history directly from your terminal — no dashboard required.
            </p>
            <CodeBlock language="bash" code="npm install -g @algo-wallet/x402-cli" />
            <p className="text-zinc-500 text-xs mt-3 mb-5">
              Or run without installing: <code className="font-mono text-zinc-400">npx @algo-wallet/x402-cli &lt;command&gt;</code>
            </p>
            <div className="overflow-x-auto mb-5">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Command</th>
                    <th className="text-left px-4 py-3">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["x402 health", "Backend health — node, Redis, halt state"],
                    ["x402 balance --agent <id>", "Live ALGO + USDC balance for an agent"],
                    ["x402 agents list", "List all registered agents with status"],
                    ["x402 mandate list --agent <id>", "List active mandates for an agent"],
                    ["x402 mandate list --agent <id> --all", "Include revoked mandates"],
                    ["x402 history --agent <id>", "Transaction history (last 20)"],
                    ["x402 history --agent <id> --limit 50", "Transaction history (custom limit)"],
                    ["x402 gas --agent <id>", "Gas status — ALGO balance, tx remaining, low/critical flag"],
                  ].map(([cmd, desc]) => (
                    <tr key={cmd} className="bg-zinc-950">
                      <td className="px-4 py-3 font-mono text-emerald-400 text-xs whitespace-nowrap">{cmd}</td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CodeBlock
              language="bash"
              code={`# Required env vars
export X402_PORTAL_KEY="your-portal-api-key"   # from /dashboard → API Keys
export X402_API_URL="https://api.ai-agentic-wallet.com"  # default
export X402_NETWORK="testnet"                   # or "mainnet"

# Examples
x402 health
x402 balance --agent my-agent-001
x402 mandate list --agent my-agent-001 --all
x402 history --agent my-agent-001 --limit 50`}
            />
          </Section>

          <Section title="Claude MCP Integration" id="mcp">
            <p className="text-zinc-400 mb-4 text-sm leading-relaxed">
              The <code className="text-violet-400 bg-zinc-800 px-1.5 py-0.5 rounded text-sm">@algo-wallet/x402-mcp</code> MCP
              server lets Claude Desktop and Claude Code agents pay for API calls autonomously — no payment code required.
              Claude calls the <code className="text-zinc-300 bg-zinc-800 px-1 rounded text-xs">pay_with_x402</code> tool and
              receives weather data, analytics, or any x402-gated resource in return.
            </p>
            <CodeBlock language="bash" code="npx @algo-wallet/x402-mcp" />
            <p className="text-zinc-400 text-sm mt-6 mb-3 font-medium">Add to Claude Desktop config:</p>
            <CodeBlock
              language="json"
              code={`// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "@algo-wallet/x402-mcp"],
      "env": {
        "ALGO_MNEMONIC": "your 25-word agent mnemonic",
        "X402_AGENT_ID": "your-agent-id",
        "X402_API_URL":  "https://api.ai-agentic-wallet.com"
      }
    }
  }
}`}
            />
            <p className="text-zinc-400 text-sm mt-6 mb-3 font-medium">Add to Claude Code (global):</p>
            <CodeBlock
              language="bash"
              code={`claude mcp add x402-wallet npx @algo-wallet/x402-mcp \\
  --env ALGO_MNEMONIC="your 25-word mnemonic" \\
  --env X402_AGENT_ID="your-agent-id"`}
            />
            <div className="overflow-x-auto mt-6">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Env var</th>
                    <th className="text-left px-4 py-3">Required</th>
                    <th className="text-left px-4 py-3">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["ALGO_MNEMONIC",  "Yes", "25-word mnemonic of your registered agent wallet"],
                    ["X402_AGENT_ID",  "Yes", "Agent ID registered with the wallet router"],
                    ["X402_API_URL",   "No",  "API base URL (default: https://api.ai-agentic-wallet.com)"],
                    ["X402_PORTAL_KEY","No",  "Portal API key if your server requires portal auth"],
                  ].map(([env, req, desc]) => (
                    <tr key={env} className="bg-zinc-950">
                      <td className="px-4 py-3 font-mono text-violet-400 text-xs whitespace-nowrap">{env}</td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">{req}</td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Performance" id="performance">
            <p className="text-zinc-400 mb-5 text-sm leading-relaxed">
              Benchmarked on Algorand mainnet with 100 real USDC payments, Poisson arrivals (λ=1.5/s) and 25% burst
              clusters. Live results: <a href="https://api.ai-agentic-wallet.com/api/benchmark" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">api.ai-agentic-wallet.com/api/benchmark</a>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-zinc-800 rounded-lg overflow-hidden">
                <thead className="bg-zinc-900 text-zinc-400">
                  <tr>
                    <th className="text-left px-4 py-3">Metric</th>
                    <th className="text-left px-4 py-3">p50</th>
                    <th className="text-left px-4 py-3">p95</th>
                    <th className="text-left px-4 py-3">p99</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {[
                    ["x402 handshake",  "549ms",   "1,273ms",  "1,693ms"],
                    ["Settlement",      "9,712ms",  "14,193ms", "15,694ms"],
                    ["End-to-end",      "10,737ms", "15,359ms", "16,899ms"],
                  ].map(([metric, p50, p95, p99]) => (
                    <tr key={metric} className="bg-zinc-950">
                      <td className="px-4 py-3 text-zinc-300 text-xs font-medium">{metric}</td>
                      <td className="px-4 py-3 text-emerald-400 text-xs font-mono">{p50}</td>
                      <td className="px-4 py-3 text-zinc-400 text-xs font-mono">{p95}</td>
                      <td className="px-4 py-3 text-zinc-400 text-xs font-mono">{p99}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-zinc-500 text-xs mt-4">
              100/100 confirmed · 126.6 tx/min · peak 46 concurrent · $1.00 USDC settled · 2026-03-22
            </p>
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
