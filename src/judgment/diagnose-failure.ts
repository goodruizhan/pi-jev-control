import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import { getJudgeUnavailableReason, judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { normalizeFailureType, normalizeRecommendedAction } from "../judge/normalize.js";
import { evaluateRepeatedFailure } from "../judge/rules-backend.js";
import { FAILURE_TYPE_QUESTION, RECOMMENDED_ACTION_QUESTION } from "../judge/questions.js";
import type { FailureType, RecommendedAction } from "../types.js";

/**
 * Diagnose Failure — the model asks what went wrong and what to do next.
 *
 * The failure classifier still counts failures and trips the circuit breaker on
 * repeated ones; that is deterministic and stays automatic. The Jev assessment
 * used to be appended to every failed tool result, which changed what the model
 * read without it asking. This tool is the reverse: the model pulls a diagnosis
 * when it wants one, typically after the same thing has failed twice.
 *
 * A repeated-failure rule outranks Jev. If the machine already counted the same
 * failure enough times, the answer is "stop retrying", full stop.
 */

export interface DiagnoseFailureResult {
  status: "ok" | "unavailable" | "disabled";
  failureType?: FailureType;
  recommendedAction?: RecommendedAction;
  confidence: number;
  deterministic?: {
    source: "local-rule";
    sameFailureCount: number;
    reason: string;
  };
  backend?: string;
  latencyMs?: number;
}

export async function diagnoseFailure(
  tool: string,
  error: string,
  input?: string,
  sameFailureCount = 0,
  signal?: AbortSignal,
): Promise<DiagnoseFailureResult> {
  const config = loadConfig();
  if (!config.enabled) {
    return { status: "disabled", confidence: 0 };
  }

  // ── Deterministic: repeated-failure rule outranks any model ─────────
  const repeat = evaluateRepeatedFailure(sameFailureCount);
  if (repeat) {
    return {
      status: "ok",
      failureType: "repeated",
      recommendedAction: "do_not_retry",
      confidence: repeat.confidence,
      deterministic: { source: "local-rule", sameFailureCount, reason: repeat.reason },
    };
  }

  if (!isJudgeAvailable("failureJudge")) {
    return { status: "unavailable", confidence: 0 };
  }

  const result = await judge(
    {
      tool: tool.slice(0, 120),
      input_summary: (input ?? "").slice(0, 2000),
      error_excerpt: error.slice(0, 2000),
      command_category: "",
      same_failure_count: sameFailureCount,
    },
    { type: FAILURE_TYPE_QUESTION, action: RECOMMENDED_ACTION_QUESTION },
    { module: "failureJudge", signal },
  );

  if (!result.ok) {
    return { status: "unavailable", confidence: 0, backend: result.backend, latencyMs: result.latencyMs };
  }

  const typeAnswer = choiceOf(result.answers.type);
  const actionAnswer = choiceOf(result.answers.action);
  return {
    status: "ok",
    failureType: normalizeFailureType(typeAnswer.choice),
    recommendedAction: normalizeRecommendedAction(actionAnswer.choice),
    confidence: actionAnswer.confidence,
    backend: result.backend,
    latencyMs: result.latencyMs,
  };
}

/** Register the `jev_diagnose_failure` tool. */
export function setupDiagnoseFailureTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_diagnose_failure",
    label: tr("Jev Diagnose Failure", "Jev 诊断失败"),
    description: tr(
      "Get a failure diagnosis and a recommended next action. Use it when a command has failed and you are not sure whether to retry, fix something first, or give up. Pass the tool name, the error output, the input you used, and how many times this same failure has already happened.",
      "获取失败诊断和建议动作。使用时机：命令失败后，你不确定该重试、先修点什么、还是放弃。传入工具名、错误输出、你用的参数，以及这个失败已经发生了几次。",
    ),
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: tr("Tool name that failed", "失败的工具名") },
        error: { type: "string", description: tr("Error output / stderr excerpt", "错误输出片段") },
        input: { type: "string", description: tr("Optional: the arguments you passed", "可选：传入的参数") },
        sameFailureCount: {
          type: "number",
          description: tr("How many times this same failure has already happened", "这个失败已经发生了几次"),
        },
      },
      required: ["tool", "error"],
    },
    async execute(_toolCallId, params, signal) {
      const tool = String(params.tool ?? "").slice(0, 120);
      const error = String(params.error ?? "").slice(0, 2000);
      const input = typeof params.input === "string" ? params.input.slice(0, 2000) : undefined;
      const count = typeof params.sameFailureCount === "number" ? params.sameFailureCount : 0;

      const result = await diagnoseFailure(tool, error, input, count, signal);

      const lines = [
        result.status === "disabled"
          ? tr("pi-jev-control is disabled, nothing was diagnosed.", "pi-jev-control 已关闭，未诊断。")
          : tr(
            `Diagnosis: ${result.failureType ?? "unknown"} → ${result.recommendedAction ?? "unknown"}${result.backend ? ` [${result.backend}]` : ""}`,
            `诊断：${result.failureType ?? "未知"} → ${result.recommendedAction ?? "未知"}${result.backend ? ` [${result.backend}]` : ""}`,
          ),
      ];

      if (result.status === "unavailable") {
        lines.push(tr(
          `Jev is unavailable (${getJudgeUnavailableReason() ?? "unknown"}). Read the error yourself.`,
          `Jev 不可用（${getJudgeUnavailableReason() ?? "未知"}）。请自己看错误信息。`,
        ));
      } else if (result.deterministic) {
        lines.push(tr(
          `Deterministic rule (not Jev): this same failure has happened ${result.deterministic.sameFailureCount} time(s). ${result.deterministic.reason}`,
          `确定性规则（非 Jev）：同一个失败已发生 ${result.deterministic.sameFailureCount} 次。${result.deterministic.reason}`,
        ));
      } else if (result.confidence > 0) {
        lines.push(tr(`Confidence: ${result.confidence.toFixed(2)}`, `置信度：${result.confidence.toFixed(2)}`));
      }

      lines.push("");
      lines.push(tr(
        "This is a suggestion. Retrying is your call, and an unchanged retry after the same failure is usually a waste.",
        "这只是建议。是否重试由你决定，同一失败后原样重试通常只是浪费时间。",
      ));

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
