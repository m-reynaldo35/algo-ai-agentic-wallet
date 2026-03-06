export const metadata = {
  title: "Privacy Policy — algo-wallet",
  description: "Privacy Policy for the algo-wallet x402 payment platform.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: March 2026</p>

        <section className="space-y-8 text-zinc-300 leading-relaxed">

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">1. Overview</h2>
            <p>
              algo-wallet (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the x402 payment
              routing platform at <span className="text-zinc-400">ai-agentic-wallet.com</span> and
              its API at <span className="text-zinc-400">api.ai-agentic-wallet.com</span>.
              This Privacy Policy explains what data we collect, how we use it, and your rights.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">2. Data We Collect</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong className="text-white">Algorand addresses</strong> — public blockchain
                addresses you register as agents. These are public by nature.
              </li>
              <li>
                <strong className="text-white">Transaction metadata</strong> — settlement
                timestamps, amounts, and transaction IDs stored for audit and velocity enforcement.
                All amounts are in micro-USDC.
              </li>
              <li>
                <strong className="text-white">API usage telemetry</strong> — request counts,
                error rates, and latency metrics. No request body content is retained.
              </li>
              <li>
                <strong className="text-white">IP addresses</strong> — hashed (SHA-256) for rate
                limiting. Raw IPs are never stored persistently.
              </li>
              <li>
                <strong className="text-white">WebAuthn credentials</strong> — public-key
                credentials only. Private keys never leave your device.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">3. Data We Do NOT Collect</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Algorand mnemonics or private keys (never transmitted to our servers)</li>
              <li>Names, email addresses, or personally identifying information</li>
              <li>Cookies or cross-site tracking identifiers</li>
              <li>Payment card information</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">4. How We Use Data</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Enforcing velocity limits and fraud detection</li>
              <li>Providing settlement history in the developer portal</li>
              <li>Operating the Wallet Guardian and on-chain monitor</li>
              <li>Debugging and improving system reliability</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">5. Data Retention</h2>
            <p>
              Settlement records are retained for 7 days in Redis. Aggregated telemetry metrics
              are retained for 30 days. Velocity window data auto-expires after each rolling window
              (10 minutes or 24 hours). Recipient anomaly records expire after 90 days.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">6. Third Parties</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong className="text-white">Algorand / Nodely</strong> — blockchain node
                providers. Transaction data is public on-chain by design.
              </li>
              <li>
                <strong className="text-white">Railway</strong> — infrastructure hosting for the
                API and Redis. Subject to Railway&apos;s privacy policy.
              </li>
              <li>
                <strong className="text-white">Sentry</strong> — error monitoring. Sentry receives
                error stack traces and request paths, but not request bodies or mnemonics.
              </li>
            </ul>
            <p className="mt-3">We do not sell data to third parties.</p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">7. Your Rights</h2>
            <p>
              Because we do not collect personally identifying information, most GDPR/CCPA rights
              (access, deletion, portability) apply only to your on-chain Algorand address, which
              is public by the nature of the blockchain and cannot be deleted. You may delete your
              agent registry entry via the developer portal at any time.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">8. Contact</h2>
            <p>
              Questions? Reach out via the developer portal or open an issue on{" "}
              <a
                href="https://github.com/algo-wallet/algo-wallet/issues"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                GitHub
              </a>.
            </p>
          </div>

        </section>

        <div className="mt-12 pt-8 border-t border-zinc-800 text-sm text-zinc-600">
          <a href="/" className="hover:text-zinc-400 transition-colors">← Back to home</a>
          <span className="mx-4">·</span>
          <a href="/terms" className="hover:text-zinc-400 transition-colors">Terms of Service</a>
        </div>
      </div>
    </div>
  );
}
