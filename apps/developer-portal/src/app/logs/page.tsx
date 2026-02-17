import EventLog from "@/components/logs/EventLog";

export const metadata = {
  title: "Logs — x402 Developer Portal",
  description: "Real-time audit event feed",
};

export default function LogsPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">Event Logs</h1>
        <p className="text-zinc-400 mt-2 text-lg">
          Live audit feed — settlements, security events, and rate limit activity.
        </p>
      </div>

      <EventLog />
    </div>
  );
}
