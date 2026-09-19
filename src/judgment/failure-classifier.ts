import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { FAILURE_TYPE_QUESTION, RECOMMENDED_ACTION_QUESTION } from "../jev/questions.js";
import { normalizeFailureType, normalizeRecommendedAction, generateFailureSignature } from "../jev/normalize.js";
import { recordFailure, getFailureCountBySignature } from "../state/runtime-state.js";
import { storeFailureMemory } from "../memory/memory-gate.js";
import type { FailureType, RecommendedAction } from "../types.js";
import { tr } from "../i18n.js";

/**
 * Failure Classifier + Retry Judge
 *
 * Hooks into pi.on("tool_result") to classify failures and suggest retry actions.
 * Only triggered when event.isError === true or exit code != 0.
 *
 * Both questions (failure_type + recommended_action) are sent in a single
 * System One request to minimize HTTP calls.
 *
 * Never auto-retries — only provides judgment appended to tool result.
 */

export function setupFailureClassifier(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.retryJudge.enabled) return;

    // Only process failures
    if (!event.isError) {
      // Check bash exit code
      const toolName = event.toolName;
      if (toolName === "bash") {
        // Check if the bash command had a non-zero exit code
        const exitCode = extractExitCode(event);
        if (exitCode === null || exitCode === 0) return;
      } else {
        return;
      }
    }

    // Check Jev availability
    if (!isJevAvailable()) return;

    const toolName = event.toolName;
    const toolInput = event.input as Record<string, unknown>;

    // Build state with size limits
    const inputSummary = JSON.stringify(toolInput).slice(0, 1500);
    let errorExcerpt = "";

    // Extract error text from content
    const content = event.content as unknown[] | string | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          errorExcerpt = ((block as Record<string, unknown>).text as string).slice(0, 4000);
          break;
        }
      }
    } else if (typeof content === "string") {
      errorExcerpt = content.slice(0, 4000);
    }

    // Build failure signature for deduplication
    const signature = generateFailureSignature(toolName, inputSummary, errorExcerpt);
    const sameFailureCount = getFailureCountBySignature(signature);

    // Build state for Jev
    const state = {
      tool: toolName,
      input_summary: inputSummary,
      error_excerpt: errorExcerpt,
      same_failure_count: sameFailureCount,
    };

    // Both questions in one request
    const questions = {
      failure_type: FAILURE_TYPE_QUESTION,
      recommended_action: RECOMMENDED_ACTION_QUESTION,
    };

    const result = await callJev(state, questions, {
      module: "failureJudge",
      signal: ctx.signal,
    });

    if (!result.ok) {
      // Jev failed — don't block, just log
      console.warn("[pi-jev-control] Failure Judge Jev call failed:", result.errorType, result.error);
      return;
    }

    const failureType = normalizeFailureType(result.result.answers.failure_type.choice);
    const recommendedAction = normalizeRecommendedAction(result.result.answers.recommended_action.choice);

    // Record the failure in runtime state
    recordFailure({
      signature,
      toolName,
      inputSummary,
      errorExcerpt,
      failureType,
      recommendedAction,
    });

    // Also store in persistent memory
    storeFailureMemory(toolName, inputSummary, errorExcerpt, failureType, recommendedAction);

    // Append judgment to tool result
    const judgmentText = tr(
      [`[Jev failure judgment]`, `type: ${failureType}`, `action: ${recommendedAction}`, `same_failure_count: ${sameFailureCount + 1}`].join("\n"),
      [`[Jev 失败判断]`, `类型：${failureType}`, `建议操作：${recommendedAction}`, `相同失败次数：${sameFailureCount + 1}`].join("\n"),
    );

    const augmentedContent = [
      ...event.content,
      { type: "text" as const, text: judgmentText },
    ];

    return {
      content: augmentedContent,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    };
  });
}

/**
 * Extract exit code from a tool result, if available.
 */
function extractExitCode(event: { content?: unknown; details?: unknown }): number | null {
  const details = event.details as Record<string, unknown> | undefined;
  if (details) {
    if (typeof details.exitCode === "number") return details.exitCode;
    if (typeof details.code === "number") return details.code;
  }
  return null;
}
