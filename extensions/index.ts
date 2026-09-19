import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPath } from "../src/config.js";
import { runtimeState, resetState } from "../src/state/runtime-state.js";
import { resetStats, formatStats } from "../src/stats/stats.js";
import { resetSavings, formatSavings } from "../src/stats/savings.js";
import { isJevAvailable, getUnavailableReason } from "../src/jev/client.js";
import { setupTaskRouter } from "../src/router/task-router.js";
import { setupToolGate } from "../src/gates/tool-gate.js";
import { setupFailureClassifier } from "../src/judgment/failure-classifier.js";
import { setupContextGate } from "../src/gates/context-gate.js";
import { setupSkillGate } from "../src/gates/skill-gate.js";
import { setupAgentRouter } from "../src/router/agent-router.js";
import { analyzeUserInput } from "../src/memory/memory-gate.js";
import { searchMemory } from "../src/memory/retrieval.js";
import { clearAllMemory, getMemoryCount, getDataPath, markFailureResolved } from "../src/memory/store.js";
import { callJev } from "../src/jev/client.js";
import { choice } from "@typesafe-ai/sdk";
import { Type } from "typebox";
// v0.3 imports
import { setupContextHook, setupSessionBeforeCompact } from "../src/compaction/context-hook.js";
import { clearEpochPlan, requestEpochPlan, resetEpoch, getEpochInfo } from "../src/compaction/epoch.js";
import { setupReviewGate } from "../src/review/review-gate.js";
import { setupGUIActionRouter } from "../src/gui/action-router.js";


/**
 * pi-jev-control — Jev-powered control layer for Pi Coding Agent
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

  // ── v0.3: Compaction ─────────────────────────────────────────────

  // Context Hook (context event — pruning)
  setupContextHook(pi);

  // Session Before Compact (ensure memory before Pi compacts)
  setupSessionBeforeCompact(pi);

  // ── v0.3: Review Gate ────────────────────────────────────────────

  setupReviewGate(pi);

  // ── v0.3: GUI Action Router ──────────────────────────────────────

  setupGUIActionRouter(pi);

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

      if (arg.startsWith("agentrouter ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "agentRouter", config, ctx);
        return;
      }

      if (arg.startsWith("reviewgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "reviewGate", config, ctx);
        return;
      }

      if (arg.startsWith("guirouter ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "guiRouter", config, ctx);
        return;
      }

      // /jev memory clear — clear all memory
      if (arg === "memory clear") {
        clearAllMemory();
        ctx.ui.notify("All memory records cleared.", "info");
        return;
      }

      if (arg.startsWith("memory resolve ")) {
        const id = arg.slice("memory resolve ".length).trim();
        const resolved = id.length > 0 && markFailureResolved(id);
        ctx.ui.notify(resolved ? `Failure ${id} marked resolved.` : `Failure ${id || "(missing id)"} not found.`, resolved ? "info" : "warning");
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

      // /jev memory on|off — toggle Memory Gate (after exact memory commands)
      if (arg.startsWith("memory ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "memoryGate", config, ctx);
        return;
      }

      // /jev reset — reset state and stats
      if (arg === "reset") {
        resetState();
        resetStats();
        resetSavings();
        resetEpoch();
        ctx.ui.notify("State, stats, savings, and epoch reset.", "info");
        return;
      }

      // ── v0.3: /jev compact commands ───────────────────────────

      // /jev compact status — show epoch/compaction status
      if (arg === "compact status") {
        const info = getEpochInfo();
        const config = loadConfig();
        const status = [
          `Compaction: ${config.compaction.enabled ? "ON" : "OFF"}`,
          `Min turns between plans: ${config.compaction.minTurnsBetweenPlans}`,
          `Min chars to save: ${config.compaction.minCharsToSave}`,
          `Preserve recent messages: ${config.compaction.preserveRecentMessages}`,
          ``,
          `Epoch Plan: ${info.hasPlan ? "ACTIVE" : "NONE"}`,
          `Epoch ID: ${info.epochId ?? "N/A"}`,
          `Plan age: ${info.planAge} turn(s)`,
          `Est. chars saved: ${info.estimatedSavedChars}`,
        ].join("\n");
        ctx.ui.notify(status, "info");
        return;
      }

      // /jev compact plan — generate a new pruning plan
      if (arg === "compact plan") {
        ctx.ui.notify("Generating new pruning plan...", "info");
        // We can't access the current messages directly from the command context
        // The plan will be generated on the next context event
        requestEpochPlan();
        ctx.ui.notify("Plan will be regenerated on the next turn.", "info");
        return;
      }

      // /jev compact clear — clear the pruning plan
      if (arg === "compact clear") {
        clearEpochPlan();
        ctx.ui.notify("Pruning plan cleared. Next turn will use full history view.", "info");
        return;
      }

      // /jev compact on|off — toggle compaction
      if (arg.startsWith("compact ")) {
        const action = arg.split(" ")[1];
        if (action === "on" || action === "off") {
          config.compaction.enabled = action === "on";
          ctx.ui.notify(`Compaction: ${action.toUpperCase()}`, "info");
          ctx.ui.notify("Note: Use /reload for persistent changes.", "info");
        } else {
          ctx.ui.notify(`Usage: /jev compact on|off|status|plan|clear`, "info");
        }
        return;
      }

      // ── v0.3: /jev savings — show savings stats ──────────────

      // /jev savings — show savings estimates
      if (arg === "savings") {
        ctx.ui.notify(formatSavings(), "info");
        return;
      }

      // Unknown subcommand
      ctx.ui.notify(
        `Unknown /jev command: "${arg}"\n` +
          `Available: status, probe, stats, savings, last, router/toolgate/retry/contextgate/skillgate/agentrouter/reviewgate/guirouter on|off, memory on|off|clear|stats|resolve <id>, compact on|off|status|plan|clear, reset`,
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
  const agentRouterStatus = config.agentRouter.enabled ? "ON" : "OFF";
  const memoryStatus = config.memoryGate.enabled ? "ON" : "OFF";
  const compactionStatus = config.compaction.enabled ? "ON" : "OFF";
  const reviewGateStatus = config.reviewGate.enabled ? "ON" : "OFF";
  const guiRouterStatus = config.guiRouter.enabled ? "ON" : "OFF";

  const epochInfo = getEpochInfo();
  const epochStatus = epochInfo.hasPlan ? `ACTIVE (${epochInfo.estimatedSavedChars} chars saved)` : "NO PLAN";

  const lastTier = runtimeState.lastTaskTier ?? "none";
  const lastConfidence = runtimeState.lastTaskConfidence !== undefined
    ? runtimeState.lastTaskConfidence.toFixed(2)
    : "N/A";

  return [
    `pi-jev-control v0.3.0`,
    `Jev API: ${jevStatus}`,
    `Model: ${config.jev.model}`,
    `Timeout: ${config.jev.timeoutMs}ms`,
    `Router: ${routerStatus} (mode: ${config.router.mode})`,
    `Tool Gate: ${toolGateStatus}`,
    `Retry Judge: ${retryStatus}`,
    `Context Gate: ${contextGateStatus}`,
    `Skill Gate: ${skillGateStatus}`,
    `Agent Router: ${agentRouterStatus}`,
    `Memory Gate: ${memoryStatus}`,
    `Compaction: ${compactionStatus} (epoch: ${epochStatus})`,
    `Review Gate: ${reviewGateStatus}`,
    `GUI Router: ${guiRouterStatus}`,
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
  moduleName: "router" | "toolGate" | "retryJudge" | "contextGate" | "skillGate" | "agentRouter" | "memoryGate" | "reviewGate" | "guiRouter",
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
    else if (moduleName === "agentRouter") config.agentRouter.enabled = action === "on";
    else if (moduleName === "memoryGate") config.memoryGate.enabled = action === "on";
    else if (moduleName === "reviewGate") config.reviewGate.enabled = action === "on";
    else if (moduleName === "guiRouter") config.guiRouter.enabled = action === "on";

    const label = moduleName === "toolGate" ? "Tool Gate" :
                  moduleName === "retryJudge" ? "Retry Judge" :
                  moduleName === "contextGate" ? "Context Gate" :
                   moduleName === "skillGate" ? "Skill Gate" :
                   moduleName === "agentRouter" ? "Agent Router" :
                   moduleName === "memoryGate" ? "Memory Gate" : "Task Router";
    const finalLabel = moduleName === "reviewGate" ? "Review Gate" :
                       moduleName === "guiRouter" ? "GUI Router" : label;
    ctx.ui.notify(`${finalLabel}: ${action.toUpperCase()}`, "info");

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
    await analyzeUserInput(event.text, ctx, event.source);
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
      const config = loadConfig();
      if (!config.enabled || !config.memoryGate.enabled) {
        return {
          content: [{ type: "text", text: "Jev Memory Gate is disabled." }],
          details: {},
        };
      }
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
        lines.push(`   id: ${r.id}`);
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
