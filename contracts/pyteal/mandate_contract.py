"""
MandateContract — Stateful Smart Contract Wallet

A per-agent Algorand application that:
  • Holds the agent's USDC and ALGO
  • Enforces mandate rules at the AVM consensus layer
  • Fires inner transactions for payments (and automatic toll collection)
  • Is controlled exclusively by the master wallet for parameter updates

The agent holds its own signing key. No Rocca. No signing service.
The agent calls pay() — the AVM enforces the mandate — USDC moves.

Deploy via MandateFactory.create_agent() so provenance is on-chain.

ARC-4 methods exposed:
  pay(address, uint64)void              — agent signs, AVM enforces
  opt_in_usdc()void                     — one-time USDC opt-in
  update_mandate(uint64,uint64,uint64,uint64)void  — master wallet only
  add_recipient(address)void            — master wallet only
  remove_recipient(address)void         — master wallet only
  halt()void                            — master wallet only
  resume()void                          — master wallet only
  transfer_master(address)void          — master wallet only

Global state:  11 uint64 + 4 byte slices
Box storage:   one box per whitelisted recipient address (32 bytes → 1 byte value)
"""

from pyteal import *
from constants import (
    SECONDS_PER_10_MIN, SECONDS_PER_DAY,
    MANDATE_CONTRACT_GLOBAL_UINTS, MANDATE_CONTRACT_GLOBAL_BYTE_SLICES,
    KEY_AGENT_KEY, KEY_MASTER, KEY_TREASURY, KEY_TOLL, KEY_USDC_ID,
    KEY_FACTORY_ID, KEY_MAX_PER_TX, KEY_VEL_CAP, KEY_DAILY_CAP,
    KEY_VERSION, KEY_HALTED, KEY_WHITELIST_ENABLED,
    KEY_WIN_START, KEY_WIN_SPEND,
    KEY_DAY_START, KEY_DAY_SPEND,
)

# ── ARC-4 method selectors ───────────────────────────────────────────────────
SEL_PAY               = MethodSignature("pay(address,uint64)void")
SEL_OPT_IN_USDC       = MethodSignature("opt_in_usdc()void")
SEL_UPDATE_MANDATE    = MethodSignature("update_mandate(uint64,uint64,uint64,uint64)void")
SEL_ADD_RECIPIENT     = MethodSignature("add_recipient(address)void")
SEL_REMOVE_RECIPIENT  = MethodSignature("remove_recipient(address)void")
SEL_HALT              = MethodSignature("halt()void")
SEL_RESUME            = MethodSignature("resume()void")
SEL_TRANSFER_MASTER   = MethodSignature("transfer_master(address)void")
SEL_ENABLE_WHITELIST  = MethodSignature("enable_whitelist()void")
SEL_DISABLE_WHITELIST = MethodSignature("disable_whitelist()void")


# ── Routing ──────────────────────────────────────────────────────────────────

def approval():
    method = Txn.application_args[0]

    return Cond(
        # Application create — initialise from factory args
        [Txn.application_id() == Int(0),
         handle_create()],

        # Standard method calls
        [And(
            Txn.application_id() != Int(0),
            Txn.on_completion() == OnComplete.NoOp,
        ),
         Cond(
             [method == SEL_PAY,               do_pay()],
             [method == SEL_OPT_IN_USDC,       do_opt_in_usdc()],
             [method == SEL_UPDATE_MANDATE,    do_update_mandate()],
             [method == SEL_ADD_RECIPIENT,     do_add_recipient()],
             [method == SEL_REMOVE_RECIPIENT,  do_remove_recipient()],
             [method == SEL_HALT,              do_halt()],
             [method == SEL_RESUME,            do_resume()],
             [method == SEL_TRANSFER_MASTER,   do_transfer_master()],
             [method == SEL_ENABLE_WHITELIST,  do_enable_whitelist()],
             [method == SEL_DISABLE_WHITELIST, do_disable_whitelist()],
         )],

        # Contract updates — master wallet only
        [Txn.on_completion() == OnComplete.UpdateApplication,
         Seq([
             Assert(Txn.sender() == App.globalGet(Bytes(KEY_MASTER))),
             Int(1),
         ])],

        # All other completion types rejected
        [Int(1), Int(0)],
    )


# ── handle_create ────────────────────────────────────────────────────────────

def handle_create():
    """
    Initialise contract state from factory-supplied args.

    Called as the inner app-create transaction from MandateFactory.create_agent().
    Args are ARC-4 encoded by the factory:
        [0] method selector  (SEL_CREATE, 4 bytes)
        [1] agent_key        (address, 32 bytes)
        [2] master_wallet    (address, 32 bytes)
        [3] treasury_addr    (address, 32 bytes)
        [4] toll_micro_usdc  (uint64,  8 bytes big-endian)
        [5] usdc_asset_id    (uint64,  8 bytes big-endian)
        [6] max_per_tx       (uint64,  8 bytes big-endian)
        [7] velocity_cap     (uint64,  8 bytes big-endian)
        [8] daily_cap        (uint64,  8 bytes big-endian)
        [9] factory_app_id   (uint64,  8 bytes big-endian)
    """
    now = Global.latest_timestamp()

    return Seq([
        Assert(Txn.application_args.length() == Int(10)),

        # ── Immutable config ─────────────────────────────────────────────
        App.globalPut(Bytes(KEY_AGENT_KEY),  Txn.application_args[1]),
        App.globalPut(Bytes(KEY_MASTER),     Txn.application_args[2]),
        App.globalPut(Bytes(KEY_TREASURY),   Txn.application_args[3]),
        App.globalPut(Bytes(KEY_TOLL),       Btoi(Txn.application_args[4])),
        App.globalPut(Bytes(KEY_USDC_ID),    Btoi(Txn.application_args[5])),
        App.globalPut(Bytes(KEY_FACTORY_ID), Btoi(Txn.application_args[9])),

        # ── Mandate parameters ───────────────────────────────────────────
        App.globalPut(Bytes(KEY_MAX_PER_TX), Btoi(Txn.application_args[6])),
        App.globalPut(Bytes(KEY_VEL_CAP),    Btoi(Txn.application_args[7])),
        App.globalPut(Bytes(KEY_DAILY_CAP),  Btoi(Txn.application_args[8])),
        App.globalPut(Bytes(KEY_VERSION),           Int(1)),
        App.globalPut(Bytes(KEY_HALTED),            Int(0)),
        App.globalPut(Bytes(KEY_WHITELIST_ENABLED), Int(0)),  # open mode by default

        # ── Velocity state ───────────────────────────────────────────────
        App.globalPut(Bytes(KEY_WIN_START),  now),
        App.globalPut(Bytes(KEY_WIN_SPEND),  Int(0)),
        App.globalPut(Bytes(KEY_DAY_START),  now),
        App.globalPut(Bytes(KEY_DAY_SPEND),  Int(0)),

        Int(1),
    ])


# ── do_pay ───────────────────────────────────────────────────────────────────

def do_pay():
    """
    Core payment method. Agent signs this app call. AVM enforces the mandate.

    Args:
        [1] recipient  (address, 32 bytes)
        [2] amount     (uint64, micro-USDC — the payment to the recipient)

    Inner transactions fired:
        If recipient == treasury (x402 toll payment):
            → single USDC transfer: amount → treasury
        If recipient != treasury (seller payment):
            → USDC transfer: amount → recipient
            → USDC toll:     toll_amount → treasury  ← always fires, cannot be skipped

    Velocity accounting (Gates 5 & 6) counts total USDC leaving the contract:
        x402 toll path (recipient == treasury): debit = amount
        Seller payment path:                   debit = amount + toll
    This ensures caps reflect actual contract spend, not just the payment leg.

    Six enforcement gates run before any funds move.
    All state updates are committed atomically with the inner transactions —
    if the inner transactions fail for any reason, state rolls back too.
    """
    now       = Global.latest_timestamp()
    recipient = Txn.application_args[1]   # 32-byte address
    amount    = Btoi(Txn.application_args[2])

    treasury  = App.globalGet(Bytes(KEY_TREASURY))
    toll      = App.globalGet(Bytes(KEY_TOLL))
    usdc_id   = App.globalGet(Bytes(KEY_USDC_ID))

    # MaybeValue for whitelist box check — must be declared before Seq
    box_check = App.box_length(recipient)

    # Scratch vars for velocity accumulation
    total_debit   = ScratchVar(TealType.uint64)
    new_win_spend = ScratchVar(TealType.uint64)
    new_day_spend = ScratchVar(TealType.uint64)

    return Seq([

        # ── Gate 0: Not halted ───────────────────────────────────────────
        Assert(
            App.globalGet(Bytes(KEY_HALTED)) == Int(0),
            comment="MANDATE_HALTED",
        ),

        # ── Gate 1: Caller must be the registered agent key ──────────────
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_AGENT_KEY)),
            comment="NOT_AGENT",
        ),

        # ── Gate 2: Non-zero amount ──────────────────────────────────────
        Assert(amount > Int(0), comment="ZERO_AMOUNT"),

        # ── Gate 3: maxPerTx ─────────────────────────────────────────────
        Assert(
            amount <= App.globalGet(Bytes(KEY_MAX_PER_TX)),
            comment="EXCEEDS_MAX_PER_TX",
        ),

        # ── Gate 4: Recipient whitelist ──────────────────────────────────
        # Only enforced when whitelist_enabled == 1 (strict mode).
        # Default is open mode (whitelist_enabled == 0) — any recipient is
        # allowed; cap gates alone protect the agent. Master wallet calls
        # enable_whitelist() to switch to strict mode and add_recipient()
        # to build the allowed set.
        #
        # Treasury is always permitted regardless of mode — it IS the
        # x402 toll target. MaybeValue must be executed before .hasValue().
        If(
            And(
                recipient != treasury,
                App.globalGet(Bytes(KEY_WHITELIST_ENABLED)) == Int(1),
            ),
            Seq([
                box_check,
                Assert(box_check.hasValue(), comment="RECIPIENT_NOT_WHITELISTED"),
            ]),
        ),

        # ── Compute total USDC debit for velocity accounting ─────────────
        # x402 toll path (recipient == treasury): amount IS the toll — no
        #   additional toll is charged, total debit = amount.
        # Seller payment path (recipient != treasury): contract fires two
        #   inner txns — amount to seller + toll to treasury — total USDC
        #   leaving the contract = amount + toll.
        # Both caps must see the full outflow so they reflect real contract spend.
        total_debit.store(
            If(
                recipient == treasury,
                amount,           # direct toll payment — no extra toll
                amount + toll,    # seller payment — amount + USDC toll
            )
        ),

        # ── Gate 5: 10-minute rolling velocity window ────────────────────
        # Reset the window if 600 seconds have elapsed since window_start.
        # Global.latest_timestamp() is the block timestamp — accurate to ~5s.
        If(
            now - App.globalGet(Bytes(KEY_WIN_START)) >= Int(SECONDS_PER_10_MIN),
            Seq([
                App.globalPut(Bytes(KEY_WIN_START), now),
                App.globalPut(Bytes(KEY_WIN_SPEND), Int(0)),
            ]),
        ),
        new_win_spend.store(App.globalGet(Bytes(KEY_WIN_SPEND)) + total_debit.load()),
        Assert(
            new_win_spend.load() <= App.globalGet(Bytes(KEY_VEL_CAP)),
            comment="VELOCITY_CAP_EXCEEDED",
        ),

        # ── Gate 6: 24-hour rolling daily cap ────────────────────────────
        If(
            now - App.globalGet(Bytes(KEY_DAY_START)) >= Int(SECONDS_PER_DAY),
            Seq([
                App.globalPut(Bytes(KEY_DAY_START), now),
                App.globalPut(Bytes(KEY_DAY_SPEND), Int(0)),
            ]),
        ),
        new_day_spend.store(App.globalGet(Bytes(KEY_DAY_SPEND)) + total_debit.load()),
        Assert(
            new_day_spend.load() <= App.globalGet(Bytes(KEY_DAILY_CAP)),
            comment="DAILY_CAP_EXCEEDED",
        ),

        # ── Commit velocity counters ─────────────────────────────────────
        # Written before inner txns — if inner txns fail, AVM rolls back all state.
        App.globalPut(Bytes(KEY_WIN_SPEND), new_win_spend.load()),
        App.globalPut(Bytes(KEY_DAY_SPEND), new_day_spend.load()),

        # ── Execute inner transactions ───────────────────────────────────
        # x402 toll case: recipient IS the treasury (direct toll payment)
        # Seller case:    recipient is a whitelisted seller address
        If(recipient == treasury).Then(
            # Single inner txn — the full amount is the toll itself
            InnerTxnBuilder.Execute({
                TxnField.type_enum:      TxnType.AssetTransfer,
                TxnField.asset_receiver: treasury,
                TxnField.asset_amount:   amount,
                TxnField.xfer_asset:     usdc_id,
                TxnField.fee:            Int(0),  # fee pooled from outer txn
            }),
        ).Else(
            # Two inner txns — seller gets amount, treasury gets toll
            Seq([
                InnerTxnBuilder.Begin(),

                # Inner txn 1: payment to seller
                InnerTxnBuilder.SetFields({
                    TxnField.type_enum:      TxnType.AssetTransfer,
                    TxnField.asset_receiver: recipient,
                    TxnField.asset_amount:   amount,
                    TxnField.xfer_asset:     usdc_id,
                    TxnField.fee:            Int(0),
                }),

                InnerTxnBuilder.Next(),

                # Inner txn 2: toll to treasury — hardcoded, cannot be skipped
                InnerTxnBuilder.SetFields({
                    TxnField.type_enum:      TxnType.AssetTransfer,
                    TxnField.asset_receiver: treasury,
                    TxnField.asset_amount:   toll,
                    TxnField.xfer_asset:     usdc_id,
                    TxnField.fee:            Int(0),
                }),

                InnerTxnBuilder.Submit(),
            ]),
        ),

        Int(1),
    ])


# ── do_opt_in_usdc ───────────────────────────────────────────────────────────

def do_opt_in_usdc():
    """
    Opt the application account into USDC.
    Must be called once before the contract can hold or transfer USDC.
    The app account needs enough ALGO to cover the ASA MBR (~0.1 ALGO).
    Callable by master wallet or agent key.
    """
    return Seq([
        Assert(
            Or(
                Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
                Txn.sender() == App.globalGet(Bytes(KEY_AGENT_KEY)),
            ),
            comment="NOT_AUTHORISED",
        ),
        InnerTxnBuilder.Execute({
            TxnField.type_enum:      TxnType.AssetTransfer,
            TxnField.asset_receiver: Global.current_application_address(),
            TxnField.asset_amount:   Int(0),
            TxnField.xfer_asset:     App.globalGet(Bytes(KEY_USDC_ID)),
            TxnField.fee:            Int(0),
        }),
        Int(1),
    ])


# ── do_update_mandate ────────────────────────────────────────────────────────

def do_update_mandate():
    """
    Update mandate parameters. Master wallet ONLY.

    Args:
        [1] new_max_per_tx   (uint64)
        [2] new_velocity_cap (uint64)
        [3] new_daily_cap    (uint64)
        [4] new_version      (uint64) — must be strictly > current version

    The version requirement prevents rollback attacks: an adversary who captures
    a signed old mandate update transaction cannot replay it to restore looser caps.
    """
    new_version = Btoi(Txn.application_args[4])

    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        # Anti-rollback: new version must be strictly greater than current
        Assert(
            new_version > App.globalGet(Bytes(KEY_VERSION)),
            comment="VERSION_ROLLBACK",
        ),

        App.globalPut(Bytes(KEY_MAX_PER_TX), Btoi(Txn.application_args[1])),
        App.globalPut(Bytes(KEY_VEL_CAP),    Btoi(Txn.application_args[2])),
        App.globalPut(Bytes(KEY_DAILY_CAP),  Btoi(Txn.application_args[3])),
        App.globalPut(Bytes(KEY_VERSION),    new_version),

        Int(1),
    ])


# ── do_add_recipient / do_remove_recipient ───────────────────────────────────

def do_add_recipient():
    """
    Whitelist a recipient address. Master wallet only.
    Creates a 1-byte box keyed by the recipient address.
    Box existence = whitelisted; box absence = not whitelisted.
    """
    recipient = Txn.application_args[1]
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        # box_create returns 0 if box already exists — Pop discards the return
        Pop(App.box_create(recipient, Int(1))),
        Int(1),
    ])


def do_remove_recipient():
    """Remove a recipient from the whitelist. Master wallet only."""
    recipient = Txn.application_args[1]
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        Pop(App.box_delete(recipient)),
        Int(1),
    ])


# ── do_halt / do_resume ──────────────────────────────────────────────────────

def do_halt():
    """Emergency halt — blocks all pay() calls. Master wallet only."""
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        App.globalPut(Bytes(KEY_HALTED), Int(1)),
        Int(1),
    ])


def do_resume():
    """Resume after halt. Master wallet only."""
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        App.globalPut(Bytes(KEY_HALTED), Int(0)),
        Int(1),
    ])


# ── do_transfer_master ───────────────────────────────────────────────────────

def do_transfer_master():
    """
    Transfer master wallet authority to a new address.
    Only the current master wallet can call this.
    This is a one-way operation — the old master loses all authority immediately.
    """
    new_master = Txn.application_args[1]
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        # Refuse to set an empty address — would lock the contract permanently
        Assert(Len(new_master) == Int(32), comment="INVALID_ADDRESS"),
        App.globalPut(Bytes(KEY_MASTER), new_master),
        Int(1),
    ])


# ── do_enable_whitelist / do_disable_whitelist ───────────────────────────────

def do_enable_whitelist():
    """
    Switch Gate 4 to strict whitelist mode. Master wallet only.
    After enabling, any recipient not in the box whitelist will be rejected.
    Use add_recipient() to populate the allowed set first.
    """
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        App.globalPut(Bytes(KEY_WHITELIST_ENABLED), Int(1)),
        Int(1),
    ])


def do_disable_whitelist():
    """
    Switch Gate 4 to open mode. Master wallet only.
    After disabling, any recipient is accepted (cap gates still apply).
    Box entries are preserved and can be re-enabled at any time.
    """
    return Seq([
        Assert(
            Txn.sender() == App.globalGet(Bytes(KEY_MASTER)),
            comment="NOT_MASTER_WALLET",
        ),
        App.globalPut(Bytes(KEY_WHITELIST_ENABLED), Int(0)),
        Int(1),
    ])


# ── Clear state ──────────────────────────────────────────────────────────────

def clear_state():
    """
    Clear state always approves — agent account is leaving the app.
    Funds (USDC/ALGO) remain in the application account regardless.
    """
    return Int(1)


# ── Compile ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "..", "teal")
    os.makedirs(out_dir, exist_ok=True)

    approval_teal = compileTeal(
        approval(),
        mode=Mode.Application,
        version=9,
    )
    clear_teal = compileTeal(
        clear_state(),
        mode=Mode.Application,
        version=9,
    )

    with open(os.path.join(out_dir, "mandate_contract_approval.teal"), "w") as f:
        f.write(approval_teal)
    with open(os.path.join(out_dir, "mandate_contract_clear.teal"), "w") as f:
        f.write(clear_teal)

    print("✓ mandate_contract_approval.teal")
    print("✓ mandate_contract_clear.teal")
