"use client";

import { useState } from "react";

interface ToggleProps {
  label: string;
  description: string;
  defaultOn?: boolean;
}

function Toggle({ label, description, defaultOn = false }: ToggleProps) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <button
        onClick={() => setOn(!on)}
        className={`relative w-10 h-5 rounded-full transition-colors ${on ? "bg-emerald-600" : "bg-zinc-700"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-5" : ""}`}
        />
      </button>
    </div>
  );
}

const rateLimits = [
  { endpoint: "/api/agent-action", limit: "100 req/min", window: "Sliding", burst: "20 req/s" },
  { endpoint: "/api/execute", limit: "50 req/min", window: "Sliding", burst: "10 req/s" },
  { endpoint: "/api/telemetry", limit: "30 req/min", window: "Fixed", burst: "5 req/s" },
];

export default function SettingsForm() {
  return (
    <div className="space-y-8">
      {/* Account Info */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Account</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <InfoRow label="Organization" value="Demo Corp" />
          <InfoRow label="Plan" value="Developer" />
          <InfoRow label="Network" value="algorand-testnet" />
          <InfoRow label="Server URL" value="https://x402-server.vercel.app" />
        </div>
      </section>

      {/* Notifications */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Notifications</h2>
        <div className="divide-y divide-zinc-800">
          <Toggle label="Settlement Alerts" description="Get notified on successful settlements" defaultOn />
          <Toggle label="Failure Alerts" description="Get notified on execution failures" defaultOn />
          <Toggle label="Rate Limit Warnings" description="Alert when approaching rate limits" />
          <Toggle label="API Key Events" description="Notify on key creation or revocation" defaultOn />
          <Toggle label="Weekly Digest" description="Receive weekly summary email" />
        </div>
      </section>

      {/* Rate Limits */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Rate Limits</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="pb-3 pr-4 font-medium">Endpoint</th>
                <th className="pb-3 pr-4 font-medium">Limit</th>
                <th className="pb-3 pr-4 font-medium">Window</th>
                <th className="pb-3 font-medium">Burst</th>
              </tr>
            </thead>
            <tbody>
              {rateLimits.map((r) => (
                <tr key={r.endpoint} className="border-b border-zinc-800/50">
                  <td className="py-3 pr-4 font-mono text-zinc-300">{r.endpoint}</td>
                  <td className="py-3 pr-4 text-zinc-400">{r.limit}</td>
                  <td className="py-3 pr-4 text-zinc-400">{r.window}</td>
                  <td className="py-3 text-zinc-400">{r.burst}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-600 mt-3">Rate limits are enforced per API key via Upstash Redis sliding window.</p>
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className="text-zinc-300">{value}</p>
    </div>
  );
}
