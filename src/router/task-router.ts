import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { TASK_TIER_QUESTION } from "../jev/questions.js";
import { buildRouterResult } from "../jev/normalize.js";
import { runtimeState } from "../state/runtime-state.js";
import { routeModel } from "./model-router.js";
import type { RouterResult } from "../types.js";
import { SHORT_CONFIRMATIONS } from "../types.js";
import { recordModelTierDecision } from "../stats/savings.js";
import { tr } from "../i18n.js";
import { notifyAutomatic } from "../ui.js";

/**
 * Task Router — classifies incoming user tasks as cheap/medium/strong/unknown.
 * Hooks into pi.on("input") to run before the main agent processes the input.
 *
 * Skips routing for:
 * - Empty input
 * - event.source === "extension"
 * - Commands starting with "/"
 * - Short confirmation phrases (继续/好的/ok/yes/go etc.)
 *
 * Only sends the current task text to Jev, not full history.
 */

interface RouterContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}

/**
 * Check if the input should be skipped by the router.
 */
function shouldSkipRouting(text: string, source: string): boolean {
  if (!text || text.trim().length === 0) return true;
  if (source === "extension") return true;
  if (text.startsWith("/")) return true;

  // Check short confirmations
  const trimmed = text.trim().toLowerCase();
  if (SHORT_CONFIRMATIONS.has(trimmed)) return true;

  return false;
}

/**
 * Run the task router on an input event.
 * Returns the RouterResult if routing occurred, or null if skipped.
 */
export async function routeTask(
  text: string,
  source: string,
  signal?: AbortSignal,
): Promise<RouterResult | null> {
  if (shouldSkipRouting(text, source)) return null;

  const config = loadConfig();
  if (!config.enabled || !config.router.enabled) return null;
  if (config.router.mode === "set-model" && !hasConfiguredRouterTarget(config.router.models)) return null;

  // Check Jev availability — if unavailable, skip routing entirely
  if (!isJevAvailable()) return null;

  // Build minimal state — only current task, no history
  const state = {
    task: text.trim().slice(0, 4000),
    domain: "software development with Pi; often Unreal Engine 5",
  };

  const questions = {
    task_tier: TASK_TIER_QUESTION,
  };

  const result = await callJev(state, questions, {
    module: "router",
    signal,
  });

  if (!result.ok) {
    // Jev failed — keep current model, log the failure
    console.warn("[pi-jev-control] Router Jev call failed:", result.errorType, result.error);
    return null;
  }

  const answer = result.result.answers.task_tier;
  const routerResult = buildRouterResult(answer.choice, answer.confidence, result.latencyMs, result.result.model);

  // Check confidence threshold
  const threshold = config.router.confidenceThreshold;
  if (routerResult.tier === "unknown" || routerResult.confidence < threshold) {
    // Below threshold or unknown — use fallback tier
    const fallbackTier = config.router.fallbackTier;
    return {
      ...routerResult,
      tier: fallbackTier,
      confidence: 0, // mark as fallback
    };
  }

  return routerResult;
}

/** Skip a network classification when no configured model could consume it. */
export function hasConfiguredRouterTarget(models: ReturnType<typeof loadConfig>["router"]["models"]): boolean {
  return Object.values(models).some((model) =>
    model.provider !== "REPLACE_ME" &&
    model.model !== "REPLACE_ME" &&
    model.provider.trim().length > 0 &&
    model.model.trim().length > 0
  );
}

/**
 * Setup the task router event handler.
 */
export function setupTaskRouter(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    const routerResult = await routeTask(event.text, event.source, ctx.signal);

    if (!routerResult) return; // skipped or failed — let Pi continue normally

    // Update runtime state
    runtimeState.lastTaskTier = routerResult.tier;
    runtimeState.lastTaskConfidence = routerResult.confidence;
    runtimeState.lastJevModel = loadConfig().jev.model;
    runtimeState.lastDecision = {
      type: "task_tier",
      value: routerResult.tier,
      confidence: routerResult.confidence,
      timestamp: routerResult.timestamp,
    };
    recordModelTierDecision();

    // Switch model based on tier
    await routeModel(pi, ctx, routerResult.tier);

    // Notify with tier (debug info)
    if (routerResult.confidence > 0) {
      notifyAutomatic(ctx,
        tr(
          `[Jev] Task tier: ${routerResult.tier} (confidence: ${routerResult.confidence.toFixed(2)})`,
          `[Jev] 任务等级：${routerResult.tier}（置信度：${routerResult.confidence.toFixed(2)}）`,
        ),
        "info",
      );
    }
  });
}
