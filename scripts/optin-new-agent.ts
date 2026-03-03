import algosdk from "algosdk";
import "dotenv/config";

const MNEMONIC      = process.env.ALGO_MNEMONIC;
const USDC_ASSET_ID = 31566704n;
const NODE_URL      = process.env.ALGO_CLIENT_NODE_URL || "https://mainnet-api.algonode.cloud";

if (!MNEMONIC) {
  console.error("ALGO_MNEMONIC env var required");
  process.exit(1);
}

async function main() {
  const account = algosdk.mnemonicToSecretKey(MNEMONIC!);
  const ADDRESS  = account.addr.toString();
  const algod    = new algosdk.Algodv2("", NODE_URL, "");
  const info     = await algod.accountInformation(ADDRESS).do();
  console.log("Address:", ADDRESS);
  console.log("ALGO balance:", Number(info.amount) / 1e6);

  const already = (info.assets ?? []).some(
    (a: { assetId: bigint }) => a.assetId === USDC_ASSET_ID,
  );
  if (already) { console.log("Already opted into USDC!"); return; }

  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: ADDRESS, receiver: ADDRESS, amount: 0n,
    assetIndex: USDC_ASSET_ID, suggestedParams: params,
    note: new Uint8Array(Buffer.from("x402:usdc-optin")),
  });
  const signed = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  console.log("Opt-in submitted:", txid);
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log("Confirmed! Send USDC to:", ADDRESS);
}

main().catch(e => { console.error(e.message); process.exit(1); });
