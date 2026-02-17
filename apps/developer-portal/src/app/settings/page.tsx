import SettingsForm from "@/components/settings/SettingsForm";

export const metadata = {
  title: "Settings — x402 Developer Portal",
  description: "Account settings and configuration",
};

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
        <p className="text-zinc-400 mt-2 text-lg">
          Account configuration, notifications, and rate limit policies.
        </p>
      </div>

      <SettingsForm />
    </div>
  );
}
