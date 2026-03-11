#!/usr/bin/env tsx
/**
 * Generate a new Algorand wallet and print the address + mnemonic.
 *
 * Usage:
 *   tsx scripts/gen-wallet.ts [label]
 *
 * Examples:
 *   tsx scripts/gen-wallet.ts treasury
 *   tsx scripts/gen-wallet.ts signer
 *   tsx scripts/gen-wallet.ts cold
 *
 * SECURITY: The mnemonic is printed ONCE to stdout. Copy it immediately to
 * your password manager (1Password / Bitwarden) or hardware wallet.
 * Never commit the output.
 */

import algosdk from "algosdk";

const label = process.argv[2] || "wallet";
const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

console.log("");
console.log(`=== NEW ${label.toUpperCase()} WALLET ===`);
console.log("");
console.log("Address:  ", account.addr.toString());
console.log("Mnemonic: ", mnemonic);
console.log("");
console.log("Next steps:");
console.log("  1. Save the mnemonic to your password manager NOW — this is shown only once.");
console.log("  2. Fund the wallet with ALGO before use.");
console.log("  3. Run: ALGO_MNEMONIC=\"<mnemonic>\" tsx scripts/optin-usdc.ts");
console.log("     (if this wallet needs to receive USDC)");
console.log("");
