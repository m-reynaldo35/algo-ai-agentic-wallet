export const metadata = {
  title: "Terms of Service — algo-wallet",
  description: "Terms of Service for the algo-wallet x402 payment platform.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-zinc-500 text-sm mb-10">Last updated: March 2026</p>

        <section className="space-y-8 text-zinc-300 leading-relaxed">

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">1. Acceptance</h2>
            <p>
              By registering an agent or using the algo-wallet API, you agree to these Terms.
              If you do not agree, do not use the service.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">2. Description of Service</h2>
            <p>
              algo-wallet provides an x402-compliant AI-to-AI payment routing protocol on the
              Algorand blockchain. The service signs and broadcasts USDC transactions on behalf
              of registered AI agents within velocity limits set by each agent&apos;s configuration.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">3. Eligibility</h2>
            <p>
              You must be at least 18 years old and have legal authority to bind any entity on
              whose behalf you register agents. The service is not available in jurisdictions where
              USDC transfers or blockchain-based payments are prohibited by law.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">4. Agent Registration</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                You are solely responsible for safeguarding your agent&apos;s 25-word mnemonic.
                We cannot recover lost mnemonics.
              </li>
              <li>
                Registered agents are rekeyed to our Rocca signing service. You retain the
                original private key and may rekey back at any time.
              </li>
              <li>
                You must not register agents for the purpose of fraud, money laundering, sanctions
                evasion, or any unlawful activity.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">5. Velocity Limits and Halts</h2>
            <p>
              We apply per-agent velocity limits (configurable) and may halt signing at any time
              if fraud, drain events, or policy violations are detected. Halts are a security
              feature, not a breach of service. We will notify you via Telegram alert if
              configured.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">6. Fees</h2>
            <p>
              The x402 toll (currently 0.01 USDC per transaction) is non-refundable. It covers
              Algorand network fees and protocol infrastructure. Toll amounts may change with
              notice.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">7. No Financial Advice</h2>
            <p>
              algo-wallet is an infrastructure protocol. Nothing on this platform constitutes
              financial, investment, or legal advice. Blockchain transactions are irreversible —
              you are responsible for verifying recipient addresses and amounts before authorizing
              payments.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">8. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, algo-wallet is not liable for any indirect,
              incidental, or consequential damages arising from use of the service, including but
              not limited to loss of funds due to compromised mnemonics, on-chain failures, or
              network outages. Our maximum liability for any claim is limited to fees paid in the
              30 days preceding the claim.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">9. Termination</h2>
            <p>
              We may suspend or terminate access to the signing service at any time for violations
              of these Terms. You may deregister your agents and rekey your wallet back to your
              own key at any time via the developer portal.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">10. Changes</h2>
            <p>
              We may update these Terms at any time. Continued use of the service after changes
              are posted constitutes acceptance of the revised Terms. Material changes will be
              announced via the portal.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-2">11. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the jurisdiction in which algo-wallet
              is incorporated, without regard to conflict of law provisions.
            </p>
          </div>

        </section>

        <div className="mt-12 pt-8 border-t border-zinc-800 text-sm text-zinc-600">
          <a href="/" className="hover:text-zinc-400 transition-colors">← Back to home</a>
          <span className="mx-4">·</span>
          <a href="/privacy" className="hover:text-zinc-400 transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
