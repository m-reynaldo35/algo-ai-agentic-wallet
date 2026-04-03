import algosdk from 'algosdk';
async function main() {
  const algod = new algosdk.Algodv2('', 'https://mainnet-api.algonode.cloud', '');
  const op = algosdk.mnemonicToSecretKey(process.env.OPERATOR_MNEMONIC!);
  const [opInfo, factoryInfo] = await Promise.all([
    algod.accountInformation(op.addr.toString()).do(),
    algod.accountInformation('WGS3SAWERLMLF3OYM2V35R2MB3GFDM2RTPOZ2LMN7XRDNUFIMGWEBWZKJQ').do(),
  ]);
  console.log('Operator balance:', Number(opInfo.amount)/1e6, 'ALGO');
  console.log('Operator spendable:', (Number(opInfo.amount) - Number(opInfo.minBalance))/1e6, 'ALGO');
  console.log('Factory balance:', Number(factoryInfo.amount)/1e6, 'ALGO');
  console.log('Factory min:', Number(factoryInfo.minBalance)/1e6, 'ALGO');
  console.log('Shortfall (+ 0.5 buffer):', Math.max(0, (Number(factoryInfo.minBalance) - Number(factoryInfo.amount) + 500_000))/1e6, 'ALGO');
}
main();
