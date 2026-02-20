import algosdk from "algosdk";
const algod = new algosdk.Algodv2("", "https://mainnet-api.4160.nodely.dev", 443);
const info = await algod.accountInformation("HG2AG4F36BZFGRCYWOHVITIZ5WIWWY7N3JR3KU3522AWTXGG6JDGPJNTWI").do();
console.log("assets:", JSON.stringify(info.assets, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
