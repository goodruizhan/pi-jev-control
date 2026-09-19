import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPath } from "../src/config.js";
import { runtimeState, resetState } from "../src/state/runtime-state.js";
import { resetStats, formatStats } from "../src/stats/stats.js";
import { isJevAvailable, getUnavailableReason } from "../src/jev/client.js";
import { setupTaskRouter } from "../src/router/task-router.js";
import { setupToolGate } from "../src/gates/tool-gate.js";
import { setupFailureClassifier } from "../src/judgment/failure-classifier.js";
import { setupContextGate } from "../src/gates/context-gate.js";
import { setupSkillGate } from "../src/gates/skill-gate.js";
import { setupAgentRouter } from "../src/router/agent-router.js";
import { analyzeUserInput } from "../src/memory/memory-gate.js";
import { searchMemory, findSimilarFailure } from "../src/memory/retrieval.js";
import { clearAllMemory, getMemoryCount, getDataPath } from "../src/memory/store.js";
import { callJev } from "../src/jev/client.js";
import { choice } from "@typesafe-ai/sdk";
import { Type } from "typebox";


/**
 * pi-dev-control — Jev-powered control layer for Pi Coding Agent
 *
 * v0.2: Task Router, Model Router, Tool Gate, Failure Classifier, Retry Judge, Stats,
 *        Context Gate (jev_search_code), Skill Gate (jev_select_skills),
 *        Agent Router (jev_route_agent), Memory Gate, Memory Store, Memory Search,
 *        Project config override
 */

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (!config.enabled) {
    console.log("[pi-jev-control] Disabled in config");
    return;
  }

  // ── Setup event handlers ────────────────────────────────────────

  // Task Router (input event)
  setupTaskRouter(pi);

  // Tool Gate (tool_call event)
  setupToolGate(pi);

  // Failure Classifier (tool_result event)
  setupFailureClassifier(pi);

  // Context Gate (jev_search_code tool)
  setupContextGate(pi);

  // Skill Gate (jev_select_skills tool)
  setupSkillGate(pi);

  // Agent Router (jev_route_agent tool)
  setupAgentRouter(pi);

  // Memory Search (jev_memory_search tool)
  registerMemorySearchTool(pi);

  // Memory Gate (input event for constraint/decision detection)
  setupMemoryGate(pi);

  // ── Register /jev command ───────────────────────────────────────

  pi.registerCommand("jev", {
    description: "Jev control layer — status, probe, stats, router/gate toggles",
    handler: async (args, ctx) => {
      const config = loadConfig();
      const arg = (args ?? "").trim().toLowerCase();

      // /jev or /jev status — show status
      if (arg === "" || arg === "status") {
        const status = buildStatus(config);
        ctx.ui.notify(status, "info");
        return;
      }

      // /jev probe — test Jev API
      if (arg === "probe") {
        await runProbe(ctx);
        return;
      }

      // /jev stats — show stats
      if (arg === "stats") {
        ctx.ui.notify(formatStats(), "info");
        return;
      }

      // /jev last — show last routing decision
      if (arg === "last") {
        const state = runtimeState;
        if (state.lastDecision) {
          ctx.ui.notify(
            `Last decision: ${state.lastDecision.type} = ${state.lastDecision.value}\n` +
              `confidence: ${state.lastDecision.confidence?.toFixed(2) ?? "N/A"}\n` +
              `time: ${new Date(state.lastDecision.timestamp).toLocaleTimeString()}`,
            "info",
          );
        } else {
          ctx.ui.notify("No routing decision recorded yet.", "info");
        }
        return;
      }

      // /jev router on|off — toggle Task Router
      if (arg.startsWith("router ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "router", config, ctx);
        return;
      }

      // /jev toolgate on|off — toggle Tool Gate
      if (arg.startsWith("toolgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "toolGate", config, ctx);
        return;
      }

      // /jev retry on|off — toggle Retry Judge
      if (arg.startsWith("retry ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "retryJudge", config, ctx);
        return;
      }

      // /jev contextgate on|off — toggle Context Gate
      if (arg.startsWith("contextgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "contextGate", config, ctx);
        return;
      }

      // /jev skillgate on|off — toggle Skill Gate
      if (arg.startsWith("skillgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "skillGate", config, ctx);
        return;
      }

      // /jev memory on|off — toggle Memory Gate
      if (arg.startsWith("memory ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "memoryGate", config, ctx);
        return;
      }

      // /jev memory clear — clear all memory
      if (arg === "memory clear") {
        clearAllMemory();
        ctx.ui.notify("All memory records cleared.", "info");
        return;
      }

      // /jev memory stats — show memory store info
      if (arg === "memory stats") {
        const counts = getMemoryCount();
        ctx.ui.notify(
          `Memory Store:\n` +
            `  Path: ${getDataPath()}\n` +
            `  Memory records: ${counts.memory}\n` +
            `  Failure records: ${counts.failures}`,
          "info",
        );
        return;
      }

      // /jev reset — reset state and stats
      if (arg === "reset") {
        resetState();
        resetStats();
        ctx.ui.notify("State and stats reset.", "info");
        return;
      }

      // Unknown subcommand
      ctx.ui.notify(
        `Unknown /jev command: "${arg}"\n` +
          `Available: status, probe, stats, last, router on|off, toolgate on|off, retry on|off, contextgate on|off, skillgate on|off, memory on|off, memory clear, memory stats, reset`,
        "info",
      );
    },
  });
}

// ── Helper functions ──────────────────────────────────────────────

function buildStatus(config: ReturnType<typeof loadConfig>): string {
  const jevStatus = isJevAvailable() ? "READY" : `UNAVAILABLE (${getUnavailableReason() ?? "unknown"})`;

  const routerStatus = config.router.enabled ? "ON" : "OFF";
  const toolGateStatus = config.toolGate.enabled ? "ON" : "OFF";
  const retryStatus = config.retryJudge.enabled ? "ON" : "OFF";
  const contextGateStatus = config.contextGate.enabled ? "ON" : "OFF";
  const skillGateStatus = config.skillGate.enabled ? "ON" : "OFF";
  const memoryStatus = config.memoryGate.enabled ? "ON" : "OFF";

  const lastTier = runtimeState.lastTaskTier ?? "none";
  const lastConfidence = runtimeState.lastTaskConfidence !== undefined
    ? runtimeState.lastTaskConfidence.toFixed(2)
    : "N/A";

  return [
    `pi-dev-control v0.2.0`,
    `Jev API: ${jevStatus}`,
    `Model: ${config.jev.model}`,
    `Timeout: ${config.jev.timeoutMs}ms`,
    `Router: ${routerStatus} (mode: ${config.router.mode})`,
    `Tool Gate: ${toolGateStatus}`,
    `Retry Judge: ${retryStatus}`,
    `Context Gate: ${contextGateStatus}`,
    `Skill Gate: ${skillGateStatus}`,
    `Memory Gate: ${memoryStatus}`,
    `Compaction: NOT AVAILABLE IN v0.2`,
    `Last routing: ${lastTier}`,
    `confidence: ${lastConfidence}`,
    `Config: ${getConfigPath()}`,
  ].join("\n");
}

async function runProbe(ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): Promise<void> {
  // Test with a simple choice question
  const probeQuestion = choice(
    "Choose whether this task is cheap, medium, strong, or unknown.",
    {
      cheap: null,
      medium: null,
      strong: null,
      unknown: null,
    },
  );

  const state = {
    task: "find all files containing EnemyPatrol",
  };

  ctx.ui.notify("Running /jev probe...", "info");

  const result = await callJev(state, { probe: probeQuestion }, {
    module: "router",
  });

  if (result.ok === false) {
    const err = result;
    ctx.ui.notify(
      `[Jev probe FAILED]\n` +
        `errorType: ${err.errorType}\n` +
        `error: ${err.error}\n` +
        `\n` +
        `If TYPESAFE_API_KEY is not set, Jev features will be unavailable.`,
      "error",
    );
    return;
  }

  const answer = result.result.answers.probe;
  ctx.ui.notify(
    `[Jev probe SUCCESS]\n` +
      `model: ${result.result.model}\n` +
      `choice: ${answer.choice}\n` +
      `confidence: ${answer.confidence.toFixed(4)}\n` +
      `probabilities: ${JSON.stringify(answer.probabilities)}\n` +
      `input_tokens: ${result.result.usage.input_tokens}\n` +
      `output_tokens: ${result.result.usage.output_tokens}\n` +
      `latency: ${result.latencyMs}ms`,
    "info",
  );
}

function toggleModule(
  action: string | undefined,
  moduleName: "router" | "toolGate" | "retryJudge" | "contextGate" | "skillGate" | "memoryGate",
  config: ReturnType<typeof loadConfig>,
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
): void {
  if (action === "on" || action === "off") {
    // Toggle in-memory config
    if (moduleName === "router") config.router.enabled = action === "on";
    else if (moduleName === "toolGate") config.toolGate.enabled = action === "on";
    else if (moduleName === "retryJudge") config.retryJudge.enabled = action === "on";
    else if (moduleName === "contextGate") config.contextGate.enabled = action === "on";
    else if (moduleName === "skillGate") config.skillGate.enabled = action === "on";
    else if (moduleName === "memoryGate") config.memoryGate.enabled = action === "on";

    const label = moduleName === "toolGate" ? "Tool Gate" :
                  moduleName === "retryJudge" ? "Retry Judge" :
                  moduleName === "contextGate" ? "Context Gate" :
                  moduleName === "skillGate" ? "Skill Gate" :
                  moduleName === "memoryGate" ? "Memory Gate" : "Task Router";
    ctx.ui.notify(`${label}: ${action.toUpperCase()}`, "info");

    // Note: /reload required for persistent changes
    ctx.ui.notify("Note: Use /reload for persistent changes.", "info");
  } else {
    ctx.ui.notify(`Usage: /jev ${moduleName} on|off`, "info");
  }
}

// ── Memory Gate setup ─────────────────────────────────────────────

function setupMemoryGate(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    // Analyze user input for memory-worthy content
    await analyzeUserInput(event.text, ctx);
  });
}

// ── Memory Search Tool ────────────────────────────────────────────

function registerMemorySearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_memory_search",
    label: "Jev Memory Search",
    description: "Search local memory store for relevant information using Jev-powered relevance ranking.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      types: Type.Optional(Type.Array(Type.String(), { description: "Filter by memory types: fact, decision, failure, constraint" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 5)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const query = params.query as string;
      const types = params.types as string[] | undefined;
      const limit = params.limit as number | undefined;

      const result = await searchMemory({ query, types, limit }, signal);

      if (result.records.length === 0) {
        return {
          content: [{ type: "text", text: `No memory records found for: "${query}"` }],
          details: {},
        };
      }

      const lines = [
        `Memory search: "${query}" (${result.totalCandidates} candidates, ${result.totalAfterJev} after Jev)`,
        ``,
      ];

      result.records.forEach((r, i) => {
        lines.push(`${i + 1}. [${r.type}] ${r.summary}`);
        lines.push(`   date: ${new Date(r.timestamp).toISOString().slice(0, 10)}`);
        lines.push(`   confidence: ${r.confidence.toFixed(2)}`);
        lines.push(`   source: ${r.source}`);
        if (r.resolved !== undefined) lines.push(`   resolved: ${r.resolved}`);
        lines.push(``);
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
