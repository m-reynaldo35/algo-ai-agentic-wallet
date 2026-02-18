import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const API_URL = process.env.API_URL || "https://ai-agentic-wallet.com";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/live/:path*",
        destination: `${API_URL}/api/portal/:path*`,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Sentry org & project (set in CI / Vercel env vars)
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Auth token for source map uploads (SENTRY_AUTH_TOKEN env var)
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload source maps in production builds only
  silent: true,
  widenClientFileUpload: true,


  // Tunnel Sentry requests through your own domain to bypass ad-blockers
  tunnelRoute: "/monitoring",

  // Keep source maps server-side only
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
