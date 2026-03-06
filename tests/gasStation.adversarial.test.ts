/**
 * Gas Station Adversarial Tests
 *
 * Validates the security controls added to gasStation.ts:
 *
 *   CRIT-1  Outflow guard — every top-up routed through checkAndRecordOutflow()
 *   CRIT-2  Halt check   — cycle skips immediately when system is halted
 *   HIGH-2  Cooldown     — per-agent 10-min cooldown prevents rapid re-tops
 *   MED-2   Balance pre-check — cycle skips when treasury balance is too low
 *
 * Additional scenarios:
 *   - Agent balance above trigger threshold → not topped up
 *   - Suspended / orphaned agent → not topped up
 *   - Send failure → outflow reservation rolled back, cooldown NOT set
 *   - No ALGO_TREASURY_MNEMONIC → cycle skips gracefully
 *   - Multiple agents: only eligible agents topped up
 *
 * Run: npx tsx --test tests/gasStation.adversarial.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import algosdk from "algosdk";
import { _setRedisForTest } from "../src/services/redis.js";
import { _setAlgodForTest } from "../src/network/nodely.js";
import type { RedisShim } from "../src/services/redis.js";

// Silence expected log noise from the gas station and nodely failover
const _origWarn  = console.warn;
const _origError = console.error;
const _origLog   = console.log;
console.warn  = () => {};
console.error = () => {};
console.log   = () => {};

// ── Redis mock ────────────────────────────────────────────────────

const redisStore = new Map<string, string>();
let evalShouldRejectCap = false;
let evalCallCount       = 0;
let decrbyCallCount     = 0;
let setCallArgs: Array<[string, unknown]> = [];

const mockRedis = {
  get: async (key: string) => {
    const raw = redisStore.get(key) ?? null;
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  set: async (key: string, value: unknown, _opts?: object) => {
    setCallArgs.push([key, value]);
    const s = typeof value === "string" ? value : JSON.stringify(value);
    redisStore.set(key, s);
    return "OK";
  },
  del: async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) { if (redisStore.delete(k)) n++; }
    return n;
  },
  getdel: async (key: string) => {
    const raw = redisStore.get(key) ?? null;
    if (raw !== null) redisStore.delete(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  scan: async (cursor: number, opts?: { match?: string }) => {
    if (cursor !== 0) return ["0", [] as string[]];
    const prefix = (opts?.match ?? "").replace(/\*$/, "");
    const keys   = [...redisStore.keys()].filter((k) => k.startsWith(prefix));
    return ["0", keys];
  },
  keys: async (pattern: string) => {
    const prefix = pattern.replace(/\*$/, "");
    return [...redisStore.keys()].filter((k) => k.startsWith(prefix));
  },
  incrby: async (key: string, amount: number) => {
    const cur  = BigInt(redisStore.get(key) ?? "0");
    const next = cur + BigInt(amount);
    redisStore.set(key, String(next));
    return Number(next);
  },
  decrby: async (key: string, amount: number) => {
    decrbyCallCount++;
    const cur  = BigInt(redisStore.get(key) ?? "0");
    const next = cur - BigInt(amount);
    redisStore.set(key, String(next));
    return Number(next);
  },
  eval: async (_script: string, keys: string[], args: (string | number)[]) => {
    evalCallCount++;
    if (evalShouldRejectCap) {
      // Simulate daily cap breach — rejected=1, exceededAlgo=1
      return [1, 0, 0, 1, 0];
    }
    // Simulate allowed — increment the ALGO outflow counter
    const mAlgo = Number(args[0]);
    if (mAlgo > 0) {
      const prev = Number(redisStore.get(keys[0]) ?? "0");
      redisStore.set(keys[0], String(prev + mAlgo));
    }
    return [0, 0, 0, 0, 0];
  },
  sadd:               async (_k: string, ..._m: string[]) => 0,
  expire:             async (_k: string, _s: number)      => 1,
  zadd:               async (_k: string, _entry: object)  => 1,
  zremrangebyrank:    async (_k: string, _s: number, _e: number) => 0,
  zrange:             async (_k: string, _s: number, _e: number) => [] as string[],
} as unknown as RedisShim;

// ── Algod mock ────────────────────────────────────────────────────

const algodAccounts = new Map<string, { amount: bigint }>();
let sendShouldFail = false;
const sentTxids: string[] = [];

const mockAlgod = {
  accountInformation: (addr: string) => ({
    do: async () => ({ amount: algodAccounts.get(addr)?.amount ?? 0n }),
  }),
  transactionParams: () => ({
    do: async () => ({
      fee:         0n,
      firstValid:  1000n,
      lastValid:   2000n,
      genesisHash: new Uint8Array(32),
      genesisID:   "mainnet-v1.0",
      minFee:      1000n,
      flatFee:     false,
    }),
  }),
  sendRawTransaction: (_bytes: Uint8Array) => ({
    do: async () => {
      if (sendShouldFail) throw new Error("Algod: transaction rejected");
      const txid = `mock-txid-${sentTxids.length}`;
      sentTxids.push(txid);
      return { txid };
    },
  }),
} as unknown as algosdk.Algodv2;

// ── Test setup ────────────────────────────────────────────────────

// Install mocks before importing the module under test
_setRedisForTest(mockRedis);
_setAlgodForTest(mockAlgod);

// Import after mocks are in place
import { _checkAndTopUpForTest as checkAndTopUp } from "../src/services/gasStation.js";

// ── Fixtures ──────────────────────────────────────────────────────

const testTreasury = algosdk.generateAccount();
const testMnemonic = algosdk.secretKeyToMnemonic(testTreasury.sk);

// Mirrors gasStation.ts constants (defaults)
const TOPUP_MICRO        = 700_000n;
const TREASURY_MIN_MICRO = 100_000n + TOPUP_MICRO + 2_000n; // 802_000 µALGO
const TRIGGER_MICRO      = 500_000n; // updated: 0.50 ALGO = 500 tx runway

function makeAgent(
  agentId:  string,
  address:  string,
  status:   "active" | "registered" | "suspended" | "orphaned" = "active",
) {
  return { agentId, address, cohort: "A", authAddr: "SIGNER",
           createdAt: new Date().toISOString(), registrationTxnId: "init",
           status };
}

function storeAgent(agent: ReturnType<typeof makeAgent>) {
  redisStore.set(`x402:agents:${agent.agentId}`, JSON.stringify(agent));
}

function resetAll() {
  redisStore.clear();
  evalShouldRejectCap = false;
  evalCallCount       = 0;
  decrbyCallCount     = 0;
  setCallArgs         = [];
  sentTxids.length    = 0;
  sendShouldFail      = false;
  algodAccounts.clear();
  process.env.ALGO_TREASURY_MNEMONIC = testMnemonic;
  // Nodely's failover logic replaces _algod with a real client on network failure.
  // Re-install the mock before each test so the singleton stays under test control.
  _setAlgodForTest(mockAlgod);
  _setRedisForTest(mockRedis);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("GasStation — adversarial scenarios", () => {
  beforeEach(() => resetAll());

  // ── CRIT-2: Halt check ────────────────────────────────────────

  it("1. CRIT-2: halted system → cycle skips, no transactions, no outflow guard call", async () => {
    redisStore.set("x402:halt", JSON.stringify({
      reason: "drain-test", setAt: new Date().toISOString(),
      region: "test", instanceId: "test-instance",
    }));
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-halt", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "No transactions while halted");
    assert.equal(evalCallCount, 0,    "Outflow guard must not fire while halted");
  });

  it("2. CRIT-2: not halted → cycle proceeds and tops up eligible agents", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-nohalt", agentAddr));
    algodAccounts.set(agentAddr, { amount: 100_000n }); // below 210_000 trigger
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 1, "Should send one top-up when not halted");
    assert.ok(evalCallCount > 0,      "Outflow guard must be called when not halted");
  });

  // ── MED-2: Treasury balance pre-check ─────────────────────────

  it("3. MED-2: treasury below minimum → bail before any agent balance checked", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-lowt", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    // Treasury < 802_000 µALGO minimum
    algodAccounts.set(testTreasury.addr.toString(), { amount: 500_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "Must not send with low treasury");
    assert.equal(evalCallCount,    0, "Outflow guard must not fire with low treasury");
  });

  it("4. MED-2: treasury exactly at minimum → proceeds", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-exactt", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: TREASURY_MIN_MICRO });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 1, "Should top up at exactly minimum treasury balance");
  });

  // ── HIGH-2: Per-agent cooldown ─────────────────────────────────

  it("5. HIGH-2: agent in cooldown → skipped entirely (no algod balance fetch)", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-cd", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });
    redisStore.set("x402:gas:topup:last:agent-cd", "1"); // cooldown active

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "Cooled-down agent must not be topped up");
    assert.equal(evalCallCount,    0, "Outflow guard must not fire for cooled-down agent");
  });

  it("6. HIGH-2: successful top-up sets cooldown key preventing immediate re-top", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-setcd", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 1, "Top-up should have been sent");
    const cooldownSet = setCallArgs.some(([k]) => k === "x402:gas:topup:last:agent-setcd");
    assert.ok(cooldownSet, "Cooldown key must be set after successful top-up");
  });

  it("7. HIGH-2: send failure → cooldown NOT set so agent is retried next cycle", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-failcd", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });
    sendShouldFail = true;

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "No confirmed tx on send failure");
    const cooldownSet = setCallArgs.some(([k]) => k === "x402:gas:topup:last:agent-failcd");
    assert.ok(!cooldownSet, "Cooldown must NOT be set on send failure");
  });

  // ── CRIT-1: Outflow guard ─────────────────────────────────────

  it("8. CRIT-1: outflow cap breached → cycle stops, no transaction sent", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-cap", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });
    evalShouldRejectCap = true;

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "No transaction when cap is breached");
    assert.ok(evalCallCount > 0,      "Outflow guard must still be called (it sets the halt)");
  });

  it("9. CRIT-1: outflow guard called once per top-up — never bypassed", async () => {
    algodAccounts.set(testTreasury.addr.toString(), { amount: 10_000_000n });
    for (let i = 0; i < 3; i++) {
      const addr = algosdk.generateAccount().addr.toString();
      storeAgent(makeAgent(`agent-og-${i}`, addr));
      algodAccounts.set(addr, { amount: 0n });
    }

    await checkAndTopUp();

    assert.equal(sentTxids.length, 3, "All 3 agents should be topped up");
    assert.equal(evalCallCount,    3, "Outflow guard called exactly once per top-up");
  });

  it("10. CRIT-1: send failure → outflow reservation rolled back via decrby", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-rb", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });
    sendShouldFail = true;

    await checkAndTopUp();

    assert.equal(evalCallCount, 1,       "Outflow guard must be called before send");
    assert.ok(decrbyCallCount > 0,
      "decrby must be called to roll back the outflow reservation after send failure");
  });

  // ── Normal flow ───────────────────────────────────────────────

  it("11. Agent balance at or above trigger threshold → not topped up", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-funded", agentAddr));
    // At exactly TRIGGER_MICRO — not below it, so should not trigger
    algodAccounts.set(agentAddr, { amount: TRIGGER_MICRO });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "Agent at threshold must not be topped up");
    assert.equal(evalCallCount,    0, "Outflow guard must not fire for funded agent");
  });

  it("12. Suspended agent → not topped up regardless of balance", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-susp", agentAddr, "suspended"));
    algodAccounts.set(agentAddr, { amount: 0n }); // empty — but still should skip
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "Suspended agent must not be topped up");
  });

  it("13. Orphaned agent → not topped up", async () => {
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-orp", agentAddr, "orphaned"));
    algodAccounts.set(agentAddr, { amount: 0n });
    algodAccounts.set(testTreasury.addr.toString(), { amount: 5_000_000n });

    await checkAndTopUp();

    assert.equal(sentTxids.length, 0, "Orphaned agent must not be topped up");
  });

  it("14. No ALGO_TREASURY_MNEMONIC → graceful skip, no crash", async () => {
    delete process.env.ALGO_TREASURY_MNEMONIC;
    const agentAddr = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("agent-nomn", agentAddr));
    algodAccounts.set(agentAddr, { amount: 0n });

    await assert.doesNotReject(() => checkAndTopUp());
    assert.equal(sentTxids.length, 0, "No transactions without mnemonic");
  });

  it("15. Mixed agents: only eligible (active/registered, no cooldown, below trigger) are topped up", async () => {
    algodAccounts.set(testTreasury.addr.toString(), { amount: 10_000_000n });

    // eligible — active, below trigger, no cooldown
    const addrA = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("mix-a", addrA, "active"));
    algodAccounts.set(addrA, { amount: 100_000n });

    // skip — above trigger
    const addrB = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("mix-b", addrB, "active"));
    algodAccounts.set(addrB, { amount: 500_000n });

    // skip — in cooldown
    const addrC = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("mix-c", addrC, "active"));
    algodAccounts.set(addrC, { amount: 0n });
    redisStore.set("x402:gas:topup:last:mix-c", "1");

    // skip — suspended
    const addrD = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("mix-d", addrD, "suspended"));
    algodAccounts.set(addrD, { amount: 0n });

    // eligible — registered (counts as eligible), below trigger, no cooldown
    const addrE = algosdk.generateAccount().addr.toString();
    storeAgent(makeAgent("mix-e", addrE, "registered"));
    algodAccounts.set(addrE, { amount: 0n });

    await checkAndTopUp();

    // Only mix-a and mix-e should be topped up
    assert.equal(sentTxids.length, 2, "Only a and e should be topped up");
    assert.equal(evalCallCount,    2, "Outflow guard called exactly twice");

    const cdA = setCallArgs.some(([k]) => k === "x402:gas:topup:last:mix-a");
    const cdE = setCallArgs.some(([k]) => k === "x402:gas:topup:last:mix-e");
    assert.ok(cdA, "Cooldown set for mix-a");
    assert.ok(cdE, "Cooldown set for mix-e");
  });
});
