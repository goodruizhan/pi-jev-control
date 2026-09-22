import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { TASK_TIER_QUESTION } from "../judge/questions.js";
import { buildRouterResult } from "../judge/normalize.js";
import { runtimeState } from "../state/runtime-state.js";
import { isConfiguredModelSpec, modelCandidates, routeModelDetailed } from "./model-router.js";
import { extractRouteRisk, summarizeTask, tierAtLeast } from "./risk.js";
import type { JevControlConfig, RouterResult } from "../types.js";
import { SHORT_CONFIRMATIONS } from "../types.js";
import { recordModelTierDecision } from "../stats/savings.js";
import { tr } from "../i18n.js";
import { notifyAutomatic } from "../ui.js";

let nextOverride: "cheap" | "medium" | "strong" | undefined;

/** One-shot override for the next substantive user input. */
export function setNextRouteOverride(tier: "cheap" | "medium" | "strong"): void {
  nextOverride = tier;
}

function shouldSkipRouting(text: string, source: string): boolean {
  if (!text?.trim() || source === "extension" || text.trimStart().startsWith("/")) return true;
  return SHORT_CONFIRMATIONS.has(text.trim().toLowerCase());
}

function previousContext(ctx?: ExtensionContext): Record<string, unknown> {
  if (!ctx?.sessionManager) return {};
  const entries = ctx.sessionManager.getBranch().slice(-24);
  const recentMessages: Array<{ role: string; text: string }> = [];
  let toolCalls = 0;
  let toolErrors = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown; isError?: boolean };
    if (message.role === "toolResult" && message.isError) toolErrors += 1;
    const blocks = Array.isArray(message.content) ? message.content : [];
    toolCalls += blocks.filter((block: { type?: string }) => block.type === "toolCall").length;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const messageText = blocks.filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "").join(" ").trim();
    if (messageText) recentMessages.push({ role: message.role, text: summarizeTask(messageText, 500) });
  }
  return {
    recentMessages: recentMessages.slice(-6),
    toolCalls,
    toolErrors,
    recordedFailures: runtimeState.recentFailures.slice(-4).map((failure) => ({
      tool: failure.toolName, type: failure.failureType, count: failure.count,
    })),
  };
}

function fallbackResult(tier: "medium" | "strong", reason: string): RouterResult {
  return {
    tier, confidence: 0, rawChoice: "unknown", rawConfidence: 0,
    latencyMs: 0, timestamp: Date.now(), source: "fallback", reason,
  };
}

/** Classify the whole task, then apply deterministic risk limits. */
export async function routeTask(
  text: string,
  source: string,
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<RouterResult | null> {
  if (shouldSkipRouting(text, source)) return null;
  const config = loadConfig();
  if (!config.enabled || !config.router.enabled) return null;
  if (config.router.mode === "set-model" && !hasConfiguredRouterTarget(config.router.models)) return null;

  const risk = extractRouteRisk(text);
  const inlineOverride = /^\s*\[(cheap|medium|strong)\](?=\s|$)/i.exec(text)?.[1]?.toLowerCase() as
    | "cheap" | "medium" | "strong" | undefined;
  const override = inlineOverride ?? nextOverride;
  nextOverride = undefined;
  if (override) {
    return {
      tier: override, confidence: 1, rawChoice: override, rawConfidence: 1,
      latencyMs: 0, timestamp: Date.now(), source: "override",
      reason: inlineOverride ? "inline override" : "command override", riskFeatures: risk.features,
    };
  }

  const failureTier = config.router.routerFailureTier === "strong" ? "strong" : "medium";
  if (!isJudgeAvailable("router")) {
    return { ...fallbackResult(tierAtLeast(failureTier, risk.minimumTier) as "medium" | "strong", "judgment backend unavailable"), riskFeatures: risk.features };
  }

  try {
    const result = await judge({
      task: summarizeTask(text),
      inputLength: text.length,
      domain: "software development with Pi; often Unreal Engine 5",
      riskFeatures: risk.features,
      filePaths: risk.filePaths,
      ...previousContext(ctx),
    }, { task_tier: TASK_TIER_QUESTION }, { module: "router", signal });
    if (!result.ok) {
      if (result.errorType === "aborted") return null;
      console.warn("[pi-jev-control] Router judgment failed:", result.errorType, result.error);
      return {
        ...fallbackResult(tierAtLeast(failureTier, risk.minimumTier) as "medium" | "strong", `${result.errorType}: ${result.error}`),
        backend: result.backend, latencyMs: result.latencyMs, riskFeatures: risk.features,
      };
    }
    const answer = result.answers.task_tier;
    const choiceAnswer = answer.type === "choice" ? answer : { choice: "unknown", confidence: 0 };
    const raw = buildRouterResult(choiceAnswer.choice, choiceAnswer.confidence, result.latencyMs, result.model);
    const threshold = raw.tier === "cheap"
      ? Math.max(config.router.confidenceThreshold, config.router.cheapConfidenceThreshold,
        result.confidenceKind === "calibrated" ? 0 : 0.95)
      : config.router.confidenceThreshold;
    const uncertain = raw.tier === "unknown" || raw.confidence < threshold;
    const proposed = uncertain ? tierAtLeast(config.router.fallbackTier, "medium") : raw.tier;
    const safeTier = tierAtLeast(proposed, risk.minimumTier);
    return {
      ...raw,
      tier: safeTier,
      confidence: uncertain ? 0 : raw.confidence,
      source: uncertain ? "fallback" : safeTier !== proposed ? "risk-floor" : "judge",
      reason: uncertain ? "low confidence or unknown" : safeTier !== proposed ? risk.features.join(", ") : undefined,
      backend: result.backend,
      judgeModel: result.model,
      confidenceKind: result.confidenceKind,
      probabilities: answer.type === "choice" ? answer.probabilities : undefined,
      riskFeatures: risk.features,
    };
  } catch (error) {
    console.warn("[pi-jev-control] Router exception:", error);
    return {
      ...fallbackResult(tierAtLeast(failureTier, risk.minimumTier) as "medium" | "strong", String(error)),
      riskFeatures: risk.features,
    };
  }
}

export function hasConfiguredRouterTarget(models: JevControlConfig["router"]["models"]): boolean {
  return Object.values(models).some((route) => modelCandidates(route).some(isConfiguredModelSpec));
}

export function setupTaskRouter(pi: ExtensionAPI): void {
  let requestId = 0;
  let switchQueue = Promise.resolve();
  let toolFailures = 0;
  const changedPaths = new Set<string>();
  pi.on("input", async (event, ctx) => {
    // Short confirmations continue the current task and inherit its tier.
    if (shouldSkipRouting(event.text, event.source)) return;
    const id = ++requestId;
    const startedAt = Date.now();
    const taskFingerprint = crypto.createHash("sha256").update(event.text).digest("hex").slice(0, 16);
    runtimeState.lastTaskTier = undefined;
    runtimeState.lastTaskConfidence = undefined;
    toolFailures = 0;
    changedPaths.clear();
    const routerResult = await routeTask(event.text, event.source, ctx.signal, ctx);
    if (!routerResult || id !== requestId) return;

    // Serialize setModel calls; a newer input always gets the last write.
    const apply = async () => {
      if (id !== requestId) return;
      const selected = await routeModelDetailed(pi, ctx, routerResult.tier);
      const audit = {
        requestId: id, taskFingerprint, startedAt, timestamp: Date.now(), source: routerResult.source ?? "judge",
        rawChoice: routerResult.rawChoice, rawConfidence: routerResult.rawConfidence,
        requestedTier: routerResult.tier, effectiveTier: selected.success ? selected.tier : undefined,
        provider: selected.provider, model: selected.model, thinking: selected.thinking,
        candidateIndex: selected.candidateIndex, success: selected.success,
        reason: selected.reason ?? routerResult.reason, backend: routerResult.backend,
        judgeModel: routerResult.judgeModel, confidenceKind: routerResult.confidenceKind,
        probabilities: routerResult.probabilities,
        latencyMs: routerResult.latencyMs, riskFeatures: routerResult.riskFeatures ?? [],
      };
      runtimeState.lastRouteAudit = audit;
      runtimeState.routeAudits.push(audit);
      if (runtimeState.routeAudits.length > 50) runtimeState.routeAudits.shift();
      console.info(`[pi-jev-control] route ${JSON.stringify(audit)}`);
      if (!selected.success) {
        notifyAutomatic(ctx, tr(
          `Task routing failed; model unchanged: ${selected.reason ?? "unknown error"}`,
          `任务路由失败，模型未切换：${selected.reason ?? "未知错误"}`,
        ), "error");
        return;
      }
      if (id !== requestId) return;
      runtimeState.lastTaskTier = selected.tier;
      runtimeState.lastTaskConfidence = routerResult.confidence;
      runtimeState.lastJevModel = routerResult.judgeModel;
      runtimeState.lastDecision = {
        type: "task_tier", value: selected.tier,
        confidence: routerResult.confidence, timestamp: routerResult.timestamp,
      };
      recordModelTierDecision();
      if (routerResult.source === "fallback") {
        const backendFailed = routerResult.reason !== "low confidence or unknown";
        notifyAutomatic(ctx, tr(
          `Judgment ${backendFailed ? "unavailable" : "uncertain"}; safely routed to ${selected.tier} (${selected.provider ?? "current"}/${selected.model ?? "model"})`,
          `判断${backendFailed ? "不可用" : "不确定"}，已安全回退到 ${selected.tier}（${selected.provider ?? "当前"}/${selected.model ?? "模型"}）`,
        ), backendFailed ? "error" : "warning");
      }
    };
    const pending = switchQueue.then(apply, apply);
    switchQueue = pending.then(() => undefined, () => undefined);
    await pending;
  });

  pi.on("tool_result", async (event, ctx) => {
    const id = requestId;
    if (!id || !runtimeState.lastTaskTier) return;
    if (event.isError) toolFailures += 1;
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path;
      if (typeof path === "string") changedPaths.add(path);
    }
    const riskText = [event.toolName, event.input.path, event.input.command]
      .filter((value): value is string => typeof value === "string").join(" ");
    const risk = extractRouteRisk(riskText);
    const features = [...risk.features];
    let minimum = risk.minimumTier;
    if (changedPaths.size >= 2) {
      features.push("multiple-modified-files");
      if (minimum === "cheap") minimum = "medium";
    }
    if (toolFailures >= 2) {
      features.push("repeated-tool-failures");
      if (minimum === "cheap") minimum = "medium";
    }
    const target = tierAtLeast(runtimeState.lastTaskTier, minimum);
    if (target === runtimeState.lastTaskTier || target === "unknown") return;
    const apply = async () => {
      if (id !== requestId) return;
      if (tierAtLeast(runtimeState.lastTaskTier ?? "unknown", minimum) === runtimeState.lastTaskTier) return;
      const selected = await routeModelDetailed(pi, ctx, target);
      const audit = {
        requestId: id, timestamp: Date.now(), source: "tool-escalation",
        rawChoice: runtimeState.lastTaskTier ?? "unknown", rawConfidence: 0,
        requestedTier: target, effectiveTier: selected.success ? selected.tier : undefined,
        provider: selected.provider, model: selected.model, thinking: selected.thinking,
        candidateIndex: selected.candidateIndex, success: selected.success,
        reason: selected.reason ?? features.join(", "), latencyMs: 0, riskFeatures: features,
      };
      runtimeState.lastRouteAudit = audit;
      runtimeState.routeAudits.push(audit);
      if (runtimeState.routeAudits.length > 50) runtimeState.routeAudits.shift();
      console.info(`[pi-jev-control] route ${JSON.stringify(audit)}`);
      if (selected.success && id === requestId) {
        runtimeState.lastTaskTier = selected.tier;
        runtimeState.lastDecision = {
          type: "task_tier", value: selected.tier, confidence: 0, timestamp: audit.timestamp,
        };
        recordModelTierDecision();
        notifyAutomatic(ctx, tr(
          `Task complexity increased; upgraded to ${selected.tier} for following steps.`,
          `任务复杂度增加，后续步骤已升级为 ${selected.tier}。`,
        ), "warning");
      } else if (!selected.success) {
        notifyAutomatic(ctx, tr(
          `Could not upgrade model after tool result: ${selected.reason ?? "unknown error"}`,
          `工具结果触发升级，但模型切换失败：${selected.reason ?? "未知错误"}`,
        ), "error");
      }
    };
    const pending = switchQueue.then(apply, apply);
    switchQueue = pending.then(() => undefined, () => undefined);
    await pending;
  });
}
