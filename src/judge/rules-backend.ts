/**
 * Rules backend — deterministic pattern/threshold rules packaged as a
 * judgment backend. Serves two roles:
 *
 * 1. Chain terminal: configured as `judgment.fallback` (the default) so
 *    judge() can return deterministic answers when model backends are down.
 *    An unanswered question makes the whole request unavailable so callers
 *    keep their existing fallback behavior.
 * 2. Shared rule library: the pure functions below are imported directly
 *    by modules (tool gate, review gate, failure classifier, memory gate)
 *    for their pre-checks, so heuristic logic lives in exactly one place.
 *
 * Safety contract: rules NEVER fail open. A rule either reproduces the
 * exact heuristic a module already applied inline, or abstains
 * (an unavailable outcome). Modules with model-only behavior keep their own
 * fallback path.
 */

import type { JudgmentBackend, JudgeCallOptions, JudgeOutcome, JudgeRequestInput } from "./backend.js";
import type { JudgeAnswer, JudgeAnswers, JudgeQuestionIR } from "./ir.js";
import {
  FAILURE_TYPE_QUESTION,
  MEMORY_TYPE_QUESTION,
  RECOMMENDED_ACTION_QUESTION,
  REVIEW_NEEDED_QUESTION,
  TOOL_GATE_QUESTION,
} from "./questions.js";
import { DANGEROUS_BASH_PATTERNS, SAFE_BASH_COMMANDS, SAFE_READONLY_TOOLS } from "../types.js";

// ── Shared verdict type ─────────────────────────────────────────────────

export interface RuleVerdict {
  choice: string;
  confidence: number;
  reason: string;
}

type StateRecord = Record<string, unknown>;

// ── Shell command classification (tool gate) ────────────────────────────

export type ShellRisk = "safe" | "dangerous" | "uncertain";

/** Classify a complete shell command. Safe fast paths never accept composition. */
export function classifyShellCommand(command: string): ShellRisk {
  if (isDangerousBashCommand(command)) return "dangerous";
  if (isSafeBashCommand(command)) return "safe";
  return "uncertain";
}

/**
 * Check if a bash command matches known safe patterns.
 * Uses explicit prefix matching, not includes().
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();

  // Reject chaining, redirection, command substitution, and multi-line commands.
  if (/[;&|<>`\r\n]/.test(trimmed) || trimmed.includes("$(")) return false;

  // Shell find can execute or delete; the built-in Pi find tool remains safe.
  if (/^find(?:\s|$)/i.test(trimmed)) return false;

  // These options can execute a helper or write output despite a read-like command name.
  if (/^rg(?:\s|$)/i.test(trimmed) && /(?:^|\s)--pre(?:=|\s)/i.test(trimmed)) return false;
  if (/^git\s+(?:diff|log)(?:\s|$)/i.test(trimmed) && /(?:^|\s)(?:--output(?:=|\s)|--ext-diff\b|--textconv\b)/i.test(trimmed)) return false;

  for (const safe of SAFE_BASH_COMMANDS) {
    const lower = trimmed.toLowerCase();
    const safeLower = safe.toLowerCase();
    if (lower === safeLower) return true;
    if (lower.startsWith(safeLower + " ")) return true;
    if (lower.startsWith(safeLower + "\t")) return true;
  }

  return false;
}

/**
 * Check if a bash command matches known dangerous patterns.
 */
export function isDangerousBashCommand(command: string): boolean {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ── Failure classification (failure classifier) ─────────────────────────

/**
 * Repeated-failure rule: the same action already failed before, so an
 * unchanged retry is pointless. Mirrors the failure classifier's local rule.
 */
export function evaluateRepeatedFailure(sameFailureCount: number): RuleVerdict | null {
  if (sameFailureCount >= 1) {
    return { choice: "repeated", confidence: 1, reason: `same failure seen ${sameFailureCount} time(s)` };
  }
  return null;
}

/** Retry action for a repeated failure: never recommend an unchanged retry. */
export function evaluateRetryAction(sameFailureCount: number): RuleVerdict | null {
  if (sameFailureCount >= 1) {
    return { choice: "do_not_retry", confidence: 1, reason: "repeated failure — change approach or input first" };
  }
  return null;
}

// ── Review gate ─────────────────────────────────────────────────────────

/** Patterns that force strong_review. */
export const REVIEW_FORCE_PATTERNS = [
  /garbage\s*collect/i,
  /\bGC\b/i,
  /multi[-]?thread/i,
  /thread\s*saf/i,
  /replication/i,
  /replicat/i,
  /gameplay\s*ability/i,
  /\bGAS\b/i,
  /engine\s*internal/i,
  /engine\s*source/i,
  /UObject\s*lifecycle/i,
  /UObject\s*alloc/i,
  /virtual\s*destructor/i,
  /override\s*virtual/i,
];

export interface ReviewRuleInput {
  modifiedFiles: number;
  fileTypes: string[];
  isCoreSystem: boolean;
  involvesGC: boolean;
  involvesThreading: boolean;
  involvesReplication: boolean;
  involvesGAS: boolean;
  description?: string;
}

/**
 * Forced strong_review rules — run before any model call. Returns null when
 * nothing forces a review level and the model should decide.
 */
export function evaluateReviewForced(params: ReviewRuleInput): RuleVerdict | null {
  const combinedText = [params.description ?? "", ...params.fileTypes].join(" ");

  for (const pattern of REVIEW_FORCE_PATTERNS) {
    if (pattern.test(combinedText)) {
      return { choice: "strong_review", confidence: 1, reason: `forced by pattern: ${pattern}` };
    }
  }

  if (params.isCoreSystem || params.involvesGC || params.involvesThreading || params.involvesReplication || params.involvesGAS) {
    return { choice: "strong_review", confidence: 1, reason: "core system involvement (core/GC/threading/replication/GAS)" };
  }

  if (params.modifiedFiles >= 10) {
    return { choice: "strong_review", confidence: 0.9, reason: `large refactoring: ${params.modifiedFiles} files modified` };
  }

  return null;
}

// ── Memory gate pre-filter patterns ─────────────────────────────────────

/** Phrases that indicate a constraint. */
export const CONSTRAINT_PATTERNS = [
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

/** Phrases that indicate a decision. */
export const DECISION_PATTERNS = [
  /决定用/,
  /decided to use/i,
  /will use/i,
  /choosing/i,
  /选择用/,
  /方案是/,
  /采用/,
];

/**
 * Rough memory-type classification from raw text. Used both as the memory
 * gate's cheap pre-filter and as the rules answer for memory_type.
 */
export function classifyMemoryText(text: string): "constraint" | "decision" | null {
  if (CONSTRAINT_PATTERNS.some((p) => p.test(text))) return "constraint";
  if (DECISION_PATTERNS.some((p) => p.test(text))) return "decision";
  return null;
}

// ── Question rules (backend role) ───────────────────────────────────────

type QuestionRule = (state: StateRecord) => RuleVerdict | null;

/** Tool gate: allow known-safe tools, flag dangerous patterns — never fail open. */
function ruleToolGate(state: StateRecord): RuleVerdict | null {
  const tool = typeof state.tool === "string" ? state.tool : "";
  if (tool && SAFE_READONLY_TOOLS.has(tool)) {
    return { choice: "allow", confidence: 1, reason: "safe read-only tool" };
  }
  const command = typeof state.command === "string" ? state.command : "";
  if ((tool === "bash" || tool === "powershell") && command && isDangerousBashCommand(command)) {
    return { choice: "confirm", confidence: 0.9, reason: "dangerous command pattern in input" };
  }
  return null;
}

function ruleFailureType(state: StateRecord): RuleVerdict | null {
  return evaluateRepeatedFailure(Number(state.same_failure_count) || 0);
}

function ruleRecommendedAction(state: StateRecord): RuleVerdict | null {
  return evaluateRetryAction(Number(state.same_failure_count) || 0);
}

function ruleReviewNeeded(state: StateRecord): RuleVerdict | null {
  return evaluateReviewForced({
    modifiedFiles: Number(state.modifiedFiles) || 0,
    fileTypes: Array.isArray(state.fileTypes) ? state.fileTypes.map(String) : [],
    isCoreSystem: state.isCoreSystem === true,
    involvesGC: state.involvesGC === true,
    involvesThreading: state.involvesThreading === true,
    involvesReplication: state.involvesReplication === true,
    involvesGAS: state.involvesGAS === true,
    description: typeof state.description === "string" ? state.description : "",
  });
}

function ruleMemoryType(state: StateRecord): RuleVerdict | null {
  const text = typeof state.text === "string" ? state.text : "";
  const classified = text ? classifyMemoryText(text) : null;
  if (classified) return { choice: classified, confidence: 0.7, reason: "pattern match" };
  return null;
}

/** Match both the stable answer key and canonical question text. */
const CHOICE_RULES: ReadonlyMap<string, { instructions: unknown; rule: QuestionRule }> = new Map([
  ["tool_gate", { instructions: TOOL_GATE_QUESTION.instructions, rule: ruleToolGate }],
  ["failure_type", { instructions: FAILURE_TYPE_QUESTION.instructions, rule: ruleFailureType }],
  ["recommended_action", { instructions: RECOMMENDED_ACTION_QUESTION.instructions, rule: ruleRecommendedAction }],
  ["review_needed", { instructions: REVIEW_NEEDED_QUESTION.instructions, rule: ruleReviewNeeded }],
  ["memory_type", { instructions: MEMORY_TYPE_QUESTION.instructions, rule: ruleMemoryType }],
]);

function answerQuestion(name: string, question: JudgeQuestionIR, state: StateRecord): JudgeAnswer | null {
  // Rules have no probabilistic answer for Noul or score questions. Returning
  // zero as a successful answer could drop context or suppress memory.
  if (question.type !== "choice" || !question.criteria || typeof question.criteria !== "object") return null;
  const entry = CHOICE_RULES.get(name);
  if (!entry || question.instructions !== entry.instructions) return null;
  const verdict = entry.rule(state);
  if (!verdict || !Object.hasOwn(question.criteria, verdict.choice)) return null;
  return { type: "choice", choice: verdict.choice, confidence: verdict.confidence };
}

/**
 * Accept both the internal judgment state and the serialized tool-call shape
 * used by eval logs and external callers. Keeping this normalization here
 * means each deterministic rule can continue to use its small canonical state.
 */
function normalizeRuleState(state: StateRecord): StateRecord {
  const normalized = { ...state };
  const input = state.input && typeof state.input === "object" && !Array.isArray(state.input)
    ? state.input as Record<string, unknown>
    : undefined;

  if (typeof normalized.tool !== "string") {
    const tool = state.tool_name ?? state.toolName;
    if (typeof tool === "string") normalized.tool = tool;
  }
  if (typeof normalized.command !== "string" && typeof input?.command === "string") {
    normalized.command = input.command;
  }
  return normalized;
}

// ── Backend ─────────────────────────────────────────────────────────────

export interface RulesBackendOptions {
  name: string;
}

export class RulesBackend implements JudgmentBackend {
  readonly name: string;
  readonly confidenceKind = "binary" as const;

  constructor(options: RulesBackendOptions) {
    this.name = options.name;
  }

  /** Always available — it is the deterministic last resort. */
  isAvailable(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async judge(request: JudgeRequestInput, options: JudgeCallOptions): Promise<JudgeOutcome> {
    const startTime = Date.now();
    if (options.signal?.aborted) {
      return { ok: false, errorType: "aborted", error: "judgment aborted", latencyMs: 0, backend: this.name };
    }
    if (!request || typeof request !== "object" || !request.questions || typeof request.questions !== "object" || Array.isArray(request.questions)) {
      return { ok: false, errorType: "unknown", error: "malformed judge request: missing questions", latencyMs: 0, backend: this.name };
    }

    const rawState = (request.state && typeof request.state === "object" ? request.state : {}) as StateRecord;
    const state = normalizeRuleState(rawState);
    const answers: JudgeAnswers = {};
    for (const [name, question] of Object.entries(request.questions)) {
      if (!question || typeof question !== "object") {
        return { ok: false, errorType: "unknown", error: `malformed question: ${name}`, latencyMs: Date.now() - startTime, backend: this.name };
      }
      const answer = answerQuestion(name, question, state);
      if (!answer) {
        return { ok: false, errorType: "unavailable", error: `no deterministic rule for ${name}`, latencyMs: Date.now() - startTime, backend: this.name };
      }
      answers[name] = answer;
    }

    return {
      ok: true,
      answers,
      model: "rules",
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs: Date.now() - startTime,
      backend: this.name,
      confidenceKind: this.confidenceKind,
    };
  }
}
