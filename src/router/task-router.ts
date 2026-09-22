import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { TASK_TIER_QUESTION } from "../judge/questions.js";
import { buildRouterResult } from "../judge/normalize.js";
import { runtimeState } from "../state/runtime-state.js";
import { isConfiguredModelSpec, modelCandidates, routeModelDetailed } from "./model-router.js";
import type { ModelRouteResult } from "./model-router.js";
import { extractRouteRisk, summarizeTask, tierAtLeast } from "./risk.js";
import type { JevControlConfig, RouterResult, TaskTier } from "../types.js";
import { SHORT_CONFIRMATIONS } from "../types.js";
import { recordModelTierDecision } from "../stats/savings.js";
import { tr } from "../i18n.js";
import { notifyAutomatic } from "../ui.js";

/**
 * Task Router — decides which model tier a task deserves.
 *
 * The direction of control is the point. `router.mode` decides *who* gets to decide,
 * and whether the decision may switch the model at all:
 *
 *   rules-only (default) — nobody decides automatically. The user can force a tier
 *     (`[strong]` inline or `/jev route`), and the model can request one itself via
 *     `jev_request_model_tier`. Deterministic risk features are a floor only — they
 *     never switch the model on their own.
 *   advisory / tier-only — Jev decides, and the verdict is recorded and announced as
 *     information. The model is never switched behind the model's back.
 *   set-model — legacy: Jev decides and the model is switched.
 *   off — routing does nothing.
 */

export type RouteMode = JevControlConfig["router"]["mode"];
export type NamedTier = "cheap" | "medium" | "strong";

const INLINE_OVERRIDE_RE = /^\s*\[(cheap|medium|strong)\](?=\s|$)/i;

/** Tier override queued by `/jev route <tier>` for the next substantive input. */
let nextOverride: NamedTier | undefined;

export function setNextRouteOverride(tier: NamedTier): void {
  nextOverride = tier;
}

export function readInlineOverride(text: string): NamedTier | undefined {
  return INLINE_OVERRIDE_RE.exec(text)?.[1]?.toLowerCase() as NamedTier | undefined;
}

/** Does this mode ask Jev to infer the tier? */
export function modeConsultsJudge(mode: RouteMode): boolean {
  return mode === "set-model" || mode === "advisory" || mode === "tier-only";
}

/** Does this mode let an inferred tier actually switch the model? */
export function modeSwitchesModel(mode: RouteMode): boolean {
  return mode === "set-model";
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
    latencyMs: 0, timestamp: Date.now(), source: "fallback", reason, backendDown: true,
  };
}

/**
 * Ask Jev what tier a task deserves, then apply the deterministic risk floor.
 *
 * Pure judgment — this never switches anything. Called by routeTask() in advisory
 * modes and by the `jev_assess_task` tool.
 */
export async function judgeTaskTier(
  text: string,
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<RouterResult> {
  const config = loadConfig();
  const risk = extractRouteRisk(text);
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
      if (result.errorType === "aborted") {
        return { ...fallbackResult(tierAtLeast(failureTier, risk.minimumTier) as "medium" | "strong", `aborted: aborted`), riskFeatures: risk.features };
      }
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

/**
 * Decide the tier for a user input.
 *
 * Returns null when no tier decision is warranted at all — routing disabled, an
 * explicit off mode, a short confirmation, or rules-only mode with no user override.
 * A null result means "leave the model exactly where it is".
 */
export async function routeTask(
  text: string,
  source: string,
  signal?: AbortSignal,
  ctx?: ExtensionContext,
): Promise<RouterResult | null> {
  if (shouldSkipRouting(text, source)) return null;
  const config = loadConfig();
  if (!config.enabled || !config.router.enabled) return null;
  if (config.router.mode === "off") return null;
  if (config.router.mode === "set-model" && !hasConfiguredRouterTarget(config.router.models)) return null;

  const risk = extractRouteRisk(text);
  const inlineOverride = readInlineOverride(text);
  const override = inlineOverride ?? nextOverride;
  nextOverride = undefined;

  if (override) {
    // The user asked for this tier; risk features may only raise it, never lower it.
    const tier = tierAtLeast(override, risk.minimumTier) as NamedTier;
    return {
      tier, confidence: 1, rawChoice: override, rawConfidence: 1,
      latencyMs: 0, timestamp: Date.now(), source: "override",
      reason: `${inlineOverride ? "inline override" : "command override"}${
        tier !== override ? ` raised to ${tier} by ${risk.features.join(", ")}` : ""
      }`,
      riskFeatures: risk.features,
    };
  }

  // rules-only with no override: nobody decides, so nothing may switch.
  if (!modeConsultsJudge(config.router.mode)) return null;

  return judgeTaskTier(text, signal, ctx);
}

export function hasConfiguredRouterTarget(models: JevControlConfig["router"]["models"]): boolean {
  return Object.values(models).some((route) => modelCandidates(route).some(isConfiguredModelSpec));
}

/** A tier request coming from the model itself, not from a Jev verdict. */
export interface ModelTierRequest {
  tier: TaskTier;
  reason: string;
  /** Extra text scanned for deterministic risk features that act as a floor. */
  context?: string;
}

export interface ModelTierRequestResult extends ModelRouteResult {
  requestedTier: NamedTier;
  /** True when deterministic risk features raised the model's own request. */
  floorApplied: boolean;
  riskFeatures: string[];
}

/**
 * Model-initiated tier request — the entry point for `jev_request_model_tier`.
 *
 * This is the inversion of the old auto-router: the request comes from the model
 * (which has the full conversation and tool trail) instead of from Jev (which sees a
 * 4000-character summary). Risk features can still raise the requested tier, which is
 * the one place where a rule overrides the model — and it can only go up.
 */
export async function requestModelTier(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: ModelTierRequest,
): Promise<ModelTierRequestResult> {
  const config = loadConfig();
  const risk = extractRouteRisk(request.context ?? request.reason);
  const wanted: TaskTier = request.tier === "unknown" ? config.router.fallbackTier : request.tier;
  const requested = tierAtLeast(wanted, risk.minimumTier) as NamedTier;
  const floorApplied = requested !== wanted;
  const base = { requestedTier: requested, floorApplied, riskFeatures: risk.features };

  if (!config.enabled || !config.router.enabled) {
    return { success: false, tier: requested, reason: "router disabled", ...base };
  }
  if (config.router.mode === "off") {
    return { success: false, tier: requested, reason: "router mode is off", ...base };
  }

  const selected = await routeModelDetailed(pi, ctx, requested);
  const audit = {
    requestId: 0,
    timestamp: Date.now(),
    source: "model-request",
    rawChoice: wanted,
    rawConfidence: 0,
    requestedTier: requested,
    effectiveTier: selected.success ? selected.tier : undefined,
    provider: selected.provider,
    model: selected.model,
    thinking: selected.thinking,
    candidateIndex: selected.candidateIndex,
    success: selected.success,
    reason: `${request.reason}${floorApplied ? ` [risk floor: ${risk.features.join(", ")}]` : ""}${selected.reason ? ` (${selected.reason})` : ""}`,
    latencyMs: 0,
    riskFeatures: risk.features,
  };
  runtimeState.lastRouteAudit = audit;
  runtimeState.routeAudits.push(audit);
  if (runtimeState.routeAudits.length > 50) runtimeState.routeAudits.shift();
  console.info(`[pi-jev-control] route ${JSON.stringify(audit)}`);

  if (selected.success) {
    runtimeState.lastTaskTier = selected.tier;
    runtimeState.lastDecision = {
      type: "task_tier", value: selected.tier, confidence: 0, timestamp: audit.timestamp,
    };
    recordModelTierDecision();
  }
  return { ...selected, ...base };
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

      // Advisory modes, and any verdict that the user did not explicitly ask for:
      // record and announce the judgment, but never switch the model. Only a user
      // override (source "override") may switch outside set-model mode.
      const userDirected = routerResult.source === "override";
      if (!userDirected && !modeSwitchesModel(loadConfig().router.mode)) {
        const audit = {
          requestId: id, taskFingerprint, startedAt, timestamp: Date.now(), source: "advisory",
          rawChoice: routerResult.rawChoice, rawConfidence: routerResult.rawConfidence,
          requestedTier: routerResult.tier, success: false,
          reason: routerResult.reason, backend: routerResult.backend,
          judgeModel: routerResult.judgeModel, confidenceKind: routerResult.confidenceKind,
          probabilities: routerResult.probabilities,
          latencyMs: routerResult.latencyMs, riskFeatures: routerResult.riskFeatures ?? [],
        };
        runtimeState.lastRouteAudit = audit;
        runtimeState.routeAudits.push(audit);
        if (runtimeState.routeAudits.length > 50) runtimeState.routeAudits.shift();
        console.info(`[pi-jev-control] route ${JSON.stringify(audit)}`);
        runtimeState.lastJevModel = routerResult.judgeModel;
        runtimeState.lastDecision = {
          type: "task_tier", value: routerResult.tier,
          confidence: routerResult.confidence, timestamp: routerResult.timestamp,
        };
        notifyAutomatic(ctx, tr(
          `Jev tier assessment (informational, no model switch): ${routerResult.tier}${routerResult.reason ? ` — ${routerResult.reason}` : ""}`,
          `Jev 等级评估（仅供参考，未切换模型）：${routerResult.tier}${routerResult.reason ? `——${routerResult.reason}` : ""}`,
        ), "info");
        return;
      }

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
    // Automatic escalation belongs to the legacy set-model mode. In rules-only mode
    // the model reads the tool results itself and asks for an upgrade when it wants one.
    const router = loadConfig().router;
    // router.enabled was not checked here. The handler used to lean on
    // runtimeState.lastTaskTier being unset to stop, which happens to hold today
    // but is a property of another code path rather than a deliberate guard, and
    // it would let the accounting below run on every tool result for no purpose.
    if (!router.enabled || router.mode !== "set-model") return;
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
