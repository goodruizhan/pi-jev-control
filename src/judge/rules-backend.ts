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

// ── Wrapper-aware dangerous detection ───────────────────────────────
//
// The pattern table in types.ts is anchored to the start of a segment, so a
// destructive command hidden inside a wrapper — `sh -c 'rm -rf /'`,
// `python -c "os.system('rm -rf /')"`, `cmd /c ...`, `eval ...`, or an
// obfuscation such as `rm$IFS-rf$IFS/` — would otherwise slip through as
// `uncertain`. The wrapper below unquotes and re-splits those payloads so they
// are judged exactly like an inline command. It only *adds* dangerous matches,
// so the safe path is untouched.

const MAX_UNWRAP_DEPTH = 4;

const SHELL_OPTION = String.raw`(?:--[a-zA-Z][\w-]*(?:=\S+)?|-[a-zA-Z]+)`;

interface WrapperRule {
  pattern: RegExp;
  group: number;
}

const WRAPPER_RULES: WrapperRule[] = [
  // sh -c / bash -lc / zsh -c "payload"
  {
    pattern: new RegExp(
      String.raw`\b(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|scsh)\b(?:\s+${SHELL_OPTION})*?\s+-[a-zA-Z]*c[a-zA-Z]*\s+(\S+(?:[^\S\n]\S+)*)`,
      "gi",
    ),
    group: 1,
  },
  // eval / exec / command / nohup — builtins that run their argument, with an
  // optional `--` end-of-options marker in between.
  {
    pattern: new RegExp(
      String.raw`\b(?:eval|exec|command|nohup)\b(?:\s+${SHELL_OPTION})*\s+(?:--\s+)?(\S+(?:[^\S\n]\S+)*)`,
      "gi",
    ),
    group: 1,
  },
  // nice takes a numeric argument: `nice -n 10 rm -rf /`
  {
    pattern: /\bnice\b\s+(?:-[a-zA-Z]+\s+\S+\s+)*(\S+(?:[^\S\n]\S+)*)/gi,
    group: 1,
  },
  // timeout takes a duration first: `timeout 5s rm -rf /`
  {
    pattern: new RegExp(
      String.raw`\btimeout\b\s+\S+(?:\s+${SHELL_OPTION})*\s+(\S+(?:[^\S\n]\S+)*)`,
      "gi",
    ),
    group: 1,
  },
  // python3 -c / node -e / perl -e / ruby -e / php -r / lua -e
  {
    pattern: new RegExp(
      String.raw`\b(?:python\d?(?:\.[\d.]+)?|pythonw|node|nodejs|perl|ruby|php|lua|deno)\b(?:\s+${SHELL_OPTION})*?\s+(?:-[a-zA-Z]*[ceer][a-zA-Z]*|--eval|--execute|--command)\s+(\S+(?:[^\S\n]\S+)*)`,
      "gi",
    ),
    group: 1,
  },
  // cmd /c payload  |  powershell -Command / -C / -EncodedCommand payload
  {
    pattern: /\bcmd(?:\.exe)?\b\s+\/[cCkK]\s+(\S+(?:[^\S\n]\S+)*)/gi,
    group: 1,
  },
  {
    pattern: /\bpowershell(?:\.exe)?\b[^\r\n;&|]*?\s-(?:Command|C|EC|EncodedCommand)\s+(\S+(?:[^\S\n]\S+)*)/gi,
    group: 1,
  },
  // awk/perl/python/shell one-liners that shell out
  {
    pattern: /\bsystem\s*\(\s*['"]([^'"\n]*)['"]/gi,
    group: 1,
  },
  {
    pattern: /\bpopen\s*\(\s*['"]([^'"\n]*)['"]\s*,\s*['"][a-zA-Z]+['"]/gi,
    group: 1,
  },
];

/**
 * Destructive constructs that live inside interpreter one-liners, where the
 * shell-style anchored table cannot see them (e.g. `shutil.rmtree('/')`).
 */
const INTERPRETER_DESTRUCTIVE: RegExp[] = [
  /shutil\.rmtree\s*\(\s*[^)]*[,)]/i,
  /(?:^|[;&|]\s*)python[\w.]*\s+-c\b[^\r\n]*\bos\.(?:unlink|remove)\s*\(/i,
  // subprocess accepts argv arrays as well as shell strings.
  /(?:^|[;&|]\s*)python[\w.]*\s+-c\b[^\r\n]*\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*\[\s*["']rm["']\s*,\s*["']-[a-zA-Z]*[rf][a-zA-Z]*["']/i,
  /os\.system\s*\(\s*["'][^"']*(?:\brm\s+-[a-zA-Z]*[rf]\b|unlink|drop\s+table)/i,
  /subprocess\.\w+\s*\(\s*["'][^"']*(?:\brm\s+-[a-zA-Z]*[rf]\b|unlink)/i,
  // `child_process.exec('rm -rf /')` and `require('child_process').exec(...)`
  /(?:\bexec|\bexecSync|\bexecFileSync|\bspawn|\bspawnSync)\s*\(\s*["'][^"']*(?:\brm\s+-[a-zA-Z]*[rf]\b|unlink)/i,
  /Path\s*\([^)]*\)\.(?:unlink|rmdir)\s*\(/i,
  // `fs.rmSync('/x', { recursive: true })` and `require('fs').rmSync(...)`
  /(?:\bfs|["']fs["'])\)?\.rmSync\s*\([^)]*(?:recursive|force\s*[:=]\s*true)/i,
  // `fs.promises.rm('/x', { recursive: true })`
  /\.rm\s*\(\s*["'][^"']*["']\s*,\s*\{[^}]*recursive\s*[:=]\s*true/i,
  /\.unlink\s*\([^)]*recursive\s*[:=]\s*true/i,
  /remove-item\b[^\r\n;&|]*(?:-recurse|-force)/i,
];

/**
 * Strip shell-level obfuscation that hides a destructive command from the
 * pattern table: `$IFS` used as whitespace, ANSI-C quoting (`$'rm -rf /'`),
 * and backslash-escaped whitespace inside quotes.
 */
function deobfuscate(command: string): string {
  return command
    .replace(/\$\{?IFS\}?/gi, " ")
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_match, body: string) =>
      body
        .replace(/\\t/g, " ")
        .replace(/\\n/g, " ")
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\(.)/g, "$1"),
    );
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Split on shell separators while ignoring separators inside quotes, so
 * `echo "hello; rm -rf /"` stays one segment and is not misread as a chain.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "|" || command.startsWith("&&", i)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += ch === "|" && command[i + 1] === "|" ? 1 : command.startsWith("&&", i) ? 1 : 0;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Extract every wrapper payload so each one is judged as its own block. */
function expandWrappers(command: string): string[] {
  const blocks: string[] = [command];
  for (const rule of WRAPPER_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(command)) !== null) {
      const payload = stripQuotes(match[rule.group]);
      if (payload) blocks.push(payload);
      if (rule.pattern.lastIndex === match.index) rule.pattern.lastIndex++;
    }
  }
  return blocks;
}

// A plain `cat` heredoc is data, not another shell command. Only mask a
// complete, standalone cat statement; pipes, substitutions, and incomplete
// delimiters stay visible (conservative: they may execute the body).
function maskInertCatHeredocs(command: string): string {
  const lines = command.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].replace(/\r$/, "");
    const match = /^[ \t]*cat(?:[ \t]+(?:-[\w-]+|[\w./-]+))*[ \t]+<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*$/.exec(header);
    if (!match) continue;
    const [, tabsAllowed, , marker] = match;
    let end = i + 1;
    while (end < lines.length && (tabsAllowed ? lines[end].replace(/^\t*/, "") : lines[end]).replace(/\r$/, "") !== marker) end++;
    if (end === lines.length) continue;
    const body = lines.slice(i + 1, end).join("\n");
    // Even an unquoted heredoc can perform shell substitutions.
    if (!match[2] && (/\$\(|`/.test(body))) { i = end; continue; }
    for (let j = i + 1; j < end; j++) lines[j] = " ";
    i = end;
  }
  return lines.join("\n");
}

function stripEnvAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*|^\*\s+/, "").trim();
}

/**
 * Replace quoted regions with a neutral space so a separator inside quotes
 * (`echo "hello; rm -rf /"`) does not look like a command chain. Wrapper
 * unwrapping already pulled quoted payloads out as their own segments, so
 * masking them here cannot hide a real destructive command.
 */
function maskQuoted(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < command.length) {
        if (command[i] === "\\") { i += 2; continue; }
        if (command[i] === quote) { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Check if a bash command matches known dangerous patterns.
 */
export function isDangerousBashCommand(command: string): boolean {
  return isSegmentDangerous(maskInertCatHeredocs(command).trim(), 0);
}

function isSegmentDangerous(segment: string, depth: number): boolean {
  // Deobfuscation runs first: `$IFS` used as whitespace and ANSI-C quoting
  // ($'rm -rf /') hide a destructive command from the pattern table.
  const expanded = deobfuscate(segment);
  // Shell-level patterns run against the masked form so separators inside
  // quotes stay inert; interpreter patterns run against the raw form because
  // their payloads are themselves quoted strings.
  const stripped = stripEnvAssignments(maskQuoted(expanded));
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(stripped)) return true;
  }
  for (const pattern of INTERPRETER_DESTRUCTIVE) {
    if (pattern.test(expanded)) return true;
  }
  if (depth >= MAX_UNWRAP_DEPTH) return false;
  // Unquoted heredocs (and ordinary shell lines) can execute command substitutions.
  for (const substitution of expanded.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    if (isSegmentDangerous(substitution[1] ?? substitution[2], depth + 1)) return true;
  }
  for (const block of expandWrappers(expanded)) {
    for (const nested of splitSegments(block)) {
      if (isSegmentDangerous(nested, depth + 1)) return true;
    }
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
