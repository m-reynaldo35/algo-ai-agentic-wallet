"use client";

import { useState, useEffect } from "react";

// ── Sub-components ─────────────────────────────────────────────

interface ToggleProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ label, description, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${checked ? "bg-emerald-600" : "bg-zinc-700"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : ""}`}
        />
      </button>
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

interface ThresholdProps {
  label: string;
  description: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}

function ThresholdInput({ label, description, value, unit, min, max, onChange }: ThresholdProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div className="flex items-center gap-2 ml-4">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
          className="w-20 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-emerald-600"
        />
        <span className="text-xs text-zinc-500 w-16">{unit}</span>
      </div>
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────

interface ConfigData {
  network: string;
  serverUrl: string;
  rateLimits: {
    ipMax: number;
    ipWindow: string;
    platformMax: number;
    platformWindow: string;
  };
}

interface NotificationSettings {
  settlementAlerts: boolean;
  failureAlerts: boolean;
  rateLimitWarnings: boolean;
  apiKeyEvents: boolean;
  weeklyDigest: boolean;
}

interface AlertThresholds {
  rateLimitHitsPerMinute: number;
  failureRatePercent: number;
  finalityWarningMs: number;
  minSettlementsPerHour: number;
}

const THRESHOLD_KEY = "x402:alert-thresholds";
const NOTIF_KEY = "x402:notifications";

const defaultThresholds: AlertThresholds = {
  rateLimitHitsPerMinute: 10,
  failureRatePercent: 5,
  finalityWarningMs: 4500,
  minSettlementsPerHour: 0,
};

const defaultNotifications: NotificationSettings = {
  settlementAlerts: true,
  failureAlerts: true,
  rateLimitWarnings: false,
  apiKeyEvents: true,
  weeklyDigest: false,
};

const defaultConfig: ConfigData = {
  network: "algorand-mainnet",
  serverUrl: "https://ai-agentic-wallet.com",
  rateLimits: { ipMax: 30, ipWindow: "10s", platformMax: 100, platformWindow: "10s" },
};

// ── Main ───────────────────────────────────────────────────────

export default function SettingsForm() {
  const [cfg, setCfg] = useState<ConfigData>(defaultConfig);
  const [notifs, setNotifs] = useState<NotificationSettings>(defaultNotifications);
  const [thresholds, setThresholds] = useState<AlertThresholds>(defaultThresholds);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/live/config")
      .then((r) => r.ok ? r.json() as Promise<ConfigData> : Promise.reject(r))
      .then((data) => setCfg(data))
      .catch(() => {});

    try {
      const t = localStorage.getItem(THRESHOLD_KEY);
      if (t) setThresholds(JSON.parse(t) as AlertThresholds);
      const n = localStorage.getItem(NOTIF_KEY);
      if (n) setNotifs(JSON.parse(n) as NotificationSettings);
    } catch { /* ignore */ }
  }, []);

  const handleSave = () => {
    try {
      localStorage.setItem(THRESHOLD_KEY, JSON.stringify(thresholds));
      localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs));
    } catch { /* ignore */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setNotif = (key: keyof NotificationSettings) => (v: boolean) =>
    setNotifs((prev) => ({ ...prev, [key]: v }));

  const setThreshold = (key: keyof AlertThresholds) => (v: number) =>
    setThresholds((prev) => ({ ...prev, [key]: v }));

  const rateLimits = [
    { endpoint: "/api/agent-action", limit: `${cfg.rateLimits.platformMax} req/${cfg.rateLimits.platformWindow}`, window: "Sliding", burst: `${Math.floor(cfg.rateLimits.platformMax / 10)} req/s` },
    { endpoint: "/api/batch-action", limit: `${cfg.rateLimits.platformMax} req/${cfg.rateLimits.platformWindow}`, window: "Sliding", burst: `${Math.floor(cfg.rateLimits.platformMax / 10)} req/s` },
    { endpoint: "/api/execute",      limit: `${Math.floor(cfg.rateLimits.platformMax / 2)} req/${cfg.rateLimits.platformWindow}`, window: "Sliding", burst: `${Math.floor(cfg.rateLimits.platformMax / 20)} req/s` },
    { endpoint: "/api/telemetry",    limit: `${cfg.rateLimits.ipMax} req/${cfg.rateLimits.ipWindow}`, window: "Fixed", burst: `${Math.floor(cfg.rateLimits.ipMax / 6)} req/s` },
  ];

  return (
    <div className="space-y-8">

      {/* Account */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Account</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <InfoRow label="Organization" value="Demo Corp" />
          <InfoRow label="Plan" value="Developer" />
          <InfoRow label="Network" value={cfg.network} />
          <InfoRow label="Server URL" value={cfg.serverUrl} />
        </div>
      </section>

      {/* Alert Thresholds */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Alert Thresholds</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Trigger alerts when these limits are crossed</p>
        </div>
        <div className="divide-y divide-zinc-800">
          <ThresholdInput
            label="Rate Limit Hits"
            description="Alert when rate limit hits exceed this per minute"
            value={thresholds.rateLimitHitsPerMinute}
            unit="hits/min"
            min={1}
            max={500}
            onChange={setThreshold("rateLimitHitsPerMinute")}
          />
          <ThresholdInput
            label="Failure Rate"
            description="Alert when pipeline failure rate exceeds this percentage"
            value={thresholds.failureRatePercent}
            unit="% failures"
            min={1}
            max={100}
            onChange={setThreshold("failureRatePercent")}
          />
          <ThresholdInput
            label="L1 Finality Warning"
            description="Sentry warning threshold for Algorand block finality latency"
            value={thresholds.finalityWarningMs}
            unit="ms"
            min={1000}
            max={30000}
            onChange={setThreshold("finalityWarningMs")}
          />
          <ThresholdInput
            label="Min Settlements/Hour"
            description="Alert if settlements drop below this rate (0 = disabled)"
            value={thresholds.minSettlementsPerHour}
            unit="per hour"
            min={0}
            max={10000}
            onChange={setThreshold("minSettlementsPerHour")}
          />
        </div>
      </section>

      {/* Notifications */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Notifications</h2>
        <div className="divide-y divide-zinc-800">
          <Toggle label="Settlement Alerts"    description="Get notified on successful settlements"   checked={notifs.settlementAlerts}    onChange={setNotif("settlementAlerts")} />
          <Toggle label="Failure Alerts"       description="Get notified on execution failures"       checked={notifs.failureAlerts}       onChange={setNotif("failureAlerts")} />
          <Toggle label="Rate Limit Warnings"  description="Alert when approaching rate limits"       checked={notifs.rateLimitWarnings}   onChange={setNotif("rateLimitWarnings")} />
          <Toggle label="API Key Events"       description="Notify on key creation or revocation"    checked={notifs.apiKeyEvents}        onChange={setNotif("apiKeyEvents")} />
          <Toggle label="Weekly Digest"        description="Receive weekly summary email"             checked={notifs.weeklyDigest}        onChange={setNotif("weeklyDigest")} />
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
                  <td className="py-3 pr-4 font-mono text-zinc-300 text-xs">{r.endpoint}</td>
                  <td className="py-3 pr-4 text-zinc-400">{r.limit}</td>
                  <td className="py-3 pr-4 text-zinc-400">{r.window}</td>
                  <td className="py-3 text-zinc-400">{r.burst}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-600 mt-3">
          Rate limits enforced per API key via Upstash Redis sliding window.
        </p>
      </section>

      {/* Save */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
            saved
              ? "bg-emerald-700 text-white"
              : "bg-emerald-600 hover:bg-emerald-500 text-white"
          }`}
        >
          {saved ? "Saved ✓" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
