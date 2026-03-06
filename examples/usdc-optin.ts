import algosdk from "algosdk";
import "dotenv/config";

const USDC_ASSET_ID = 31566704n; // Mainnet USDC
const MNEMONIC = process.env.ALGO_MNEMONIC;
const NODE_URL = process.env.ALGORAND_NODE_URL ?? "https://mainnet-api.4160.nodely.dev";

if (!MNEMONIC) {
  console.error("[FATAL] ALGO_MNEMONIC env var is required");
  process.exit(1);
}

// Derive address from mnemonic, or override with ALGO_ADDRESS
const derived = algosdk.mnemonicToSecretKey(MNEMONIC);
const ADDRESS = process.env.ALGO_ADDRESS ?? derived.addr.toString();

async function main() {
  const algod = new algosdk.Algodv2("", NODE_URL, "");

  // Check balance first
  const info = await algod.accountInformation(ADDRESS).do();
  const algoBalance = Number(info.amount) / 1e6;
  const alreadyOptedIn = info.assets?.some((a: { assetId: bigint }) => a.assetId === USDC_ASSET_ID);

  console.log(`Address:       ${ADDRESS}`);
  console.log(`ALGO balance:  ${algoBalance.toFixed(6)} ALGO`);
  console.log(`USDC opted in: ${alreadyOptedIn ? "YES" : "NO"}`);

  if (alreadyOptedIn) {
    console.log("\nAlready opted into USDC — nothing to do.");
    return;
  }

  if (Number(info.amount) < 200_000) {
    console.error(`\nInsufficient ALGO — need at least 0.2 ALGO, have ${algoBalance.toFixed(6)}`);
    console.error(`Fund this address first: ${ADDRESS}`);
    process.exit(1);
  }

  const params  = await algod.getTransactionParams().do();

  // Opt-in = 0-amount asset transfer to self
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:    ADDRESS,
    receiver:  ADDRESS,
    amount:    0n,
    assetIndex: USDC_ASSET_ID,
    suggestedParams: params,
    note: new Uint8Array(Buffer.from("x402:usdc-optin")),
  });

  const signed = optInTxn.signTxn(derived.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  console.log(`\nOpt-in submitted: ${txid}`);

  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`Confirmed! Explorer: https://allo.info/tx/${txid}`);
  console.log(`\nWallet is now ready for USDC. Send at least 0.01 USDC to:`);
  console.log(`  ${ADDRESS}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
