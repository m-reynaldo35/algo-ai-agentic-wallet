/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  x402 Setup Tester — Claude-Powered Diagnostic Agent           ║
 * ║                                                                  ║
 * ║  Logs in to your algo-wallet API and runs a full diagnostic     ║
 * ║  suite: health, portal auth, agents, telemetry, x402 protocol.  ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    X402_API_URL=https://algo-ai-wallet-production.up.railway.app ║
 * ║    PORTAL_API_SECRET=your-secret                                 ║
 * ║    ALGO_MNEMONIC="25 word mnemonic" (optional — skips x402)      ║
 * ║    ANTHROPIC_API_KEY=your-key                                    ║
 * ║    npx tsx examples/setup-tester.ts                              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import Anthropic from "@anthropic-ai/sdk";
import algosdk from "algosdk";
import "dotenv/config";

// ── Config ────────────────────────────────────────────────────────
const API_URL        = process.env.X402_API_URL ?? process.env.E2E_BASE_URL ?? "http://localhost:4020";
const PORTAL_SECRET  = process.env.PORTAL_API_SECRET ?? "";
const MNEMONIC       = process.env.ALGO_MNEMONIC ?? "";
const TEST_AGENT_ID  = process.env.TEST_AGENT_ID ?? "setup-tester-v1";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[FATAL] ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

const portalHeaders: Record<string, string> = {
  "Content-Type": "application/json",
  ...(PORTAL_SECRET ? { "Authorization": `Bearer ${PORTAL_SECRET}` } : {}),
};

// ── Helpers ───────────────────────────────────────────────────────
async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; ok: boolean; data: unknown }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...portalHeaders, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: unknown;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: { error: String(err) } };
  }
}

// ── Tool Definitions ──────────────────────────────────────────────
const tools: Anthropic.Tool[] = [
  {
    name: "check_health",
    description: "Calls GET /health on the algo-wallet API. Returns server status, network, and uptime. No auth needed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_api_info",
    description: "Calls GET /api/info. Returns API version, configured x402 price, USDC asset ID, and network info.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_halt_status",
    description: "Calls GET /api/system/halt-status. Requires portal auth. Returns whether the system is globally halted and the halt reason if so.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_telemetry",
    description: "Calls GET /api/portal/telemetry. Requires portal auth. Returns agent counts, settlement totals, velocity stats, and event counts.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_agents",
    description: "Calls GET /api/agents. Requires portal auth. Returns all registered agents with their status, cohort, and auth address.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_agent",
    description: "Calls GET /api/agents/:agentId. Requires portal auth. Returns a single agent's full status including custody version.",
    input_schema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent ID to look up" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "register_agent",
    description: "Calls POST /api/agents/register-existing with a mnemonic. Requires portal auth and ALGO_MNEMONIC to be set. Returns the registered agent with Algorand address and cohort.",
    input_schema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The agent ID to register (default: setup-tester-v1)",
        },
      },
      required: [],
    },
  },
  {
    name: "check_x402_paywall",
    description: "Hits a protected endpoint without payment to verify the x402 paywall is active. Expects a 402 response. Returns the payment details (price, pay-to address, asset ID).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recent_events",
    description: "Calls GET /api/portal/events to list recent security and settlement events. Requires portal auth.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return (default 10)" },
      },
      required: [],
    },
  },
];

// ── Tool Executor ──────────────────────────────────────────────────
async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "check_health": {
      const r = await apiCall("GET", "/health");
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "get_api_info": {
      const r = await apiCall("GET", "/api/info");
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "get_halt_status": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({
          error: "PORTAL_API_SECRET not set — portal auth required for this endpoint",
          hint: "Set PORTAL_API_SECRET env var and re-run",
        });
      }
      const r = await apiCall("GET", "/api/system/halt-status");
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "get_telemetry": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({ error: "PORTAL_API_SECRET not set — skipping telemetry check" });
      }
      const r = await apiCall("GET", "/api/portal/telemetry");
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "list_agents": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({ error: "PORTAL_API_SECRET not set — skipping agent list" });
      }
      const r = await apiCall("GET", "/api/agents");
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "get_agent": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({ error: "PORTAL_API_SECRET not set — skipping agent lookup" });
      }
      const agentId = (input.agentId as string) ?? TEST_AGENT_ID;
      const r = await apiCall("GET", `/api/agents/${encodeURIComponent(agentId)}`);
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    case "register_agent": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({ error: "PORTAL_API_SECRET not set — cannot register agent" });
      }
      if (!MNEMONIC) {
        return JSON.stringify({
          error: "ALGO_MNEMONIC not set — cannot register agent",
          hint: "Set ALGO_MNEMONIC env var with a 25-word Algorand mnemonic and re-run",
        });
      }
      const agentId = (input.agentId as string) ?? TEST_AGENT_ID;
      // Derive address from mnemonic to display
      const account = algosdk.mnemonicToSecretKey(MNEMONIC);
      const address = account.addr.toString();
      const r = await apiCall("POST", "/api/agents/register-existing", {
        agentId,
        mnemonic: MNEMONIC,
      });
      return JSON.stringify({
        status: r.status,
        agentId,
        derivedAddress: address,
        data: r.data,
      }, null, 2);
    }

    case "check_x402_paywall": {
      // Hit /api/agent-action without any x402 headers — should get 402
      const r = await apiCall("POST", "/api/agent-action", { test: true }, {
        // No x402 payment headers — intentionally triggering 402
      });
      return JSON.stringify({
        status: r.status,
        expected: 402,
        paywallActive: r.status === 402,
        data: r.data,
      }, null, 2);
    }

    case "get_recent_events": {
      if (!PORTAL_SECRET) {
        return JSON.stringify({ error: "PORTAL_API_SECRET not set — skipping events" });
      }
      const limit = (input.limit as number) ?? 10;
      const r = await apiCall("GET", `/api/portal/events?limit=${limit}`);
      return JSON.stringify({ status: r.status, data: r.data }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── Main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const client = new Anthropic();

  // Derive agent address if mnemonic is available
  let agentAddress = "(not provided)";
  if (MNEMONIC) {
    try {
      const account = algosdk.mnemonicToSecretKey(MNEMONIC);
      agentAddress = account.addr.toString();
    } catch {
      agentAddress = "(invalid mnemonic)";
    }
  }

  const systemPrompt = `You are a diagnostic agent for the x402 Agentic Wallet infrastructure.
Your job is to run a complete setup test and produce a clear status report.

Run these checks IN ORDER, calling one tool at a time:
1. check_health — verify the server is reachable
2. get_api_info — confirm version and x402 price config
3. check_x402_paywall — verify the 402 paywall is working
4. get_halt_status — check the system is not halted
5. list_agents — see how many agents are registered
6. get_telemetry — check settlement and event metrics
7. get_recent_events — review recent security events
${MNEMONIC ? `8. register_agent — register the test agent (agentId: "${TEST_AGENT_ID}")
9. get_agent — confirm the agent registered successfully` : ""}

After all checks, produce a final Markdown report with:
- A PASS/FAIL/WARN status for each check
- A summary table
- Any configuration issues found
- Recommended next steps

Be concise but complete. Flag any security concerns.`;

  const userMessage = `Run a full diagnostic on the algo-wallet API at ${API_URL}.

Config summary:
- API URL: ${API_URL}
- Portal auth: ${PORTAL_SECRET ? "✓ configured" : "✗ NOT SET"}
- Agent mnemonic: ${MNEMONIC ? `✓ configured (addr: ${agentAddress})` : "✗ not set (skipping x402 payment tests)"}
- Test agent ID: ${TEST_AGENT_ID}

Run all checks and report the results.`;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  x402 Setup Tester — Claude Diagnostic Agent                    ║
╠══════════════════════════════════════════════════════════════════╣
║  API:    ${API_URL.padEnd(53)}║
║  Auth:   ${(PORTAL_SECRET ? "Portal secret configured" : "NO SECRET — auth endpoints will fail").padEnd(53)}║
║  Model:  claude-opus-4-6 (adaptive thinking)                    ║
╚══════════════════════════════════════════════════════════════════╝
`);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // Agentic loop with streaming
  let iteration = 0;
  const MAX_ITERATIONS = 20;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      tools,
      messages,
    });

    // Stream text output in real time
    process.stdout.write("\n");
    stream.on("text", (delta) => process.stdout.write(delta));

    const message = await stream.finalMessage();

    // Append assistant response
    messages.push({ role: "assistant", content: message.content });

    // Done?
    if (message.stop_reason === "end_turn") {
      process.stdout.write("\n\n");
      break;
    }

    // Handle tool calls
    if (message.stop_reason === "tool_use") {
      const toolUseBlocks = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tool of toolUseBlocks) {
        process.stdout.write(`\n\n[TOOL] ${tool.name}`);
        if (Object.keys(tool.input as object).length > 0) {
          process.stdout.write(` ${JSON.stringify(tool.input)}`);
        }
        process.stdout.write("\n");

        const result = await executeTool(tool.name, tool.input as Record<string, unknown>);

        // Pretty-print the result summary
        try {
          const parsed = JSON.parse(result);
          const status = parsed.status;
          const ok = status >= 200 && status < 300;
          const paywallOk = tool.name === "check_x402_paywall" && parsed.paywallActive;
          const icon = (ok || paywallOk) ? "✓" : "✗";
          process.stdout.write(`       ${icon} HTTP ${status || "ERR"}\n`);
        } catch {
          // not JSON
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // pause_turn — re-send to continue
    if (message.stop_reason === "pause_turn") {
      continue;
    }

    break;
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error("[WARN] Reached max iterations — agent may be stuck in a loop");
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
