import algosdk from "algosdk";
import "dotenv/config";

async function main() {
  const algod = new algosdk.Algodv2("", process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.algonode.cloud", "");
  const op = algosdk.mnemonicToSecretKey(process.env.OPERATOR_MNEMONIC!);
  const info = await algod.accountInformation(op.addr.toString()).do();
  const usdc = (info.assets ?? []).find((a: any) => Number(a['asset-id'] ?? a.assetId) === 31566704);
  console.log("Operator USDC:", usdc ? Number(usdc.amount)/1e6 : "not opted in");

  // Check each showcase agent contract balance
  const { default: fs } = await import("fs");
  const cfg = JSON.parse(fs.readFileSync("scripts/showcase-agents.json", "utf8"));
  console.log("\nAgent contract balances:");
  for (const agent of cfg.agents) {
    const contractInfo = await algod.accountInformation(agent.appAddress).do();
    const contractUsdc = (contractInfo.assets ?? []).find((a: any) => Number(a['asset-id'] ?? a.assetId) === 31566704);
    const contractAlgo = Number(contractInfo.amount)/1e6;
    const contractUsdcAmt = contractUsdc ? Number(contractUsdc.amount)/1e6 : 0;
    console.log(`  app=${agent.mandateAppId}  ${contractAlgo.toFixed(3)} ALGO  ${contractUsdcAmt.toFixed(6)} USDC`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
