import algosdk from "algosdk";
import "dotenv/config";

const NODE_URL       = "https://mainnet-api.4160.nodely.dev";
const USDC_ASSET_ID  = 31566704n;
const SPEED_TEST_AGENT = "MERZZEJLQ3TNPGW3J7UXQFPNMDWBGOLUUZ7C5KA5KGP4DVMXINUQR56FFI";
const WEATHER_AGENT    = "ZBYZFOXJEKC6IBR47DEUF46QLNH7NOLJBYUPSDQDKH43PZUBQ7LGKHG4AQ";

const cohortA = algosdk.mnemonicToSecretKey(process.env.ALGO_SIGNER_MNEMONIC!);
const algod   = new algosdk.Algodv2("", NODE_URL, "");

async function main() {
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          SPEED_TEST_AGENT,
    receiver:        WEATHER_AGENT,
    amount:          50_000n,
    assetIndex:      USDC_ASSET_ID,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from("x402:topup:weather-test-agent")),
  });

  const { txid } = await algod.sendRawTransaction(txn.signTxn(cohortA.sk)).do();
  console.log("Sent. txid:", txid);
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log("Confirmed. weather-test-agent topped up with 50,000 µUSDC");
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
