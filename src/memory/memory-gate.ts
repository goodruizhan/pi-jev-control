import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { MEMORY_TYPE_QUESTION, MEMORY_DURABILITY_QUESTION } from "../jev/questions.js";
import { normalizeMemoryType } from "../jev/normalize.js";
import type { MemoryType, MemoryRecord } from "../types.js";
import { appendMemory, appendFailure, getProjectHash } from "./store.js";
import crypto from "node:crypto";

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

// Phrases that indicate a constraint
const CONSTRAINT_PATTERNS = [
  /不要.*修改/,
  /不要.*改/,
  /不要动/,
  /别改/,
  /别动/,
  /don't modify/i,
  /don't change/i,
  /never touch/i,
  /always use/i,
  /must use/i,
  /不要用/,
  /必须用/,
  /禁止/,
  /不允许/,
];

// Phrases that indicate a decision
const DECISION_PATTERNS = [
  /决定用/,
  /decided to use/i,
  /will use/i,
  /choosing/i,
  /选择用/,
  /方案是/,
  /采用/,
];

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
): Promise<void> {
  const config = loadConfig();
  if (!config.enabled || !config.memoryGate.enabled) return;

  // Skip short confirmations and commands
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.startsWith("/")) return;

  // Quick heuristic: only analyze if it looks constraint/decision-like
  const isConstraint = detectConstraint(trimmed);
  const isDecision = detectDecision(trimmed);

  if (!isConstraint && !isDecision) return;

  // Check Jev availability
  if (!isJevAvailable()) return;

  // Use Jev to classify memory type and durability
  const state = {
    text: trimmed.slice(0, 500),
    domain: "software development with Pi; often Unreal Engine 5",
  };

  const questions = {
    memory_type: MEMORY_TYPE_QUESTION,
    durable: MEMORY_DURABILITY_QUESTION,
  };

  const result = await callJev(state, questions, {
    module: "memoryGate",
    signal: ctx.signal,
  });

  if (!result.ok) return;

  const memoryType = normalizeMemoryType(result.result.answers.memory_type.choice);
  const durableProb = (result.result.answers.durable as { noul: number }).noul;

  // Write condition: memory_type != none AND durable probability >= 0.65
  if (memoryType === "none" || durableProb < 0.65) return;

  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    projectHash: getProjectHash(),
    type: memoryType,
    summary: trimmed.slice(0, 200),
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

  ctx.ui.notify(`[Jev Memory] Stored as ${memoryType} (durability: ${durableProb.toFixed(2)})`, "info");
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
    fingerprint: crypto.createHash("sha256").update(`${toolName}|${inputSummary}`).digest("hex").slice(0, 16),
    resolved: false,
  };

  appendFailure(record);
}
