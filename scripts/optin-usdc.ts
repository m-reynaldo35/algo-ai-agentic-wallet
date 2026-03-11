import "dotenv/config";
import algosdk from "algosdk";

// Usage:
//   ALGO_MNEMONIC="25 words..." tsx scripts/optin-usdc.ts
//   ALGO_TREASURY_MNEMONIC="25 words..." tsx scripts/optin-usdc.ts
const MNEMONIC = process.env.ALGO_MNEMONIC || process.env.ALGO_TREASURY_MNEMONIC || "";
if (!MNEMONIC) {
  console.error("Set ALGO_MNEMONIC (or ALGO_TREASURY_MNEMONIC) env var to the wallet you want to opt in.");
  process.exit(1);
}
const USDC_ASSET_ID = 31566704;

const account = algosdk.mnemonicToSecretKey(MNEMONIC);
const algod = new algosdk.Algodv2("", "https://mainnet-api.4160.nodely.dev", 443);

console.log("Address:", account.addr.toString());

// Check current status
let alreadyOptedIn = false;
try {
  const info = await algod.accountInformation(account.addr.toString()).do();
  const balanceAlgo = Number(info.amount) / 1e6;
  console.log("Balance:", balanceAlgo, "ALGO");
  alreadyOptedIn = !!info.assets?.find((a: any) => Number(a["asset-id"]) === USDC_ASSET_ID);
  console.log("USDC opted-in:", alreadyOptedIn ? "YES" : "NO");

  if (alreadyOptedIn) {
    console.log("Already opted in — nothing to do.");
    process.exit(0);
  }

  if (balanceAlgo < 0.202) {
    console.error("Need at least 0.202 ALGO to opt-in (0.1 min balance + 0.1 ASA reserve + 0.001 fee + buffer). Fund the wallet first.");
    process.exit(1);
  }
} catch (e: any) {
  console.error("Account not yet on-chain — fund it with at least 0.3 ALGO first.");
  process.exit(1);
}

// Submit opt-in (0-amount self-transfer of the ASA)
const sp = await algod.getTransactionParams().do();
const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: account.addr.toString(),
  receiver: account.addr.toString(),
  assetIndex: USDC_ASSET_ID,
  amount: 0,
  suggestedParams: sp,
});

const signed = txn.signTxn(account.sk);
const { txid } = await algod.sendRawTransaction(signed).do();
console.log("Opt-in submitted. TxID:", txid);
console.log("Waiting for confirmation...");

await algosdk.waitForConfirmation(algod, txid, 4);
console.log("Confirmed. Wallet is now opted into USDC (ASA 31566704).");
