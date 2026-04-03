/**
 * Top-up operator and factory so agent 5 provisioning can complete.
 * Sends from signer wallet (ALGO_SIGNER_MNEMONIC) which has ample ALGO.
 */
import algosdk from "algosdk";
import "dotenv/config";

async function main() {
  const algod = new algosdk.Algodv2("", process.env.ALGO_CLIENT_NODE_URL ?? "https://mainnet-api.algonode.cloud", "");
  const signer   = algosdk.mnemonicToSecretKey(process.env.ALGO_SIGNER_MNEMONIC!);
  const operator = algosdk.mnemonicToSecretKey(process.env.OPERATOR_MNEMONIC!);

  console.log("Signer:", signer.addr.toString());
  console.log("Operator:", operator.addr.toString());

  const signerInfo = await algod.accountInformation(signer.addr.toString()).do();
  console.log(`Signer balance: ${Number(signerInfo.amount)/1e6} ALGO`);

  const params = await algod.getTransactionParams().do();

  // Send 2 ALGO to operator (covers agent 5 wallet + contract + fees)
  const toOperator = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:   signer.addr.toString(),
    receiver: operator.addr.toString(),
    amount:   2_000_000n,
    suggestedParams: params,
  });
  const r1 = await algod.sendRawTransaction(toOperator.signTxn(signer.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, r1.txid, 5);
  console.log(`✔ Sent 2 ALGO to operator  txid=${r1.txid}`);

  // Send 1 ALGO to factory contract account (cover MBR for agent 5 + buffer)
  const toFactory = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:   signer.addr.toString(),
    receiver: "WGS3SAWERLMLF3OYM2V35R2MB3GFDM2RTPOZ2LMN7XRDNUFIMGWEBWZKJQ",
    amount:   1_000_000n,
    suggestedParams: { ...params, firstValid: params.firstValid + 1n },
  });
  const r2 = await algod.sendRawTransaction(toFactory.signTxn(signer.sk)).do() as { txid: string };
  await algosdk.waitForConfirmation(algod, r2.txid, 5);
  console.log(`✔ Sent 1 ALGO to factory   txid=${r2.txid}`);

  const opInfo  = await algod.accountInformation(operator.addr.toString()).do();
  const facInfo = await algod.accountInformation("WGS3SAWERLMLF3OYM2V35R2MB3GFDM2RTPOZ2LMN7XRDNUFIMGWEBWZKJQ").do();
  console.log(`Operator now: ${Number(opInfo.amount)/1e6} ALGO (spendable ${(Number(opInfo.amount)-Number(opInfo.minBalance))/1e6})`);
  console.log(`Factory now:  ${Number(facInfo.amount)/1e6} ALGO (min ${Number(facInfo.minBalance)/1e6})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
