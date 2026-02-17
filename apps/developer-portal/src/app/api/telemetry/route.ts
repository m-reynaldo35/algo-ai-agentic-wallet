import { NextResponse } from "next/server";

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const agentIds = [
  "sdk-WYQ24WWZ", "sdk-GOBIB6Q4", "sdk-T8XM3PLR", "sdk-KJN9V2AE",
  "agent-rogue-01", "agent-rogue-02", "sdk-Q7YPFH1B", "sdk-LZWD4C6N",
];

export async function GET() {
  const revenue = (10 + Math.random() * 8).toFixed(2);
  const settlements = rand(100, 160);
  const replays = rand(3, 12);
  const rateLimits = rand(10, 40);
  const oraclePrice = (0.28 + Math.random() * 0.02).toFixed(4);
  const activeAgents = rand(5, 12);

  const metrics = [
    { label: "Total USDC Revenue", value: `$${revenue}`, delta: `+$${(Math.random() * 4).toFixed(2)} today`, status: "positive" },
    { label: "Settlements (24h)", value: String(settlements), delta: `+${rand(8, 25)}%`, status: "positive" },
    { label: "Blocked Replays", value: String(replays), delta: `${rand(1, 5)} today`, status: "negative" },
    { label: "Rate Limit Hits", value: String(rateLimits), delta: `${rand(2, 8)} unique IPs`, status: "neutral" },
    { label: "Gora Oracle Price", value: `${oraclePrice} USDC/ALGO`, delta: `${rand(1, 10)}s ago`, status: "neutral" },
    { label: "Active Agents", value: String(activeAgents), delta: `${rand(1, 4)} new today`, status: "positive" },
  ];

  const eventTypes = ["settlement.success", "execution.failure"] as const;
  const now = Date.now();

  const recentEvents = Array.from({ length: 5 }, (_, i) => {
    const isSuccess = Math.random() > 0.3;
    const ts = new Date(now - i * rand(30000, 120000)).toISOString();
    const agent = agentIds[rand(0, agentIds.length - 1)];

    if (isSuccess) {
      return {
        event: eventTypes[0],
        agentId: agent,
        tollAmountMicroUsdc: 100000,
        settledAt: ts,
        oracleContext: {
          assetPair: "USDC/ALGO",
          goraConsensusPrice: String(rand(280000, 290000)),
          goraTimestamp: Math.floor(now / 1000) - rand(1, 10),
          goraTimestampISO: ts,
          slippageDelta: rand(20, 80),
        },
      };
    }
    return {
      event: eventTypes[1],
      agentId: agent,
      failedStage: "validation",
      error: "Signature Replay Detected: nonce has already been used",
      timestamp: ts,
    };
  });

  return NextResponse.json({ metrics, recentEvents });
}
