"""
Deployment script — MandateFactory + MandateContract

Usage:
    # 1. Compile contracts first
    python mandate_contract.py
    python mandate_factory.py

    # 2. Deploy factory (one time, operator only)
    python deploy.py deploy-factory

    # 3. Upload compiled contract programs to factory
    python deploy.py set-programs

    # 4. Test: deploy one agent contract
    python deploy.py create-agent \
        --agent-key  <AGENT_ALGORAND_ADDRESS> \
        --master-key <MASTER_WALLET_ADDRESS>  \
        --max-per-tx 1000000 \
        --velocity   5000000 \
        --daily      50000000

Environment variables required:
    ALGOD_URL          — Algorand node URL
    ALGOD_TOKEN        — Algorand node token (empty string for public nodes)
    OPERATOR_MNEMONIC  — 25-word mnemonic of the operator account
    FACTORY_APP_ID     — set after initial deploy-factory run
    ALGORAND_NETWORK   — mainnet | testnet
"""

import os
import sys
import base64
import argparse
from algosdk import account, mnemonic, transaction
from algosdk.v2client import algod

# ── Client ───────────────────────────────────────────────────────────────────

def get_algod_client():
    url   = os.environ.get("ALGOD_URL", "https://mainnet-api.4160.nodely.dev")
    token = os.environ.get("ALGOD_TOKEN", "")
    return algod.AlgodClient(token, url)

def get_operator_key():
    m = os.environ.get("OPERATOR_MNEMONIC")
    if not m:
        raise ValueError("OPERATOR_MNEMONIC env var not set")
    private_key = mnemonic.to_private_key(m)
    address     = account.address_from_private_key(private_key)
    return private_key, address

def wait_for_confirmation(client: algod.AlgodClient, txid: str):
    last_round = client.status()["last-round"]
    while True:
        try:
            result = client.pending_transaction_info(txid)
            if result.get("confirmed-round", 0) > 0:
                return result
        except Exception:
            pass
        client.status_after_block(last_round + 1)
        last_round += 1

# ── deploy-factory ───────────────────────────────────────────────────────────

def deploy_factory(client: algod.AlgodClient, private_key: str, address: str):
    network  = os.environ.get("ALGORAND_NETWORK", "mainnet")
    usdc_id  = 31_566_704 if network == "mainnet" else 10_458_941
    treasury = os.environ.get("X402_PAY_TO_ADDRESS")
    if not treasury:
        raise ValueError("X402_PAY_TO_ADDRESS env var not set")
    toll = 10_000  # 0.01 USDC

    teal_dir = os.path.join(os.path.dirname(__file__), "..", "teal")

    with open(os.path.join(teal_dir, "mandate_factory_approval.teal")) as f:
        approval_src = f.read()
    with open(os.path.join(teal_dir, "mandate_factory_clear.teal")) as f:
        clear_src = f.read()

    approval_result = client.compile(approval_src)
    clear_result    = client.compile(clear_src)
    approval_bytes  = base64.b64decode(approval_result["result"])
    clear_bytes     = base64.b64decode(clear_result["result"])

    params = client.suggested_params()

    # ARC-4: selector + treasury(address) + toll(uint64) + usdc_id(uint64)
    from algosdk.abi import ABIType
    addr_type  = ABIType.from_string("address")
    uint64_type = ABIType.from_string("uint64")

    from algosdk import encoding as algo_encoding
    import hashlib

    def method_selector(sig: str) -> bytes:
        return hashlib.new("sha512_256", sig.encode()).digest()[:4]

    app_args = [
        method_selector("create(address,uint64,uint64)void"),
        algo_encoding.decode_address(treasury),
        toll.to_bytes(8, "big"),
        usdc_id.to_bytes(8, "big"),
    ]

    txn = transaction.ApplicationCreateTxn(
        sender=address,
        sp=params,
        on_complete=transaction.OnComplete.NoOpOC,
        approval_program=approval_bytes,
        clear_program=clear_bytes,
        global_schema=transaction.StateSchema(num_uints=4, num_byte_slices=1),
        local_schema=transaction.StateSchema(num_uints=0, num_byte_slices=0),
        app_args=app_args,
    )

    signed = txn.sign(private_key)
    txid   = client.send_transaction(signed)
    print(f"  Deploy factory txid: {txid}")

    result = wait_for_confirmation(client, txid)
    app_id = result["application-index"]
    print(f"  Factory deployed: app_id = {app_id}")
    print(f"  Set FACTORY_APP_ID={app_id} in your .env")
    return app_id

# ── set-programs ─────────────────────────────────────────────────────────────

def set_programs(client: algod.AlgodClient, private_key: str, address: str):
    factory_app_id = int(os.environ.get("FACTORY_APP_ID", "0"))
    if not factory_app_id:
        raise ValueError("FACTORY_APP_ID env var not set")

    teal_dir = os.path.join(os.path.dirname(__file__), "..", "teal")

    with open(os.path.join(teal_dir, "mandate_contract_approval.teal")) as f:
        approval_src = f.read()
    with open(os.path.join(teal_dir, "mandate_contract_clear.teal")) as f:
        clear_src = f.read()

    approval_bytes = base64.b64decode(client.compile(approval_src)["result"])
    clear_bytes    = base64.b64decode(client.compile(clear_src)["result"])

    print(f"  Approval program: {len(approval_bytes)} bytes")
    print(f"  Clear program:    {len(clear_bytes)} bytes")

    import hashlib
    approval_hash = hashlib.sha256(approval_bytes).hexdigest()
    print(f"  Approval SHA-256: {approval_hash}")
    print(f"  Set MANDATE_CONTRACT_APPROVAL_HASH={approval_hash} in server config")

    params = client.suggested_params()

    def method_selector(sig: str) -> bytes:
        import hashlib
        return hashlib.new("sha512_256", sig.encode()).digest()[:4]

    # ARC-4 encoding for byte[] includes a 2-byte big-endian length prefix
    def encode_bytes(b: bytes) -> bytes:
        return len(b).to_bytes(2, "big") + b

    app_args = [
        method_selector("set_programs(byte[],byte[])void"),
        encode_bytes(approval_bytes),
        encode_bytes(clear_bytes),
    ]

    txn = transaction.ApplicationCallTxn(
        sender=address,
        sp=params,
        index=factory_app_id,
        on_complete=transaction.OnComplete.NoOpOC,
        app_args=app_args,
        # Box references required for box reads/writes
        boxes=[(factory_app_id, b"__approval__"), (factory_app_id, b"__clear__")],
    )

    signed = txn.sign(private_key)
    txid   = client.send_transaction(signed)
    print(f"  set_programs txid: {txid}")
    wait_for_confirmation(client, txid)
    print("  Programs uploaded to factory boxes ✓")

# ── create-agent ─────────────────────────────────────────────────────────────

def create_agent(
    client: algod.AlgodClient,
    private_key: str,
    address: str,
    agent_key: str,
    master_wallet: str,
    max_per_tx: int,
    velocity_cap: int,
    daily_cap: int,
):
    factory_app_id = int(os.environ.get("FACTORY_APP_ID", "0"))
    if not factory_app_id:
        raise ValueError("FACTORY_APP_ID env var not set")

    import hashlib
    from algosdk import encoding as algo_encoding

    def method_selector(sig: str) -> bytes:
        return hashlib.new("sha512_256", sig.encode()).digest()[:4]

    params = client.suggested_params()

    app_args = [
        method_selector("create_agent(address,address,uint64,uint64,uint64)uint64"),
        algo_encoding.decode_address(agent_key),
        algo_encoding.decode_address(master_wallet),
        max_per_tx.to_bytes(8, "big"),
        velocity_cap.to_bytes(8, "big"),
        daily_cap.to_bytes(8, "big"),
    ]

    txn = transaction.ApplicationCallTxn(
        sender=address,
        sp=params,
        index=factory_app_id,
        on_complete=transaction.OnComplete.NoOpOC,
        app_args=app_args,
        boxes=[(factory_app_id, b"__approval__"), (factory_app_id, b"__clear__")],
    )

    signed = txn.sign(private_key)
    txid   = client.send_transaction(signed)
    print(f"  create_agent txid: {txid}")

    result   = wait_for_confirmation(client, txid)
    # App ID is in the inner transaction
    inner    = result.get("inner-txns", [{}])[0]
    app_id   = inner.get("application-index", 0)
    app_addr = transaction.get_application_address(app_id)

    print(f"  MandateContract deployed: app_id = {app_id}")
    print(f"  Application address (deposit USDC + ALGO here): {app_addr}")
    print(f"  Next steps:")
    print(f"    1. Send 0.5+ ALGO to {app_addr}  (covers MBR + fees)")
    print(f"    2. Call opt_in_usdc() to opt the app account into USDC")
    print(f"    3. Send USDC to {app_addr}")
    return app_id, app_addr

# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MandateFactory deployment tool")
    sub    = parser.add_subparsers(dest="cmd")

    sub.add_parser("deploy-factory")
    sub.add_parser("set-programs")

    p_agent = sub.add_parser("create-agent")
    p_agent.add_argument("--agent-key",  required=True)
    p_agent.add_argument("--master-key", required=True)
    p_agent.add_argument("--max-per-tx", type=int, required=True)
    p_agent.add_argument("--velocity",   type=int, required=True)
    p_agent.add_argument("--daily",      type=int, required=True)

    args         = parser.parse_args()
    client       = get_algod_client()
    private_key, address = get_operator_key()

    if args.cmd == "deploy-factory":
        deploy_factory(client, private_key, address)
    elif args.cmd == "set-programs":
        set_programs(client, private_key, address)
    elif args.cmd == "create-agent":
        create_agent(
            client, private_key, address,
            args.agent_key, args.master_key,
            args.max_per_tx, args.velocity, args.daily,
        )
    else:
        parser.print_help()
