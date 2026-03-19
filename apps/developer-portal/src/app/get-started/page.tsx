import Link from "next/link";

export const metadata = {
  title: "Get Started — algo-wallet",
  description: "What you need to use algo-wallet: an Algorand wallet, ALGO for gas, and USDC to spend.",
};

const STEPS = [
  {
    number: "1",
    title: "Install Pera Wallet",
    body: "Pera is the official Algorand wallet app. It handles sign-in and mandate approvals — scan a QR, tap Approve, done.",
    links: [
      { label: "Pera iOS", href: "https://apps.apple.com/app/pera-algo-wallet/id1459128103" },
      { label: "Pera Android", href: "https://play.google.com/store/apps/details?id=com.algorand.android" },
      { label: "Pera Web", href: "https://web.perawallet.app" },
    ],
    note: "Defly Wallet also works — it supports the same WalletConnect sign-in.",
  },
  {
    number: "2",
    title: "Get ALGO for gas",
    body: "Your AI agent needs a small amount of ALGO to cover Algorand network fees and its minimum balance reserve. 1 ALGO is plenty — it costs around $0.15 and covers hundreds of transactions.",
    links: [
      { label: "Coinbase", href: "https://coinbase.com" },
      { label: "Binance", href: "https://binance.com" },
      { label: "Kraken", href: "https://kraken.com" },
    ],
    note: "Buy ALGO on any major exchange, then send it to your Pera wallet address. You need at least 0.5 ALGO to activate each agent.",
  },
  {
    number: "3",
    title: "Get USDC on Algorand",
    body: "USDC is the currency your agent uses to pay for API calls. It must be Algorand-native USDC — not EVM USDC from Ethereum or Solana.",
    links: [
      { label: "Coinbase (withdraw to Algorand)", href: "https://coinbase.com" },
      { label: "Binance (USDC/Algorand)", href: "https://binance.com" },
      { label: "Testnet faucet (Folks Finance)", href: "https://testnet.folks.finance" },
    ],
    note: "When withdrawing from an exchange, select Algorand as the network. ASA ID: 31566704 (mainnet) / 10458941 (testnet).",
  },
];

export default function GetStartedPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 max-w-4xl mx-auto">
        <Link href="/" className="font-semibold text-white tracking-tight">algo-wallet</Link>
        <Link href="/app/login" className="text-sm text-zinc-400 hover:text-white transition-colors">
          Already set up? Sign in →
        </Link>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-14">

        <div className="mb-12">
          <div className="inline-flex items-center gap-2 bg-amber-950/60 border border-amber-800/50 text-amber-400 text-xs px-3 py-1 rounded-full mb-6">
            Prerequisites
          </div>
          <h1 className="text-3xl font-bold text-white mb-3">Before you sign in</h1>
          <p className="text-zinc-400 leading-relaxed">
            algo-wallet is built on Algorand. To use it you need an Algorand wallet, a small amount
            of ALGO for gas, and USDC to fund your agent&apos;s spending. Setup takes about 10 minutes
            if you&apos;re starting from scratch.
          </p>
        </div>

        {/* Two paths */}
        <div className="grid sm:grid-cols-2 gap-4 mb-14">
          <div className="bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-5">
            <p className="text-emerald-400 font-semibold text-sm mb-2">Already have Pera + ALGO?</p>
            <p className="text-zinc-400 text-sm leading-relaxed mb-4">
              Skip this guide and sign in directly. You can fund your agent with USDC from the dashboard.
            </p>
            <Link
              href="/app/login"
              className="inline-flex items-center gap-1 text-emerald-400 text-sm font-medium hover:text-emerald-300 transition-colors"
            >
              Sign in now →
            </Link>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className="text-white font-semibold text-sm mb-2">Building an AI agent?</p>
            <p className="text-zinc-400 text-sm leading-relaxed mb-4">
              Use the API directly — no dashboard required. Create an agent, get the mnemonic, add it
              to your app&apos;s env vars.
            </p>
            <a
              href="/docs"
              className="inline-flex items-center gap-1 text-zinc-300 text-sm font-medium hover:text-white transition-colors"
            >
              Read the API docs →
            </a>
          </div>
        </div>

        {/* Setup steps */}
        <div className="space-y-10">
          {STEPS.map(({ number, title, body, links, note }) => (
            <div key={number} className="flex gap-5">
              <div className="shrink-0 w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-400 text-sm font-bold">
                {number}
              </div>
              <div className="flex-1 pt-0.5">
                <h2 className="text-white font-semibold mb-2">{title}</h2>
                <p className="text-zinc-400 text-sm leading-relaxed mb-3">{body}</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {links.map(({ label, href }) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 px-3 py-1.5 rounded-md transition-colors"
                    >
                      {label}
                      <svg className="w-3 h-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  ))}
                </div>
                <p className="text-zinc-600 text-xs leading-relaxed">{note}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Two-wallet explainer */}
        <div className="mt-14 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-white font-semibold mb-3">How the two wallets work</h3>
          <p className="text-zinc-400 text-sm leading-relaxed mb-5">
            algo-wallet uses two separate Algorand addresses — this is intentional.
          </p>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 w-6 h-6 rounded bg-violet-900/50 border border-violet-700 flex items-center justify-center text-violet-400 text-xs font-bold shrink-0">P</span>
              <div>
                <p className="text-white text-sm font-medium">Your Pera wallet — identity &amp; governance</p>
                <p className="text-zinc-500 text-xs mt-0.5 leading-relaxed">Signs you in and approves spending limits (mandates). You keep full control. This wallet is never rekeyed.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 w-6 h-6 rounded bg-emerald-900/50 border border-emerald-700 flex items-center justify-center text-emerald-400 text-xs font-bold shrink-0">A</span>
              <div>
                <p className="text-white text-sm font-medium">Your agent wallet — AI payment funds</p>
                <p className="text-zinc-500 text-xs mt-0.5 leading-relaxed">Holds the USDC your AI spends. Rekeyed to Rocca so it can pay autonomously within your mandate limits. You hold the signing key — the server never does.</p>
              </div>
            </div>
          </div>
          <p className="text-zinc-600 text-xs mt-5 leading-relaxed border-t border-zinc-800 pt-4">
            The separation means a compromised agent key only exposes the agent&apos;s spending funds — your main Pera wallet is completely untouched.
          </p>
        </div>

        {/* Final CTA */}
        <div className="mt-10 text-center">
          <p className="text-zinc-500 text-sm mb-4">Got Pera, ALGO, and USDC? You&apos;re ready.</p>
          <Link
            href="/app/login"
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-3 rounded-lg transition-colors text-sm"
          >
            Sign in with Pera →
          </Link>
        </div>

      </div>
    </div>
  );
}
