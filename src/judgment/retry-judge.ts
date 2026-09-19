import type { FailureRecord } from "../types.js";
import { getFailureCountBySignature } from "../state/runtime-state.js";
import { generateFailureSignature } from "../jev/normalize.js";
import { loadConfig } from "../config.js";

/**
 * Retry Judge — determines if a retry should be blocked based on failure history.
 *
 * v0.1: Only provides suggestions appended to tool results, never auto-retries.
 * The actual blocking happens in the Tool Gate (repeated failure protection).
 *
 * This module provides the judgment logic used by both the Tool Gate
 * and the Failure Classifier.
 */

export interface RetryJudgment {
  shouldBlock: boolean;
  reason?: string;
  failureCount: number;
  maxRetries: number;
}

/**
 * Check if a retry should be blocked based on failure history.
 * Called from the Tool Gate before allowing a tool_call.
 */
export function judgeRetry(
  toolName: string,
  inputSummary: string,
  errorExcerpt?: string,
): RetryJudgment {
  const config = loadConfig();
  const maxRetries = config.retryJudge.maxSameFailureRetries;

  const signature = generateFailureSignature(toolName, inputSummary, errorExcerpt ?? "");
  const failureCount = getFailureCountBySignature(signature);

  if (maxRetries <= 0) {
    // No retry limit configured
    return {
      shouldBlock: false,
      failureCount,
      maxRetries: 0,
    };
  }

  if (failureCount >= maxRetries) {
    return {
      shouldBlock: true,
      reason: `This action already failed ${failureCount} time(s). Change the approach or provide new evidence before retrying.`,
      failureCount,
      maxRetries,
    };
  }

  return {
    shouldBlock: false,
    failureCount,
    maxRetries,
  };
}
