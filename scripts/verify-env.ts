/**
 * verify-env — Diff local .env against Railway production config
 *
 * Compares critical environment variables between the local process
 * and the Railway production service. Catches mismatches that cause
 * silent auth or signing failures (e.g. truncated secrets, stale addresses).
 *
 * Usage:
 *   npm run verify-env
 *   npm run verify-env -- --service algo-ai-wallet
 *
 * Requires:
 *   - `railway` CLI installed and authenticated
 *   - PORTAL_API_SECRET etc. set in local .env
 *
 * Run before any sprint that touches auth, signing, or Redis config.
 */

import { execSync } from "child_process";
import "dotenv/config";

// ── Vars to check ──────────────────────────────────────────────────

const CHECKS: Array<{
  name: string;
  /** If true, compare full value. If false, compare derived form only. */
  sensitive?: boolean;
  /** Optional transform applied to both sides before comparing (e.g. derive address) */
  transform?: (value: string) => string;
}> = [
  { name: "ALGO_SIGNER_ADDRESS" },
  { name: "X402_PAY_TO_ADDRESS" },
  { name: "ROCCA_SIGNER_ADDRESS" },
  { name: "UPSTASH_REDIS_REST_URL" },
  {
    name: "PORTAL_API_SECRET",
    sensitive: true,
    // Compare length + first 8 chars only — enough to detect truncation without logging secrets
    transform: (v) => `len=${v.length} prefix=${v.slice(0, 8)}`,
  },
  {
    name: "ALGO_SIGNER_MNEMONIC",
    sensitive: true,
    // Derive address from mnemonic — never log the mnemonic itself
    transform: (v) => {
      try {
        const algosdk = require("algosdk");
        return algosdk.mnemonicToSecretKey(v).addr.toString();
      } catch {
        return "(invalid mnemonic)";
      }
    },
  },
];

// ── Railway fetch ──────────────────────────────────────────────────

function getRailwayVar(name: string, service?: string): string | null {
  try {
    const serviceFlag = service ? `--service "${service}"` : "";
    // Use `railway run` to echo the var from the production context
    const raw = execSync(
      `railway run ${serviceFlag} node -e "process.stdout.write(process.env.${name} ?? '')"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return raw.trim() || null;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const service = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  console.log(`\nverify-env — comparing local .env vs Railway production`);
  if (service) console.log(`Service: ${service}`);
  console.log("─".repeat(60));

  let anyMismatch = false;

  for (const check of CHECKS) {
    const localRaw = process.env[check.name] ?? null;
    const railwayRaw = getRailwayVar(check.name, service);

    const local   = localRaw   ? (check.transform ? check.transform(localRaw)   : localRaw)   : null;
    const railway = railwayRaw ? (check.transform ? check.transform(railwayRaw) : railwayRaw) : null;

    const localDisplay   = local   ?? "(not set)";
    const railwayDisplay = railway ?? "(not set)";

    if (local === railway) {
      console.log(`✓  ${check.name}`);
      if (check.sensitive && local) {
        console.log(`   ${localDisplay}`);
      }
    } else {
      anyMismatch = true;
      console.log(`✗  ${check.name}  MISMATCH`);
      console.log(`   local:   ${localDisplay}`);
      console.log(`   railway: ${railwayDisplay}`);
    }
  }

  console.log("─".repeat(60));

  if (anyMismatch) {
    console.log(`\nMISMATCH detected — resolve before debugging auth or signing failures.\n`);
    process.exit(1);
  } else {
    console.log(`\nAll vars match.\n`);
  }
}

main().catch((err) => {
  console.error("[verify-env] Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
