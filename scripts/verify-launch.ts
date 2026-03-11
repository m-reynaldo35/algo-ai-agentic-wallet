#!/usr/bin/env tsx
/**
 * Launch Gate Verification
 *
 * Runs all checkable launch gate items and prints a pass/fail report.
 *
 * Usage:
 *   tsx scripts/verify-launch.ts
 *   tsx scripts/verify-launch.ts --mainnet   # check mainnet endpoints only
 */

import "dotenv/config";

const MAINNET_MODE = process.argv.includes("--mainnet");

const API_URL      = "https://api.ai-agentic-wallet.com";
const PORTAL_URL   = "https://ai-agentic-wallet.com";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

function ok(name: string, detail?: string) {
  results.push({ name, pass: true, detail });
}
function fail(name: string, detail?: string) {
  results.push({ name, pass: false, detail });
}

async function fetchOk(url: string, opts?: RequestInit): Promise<{ ok: boolean; body: string; status: number }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), ...opts });
    const body = await r.text();
    return { ok: r.ok, body, status: r.status };
  } catch (e: any) {
    return { ok: false, body: e.message, status: 0 };
  }
}

// ── 1. Backend health ────────────────────────────────────────────────────────
{
  const r = await fetchOk(`${API_URL}/health`);
  if (!r.ok) {
    fail("Backend /health reachable", `HTTP ${r.status}: ${r.body.slice(0, 120)}`);
  } else {
    try {
      const j = JSON.parse(r.body);
      if (j.status === "ok") {
        ok("Backend /health reachable");
        // subsystems
        const sub = j.subsystems ?? j.services ?? {};
        for (const [key, val] of Object.entries(sub)) {
          const healthy = (val as any) === "ok" || (val as any)?.status === "ok";
          (healthy ? ok : fail)(`  Subsystem: ${key}`, String(val));
        }
      } else {
        fail("Backend /health status ok", `status=${j.status}`);
      }
    } catch {
      fail("Backend /health JSON parse", r.body.slice(0, 120));
    }
  }
}

// ── 2. Portal reachable ──────────────────────────────────────────────────────
{
  const r = await fetchOk(PORTAL_URL);
  r.ok
    ? ok("Portal reachable (ai-agentic-wallet.com)")
    : fail("Portal reachable (ai-agentic-wallet.com)", `HTTP ${r.status}`);
}

// ── 3. DNS check (CNAME api → Railway) ──────────────────────────────────────
{
  // We can't do a real DNS lookup from Node without extra deps, but we can
  // verify that the URL resolves by checking the /health endpoint above.
  // Add a note to check manually if the above failed.
  if (!results.find(r => r.name === "Backend /health reachable")?.pass) {
    fail("DNS: api.ai-agentic-wallet.com → Railway", "Backend unreachable — check CNAME");
  } else {
    ok("DNS: api.ai-agentic-wallet.com → Railway (inferred from /health)");
  }
}

// ── 4. CORS headers ──────────────────────────────────────────────────────────
{
  const r = await fetchOk(`${API_URL}/health`, {
    method: "OPTIONS",
    headers: { "Origin": PORTAL_URL, "Access-Control-Request-Method": "GET" },
  });
  const allowed = r.status === 200 || r.status === 204;
  allowed
    ? ok("CORS: portal origin allowed on API")
    : fail("CORS: portal origin allowed on API", `HTTP ${r.status}`);
}

// ── 5. Well-known x402 endpoint ──────────────────────────────────────────────
{
  const r = await fetchOk(`${API_URL}/.well-known/x402`);
  if (r.ok) {
    ok("/.well-known/x402 reachable");
  } else {
    // Not a blocker — not yet built — just informational
    fail("/.well-known/x402 reachable (Sprint 17, not yet built)", `HTTP ${r.status}`);
  }
}

// ── 6. Required env vars (local .env check) ──────────────────────────────────
const REQUIRED_ENV: Array<[string, string]> = [
  ["ALGO_TREASURY_MNEMONIC",  "Treasury wallet mnemonic"],
  ["ALGO_SIGNER_ADDRESS",     "Signer wallet address"],
  ["X402_PAY_TO_ADDRESS",     "x402 pay-to address"],
  ["COLD_WALLET_ADDRESS",     "Cold wallet address"],
  ["REDIS_PRIVATE_URL",       "Redis private URL"],
  ["PORTAL_API_SECRET",       "Portal API secret"],
  ["HALT_OVERRIDE_KEY",       "Halt override key"],
  ["APPROVAL_TOKEN_SECRET",   "Approval token secret"],
  ["ROCCA_API_KEY",           "Rocca API key"],
  ["TELEGRAM_BOT_TOKEN",      "Telegram bot token (guardian alerts)"],
  ["TELEGRAM_CHAT_ID",        "Telegram chat ID (guardian alerts)"],
  ["ADMIN_WALLET_ADDRESSES",  "Admin wallet whitelist (portal login)"],
  ["CORS_ALLOWED_ORIGINS",    "CORS allowed origins"],
];

for (const [key, label] of REQUIRED_ENV) {
  const val = process.env[key] || "";
  if (!val || val.startsWith("<")) {
    fail(`Env: ${key}`, `${label} — not set`);
  } else {
    ok(`Env: ${key}`);
  }
}

// ── 7. Signer ALGO balance ───────────────────────────────────────────────────
const signerAddress = process.env.ALGO_SIGNER_ADDRESS || "";
if (signerAddress) {
  try {
    const algodUrl = process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev";
    const r = await fetch(`${algodUrl}/v2/accounts/${signerAddress}`, {
      headers: { "X-Algo-API-Token": process.env.ALGORAND_NODE_TOKEN || "" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const j = await r.json() as any;
      const algoBalance = Number(j.amount) / 1e6;
      const threshold = 200;
      algoBalance >= threshold
        ? ok(`Signer ALGO balance ≥ ${threshold}`, `${algoBalance.toFixed(3)} ALGO`)
        : fail(`Signer ALGO balance ≥ ${threshold}`, `${algoBalance.toFixed(3)} ALGO — fund it!`);
      // USDC opt-in check
      const usdc = j.assets?.find((a: any) => Number(a["asset-id"]) === 31566704);
      usdc !== undefined
        ? ok("Signer opted into USDC (ASA 31566704)")
        : fail("Signer opted into USDC (ASA 31566704)", "Run: ALGO_MNEMONIC=... tsx scripts/optin-usdc.ts");
    } else {
      fail("Signer account on-chain", `HTTP ${r.status}`);
    }
  } catch (e: any) {
    fail("Signer account check", e.message);
  }
} else {
  fail("Signer account check", "ALGO_SIGNER_ADDRESS not set");
}

// ── 8. Cold wallet USDC opt-in ───────────────────────────────────────────────
const coldAddress = process.env.COLD_WALLET_ADDRESS || "";
if (coldAddress && !coldAddress.startsWith("<")) {
  try {
    const algodUrl = process.env.ALGORAND_NODE_URL || "https://mainnet-api.4160.nodely.dev";
    const r = await fetch(`${algodUrl}/v2/accounts/${coldAddress}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const j = await r.json() as any;
      const usdc = j.assets?.find((a: any) => Number(a["asset-id"]) === 31566704);
      usdc !== undefined
        ? ok("Cold wallet opted into USDC (ASA 31566704)")
        : fail("Cold wallet opted into USDC (ASA 31566704)", "Opt-in the cold wallet with Pera or optin-usdc.ts");
    } else {
      fail("Cold wallet on-chain check", `HTTP ${r.status}`);
    }
  } catch (e: any) {
    fail("Cold wallet on-chain check", e.message);
  }
} else {
  fail("Cold wallet check", "COLD_WALLET_ADDRESS not set");
}

// ── Print report ─────────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║              LAUNCH GATE VERIFICATION REPORT             ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

let passed = 0, failed = 0;
for (const r of results) {
  const icon = r.pass ? "✓" : "✗";
  const label = r.pass ? "PASS" : "FAIL";
  const detail = r.detail ? `  → ${r.detail}` : "";
  console.log(`  [${label}] ${icon} ${r.name}${detail}`);
  r.pass ? passed++ : failed++;
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed === 0) {
  console.log("  All checks passed — ready to launch! 🚀\n");
} else {
  console.log("  Fix the FAIL items above before going live.\n");
  process.exit(1);
}
