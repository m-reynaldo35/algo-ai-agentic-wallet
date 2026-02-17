/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  TEAL Compiler — Agent Spending Policy LogicSig                 ║
 * ║                                                                  ║
 * ║  Compiles contracts/teal/agentPolicy.teal via the Algod REST    ║
 * ║  API and outputs the LogicSig as a base64 byte array.           ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    npx tsx scripts/compile-teal.ts                               ║
 * ║                                                                  ║
 * ║  Environment (optional — defaults to public Algorand testnet):   ║
 * ║    ALGORAND_NODE_URL   — Algod REST endpoint                     ║
 * ║    ALGORAND_NODE_TOKEN — Algod API token                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import algosdk from "algosdk";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────
const NODE_URL = process.env.ALGORAND_NODE_URL || "https://testnet-api.4160.nodely.dev";
const NODE_TOKEN = process.env.ALGORAND_NODE_TOKEN || "";

const TEAL_PATH = resolve(__dirname, "../contracts/teal/agentPolicy.teal");
const OUTPUT_PATH = resolve(__dirname, "../contracts/teal/agentPolicy.compiled.json");

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("[compile-teal] Reading TEAL source...");
  const tealSource = readFileSync(TEAL_PATH, "utf-8");
  console.log(`[compile-teal] Source: ${TEAL_PATH} (${tealSource.length} bytes)`);

  console.log(`[compile-teal] Connecting to Algod: ${NODE_URL}`);
  const algod = new algosdk.Algodv2(NODE_TOKEN, NODE_URL);

  console.log("[compile-teal] Compiling via Algod /v2/teal/compile ...");
  const compiled = await algod.compile(tealSource).do();

  // compiled.result is the base64-encoded program bytes
  const programBytes = new Uint8Array(Buffer.from(compiled.result, "base64"));
  const logicSig = new algosdk.LogicSigAccount(programBytes);

  console.log("[compile-teal] Compilation successful.");
  console.log(`[compile-teal]   Program hash:  ${compiled.hash}`);
  console.log(`[compile-teal]   Program bytes: ${programBytes.length}`);
  console.log(`[compile-teal]   Base64 length: ${compiled.result.length}`);

  // ── Write output ────────────────────────────────────────────────
  const output = {
    hash: compiled.hash,
    programBase64: compiled.result,
    programLength: programBytes.length,
    logicSigBase64: Buffer.from(logicSig.toByte()).toString("base64"),
    compiledAt: new Date().toISOString(),
    source: "contracts/teal/agentPolicy.teal",
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`[compile-teal] Output written: ${OUTPUT_PATH}`);

  console.log("\n── LogicSig Base64 ──────────────────────────────────");
  console.log(output.logicSigBase64);
  console.log("─────────────────────────────────────────────────────\n");

  console.log("[compile-teal] Done. The LogicSigAccount is ready for delegation.");
  console.log("[compile-teal] To delegate: call logicSig.sign(agentSecretKey) with the agent's Ed25519 key.");
}

main().catch((err) => {
  console.error("[compile-teal] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
