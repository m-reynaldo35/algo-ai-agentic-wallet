import algosdk from "algosdk";
const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
console.log("ADDRESS:", account.addr.toString());
console.log("MNEMONIC:", mnemonic);
