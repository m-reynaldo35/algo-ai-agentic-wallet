import algosdk from "algosdk";

const MNEMONIC      = "fog flash verb update fish domain scout modify jacket father finger century cage unable strong provide diary reopen color mean animal inquiry start absorb oven";
const ADDRESS       = "MERZZEJLQ3TNPGW3J7UXQFPNMDWBGOLUUZ7C5KA5KGP4DVMXINUQR56FFI";
const USDC_ASSET_ID = 31566704n;
const NODE_URL      = "https://mainnet-api.4160.nodely.dev";

async function main() {
  const algod = new algosdk.Algodv2("", NODE_URL, "");
  const info  = await algod.accountInformation(ADDRESS).do();
  console.log("ALGO balance:", Number(info.amount) / 1e6);

  const already = (info.assets ?? []).some(
    (a: { assetId: bigint }) => a.assetId === USDC_ASSET_ID,
  );
  if (already) { console.log("Already opted into USDC!"); return; }

  const account = algosdk.mnemonicToSecretKey(MNEMONIC);
  const params  = await algod.getTransactionParams().do();
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
