const agentIds = [
  "sdk-WYQ24WWZ", "sdk-GOBIB6Q4", "sdk-T8XM3PLR", "sdk-KJN9V2AE",
  "sdk-Q7YPFH1B", "sdk-LZWD4C6N", "agent-rogue-01", "agent-rogue-02",
  "sdk-M4RB8HXV", "sdk-P2GF5JDK",
];

const chains = ["algorand-testnet", "algorand-mainnet"];
const statuses = ["confirmed", "confirmed", "confirmed", "confirmed", "failed"] as const;

function randomDate(daysBack: number): string {
  const d = new Date();
  d.setTime(d.getTime() - Math.random() * daysBack * 86400000);
  return d.toISOString();
}

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export interface Settlement {
  id: string;
  time: string;
  agentId: string;
  status: "confirmed" | "failed";
  amountMicroUsdc: number;
  txnId: string;
  chain: string;
  confirmedRound?: number;
  failedStage?: string;
  error?: string;
  oracleContext?: {
    assetPair: string;
    goraConsensusPrice: string;
    goraTimestamp: number;
    slippageDelta: number;
  };
}

export interface AuditEvent {
  id: string;
  time: string;
  type: "settlement.success" | "execution.failure" | "rate.limit" | "key.created" | "key.revoked";
  agentId: string;
  detail: string;
}

function generateSettlements(): Settlement[] {
  return Array.from({ length: 25 }, (_, i) => {
    const status = statuses[i % statuses.length];
    const txnBase = Math.random().toString(36).slice(2, 14).toUpperCase();
    return {
      id: `stl-${String(i + 1).padStart(3, "0")}`,
      time: randomDate(14),
      agentId: agentIds[i % agentIds.length],
      status,
      amountMicroUsdc: rand(50000, 500000),
      txnId: `${txnBase}...${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      chain: chains[i % chains.length],
      confirmedRound: status === "confirmed" ? rand(40000000, 41000000) : undefined,
      failedStage: status === "failed" ? "validation" : undefined,
      error: status === "failed" ? "Signature Replay Detected: nonce already used" : undefined,
      oracleContext: status === "confirmed" ? {
        assetPair: "USDC/ALGO",
        goraConsensusPrice: String(rand(280000, 290000)),
        goraTimestamp: Math.floor(Date.now() / 1000) - rand(1, 300),
        slippageDelta: rand(20, 80),
      } : undefined,
    };
  }).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

function generateEvents(): AuditEvent[] {
  const types: AuditEvent["type"][] = [
    "settlement.success", "execution.failure", "rate.limit", "key.created", "key.revoked",
  ];
  const details: Record<AuditEvent["type"], string[]> = {
    "settlement.success": ["Toll settled on-chain", "Atomic group confirmed", "USDC transfer verified"],
    "execution.failure": ["Signature Replay Detected", "Invalid nonce", "Rate limit exceeded"],
    "rate.limit": ["Sliding window threshold hit", "IP blocked for 60s", "Burst limit exceeded"],
    "key.created": ["New API key generated", "Platform registered"],
    "key.revoked": ["API key revoked by admin", "Key expired"],
  };

  return Array.from({ length: 20 }, (_, i) => {
    const type = types[i % types.length];
    const dList = details[type];
    return {
      id: `evt-${String(i + 1).padStart(3, "0")}`,
      time: randomDate(7),
      type,
      agentId: agentIds[i % agentIds.length],
      detail: dList[i % dList.length],
    };
  }).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

export const MOCK_SETTLEMENTS = generateSettlements();
export const MOCK_EVENTS = generateEvents();

export const SETTLEMENT_VOLUME_7D = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return {
    label: d.toLocaleDateString("en-US", { weekday: "short" }),
    value: rand(8, 45),
  };
});
