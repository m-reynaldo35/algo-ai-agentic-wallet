from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class X402ErrorCode(str, Enum):
    CONFIG_ERROR         = "CONFIG_ERROR"
    OFFER_EXPIRED        = "OFFER_EXPIRED"
    UNSUPPORTED_VERSION  = "UNSUPPORTED_VERSION"
    NETWORK_ERROR        = "NETWORK_ERROR"
    SANDBOX_ERROR        = "SANDBOX_ERROR"
    SETTLEMENT_ERROR     = "SETTLEMENT_ERROR"
    POLICY_BREACH        = "POLICY_BREACH"
    UNKNOWN              = "UNKNOWN"


class X402Error(Exception):
    def __init__(self, message: str, code: X402ErrorCode = X402ErrorCode.UNKNOWN) -> None:
        super().__init__(message)
        self.code = code

    def is_retryable(self) -> bool:
        return self.code in (X402ErrorCode.NETWORK_ERROR, X402ErrorCode.UNKNOWN)

    def is_policy_breach(self) -> bool:
        return self.code is X402ErrorCode.POLICY_BREACH


class DestinationChain(str, Enum):
    ETHEREUM  = "ethereum"
    SOLANA    = "solana"
    BASE      = "base"
    ALGORAND  = "algorand"
    AVALANCHE = "avalanche"
    POLYGON   = "polygon"
    ARBITRUM  = "arbitrum"
    OPTIMISM  = "optimism"


@dataclass
class SettlementResult:
    success:         bool
    agent_id:        str
    sandbox_id:      str
    txn_id:          str
    confirmed_round: int
    group_id:        str
    txn_count:       int
    settled_at:      str

    @property
    def explorer_url(self) -> str:
        return f"https://explorer.perawallet.app/tx/{self.txn_id}"


@dataclass
class VelocityBlock:
    """Returned instead of SettlementResult when the velocity cap is hit."""
    ten_min_total:       int  # µUSDC spent in current 10-min window
    day_total:           int  # µUSDC spent in current 24-hour window
    threshold_10m:       int  # µUSDC cap per 10-min window
    threshold_24h:       int  # µUSDC cap per 24-hour window
    proposed_micro_usdc: int  # µUSDC that was rejected

    @property
    def message(self) -> str:
        return (
            f"Velocity cap hit: ${self.ten_min_total/1e6:.4f}/${self.threshold_10m/1e6:.2f} "
            f"USDC in 10-min window. Retry after window resets."
        )


# Union type callers should check
TradeResult = SettlementResult | VelocityBlock


@dataclass
class AgentInfo:
    agent_id:            str
    address:             str
    status:              str
    cohort:              str
    auth_addr:           str
    custody:             str
    custody_version:     int
    created_at:          str
    registration_txn_id: Optional[str] = None
