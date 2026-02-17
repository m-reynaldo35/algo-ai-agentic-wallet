"use client";

import { useState } from "react";

interface ApiKeyEntry {
  id: string;
  name: string;
  platform: string;
  key: string;
  webhookUrl: string;
  created: string;
  status: "active" | "revoked";
  usageCount: number;
  rateLimit: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([
    {
      id: "1",
      name: "OpenClaw Production",
      platform: "openclaw.network",
      key: "x402_live_oc_a8k2m4p9q1r3s5t7",
      webhookUrl: "https://api.openclaw.network/webhooks/x402",
      created: "2026-02-15",
      status: "active",
      usageCount: 142,
      rateLimit: "100 req/min",
    },
    {
      id: "2",
      name: "Moltbook Staging",
      platform: "moltbook.com",
      key: "x402_test_mb_b3n5p7r9t1v3x5z7",
      webhookUrl: "https://staging.moltbook.com/hooks/x402",
      created: "2026-02-16",
      status: "active",
      usageCount: 37,
      rateLimit: "50 req/min",
    },
  ]);

  const [formName, setFormName] = useState("");
  const [formPlatform, setFormPlatform] = useState("");
  const [formWebhook, setFormWebhook] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    const newKey: ApiKeyEntry = {
      id: String(Date.now()),
      name: formName,
      platform: formPlatform,
      key: `x402_live_${formPlatform.slice(0, 2)}_${Math.random().toString(36).slice(2, 14)}`,
      webhookUrl: formWebhook || `https://${formPlatform}/webhooks/x402`,
      created: new Date().toISOString().slice(0, 10),
      status: "active",
      usageCount: 0,
      rateLimit: "100 req/min",
    };
    setKeys([newKey, ...keys]);
    setFormName("");
    setFormPlatform("");
    setFormWebhook("");
  }

  function handleRevoke(id: string) {
    setKeys(keys.map((k) => k.id === id ? { ...k, status: "revoked" as const } : k));
  }

  async function handleCopy(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">API Keys</h1>
        <p className="text-zinc-400 mt-2 text-lg">
          Register your aggregator platform and manage webhook endpoints.
        </p>
      </div>

      {/* Registration Form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 mb-8">
        <h2 className="text-xl font-semibold mb-4">Register New Platform</h2>
        <form onSubmit={handleRegister} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Platform Name</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g., OpenClaw Trading Bot"
                required
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Domain</label>
              <input
                type="text"
                value={formPlatform}
                onChange={(e) => setFormPlatform(e.target.value)}
                placeholder="e.g., openclaw.network"
                required
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Webhook URL</label>
            <input
              type="url"
              value={formWebhook}
              onChange={(e) => setFormWebhook(e.target.value)}
              placeholder="https://api.openclaw.network/webhooks/x402"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <button
            type="submit"
            className="bg-white text-black font-medium px-6 py-2 rounded-md hover:bg-zinc-200 transition-colors"
          >
            Generate API Key
          </button>
        </form>
      </div>

      {/* Key List */}
      <div className="space-y-3">
        <h2 className="text-xl font-semibold mb-2">Active Keys</h2>
        {keys.map((k) => (
          <div key={k.id} className={`border rounded-lg p-4 ${
            k.status === "active"
              ? "border-zinc-800 bg-zinc-900"
              : "border-red-900/50 bg-red-950/20 opacity-60"
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <p className="font-semibold">{k.name}</p>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    k.status === "active"
                      ? "bg-emerald-900/50 text-emerald-400"
                      : "bg-red-900/50 text-red-400"
                  }`}>
                    {k.status}
                  </span>
                </div>
                <p className="text-sm text-zinc-400">{k.platform}</p>

                {/* Key with copy */}
                <div className="flex items-center gap-2 mt-2">
                  <code className="font-mono text-sm text-zinc-500 bg-zinc-800 px-2 py-1 rounded">{k.key}</code>
                  {k.status === "active" && (
                    <button
                      onClick={() => handleCopy(k.id, k.key)}
                      className="text-xs text-zinc-400 hover:text-white border border-zinc-700 px-2 py-1 rounded transition-colors"
                    >
                      {copiedId === k.id ? "Copied!" : "Copy"}
                    </button>
                  )}
                </div>

                {/* Webhook URL */}
                <p className="text-xs text-zinc-600 mt-2">
                  Webhook: <span className="text-zinc-500">{k.webhookUrl}</span>
                </p>

                {/* Usage & rate limit */}
                <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                  <span>{k.usageCount} calls</span>
                  <span className="text-zinc-700">|</span>
                  <span>Rate limit: {k.rateLimit}</span>
                  <span className="text-zinc-700">|</span>
                  <span>Created: {k.created}</span>
                </div>
              </div>

              {k.status === "active" && (
                <button
                  onClick={() => handleRevoke(k.id)}
                  className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-3 py-1 rounded shrink-0"
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
