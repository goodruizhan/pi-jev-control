import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import { getJudgeUnavailableReason, isJudgeAvailable } from "../judge/facade.js";
import { judgeTaskTier } from "./task-router.js";

/**
 * Assess Task — Jev answers a question the model asks it.
 *
 * The old router asked Jev "what tier is this?" on every input and then swapped
 * the model behind the model's back. Now the model asks on its own: "is this
 * getting too complex for the model I'm on?" Jev's verdict comes back as a tool
 * result and the model decides what to do with it, including ignoring it.
 *
 * Nothing here switches anything. Escalation is a separate, explicit step — the
 * model calls `jev_request_model_tier`.
 */

export interface AssessTaskResult {
  status: "ok" | "unavailable" | "disabled";
  tier: string;
  confidence: number;
  source?: string;
  reason?: string;
  riskFeatures?: string[];
  backend?: string;
  latencyMs?: number;
  judgeModel?: string;
}

export async function assessTask(
  task: string,
  context?: string,
  signal?: AbortSignal,
): Promise<AssessTaskResult> {
  const config = loadConfig();
  if (!config.enabled) {
    return { status: "disabled", tier: "unknown", confidence: 0, reason: "pi-jev-control is disabled" };
  }

  const text = [context, task].filter((part) => part && part.trim()).join("\n").slice(0, 2000);
  const result = await judgeTaskTier(text, signal);

  // `backendDown` marks a backend failure specifically. String-matching the
  // reason here was wrong: judgeTaskTier has four failure paths (unavailable,
  // aborted, error, thrown) and only one of them produced this literal, so a
  // timeout or an auth failure came back as status "ok" with a confidence of
  // zero and no hint that the tier was not a judgment. Low-confidence fallback
  // also uses source "fallback" but is a real judgment, so it must stay "ok".
  const backendDown = result.backendDown ?? false;
  return {
    status: backendDown ? "unavailable" : "ok",
    tier: result.tier,
    confidence: result.confidence,
    source: result.source,
    reason: result.reason,
    riskFeatures: result.riskFeatures,
    backend: result.backend,
    latencyMs: result.latencyMs,
    judgeModel: result.judgeModel,
  };
}

/** Register the `jev_assess_task` tool. */
export function setupAssessTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_assess_task",
    label: tr("Jev Assess Task", "Jev 评估任务"),
    description: tr(
      "Ask Jev to rate how complex a task really is and what model tier it would justify. Use this when you are mid-task and suspect the current model is too weak (or too expensive), or before starting a big chunk of work. Returns an advisory tier plus deterministic risk features. It changes nothing by itself — call jev_request_model_tier if you actually want a tier change.",
      "请 Jev 评估一个任务到底有多复杂、值不值得用更强的模型。使用时机：任务做了一半觉得当前模型不够（或太贵），或动手前评估大块工作。返回建议等级和确定性风险特征，本身不改变任何东西——需要换模型请调用 jev_request_model_tier。",
    ),
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: tr("The task description to assess", "待评估的任务描述"),
        },
        context: {
          type: "string",
          description: tr("Optional surrounding context", "可选的上下文补充"),
        },
      },
      required: ["task"],
    },
    async execute(_toolCallId, params, signal) {
      const task = String(params.task ?? "").slice(0, 2000);
      const context = typeof params.context === "string" ? params.context.slice(0, 2000) : undefined;

      const result = await assessTask(task, context, signal);

      const lines = [
        tr(
          `Task assessment: ${result.tier} (confidence ${result.confidence.toFixed(2)})${result.backend ? ` [${result.backend}]` : ""}`,
          `任务评估：${result.tier}（置信度 ${result.confidence.toFixed(2)}）${result.backend ? ` [${result.backend}]` : ""}`,
        ),
      ];

      if (result.status === "unavailable") {
        lines.push(tr(
          `Jev is unavailable (${getJudgeUnavailableReason() ?? "unknown"}), so the tier below is a deterministic floor, not a judgment.`,
          `Jev 不可用（${getJudgeUnavailableReason() ?? "未知"}），下面的等级来自确定性下限，不是判断结果。`,
        ));
      }
      if (result.reason) lines.push(tr(`Reason: ${result.reason}`, `原因：${result.reason}`));
      if (result.riskFeatures && result.riskFeatures.length > 0) {
        lines.push(tr(`Deterministic risk features: ${result.riskFeatures.join(", ")}`, `确定性风险特征：${result.riskFeatures.join(", ")}`));
      }

      lines.push("");
      lines.push(tr(
        "This is information, not a decision. Escalate yourself with jev_request_model_tier if the task really needs it, or proceed on the current model.",
        "这只是情报，不是决定。如果确实需要更强的模型，请调用 jev_request_model_tier 自行升级；否则继续用当前模型。",
      ));

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
