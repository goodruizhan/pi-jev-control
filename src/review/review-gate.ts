import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { REVIEW_NEEDED_QUESTION } from "../judge/questions.js";
import { normalizeReviewDecision } from "../judge/normalize.js";
import { evaluateReviewForced } from "../judge/rules-backend.js";
import { backendTypeOf } from "../judge/registry.js";
import type { ReviewDecision } from "../types.js";
import { tr } from "../i18n.js";

/**
 * Review Gate — determines if a code change needs review.
 *
 * Output: skip, normal_review, strong_review
 *
 * Forced strong_review for:
 * - Engine internals
 * - GC (garbage collection)
 * - Multithreading
 * - Replication
 * - GAS (Gameplay Ability System) core lifecycle
 * - Large-scale core file refactoring
 *
 * Jev only judges whether review is needed — doesn't review code itself.
 */

// Forced strong_review patterns live in the rules backend (single source of truth).

export interface ReviewGateResult {
  decision: ReviewDecision;
  confidence: number;
  forced: boolean;
  reason: string;
}

/**
 * Check if a code change needs review.
 * Called from the Review Gate tool.
 */
export async function judgeReview(
  params: {
    modifiedFiles: number;
    fileTypes: string[];
    isCoreSystem: boolean;
    involvesGC: boolean;
    involvesThreading: boolean;
    involvesReplication: boolean;
    involvesGAS: boolean;
    hasFailures: boolean;
    description?: string;
  },
  signal?: AbortSignal,
): Promise<ReviewGateResult> {
  const config = loadConfig();
  if (!config.enabled || !config.reviewGate.enabled) {
    return {
      decision: "normal_review",
      confidence: 0,
      forced: false,
      reason: "Review Gate disabled",
    };
  }
  // Steps 1-3: forced strong_review rules (shared with the rules backend)
  const description = params.description ?? "";
  const forced = evaluateReviewForced(params);
  if (forced) {
    return {
      decision: "strong_review",
      confidence: forced.confidence,
      forced: true,
      reason: forced.reason,
    };
  }

  // Step 4: Use Jev to decide
  if (!isJudgeAvailable()) {
    return {
      decision: "normal_review",
      confidence: 0,
      forced: false,
      reason: "Jev unavailable — heuristic fallback",
    };
  }

  const state = {
    modifiedFiles: params.modifiedFiles,
    fileTypes: params.fileTypes,
    isCoreSystem: params.isCoreSystem,
    involvesGC: params.involvesGC,
    involvesThreading: params.involvesThreading,
    involvesReplication: params.involvesReplication,
    involvesGAS: params.involvesGAS,
    hasFailures: params.hasFailures,
    description: description.slice(0, 300),
  };

  const questions = {
    review_needed: REVIEW_NEEDED_QUESTION,
  };

  const result = await judge(state, questions, {
    module: "review",
    signal,
  });

  // A rules-backend answer means no model judgment was available — treat it
  // as the heuristic fallback instead of trusting deterministic answers here.
  if (!result.ok || backendTypeOf(result.backend) === "rules") {
    return {
      decision: "normal_review",
      confidence: 0,
      forced: false,
      reason: result.ok
        ? "Heuristic fallback (deterministic rules — model backends unavailable)"
        : `Jev failed: ${result.error} — heuristic fallback`,
    };
  }

  const { choice, confidence } = choiceOf(result.answers.review_needed);
  const decision = normalizeReviewDecision(choice);

  return {
    decision,
    confidence,
    forced: false,
    reason: `Jev decision: ${choice} (confidence: ${confidence.toFixed(2)})`,
  };
}

/**
 * Setup the Review Gate — registers the jev_review_check tool.
 */
export function setupReviewGate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_review_check",
    label: tr("Jev Review Gate", "Jev 审查门控"),
    description: tr("Determine if a code change needs review (skip/normal_review/strong_review) using Jev.", "使用 Jev 判断代码改动需要跳过、普通还是强审查。"),
    parameters: {
      type: "object",
      properties: {
        modifiedFiles: {
          type: "number",
          description: tr("Number of modified files", "修改的文件数量"),
        },
        fileTypes: {
          type: "array",
          items: { type: "string" },
          description: tr("Types/paths of modified files (e.g. ['.cpp', '.h', 'Source/AI/...'])", "修改文件的类型/路径（例如 ['.cpp', '.h', 'Source/AI/...']）"),
        },
        isCoreSystem: {
          type: "boolean",
          description: tr("Whether the change touches core systems", "改动是否涉及核心系统"),
        },
        involvesGC: {
          type: "boolean",
          description: tr("Whether the change involves garbage collection", "改动是否涉及垃圾回收"),
        },
        involvesThreading: {
          type: "boolean",
          description: tr("Whether the change involves multithreading", "改动是否涉及多线程"),
        },
        involvesReplication: {
          type: "boolean",
          description: tr("Whether the change involves replication", "改动是否涉及复制"),
        },
        involvesGAS: {
          type: "boolean",
          description: tr("Whether the change involves GAS (Gameplay Ability System)", "改动是否涉及 GAS（Gameplay Ability System）"),
        },
        hasFailures: {
          type: "boolean",
          description: tr("Whether there were any failures during this change", "本次改动过程中是否出现失败"),
        },
        description: {
          type: "string",
          description: tr("Description of the change", "改动说明"),
        },
      },
      required: ["modifiedFiles", "fileTypes"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await judgeReview({
        modifiedFiles: Number.isFinite(params.modifiedFiles) ? Math.max(0, Math.floor(params.modifiedFiles as number)) : 0,
        fileTypes: Array.isArray(params.fileTypes) ? (params.fileTypes as string[]).slice(0, 100) : [],
        isCoreSystem: params.isCoreSystem === true,
        involvesGC: params.involvesGC === true,
        involvesThreading: params.involvesThreading === true,
        involvesReplication: params.involvesReplication === true,
        involvesGAS: params.involvesGAS === true,
        hasFailures: params.hasFailures === true,
        description: typeof params.description === "string" ? params.description.slice(0, 1000) : undefined,
      }, signal);

      const output = formatReviewResult(result);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  });
}

/**
 * Format review result for output.
 */
function formatReviewResult(result: ReviewGateResult): string {
  const lines = [
    tr(`Review Gate Decision: ${result.decision.toUpperCase()}`, `审查门控决策：${result.decision.toUpperCase()}`),
    ``,
    tr(`Confidence: ${result.confidence.toFixed(2)}`, `置信度：${result.confidence.toFixed(2)}`),
    tr(`Forced: ${result.forced ? "YES" : "no"}`, `强制：${result.forced ? "是" : "否"}`),
    tr(`Reason: ${result.reason}`, `原因：${result.reason}`),
  ];

  if (result.decision === "strong_review") {
    lines.push(``, tr("Action: Use a strong model for detailed code review.", "操作：使用强模型进行详细代码审查。"));
  } else if (result.decision === "normal_review") {
    lines.push(``, tr("Action: Perform a standard review.", "操作：执行标准审查。"));
  } else {
    lines.push(``, tr("Action: No review needed.", "操作：无需审查。"));
  }

  return lines.join("\n");
}
