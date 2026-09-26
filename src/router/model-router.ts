import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { ModelRouteSpec, ModelSpec, TaskTier } from "../types.js";
import { tr } from "../i18n.js";
import { notifyAutomatic } from "../ui.js";

export interface ModelRouteResult {
  success: boolean;
  tier: TaskTier;
  provider?: string;
  model?: string;
  thinking?: string;
  candidateIndex?: number;
  reason?: string;
}

/** Normalize a legacy single target or an ordered target list. */
export function modelCandidates(route: ModelRouteSpec | undefined): ModelSpec[] {
  if (!route) return [];
  return (Array.isArray(route) ? route : [route]).filter(
    (spec): spec is ModelSpec => Boolean(spec) && typeof spec.provider === "string" && typeof spec.model === "string",
  );
}

/** True when the target names a real Pi model instead of a placeholder. */
export function isConfiguredModelSpec(spec: ModelSpec): boolean {
  return Boolean(
    spec.provider.trim().length > 0 &&
    spec.model.trim().length > 0 &&
    spec.provider !== "REPLACE_ME" &&
    spec.model !== "REPLACE_ME",
  );
}

/**
 * Model Router — maps task tier to configured model candidates and switches via
 * pi.setModel(). Candidates are tried in array order. After selection, an
 * optional per-target thinking level is applied with pi.setThinkingLevel().
 *
 * Modes:
 * - "set-model": directly switch Pi model via pi.setModel()
 * - "tier-only": record tier decision but do not switch model
 */
export async function routeModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tier: TaskTier,
): Promise<boolean> {
  return (await routeModelDetailed(pi, ctx, tier)).success;
}

export async function routeModelDetailed(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tier: TaskTier,
): Promise<ModelRouteResult> {
  const config = loadConfig();

  if (!config.enabled || !config.router.enabled) return { success: false, tier, reason: "router disabled" };
  if (config.router.mode === "off") return { success: false, tier, reason: "router mode is off" };

  if (config.router.mode === "tier-only") {
    return { success: true, tier, provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel?.() };
  }

  const requestedTier = tier === "unknown" ? config.router.fallbackTier : tier;
  const effectiveTier = requestedTier === "cheap" || requestedTier === "medium" || requestedTier === "strong"
    ? requestedTier
    : "medium";
  // A missing or unavailable low-tier model may fall upward, never downward.
  const tiers: Array<"cheap" | "medium" | "strong"> = effectiveTier === "cheap"
    ? ["cheap", "medium", "strong"]
    : effectiveTier === "medium" ? ["medium", "strong"] : ["strong"];
  const candidates = tiers.flatMap((candidateTier) =>
    modelCandidates(config.router.models[candidateTier]).filter(isConfiguredModelSpec)
      .map((spec) => ({ spec, candidateTier })),
  );

  if (candidates.length === 0) {
    notifyAutomatic(ctx, tr(
      `No model configured for tier "${effectiveTier}"`,
      `等级“${effectiveTier}”未配置模型`,
    ), "error");
    return { success: false, tier: effectiveTier, reason: "no configured model" };
  }

  const failures: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const { spec, candidateTier } = candidates[index];
    const model = ctx.modelRegistry.find(spec.provider, spec.model);

    if (!model) {
      failures.push(`${spec.provider}/${spec.model}: not found`);
      continue;
    }

    const isCurrentModel = ctx.model?.provider === spec.provider && ctx.model?.id === spec.model;
    if (!isCurrentModel) {
      try {
        const success = await pi.setModel(model);
        if (!success) {
          failures.push(`${spec.provider}/${spec.model}: authentication unavailable`);
          continue;
        }
      } catch (err) {
        failures.push(`${spec.provider}/${spec.model}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    let actualThinking: string | undefined;
    if (spec.thinking) {
      try {
        pi.setThinkingLevel(spec.thinking);
        actualThinking = pi.getThinkingLevel();
      } catch (err) {
        notifyAutomatic(ctx, tr(
          `Switched to ${spec.provider}/${spec.model}, but could not set thinking level "${spec.thinking}": ${err instanceof Error ? err.message : String(err)}`,
          `已切换到 ${spec.provider}/${spec.model}，但无法设置思考等级“${spec.thinking}”：${err instanceof Error ? err.message : String(err)}`,
        ), "warning");
      }
    }

    if (isCurrentModel && !spec.thinking) {
      return { success: true, tier: candidateTier, provider: spec.provider, model: spec.model, thinking: pi.getThinkingLevel?.(), candidateIndex: index };
    }

    const fallbackNote = index > 0
      ? tr(` (fallback candidate ${index + 1})`, `（回退候选 ${index + 1}）`)
      : "";
    const thinkingNote = spec.thinking
      ? actualThinking === spec.thinking
        ? tr(` with thinking ${actualThinking}`, `，思考等级 ${actualThinking}`)
        : tr(
          ` with thinking ${actualThinking ?? "unchanged"} (requested ${spec.thinking})`,
          `，思考等级 ${actualThinking ?? "未更改"}（请求 ${spec.thinking}）`,
        )
      : "";

    notifyAutomatic(ctx, tr(
      `Switched to ${spec.provider}/${spec.model}${thinkingNote} for ${candidateTier} task${fallbackNote}`,
      `已为 ${candidateTier} 任务切换到 ${spec.provider}/${spec.model}${thinkingNote}${fallbackNote}`,
    ), actualThinking && spec.thinking && actualThinking !== spec.thinking ? "warning" : "info");
    return {
      success: true, tier: candidateTier, provider: spec.provider, model: spec.model,
      thinking: actualThinking ?? pi.getThinkingLevel?.(), candidateIndex: index,
      reason: candidateTier !== effectiveTier ? `upward fallback from ${effectiveTier}` : undefined,
    };
  }

  notifyAutomatic(ctx, tr(
    `No available model for tier "${effectiveTier}". Tried: ${failures.join("; ")}`,
    `等级“${effectiveTier}”没有可用模型。已尝试：${failures.join("；")}`,
  ), "error");
  return { success: false, tier: effectiveTier, reason: failures.join("; ") };
}
