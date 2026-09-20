import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { FAILURE_TYPE_QUESTION, RECOMMENDED_ACTION_QUESTION } from "../judge/questions.js";
import { generateFailureSignature, normalizeFailureType, normalizeRecommendedAction } from "../judge/normalize.js";
import { getFailureCountByActionKey, getFailureCountByFamily, recordFailure } from "../state/runtime-state.js";
import { storeFailureMemory } from "../memory/memory-gate.js";
import type { FailureType, RecommendedAction } from "../types.js";
import { tr } from "../i18n.js";
import { getActionKey, getCommandCategory } from "../action-context.js";
import { recordBenignFailureSkipped } from "../stats/savings.js";

/** Failure Classifier + Retry Judge. Never retries automatically. */
export function setupFailureClassifier(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.retryJudge.enabled) return;

    const toolName = event.toolName;
    const toolInput = (event.input ?? {}) as Record<string, unknown>;
    const exitCode = extractExitCode(event);
    const evidence = extractFailureEvidence(event);
    if (!isFailureEvent(event.isError === true, exitCode, evidence)) return;

    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (config.retryJudge.skipBenignExitCodes && isBenignShellOutcome(toolName, command, exitCode, evidence)) {
      recordBenignFailureSkipped();
      return;
    }

    const inputSummary = JSON.stringify(toolInput).slice(0, 1500);
    const errorExcerpt = evidence.slice(0, 4000);
    const actionKey = getActionKey(toolName, toolInput);
    const commandCategory = getCommandCategory(toolName, toolInput);
    const sameFailureCount = Math.max(
      getFailureCountByActionKey(actionKey),
      getFailureCountByFamily(toolName, commandCategory),
    );
    const signature = generateFailureSignature(toolName, inputSummary, errorExcerpt);

    if (sameFailureCount >= 1) {
      return appendAssessment(event, {
        signature, actionKey, commandCategory, toolName, inputSummary, errorExcerpt,
        failureType: "repeated", recommendedAction: "do_not_retry", sameFailureCount, source: "local-rule",
      });
    }

    if (!isJudgeAvailable()) return appendUnavailableAssessment(event, "unavailable", "Jev API unavailable");

    const result = await judge(
      {
        tool: toolName,
        command: command.slice(0, 1000),
        command_category: commandCategory,
        input_summary: inputSummary,
        exit_code: exitCode,
        stderr_excerpt: extractStderr(event).slice(0, 2000),
        output_excerpt: errorExcerpt,
        operation_aborted: /operation aborted|aborted|cancelled|canceled|已中止|已取消/i.test(errorExcerpt),
        same_failure_count: sameFailureCount,
      },
      { failure_type: FAILURE_TYPE_QUESTION, recommended_action: RECOMMENDED_ACTION_QUESTION },
      { module: "failureJudge", signal: ctx.signal, timeoutMs: config.retryJudge.timeoutMs },
    );

    if (!result.ok) {
      console.warn("[pi-jev-control] Failure Judge Jev call failed:", result.errorType, result.error);
      return appendUnavailableAssessment(event, result.errorType, result.error);
    }

    return appendAssessment(event, {
      signature, actionKey, commandCategory, toolName, inputSummary, errorExcerpt,
      failureType: normalizeFailureType(choiceOf(result.answers.failure_type).choice),
      recommendedAction: normalizeRecommendedAction(choiceOf(result.answers.recommended_action).choice),
      sameFailureCount,
      source: "jev",
    });
  });
}

interface AssessmentInput {
  signature: string;
  actionKey: string;
  commandCategory: string;
  toolName: string;
  inputSummary: string;
  errorExcerpt: string;
  failureType: FailureType;
  recommendedAction: RecommendedAction;
  sameFailureCount: number;
  source: "jev" | "local-rule";
}

function appendAssessment(event: any, assessment: AssessmentInput) {
  recordFailure({
    signature: assessment.signature,
    actionKey: assessment.actionKey,
    commandCategory: assessment.commandCategory,
    toolName: assessment.toolName,
    inputSummary: assessment.inputSummary,
    errorExcerpt: assessment.errorExcerpt,
    failureType: assessment.failureType,
    recommendedAction: assessment.recommendedAction,
  });
  storeFailureMemory(assessment.toolName, assessment.inputSummary, assessment.errorExcerpt, assessment.failureType, assessment.recommendedAction);

  if (loadConfig().retryJudge.appendToResult === false) return undefined;

  const judgmentText = tr(
    [
      `[pi-jev-control plugin assessment — not tool output]`,
      `source: ${assessment.source}`,
      `type: ${assessment.failureType}`,
      `action: ${assessment.recommendedAction}`,
      `failure_family: ${assessment.commandCategory}`,
      `same_failure_count: ${assessment.sameFailureCount + 1}`,
    ].join("\n"),
    [
      `[pi-jev-control 插件评估——并非工具输出]`,
      `来源：${assessment.source === "jev" ? "Jev" : "本地规则"}`,
      `类型：${assessment.failureType}`,
      `建议操作：${assessment.recommendedAction}`,
      `失败类别：${assessment.commandCategory}`,
      `同类失败次数：${assessment.sameFailureCount + 1}`,
    ].join("\n"),
  );
  return withAppendedText(event, judgmentText);
}

function appendUnavailableAssessment(event: any, errorType: string, error: string) {
  if (loadConfig().retryJudge.appendToResult === false) return undefined;
  return withAppendedText(event, tr(
    `[pi-jev-control plugin assessment — not tool output]\nstatus: skipped (${errorType})\ndetail: ${error.slice(0, 300)}\nraw tool result preserved`,
    `[pi-jev-control 插件评估——并非工具输出]\n状态：已跳过（${errorType}）\n详情：${error.slice(0, 300)}\n原始工具结果保持不变`,
  ));
}

function withAppendedText(event: any, text: string) {
  const originalContent = Array.isArray(event.content)
    ? event.content
    : typeof event.content === "string"
      ? [{ type: "text" as const, text: event.content }]
      : [];
  return {
    content: [...originalContent, { type: "text" as const, text }],
    details: event.details,
    isError: event.isError,
    usage: event.usage,
  };
}

export function isFailureEvent(isError: boolean, exitCode: number | null, evidence: string): boolean {
  return isError || (exitCode !== null && exitCode !== 0) || /operation aborted|operation cancelled|operation canceled|操作已中止|操作已取消/i.test(evidence);
}

export function isBenignShellOutcome(toolName: string, command: string, exitCode: number | null, evidence: string): boolean {
  if (toolName !== "bash" && toolName !== "powershell") return false;
  if (exitCode !== 1) return false;
  if (/permission denied|access denied|拒绝访问|权限不足/i.test(evidence)) return false;

  const executable = command.trim().match(/^([\w.\\/-]+)/)?.[1]?.replace(/^.*[\\/]/, "").toLowerCase();
  if (executable === "grep" || executable === "rg") return true;
  if (executable === "find" || executable === "ls" || executable === "dir") {
    return evidence.trim().length === 0 || /no match|no files|not found|cannot find|找不到|不存在|无匹配/i.test(evidence);
  }
  return false;
}

export function extractExitCode(event: { details?: unknown }): number | null {
  const details = event.details as Record<string, unknown> | undefined;
  if (!details) return null;
  for (const key of ["exitCode", "exit_code", "code"]) {
    if (typeof details[key] === "number") return details[key] as number;
  }
  return null;
}

function extractFailureEvidence(event: { content?: unknown; details?: unknown }): string {
  const pieces = [extractStderr(event)];
  const content = event.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") pieces.push(block);
      else if (typeof block === "object" && block !== null) {
        const value = block as Record<string, unknown>;
        if (typeof value.text === "string") pieces.push(value.text);
        if (typeof value.content === "string") pieces.push(value.content);
      }
    }
  } else if (typeof content === "string") pieces.push(content);
  return pieces.filter(Boolean).join("\n").slice(0, 4000);
}

function extractStderr(event: { details?: unknown }): string {
  const details = event.details as Record<string, unknown> | undefined;
  if (!details) return "";
  for (const key of ["stderr", "error", "errorMessage", "message"]) {
    if (typeof details[key] === "string") return details[key] as string;
  }
  return "";
}
