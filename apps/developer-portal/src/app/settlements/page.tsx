import SettlementTable from "@/components/settlements/SettlementTable";

export const metadata = {
  title: "Settlements — x402 Developer Portal",
  description: "View and filter x402 protocol settlements",
};

export default function SettlementsPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">Settlements</h1>
        <p className="text-zinc-400 mt-2 text-lg">
          On-chain settlement history with oracle context and audit trail.
        </p>
      </div>

      <SettlementTable />
    </div>
  );
}
