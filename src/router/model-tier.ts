import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import type { NamedTier } from "./task-router.js";
import type { TaskTier } from "../types.js";
import { requestModelTier } from "./task-router.js";

/**
 * Request Model Tier — the model switches itself, on its own judgment.
 *
 * This is the direct inversion of the old automatic router. The old path ran on
 * every input, asked Jev (which saw a 4000-character summary) to classify the
 * task, and then swapped the model out from under the model. The new path only
 * fires when the model itself decides: it is mid-task, the work has grown more
 * complex than the current model can handle, and it asks.
 *
 * Deterministic risk features can still raise the requested tier — that is the
 * one place a rule overrides the model, and it can only go up. A request for
 * "cheap" on a task that mentions replication becomes "strong", never cheaper.
 */

const TIERS: NamedTier[] = ["cheap", "medium", "strong"];

export async function requestModelTierTool(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: { tier: string; reason: string; context?: string },
): Promise<ReturnType<typeof requestModelTier>> {
  const config = loadConfig();
  const tier = input.tier.trim().toLowerCase();

  const requested = (tier === "unknown" ? config.router.fallbackTier : tier) as NamedTier;
  const base = {
    success: false,
    tier: requested as TaskTier,
    requestedTier: requested,
    wantedTier: requested,
    floorApplied: false,
    riskFeatures: [] as string[],
  };

  if (!TIERS.includes(tier as NamedTier)) {
    return { ...base, reason: `tier must be one of ${TIERS.join(", ")}` };
  }

  const request = {
    tier: requested as TaskTier,
    reason: input.reason.trim().slice(0, 500),
    context: input.context?.trim().slice(0, 2000),
  };

  if (!config.enabled || !config.router.enabled) {
    return { ...base, reason: "router disabled" };
  }

  return requestModelTier(pi, ctx, request);
}

/** Register the `jev_request_model_tier` tool. */
export function setupModelTierTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_request_model_tier",
    label: tr("Jev Request Model Tier", "Jev 请求模型等级"),
    description: tr(
      "Switch your own model tier because the task got harder (or easier) than you expected. Call this when you are mid-task and the current model is no longer a good fit. Deterministic risk features can only raise your request, never lower it: asking for cheap on a task that touches replication becomes strong. Nothing switches the model automatically anymore — this call is the switch.",
      "任务比预期更难（或更容易）时切换你自己的模型等级。使用时机：任务进行到一半，当前模型不再合适。确定性风险特征只能上调你的请求，不能下调：在涉及 replication 的任务上要 cheap 会被提升为 strong。现在没有任何东西会自动换模型，这个调用就是开关。",
    ),
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: [...TIERS],
          description: "Target tier: cheap, medium or strong",
        },
        reason: {
          type: "string",
          description: tr("Why you need this tier", "为什么需要这个等级"),
        },
        context: {
          type: "string",
          description: tr("Optional context scanned for risk features", "可选：用于扫描风险特征的上下文"),
        },
      },
      required: ["tier", "reason"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tier = String(params.tier ?? "").slice(0, 20);
      const reason = String(params.reason ?? "").slice(0, 500);
      const context = typeof params.context === "string" ? params.context.slice(0, 2000) : undefined;

      const result = await requestModelTierTool(pi, ctx, { tier, reason, context });

      const lines = result.success
        ? [tr(
            `Tier switch OK: requested ${result.requestedTier}, effective ${result.tier}${result.provider ? ` → ${result.provider}/${result.model}` : ""}${result.thinking ? ` (thinking ${result.thinking})` : ""}`,
            `等级切换成功：请求 ${result.requestedTier}，实际 ${result.tier}${result.provider ? ` → ${result.provider}/${result.model}` : ""}${result.thinking ? `（思考等级 ${result.thinking}）` : ""}`,
          )]
        : [tr(
            `Tier switch FAILED: ${result.reason ?? "unknown error"}`,
            `等级切换失败：${result.reason ?? "未知错误"}`,
          )];

      if (result.floorApplied) {
        lines.push(tr(
          `Risk features raised the request from ${result.wantedTier} to ${result.requestedTier}: ${result.riskFeatures.join(", ")}`,
          `风险特征把请求从 ${result.wantedTier} 上调到 ${result.requestedTier}：${result.riskFeatures.join(", ")}`,
        ));
      } else if (result.riskFeatures.length > 0) {
        lines.push(tr(`Risk features detected: ${result.riskFeatures.join(", ")}`, `检测到风险特征：${result.riskFeatures.join(", ")}`));
      }
      if (result.candidateIndex) {
        lines.push(tr(
          `Used candidate #${result.candidateIndex + 1} (earlier candidates were unavailable).`,
          `使用了第 ${result.candidateIndex + 1} 个候选（前面的候选不可用）。`,
        ));
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
