/**
 * Refund all showcase agent contracts with USDC from operator.
 * Tops each up to 220,001 µUSDC (20 payments × $0.01 + 1 µUSDC dust).
 */
import algosdk from "algosdk";
import fs from "fs";
import "dotenv/config";

const USDC_ASA_ID  = 31566704n;
const TARGET_USDC  = 220_001n; // µUSDC per contract

async function main() {
  const algod    = new algosdk.Algodv2("", process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.algonode.cloud", "");
  const operator = algosdk.mnemonicToSecretKey(process.env.OPERATOR_MNEMONIC!);

  const cfg = JSON.parse(fs.readFileSync("scripts/showcase-agents.json", "utf8"));

  for (const agent of cfg.agents) {
    const info      = await algod.accountInformation(agent.appAddress).do();
    const usdcEntry = (info.assets ?? []).find((a: any) => Number(a['asset-id'] ?? a.assetId) === 31566704);
    const current   = BigInt(usdcEntry?.amount ?? 0);
    const topUp     = TARGET_USDC - current;

    if (topUp <= 0n) {
      console.log(`  app=${agent.mandateAppId}  already funded (${current} µUSDC)`);
      continue;
    }

    const params = await algod.getTransactionParams().do();
    const txn    = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender:          operator.addr.toString(),
      receiver:        agent.appAddress,
      assetIndex:      USDC_ASA_ID,
      amount:          topUp,
      suggestedParams: params,
    });
    const { txid } = await algod.sendRawTransaction(txn.signTxn(operator.sk)).do() as { txid: string };
    await algosdk.waitForConfirmation(algod, txid, 5);
    console.log(`  ✔ app=${agent.mandateAppId}  topped up ${topUp} µUSDC  txid=${txid.slice(0,12)}...`);
  }

  console.log("\nDone. Final balances:");
  for (const agent of cfg.agents) {
    const info      = await algod.accountInformation(agent.appAddress).do();
    const usdcEntry = (info.assets ?? []).find((a: any) => Number(a['asset-id'] ?? a.assetId) === 31566704);
    console.log(`  app=${agent.mandateAppId}  ${Number(usdcEntry?.amount ?? 0)/1e6} USDC`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
