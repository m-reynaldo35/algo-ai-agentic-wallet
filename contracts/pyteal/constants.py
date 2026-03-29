# ── Network constants ───────────────────────────────────────────────────────
USDC_ASSET_ID_MAINNET = 31_566_704
USDC_ASSET_ID_TESTNET = 10_458_941

TOLL_MICRO_USDC = 10_000   # 0.01 USDC — operator revenue per pay() call

# ── Time windows (seconds) ──────────────────────────────────────────────────
# Global.latest_timestamp() is the committed block timestamp.
# It is set by the block proposer and consensus enforces it stays
# within a few seconds of real time — reliable enough for mandate windows.
SECONDS_PER_10_MIN = 600
SECONDS_PER_DAY    = 86_400

# ── Global state schema ─────────────────────────────────────────────────────
# MandateContract: 11 uint64 + 4 byte slices
# MandateFactory:  4 uint64  + 1 byte slice
MANDATE_CONTRACT_GLOBAL_UINTS      = 11
MANDATE_CONTRACT_GLOBAL_BYTE_SLICES = 4

FACTORY_GLOBAL_UINTS       = 4
FACTORY_GLOBAL_BYTE_SLICES = 1

# ── Global state keys (short to minimise state cost) ───────────────────────
# MandateContract immutable config
KEY_AGENT_KEY    = b"ak"   # agent signing address (bytes)
KEY_MASTER       = b"mw"   # master wallet address (bytes)
KEY_TREASURY     = b"tr"   # operator treasury address (bytes)
KEY_TOLL         = b"tl"   # toll in micro-USDC (uint64)
KEY_USDC_ID      = b"ui"   # USDC ASA ID (uint64)
KEY_FACTORY_ID   = b"fi"   # deploying factory app ID — provenance proof (uint64)

# MandateContract mandate parameters (master wallet can update)
KEY_MAX_PER_TX   = b"mx"   # max micro-USDC per single tx (uint64)
KEY_VEL_CAP      = b"vc"   # max micro-USDC per 10-min window (uint64)
KEY_DAILY_CAP    = b"dc"   # max micro-USDC per 24-hour window (uint64)
KEY_VERSION      = b"v"    # mandate version — monotonic, prevents rollback (uint64)
KEY_HALTED       = b"h"    # 0 = active, 1 = halted (uint64)

# MandateContract runtime velocity state
KEY_WIN_START    = b"ws"   # unix timestamp of current 10-min window start (uint64)
KEY_WIN_SPEND    = b"wx"   # micro-USDC spent in current window (uint64)
KEY_DAY_START    = b"ds"   # unix timestamp of current day window start (uint64)
KEY_DAY_SPEND    = b"dy"   # micro-USDC spent today (uint64)

# MandateFactory keys
KEY_TOTAL_AGENTS = b"n"    # total agents deployed (uint64)
