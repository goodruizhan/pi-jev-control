import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { MEMORY_TYPE_QUESTION, MEMORY_DURABILITY_QUESTION } from "../judge/questions.js";
import { normalizeMemoryType } from "../judge/normalize.js";
import { CONSTRAINT_PATTERNS, DECISION_PATTERNS } from "../judge/rules-backend.js";
import type { MemoryType, MemoryRecord } from "../types.js";
import { appendMemory, appendFailure, getProjectHash, upsertFailure } from "./store.js";
import { generateActionFingerprint } from "../judge/normalize.js";
import { recordMemoryCreated } from "../stats/savings.js";
import crypto from "node:crypto";
import { tr } from "../i18n.js";
import { notifyAutomatic } from "../ui.js";

/**
 * Memory Gate — analyzes user input and tool results to determine
 * what should be stored as long-term memory.
 *
 * Hooks into pi.on("input") to analyze user messages.
 * Also provides a function called by the failure classifier for tool failures.
 *
 * Only analyzes:
 * - User explicit constraints ("不要修改 X", "always use Y")
 * - Important tool failures
 * - Important success results
 * - Obvious architecture decisions
 *
 * Never analyzes every read/grep call.
 */

/**
 * Check if user input contains a constraint.
 */
function detectConstraint(text: string): boolean {
  return CONSTRAINT_PATTERNS.some((p) => p.test(text));
}

/**
 * Check if user input contains a decision.
 */
function detectDecision(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

/**
 * Analyze user input for memory-worthy content.
 * Called from the input event handler.
 */
export async function analyzeUserInput(
  text: string,
  ctx: ExtensionContext,
  source?: string,
): Promise<void> {
  const config = loadConfig();
  if (!config.enabled || !config.memoryGate.enabled) return;
  if (source === "extension") return;

  // Skip short confirmations and commands
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.startsWith("/")) return;

  // Quick heuristic: only analyze if it looks constraint/decision-like
  const isConstraint = detectConstraint(trimmed);
  const isDecision = detectDecision(trimmed);

  if (!isConstraint && !isDecision) return;

  // Check Jev availability
  if (!isJudgeAvailable()) return;

  // Use Jev to classify memory type and durability
  const state = {
    text: trimmed.slice(0, 500),
    domain: "software development with Pi; often Unreal Engine 5",
  };

  const questions = {
    memory_type: MEMORY_TYPE_QUESTION,
    durable: MEMORY_DURABILITY_QUESTION,
  };

  const result = await judge(state, questions, {
    module: "memoryGate",
    signal: ctx.signal,
  });

  if (!result.ok) return;

  const memoryType = normalizeMemoryType(choiceOf(result.answers.memory_type).choice);
  const durableProb = (result.answers.durable as { noul: number }).noul;

  // Write condition: memory_type != none AND durable probability >= 0.65
  if (memoryType === "none" || durableProb < 0.65) return;

  const summary = trimmed.slice(0, 200);

  // suggest (default): announce, never write. The model decides what to remember
  // through jev_memory_add — it has the conversation this watcher does not.
  if (config.memoryGate.mode === "suggest") {
    notifyAutomatic(ctx, tr(
      `[Jev memory] Detected a possible ${memoryType} (durability ${durableProb.toFixed(2)}): "${summary}" — call jev_memory_add if it should be stored.`,
      `[Jev 记忆] 检测到一条可能的 ${memoryType}（持久度 ${durableProb.toFixed(2)}）：“${summary}”——如果值得保存请调用 jev_memory_add。`,
    ), "info");
    return;
  }

  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    projectHash: getProjectHash(),
    type: memoryType,
    summary,
    rawExcerpt: trimmed.slice(0, 500),
    confidence: durableProb,
    source: "user",
    fingerprint: crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 16),
  };

  if (memoryType === "failure") {
    appendFailure(record);
  } else {
    appendMemory(record);
  }
  recordMemoryCreated();

  notifyAutomatic(ctx, tr(
    `[Jev Memory] Stored as ${memoryType} (durability: ${durableProb.toFixed(2)})`,
    `[Jev 记忆] 已保存为 ${memoryType}（持久度：${durableProb.toFixed(2)}）`,
  ), "info");
}

/**
 * Store a tool failure as memory.
 * Called from the failure classifier.
 */
export function storeFailureMemory(
  toolName: string,
  inputSummary: string,
  errorExcerpt: string,
  failureType: string,
  recommendedAction: string,
): void {
  const config = loadConfig();
  if (!config.enabled || !config.memoryGate.enabled) return;

  // Only store important failures (not transient, not repeated)
  if (failureType === "transient" || failureType === "repeated") return;

  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    projectHash: getProjectHash(),
    type: "failure",
    summary: `${toolName}: ${inputSummary.slice(0, 100)}`,
    rawExcerpt: errorExcerpt.slice(0, 500),
    confidence: 0.8,
    source: "tool_result",
    fingerprint: generateActionFingerprint(toolName, inputSummary),
    resolved: false,
    action: inputSummary,
    result: errorExcerpt.slice(0, 500),
    reason: `${failureType}:${recommendedAction}`,
    retryCount: 1,
    toolName,
  };

  if (upsertFailure(record)) recordMemoryCreated();
}
