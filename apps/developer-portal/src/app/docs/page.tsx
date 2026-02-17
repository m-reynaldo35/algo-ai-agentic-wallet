import CodeBlock from "@/components/docs/CodeBlock";
import EndpointCard from "@/components/docs/EndpointCard";

export const metadata = {
  title: "Documentation — x402 Developer Portal",
  description: "x402 Protocol SDK documentation and API reference",
};

export default function DocsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">Documentation</h1>
        <p className="text-zinc-400 mt-2 text-lg">
          Everything you need to integrate x402-compliant AI-to-AI settlement on Algorand.
        </p>
      </div>

      <div className="space-y-12">
        {/* Overview */}
        <Section title="Overview">
          <p className="text-zinc-400 leading-relaxed">
            The <code className="text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded text-sm">@algo-wallet/x402-client</code> SDK
            handles the full x402 payment handshake automatically. Your agent sends a request, gets a 402 bounce with payment
            terms, and the SDK absorbs it — building the Ed25519 proof and settling the atomic group on-chain. Three lines of code.
          </p>
        </Section>

        {/* Install */}
        <Section title="Install">
          <CodeBlock code="npm install @algo-wallet/x402-client algosdk" language="bash" />
        </Section>

        {/* Quick Start */}
        <Section title="Quick Start">
          <CodeBlock
            language="typescript"
            code={`import { AlgoAgentClient } from "@algo-wallet/x402-client";

const client = new AlgoAgentClient({
  baseUrl: "https://your-x402-server.vercel.app",
  privateKey: yourAlgorandSecretKey, // 64-byte Uint8Array
});

const result = await client.executeTrade({ senderAddress: "AAAA...7Q" });
console.log(result);
// { success: true, settlement: { txnId: "...", confirmedRound: 12345 } }`}
          />
        </Section>

        {/* 402 Handshake Flow */}
        <Section title="402 Handshake Flow">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 font-mono text-sm leading-loose text-zinc-400">
            <p className="text-white mb-2">executeTrade()</p>
            <p>  ├─ <span className="text-emerald-400">POST</span> /api/agent-action &larr; Initial request (no proof)</p>
            <p>  │&nbsp;&nbsp;&nbsp;↳ <span className="text-amber-400">402 Payment Required</span> &larr; Server bounces with pay+json terms</p>
            <p>  ├─ Parse 402 terms &larr; Extract USDC amount, payTo, asset ID</p>
            <p>  ├─ Build atomic group &larr; ASA transfer to treasury</p>
            <p>  ├─ Sign groupId &larr; Ed25519 signature with your key</p>
            <p>  ├─ Retry with <span className="text-blue-400">X-PAYMENT</span> header injected</p>
            <p>  │&nbsp;&nbsp;&nbsp;↳ <span className="text-emerald-400">200 SandboxExport</span> &larr; Unsigned atomic group returned</p>
            <p>  └─ <span className="text-emerald-400">POST</span> /api/execute &larr; Forward to settlement pipeline</p>
            <p>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↳ <span className="text-emerald-400">200 SettlementResult</span> &larr; On-chain confirmation</p>
          </div>
        </Section>

        {/* API Reference */}
        <Section title="API Reference">
          <div className="space-y-4">
            <EndpointCard
              method="POST"
              path="/api/agent-action"
              description="Initiates a trade action. Returns 402 with payment terms on first call, then 200 with SandboxExport when X-PAYMENT header is present."
              params={[
                { name: "senderAddress", type: "string", required: true, desc: "Algorand address" },
                { name: "amount", type: "number", required: false, desc: "Micro-USDC amount" },
                { name: "destinationChain", type: "string", required: false, desc: 'Wormhole target (default: "ethereum")' },
              ]}
            />
            <EndpointCard
              method="POST"
              path="/api/execute"
              description="Forwards a SandboxExport to the settlement pipeline. Signs and submits the atomic group on-chain."
              params={[
                { name: "sandboxExport", type: "SandboxExport", required: true, desc: "From agent-action 200 response" },
              ]}
            />
            <EndpointCard
              method="GET"
              path="/api/telemetry"
              description="Returns real-time protocol metrics and recent audit events for the dashboard."
            />
          </div>
        </Section>

        {/* SDK Methods */}
        <Section title="SDK Methods">
          <div className="space-y-6">
            <MethodDoc
              name="new AlgoAgentClient(config)"
              params={[
                ["baseUrl", "string", "Required", "x402 server URL"],
                ["privateKey", "Uint8Array", "Required", "64-byte Algorand Ed25519 secret key"],
                ["slippageBips", "number", "Optional", "Slippage tolerance (default: 50 = 0.5%)"],
              ]}
            />
            <MethodDoc
              name="client.executeTrade(params)"
              params={[
                ["senderAddress", "string", "Required", "Your Algorand address"],
                ["amount", "number", "Optional", "Micro-USDC amount"],
                ["destinationChain", "string", "Optional", 'Wormhole target (default: "ethereum")'],
                ["destinationRecipient", "string", "Optional", "Recipient on destination chain"],
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
              description="Forwards a previously obtained AgentActionResponse to /api/execute."
            />
          </div>
        </Section>

        {/* Types */}
        <Section title="Types">
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
        <Section title="Error Handling">
          <CodeBlock
            language="typescript"
            code={`import { X402Error } from "@algo-wallet/x402-client";

try {
  const result = await client.executeTrade({ senderAddress: "AAAA...7Q" });
  if ("success" in result) {
    console.log("Settled:", result.settlement.txnId);
  } else {
    console.error("Pipeline failed at:", result.failedStage, result.detail);
  }
} catch (err) {
  if (err instanceof X402Error) {
    console.error("x402 protocol error:", err.message);
  }
}`}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
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
