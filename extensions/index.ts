import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPath } from "../src/config.js";
import { runtimeState, resetState } from "../src/state/runtime-state.js";
import { resetStats, formatStats } from "../src/stats/stats.js";
import { isJevAvailable, getUnavailableReason } from "../src/jev/client.js";
import { setupTaskRouter } from "../src/router/task-router.js";
import { setupToolGate } from "../src/gates/tool-gate.js";
import { setupFailureClassifier } from "../src/judgment/failure-classifier.js";
import { callJev } from "../src/jev/client.js";
import { choice } from "@typesafe-ai/sdk";


/**
 * pi-dev-control — Jev-powered control layer for Pi Coding Agent
 *
 * v0.1: Task Router, Model Router, Tool Gate, Failure Classifier, Retry Judge, Stats, /jev commands
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
          `Available: status, probe, stats, last, router on|off, toolgate on|off, retry on|off, reset`,
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

  const lastTier = runtimeState.lastTaskTier ?? "none";
  const lastConfidence = runtimeState.lastTaskConfidence !== undefined
    ? runtimeState.lastTaskConfidence.toFixed(2)
    : "N/A";

  return [
    `pi-dev-control v0.1.0`,
    `Jev API: ${jevStatus}`,
    `Model: ${config.jev.model}`,
    `Timeout: ${config.jev.timeoutMs}ms`,
    `Router: ${routerStatus} (mode: ${config.router.mode})`,
    `Tool Gate: ${toolGateStatus}`,
    `Retry Judge: ${retryStatus}`,
    `Context Gate: NOT AVAILABLE IN v0.1`,
    `Skill Gate: NOT AVAILABLE IN v0.1`,
    `Memory Gate: NOT AVAILABLE IN v0.1`,
    `Compaction: NOT AVAILABLE IN v0.1`,
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
  moduleName: "router" | "toolGate" | "retryJudge",
  config: ReturnType<typeof loadConfig>,
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
): void {
  if (action === "on" || action === "off") {
    // Toggle in-memory config
    if (moduleName === "router") config.router.enabled = action === "on";
    else if (moduleName === "toolGate") config.toolGate.enabled = action === "on";
    else if (moduleName === "retryJudge") config.retryJudge.enabled = action === "on";

    const label = moduleName === "toolGate" ? "Tool Gate" : moduleName === "retryJudge" ? "Retry Judge" : "Task Router";
    ctx.ui.notify(`${label}: ${action.toUpperCase()}`, "info");

    // Note: /reload required for persistent changes
    ctx.ui.notify("Note: Use /reload for persistent changes.", "info");
  } else {
    ctx.ui.notify(`Usage: /jev ${moduleName} on|off`, "info");
  }
}
