import TelemetryMetrics from "@/components/TelemetryMetrics";
import SettlementChart from "@/components/dashboard/SettlementChart";
import HealthBanner from "@/components/dashboard/HealthBanner";

export const metadata = {
  title: "Dashboard — x402 Developer Portal",
  description: "Real-time x402 protocol telemetry and Gora oracle metrics",
};

export default function DashboardPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">
          x402 Protocol Dashboard
        </h1>
        <p className="text-zinc-400 mt-2 text-lg">
          Real-time settlement telemetry, Gora oracle prices, and security events.
        </p>
      </div>

      <HealthBanner />
      <TelemetryMetrics />

      <div className="mt-8">
        <SettlementChart />
      </div>
    </div>
  );
}
