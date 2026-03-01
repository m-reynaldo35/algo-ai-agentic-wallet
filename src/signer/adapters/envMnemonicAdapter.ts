/**
 * EnvMnemonic Adapter — Environment Variable Key Backend
 *
 * The original key loading strategy: decode ALGO_SIGNER_MNEMONIC from
 * the environment into an Ed25519 keypair and sign in-process.
 *
 * Suitable for development and Phase 1 production deployments where
 * the mnemonic is stored in a secret vault (Railway / Vercel secrets)
 * rather than a dedicated HSM.
 *
 * For higher key-material security, replace with VaultTransitAdapter.
 */

import algosdk from "algosdk";
import type { SignerAdapter } from "./signerAdapter.js";

export class EnvMnemonicAdapter implements SignerAdapter {
  private _account: algosdk.Account | null = null;

  private getAccount(): algosdk.Account {
    if (this._account) return this._account;

    const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
    if (mnemonic) {
      this._account = algosdk.mnemonicToSecretKey(mnemonic);
      console.log(`[EnvMnemonicAdapter] Persistent signer loaded: ${this._account.addr}`);
      console.log(`[EnvMnemonicAdapter] Ensure this address is funded before broadcasting transactions.`);
    } else {
      this._account = algosdk.generateAccount();
      console.warn(`[EnvMnemonicAdapter] DEV MODE: Ephemeral signer created: ${this._account.addr}`);
      console.warn(`[EnvMnemonicAdapter] Set ALGO_SIGNER_MNEMONIC for a persistent, funded signer.`);
    }

    return this._account;
  }

  async getPublicAddress(): Promise<string> {
    return this.getAccount().addr.toString();
  }

  async signRawBytes(bytesToSign: Uint8Array): Promise<Uint8Array> {
    const account = this.getAccount();
    // Use rawSignTxn which takes the secret key and signs the pre-built
    // bytesToSign buffer, returning only the 64-byte raw Ed25519 signature.
    // The caller attaches it via txn.attachSignature(addr, rawSig).
    //
    // Note: rawSignTxn(sk) extracts the 32-byte seed from the 64-byte sk
    // and passes the full 64-byte sk to nacl.sign.detached(bytesToSign, sk).
    // This matches what txn.signTxn(sk) does internally.
    //
    // We re-create a minimal Transaction to access rawSignTxn by decoding
    // the input bytes: bytesToSign = b"TX" + msgpack(txn), so we cannot
    // call rawSignTxn directly without the Transaction object.
    // Instead, use nacl directly via the account secret key.
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached(bytesToSign, account.sk);
  }

  async healthCheck(): Promise<void> {
    this.getAccount(); // throws if mnemonic is invalid
  }
}
