import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const API_URL = process.env.API_URL || "https://ai-agentic-wallet.com";
const PORTAL_SECRET = process.env.PORTAL_API_SECRET || "";

const nextConfig: NextConfig = {
  // Pin the output file tracing root to this app to avoid multiple lockfile warnings
  outputFileTracingRoot: require("path").join(__dirname),
  async rewrites() {
    return [
      // The SSE stream has its own dedicated route handler (/api/live/stream/route.ts)
      // which bypasses this rewrite. All other portal routes use this proxy.
      {
        source: "/api/live/:path*",
        destination: `${API_URL}/api/portal/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        // Inject portal auth secret into all proxied /api/live/* requests
        source: "/api/live/:path*",
        headers: [
          { key: "X-Portal-Key", value: PORTAL_SECRET },
        ],
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
