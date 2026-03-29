"""
MandateFactory — One-time operator deployment

Deploys new MandateContract instances via inner application-create transactions.
All contracts deployed through this factory share the same:
  - TREASURY_ADDRESS  (operator revenue destination)
  - TOLL_MICRO_USDC   (0.01 USDC per non-treasury pay() call)
  - USDC_ASSET_ID     (31566704 mainnet / 10458941 testnet)

The factory_app_id is written into every child contract's state at creation.
The server verifies: does this contract's factory_id match the known factory?
This is the provenance chain — contracts not deployed through this factory
will have a different factory_id and are rejected by the x402 server.

ARC-4 methods:
  set_programs(byte[],byte[])void         — operator uploads compiled contract bytes
  create_agent(address,address,uint64,uint64,uint64)uint64  — deploy agent contract
  update_toll(uint64)void                 — operator updates toll (new contracts only)
  update_treasury(address)void            — operator updates treasury (new contracts only)

Global state: 4 uint64 + 1 byte slice
Box storage:  BOX_APPROVAL + BOX_CLEAR (compiled MandateContract program bytes)
"""

from pyteal import *
from constants import (
    FACTORY_GLOBAL_UINTS, FACTORY_GLOBAL_BYTE_SLICES,
    MANDATE_CONTRACT_GLOBAL_UINTS, MANDATE_CONTRACT_GLOBAL_BYTE_SLICES,
    KEY_TREASURY, KEY_TOLL, KEY_USDC_ID, KEY_TOTAL_AGENTS,
)

# ── Factory-specific keys ────────────────────────────────────────────────────
KEY_PAUSED = b"p"  # 0 = active, 1 = paused (no new agents)

# Box keys for storing compiled contract program bytes
BOX_APPROVAL = Bytes(b"__approval__")
BOX_CLEAR    = Bytes(b"__clear__")

# ── ARC-4 method selectors ───────────────────────────────────────────────────
SEL_SET_PROGRAMS    = MethodSignature("set_programs(byte[],byte[])void")
SEL_CREATE_AGENT    = MethodSignature("create_agent(address,address,uint64,uint64,uint64)uint64")
SEL_UPDATE_TOLL     = MethodSignature("update_toll(uint64)void")
SEL_UPDATE_TREASURY = MethodSignature("update_treasury(address)void")
SEL_PAUSE           = MethodSignature("pause()void")
SEL_UNPAUSE         = MethodSignature("unpause()void")


# ── Routing ──────────────────────────────────────────────────────────────────

def approval():
    method = Txn.application_args[0]

    return Cond(
        # Factory creation
        [Txn.application_id() == Int(0),
         handle_create()],

        # Method dispatch
        [And(
            Txn.application_id() != Int(0),
            Txn.on_completion() == OnComplete.NoOp,
        ),
         Cond(
             [method == SEL_SET_PROGRAMS,    do_set_programs()],
             [method == SEL_CREATE_AGENT,    do_create_agent()],
             [method == SEL_UPDATE_TOLL,     do_update_toll()],
             [method == SEL_UPDATE_TREASURY, do_update_treasury()],
             [method == SEL_PAUSE,           do_pause()],
             [method == SEL_UNPAUSE,         do_unpause()],
         )],

        # Factory contract updates — creator only
        [Txn.on_completion() == OnComplete.UpdateApplication,
         Seq([
             Assert(Txn.sender() == Global.creator_address()),
             Int(1),
         ])],

        [Int(1), Int(0)],
    )


# ── handle_create ────────────────────────────────────────────────────────────

def handle_create():
    """
    Initialise the factory.

    Args:
        [1] treasury_address  (address, 32 bytes)
        [2] toll_micro_usdc   (uint64,  8 bytes)
        [3] usdc_asset_id     (uint64,  8 bytes)
    """
    return Seq([
        Assert(Txn.application_args.length() == Int(4)),
        App.globalPut(Bytes(KEY_TREASURY),     Txn.application_args[1]),
        App.globalPut(Bytes(KEY_TOLL),         Btoi(Txn.application_args[2])),
        App.globalPut(Bytes(KEY_USDC_ID),      Btoi(Txn.application_args[3])),
        App.globalPut(Bytes(KEY_TOTAL_AGENTS), Int(0)),
        App.globalPut(Bytes(KEY_PAUSED),       Int(0)),
        Int(1),
    ])


# ── do_set_programs ──────────────────────────────────────────────────────────

def do_set_programs():
    """
    Upload compiled MandateContract approval and clear program bytes.
    Stored in boxes because program bytes (up to 8KB each) exceed global state limits.

    Note: if program bytes exceed the single-txn application_args limit (~2KB),
    upload in chunks using box_replace() in subsequent transactions.
    For most mandate contracts, the compiled TEAL fits in one transaction.

    Args:
        [1] approval_bytes  (byte[])
        [2] clear_bytes     (byte[])
    """
    approval_bytes = Txn.application_args[1]
    clear_bytes    = Txn.application_args[2]

    # MaybeValue checks — must be declared before Seq, executed inside it
    approval_len = App.box_length(BOX_APPROVAL)
    clear_len    = App.box_length(BOX_CLEAR)

    return Seq([
        Assert(
            Txn.sender() == Global.creator_address(),
            comment="NOT_CREATOR",
        ),
        Assert(Len(approval_bytes) > Int(0), comment="EMPTY_APPROVAL"),
        Assert(Len(clear_bytes) > Int(0),    comment="EMPTY_CLEAR"),

        # Recreate boxes to handle updates (delete if exists, then create)
        approval_len,
        If(approval_len.hasValue(), Pop(App.box_delete(BOX_APPROVAL))),
        clear_len,
        If(clear_len.hasValue(), Pop(App.box_delete(BOX_CLEAR))),

        Pop(App.box_create(BOX_APPROVAL, Len(approval_bytes))),
        App.box_put(BOX_APPROVAL, approval_bytes),

        Pop(App.box_create(BOX_CLEAR, Len(clear_bytes))),
        App.box_put(BOX_CLEAR, clear_bytes),

        Int(1),
    ])


# ── do_create_agent ──────────────────────────────────────────────────────────

def do_create_agent():
    """
    Deploy a new MandateContract instance via an inner app-create transaction.
    Returns the new application ID (ABI-encoded uint64 in the log).

    Args:
        [1] agent_key       (address) — agent's signing address
        [2] master_wallet   (address) — master wallet that controls this contract
        [3] max_per_tx      (uint64)  — max micro-USDC per single transaction
        [4] velocity_cap    (uint64)  — max micro-USDC per 10-minute window
        [5] daily_cap       (uint64)  — max micro-USDC per 24 hours

    Treasury, toll, and usdc_asset_id are taken from factory state — the caller
    cannot override them. This is how the operator ensures every deployed contract
    routes toll revenue to the correct treasury.
    """
    agent_key     = Txn.application_args[1]
    master_wallet = Txn.application_args[2]
    max_per_tx    = Btoi(Txn.application_args[3])
    velocity_cap  = Btoi(Txn.application_args[4])
    daily_cap     = Btoi(Txn.application_args[5])

    # MaybeValue box reads — declared before Seq, executed inside it
    approval_result = App.box_get(BOX_APPROVAL)
    clear_result    = App.box_get(BOX_CLEAR)

    created_app_id = ScratchVar(TealType.uint64)

    # ARC-4 method selector for MandateContract.create()
    SEL_MANDATE_CREATE = MethodSignature(
        "create(address,address,address,uint64,uint64,uint64,uint64,uint64,uint64)void"
    )

    return Seq([
        # Factory must not be paused
        Assert(
            App.globalGet(Bytes(KEY_PAUSED)) == Int(0),
            comment="FACTORY_PAUSED",
        ),

        # Execute box_get opcodes first, then check hasValue
        approval_result,
        Assert(approval_result.hasValue(), comment="PROGRAMS_NOT_SET"),
        clear_result,
        Assert(clear_result.hasValue(),    comment="PROGRAMS_NOT_SET"),

        # Mandate parameter sanity checks
        Assert(max_per_tx > Int(0),    comment="INVALID_MAX_PER_TX"),
        Assert(velocity_cap > Int(0),  comment="INVALID_VELOCITY_CAP"),
        Assert(daily_cap > Int(0),     comment="INVALID_DAILY_CAP"),
        # velocity_cap should not exceed daily_cap
        Assert(velocity_cap <= daily_cap, comment="VELOCITY_EXCEEDS_DAILY"),

        # ── Inner app-create transaction ─────────────────────────────────
        # This deploys a new MandateContract instance.
        # The args are passed directly to the new contract's handle_create().
        InnerTxnBuilder.Execute({
            TxnField.type_enum:            TxnType.ApplicationCall,
            TxnField.approval_program:     approval_result.value(),
            TxnField.clear_state_program:  clear_result.value(),
            TxnField.global_num_uints:     Int(MANDATE_CONTRACT_GLOBAL_UINTS),
            TxnField.global_num_byte_slices: Int(MANDATE_CONTRACT_GLOBAL_BYTE_SLICES),
            TxnField.application_args: [
                SEL_MANDATE_CREATE,
                agent_key,                                         # [1]
                master_wallet,                                     # [2]
                App.globalGet(Bytes(KEY_TREASURY)),                # [3] treasury
                Itob(App.globalGet(Bytes(KEY_TOLL))),              # [4] toll
                Itob(App.globalGet(Bytes(KEY_USDC_ID))),           # [5] usdc_id
                Itob(max_per_tx),                                  # [6]
                Itob(velocity_cap),                                # [7]
                Itob(daily_cap),                                   # [8]
                Itob(Global.current_application_id()),             # [9] factory_id
            ],
            TxnField.fee: Int(0),
        }),

        # Capture created app ID
        created_app_id.store(InnerTxn.created_application_id()),

        # Increment agent counter
        App.globalPut(
            Bytes(KEY_TOTAL_AGENTS),
            App.globalGet(Bytes(KEY_TOTAL_AGENTS)) + Int(1),
        ),

        # Return the app ID as ABI uint64 in the log
        # Server reads this to register the agent
        Log(Concat(Bytes("return"), Itob(created_app_id.load()))),

        Int(1),
    ])


# ── do_update_toll ───────────────────────────────────────────────────────────

def do_update_toll():
    """
    Update the toll amount for future deployments only.
    Existing contracts keep their original toll (hardcoded at creation).
    Creator only.
    """
    return Seq([
        Assert(
            Txn.sender() == Global.creator_address(),
            comment="NOT_CREATOR",
        ),
        Assert(Btoi(Txn.application_args[1]) > Int(0), comment="ZERO_TOLL"),
        App.globalPut(Bytes(KEY_TOLL), Btoi(Txn.application_args[1])),
        Int(1),
    ])


# ── do_update_treasury ───────────────────────────────────────────────────────

def do_update_treasury():
    """
    Update treasury address for future deployments only.
    Creator only.
    """
    new_treasury = Txn.application_args[1]
    return Seq([
        Assert(
            Txn.sender() == Global.creator_address(),
            comment="NOT_CREATOR",
        ),
        Assert(Len(new_treasury) == Int(32), comment="INVALID_ADDRESS"),
        App.globalPut(Bytes(KEY_TREASURY), new_treasury),
        Int(1),
    ])


# ── do_pause / do_unpause ────────────────────────────────────────────────────

def do_pause():
    """Pause new agent creation. Existing agents unaffected. Creator only."""
    return Seq([
        Assert(Txn.sender() == Global.creator_address()),
        App.globalPut(Bytes(KEY_PAUSED), Int(1)),
        Int(1),
    ])


def do_unpause():
    return Seq([
        Assert(Txn.sender() == Global.creator_address()),
        App.globalPut(Bytes(KEY_PAUSED), Int(0)),
        Int(1),
    ])


# ── Clear state ──────────────────────────────────────────────────────────────

def clear_state():
    return Int(1)


# ── Compile ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "..", "teal")
    os.makedirs(out_dir, exist_ok=True)

    approval_teal = compileTeal(approval(),     mode=Mode.Application, version=9)
    clear_teal    = compileTeal(clear_state(),  mode=Mode.Application, version=9)

    with open(os.path.join(out_dir, "mandate_factory_approval.teal"), "w") as f:
        f.write(approval_teal)
    with open(os.path.join(out_dir, "mandate_factory_clear.teal"), "w") as f:
        f.write(clear_teal)

    print("✓ mandate_factory_approval.teal")
    print("✓ mandate_factory_clear.teal")
