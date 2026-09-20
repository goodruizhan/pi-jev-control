/**
 * OpenAI-compatible backend — small, fast local/private models as a
 * judgment engine (Ollama, vLLM, LM Studio, or any /v1/chat/completions
 * endpoint). Default target is Ollama at http://localhost:11434/v1.
 *
 * This backend exists to host SMALL judgment models (1-4B class) as an
 * offline/privacy fallback — NOT to route judgment through large general
 * LLMs, which would defeat the purpose of a fast decision layer.
 *
 * Confidence semantics: "self-reported" — the model states its own
 * confidence, which is not calibrated like Jev's probabilities. Callers
 * should treat thresholds more conservatively for this kind.
 */

import type { JudgmentBackend, JudgeCallOptions, JudgeErrorType, JudgeOutcome, JudgeRequestInput } from "./backend.js";
import type { JudgeAnswer, JudgeAnswers, JudgeQuestionIR } from "./ir.js";

export interface OpenAiBackendOptions {
  name: string;
  /** Env var holding the API key. Optional — local servers often need none. */
  apiKeyEnv?: string;
  /** API root, e.g. http://localhost:11434/v1 (Ollama default). */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = [
  "You are a fast judgment engine inside a coding agent. Answer questions about the given state.",
  "Return ONLY a JSON object of the form {\"answers\": {\"<question-name>\": {...}}}. No prose, no markdown fences.",
  "For choice questions: {\"choice\": \"<exactly one option label>\", \"confidence\": <0..1>}",
  "For noul (yes/no) questions: {\"probability\": <0..1>} — the probability that the answer is YES.",
  "For score questions: {\"score\": <number within the rubric range>, \"confidence\": <0..1>}",
].join("\n");

export class OpenAiCompatibleBackend implements JudgmentBackend {
  readonly name: string;
  readonly confidenceKind = "self-reported" as const;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string | null;
  private readonly timeoutMs: number;
  private readonly reason: string | null = null;

  constructor(options: OpenAiBackendOptions) {
    this.name = options.name;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const keyEnv = options.apiKeyEnv;
    this.apiKey = keyEnv ? process.env[keyEnv] ?? null : null;
    if (keyEnv && !this.apiKey) {
      this.reason = `${keyEnv} not set`;
    } else if (!this.model) {
      this.reason = `no model configured for backend "${options.name}"`;
    }
  }

  isAvailable(): boolean {
    return this.reason === null;
  }

  unavailableReason(): string | null {
    return this.reason;
  }

  async judge(request: JudgeRequestInput, options: JudgeCallOptions): Promise<JudgeOutcome> {
    const startTime = Date.now();
    if (!this.isAvailable()) {
      return { ok: false, errorType: "unavailable", error: this.reason ?? "backend unavailable", latencyMs: 0, backend: this.name };
    }
    if (!request || typeof request !== "object" || !request.questions || typeof request.questions !== "object") {
      return { ok: false, errorType: "unknown", error: "malformed judge request: missing questions", latencyMs: 0, backend: this.name };
    }

    const signal = composeSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model ?? this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: renderPrompt(request) },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          errorType: classifyHttpStatus(response.status),
          error: `HTTP ${response.status}`,
          latencyMs: Date.now() - startTime,
          backend: this.name,
        };
      }

      const payload = (await response.json()) as ChatCompletionPayload;
      const text = payload.choices?.[0]?.message?.content ?? "";
      const answers = parseAnswers(text, request.questions);
      if (!answers) {
        return {
          ok: false,
          errorType: "unknown",
          error: "unparseable model output",
          latencyMs: Date.now() - startTime,
          backend: this.name,
        };
      }

      return {
        ok: true,
        answers,
        model: request.model ?? this.model ?? "unknown",
        usage: {
          input_tokens: payload.usage?.prompt_tokens ?? 0,
          output_tokens: payload.usage?.completion_tokens ?? 0,
        },
        latencyMs: Date.now() - startTime,
        backend: this.name,
        confidenceKind: this.confidenceKind,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      if (isAbortError(err)) {
        return { ok: false, errorType: options.signal?.aborted ? "aborted" : "timeout", error: "timed out", latencyMs, backend: this.name };
      }
      return {
        ok: false,
        errorType: "unavailable",
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
        backend: this.name,
      };
    }
  }
}

// ── Prompt rendering ────────────────────────────────────────────────────

function renderPrompt(request: JudgeRequestInput): string {
  const lines: string[] = ["State:", safeJson(request.state), "", "Questions:"];
  for (const [name, question] of Object.entries(request.questions)) {
    lines.push(renderQuestion(name, question));
  }
  return lines.join("\n");
}

function renderQuestion(name: string, question: JudgeQuestionIR): string {
  const text = typeof question.instructions === "string" ? question.instructions : safeJson(question.instructions ?? "");
  if (question.type === "choice") {
    const options = Object.entries(question.criteria)
      .map(([label, desc]) => `  - ${label}${typeof desc === "string" && desc ? `: ${desc}` : ""}`)
      .join("\n");
    return `- "${name}" (choice): ${text}\n${options}`;
  }
  if (question.type === "score") {
    const rubric = question.criteria.map((desc, index) => `  - ${index}${typeof desc === "string" && desc ? `: ${desc}` : ""}`).join("\n");
    return `- "${name}" (score 0..${question.criteria.length - 1}): ${text}\n${rubric}`;
  }
  return `- "${name}" (noul): ${text}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

// ── Response parsing ────────────────────────────────────────────────────

interface ChatCompletionPayload {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseAnswers(text: string, questions: Record<string, JudgeQuestionIR>): JudgeAnswers | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let parsed: { answers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.answers) return null;

  const answers: JudgeAnswers = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = parsed.answers[name];
    if (!raw || typeof raw !== "object") continue;
    const answer = normalizeAnswer(question, raw);
    if (answer) answers[name] = answer;
  }
  return answers;
}

/** Extract the first balanced JSON object, tolerating prose and fences. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeAnswer(question: JudgeQuestionIR, raw: Record<string, unknown>): JudgeAnswer | null {
  if (question.type === "noul") {
    const probability = clamp01(toNumber(raw.probability ?? raw.noul ?? raw.confidence));
    if (probability === null) return null;
    return { type: "noul", noul: probability };
  }
  if (question.type === "choice") {
    const confidence = clamp01(toNumber(raw.confidence)) ?? 0.5;
    const rawChoice = typeof raw.choice === "string" ? raw.choice : String(raw.choice ?? "");
    const matched = matchOption(rawChoice, Object.keys(question.criteria));
    if (!matched) {
      // Unmatched answer: pass through with heavily discounted confidence;
      // callers normalize unknown values to their safe defaults.
      return { type: "choice", choice: rawChoice, confidence: confidence * 0.3 };
    }
    return {
      type: "choice",
      choice: matched.label,
      confidence: matched.exact ? confidence : confidence * 0.6,
    };
  }
  const score = toNumber(raw.score);
  if (score === null) return null;
  return {
    type: "score",
    score: Math.min(Math.max(score, 0), question.criteria.length - 1),
    confidence: clamp01(toNumber(raw.confidence)) ?? 0.5,
  };
}

/** Fuzzy-match a model-produced choice against the declared option labels. */
function matchOption(raw: string, labels: string[]): { label: string; exact: boolean } | null {
  const trimmed = raw.trim();
  for (const label of labels) if (label === trimmed) return { label, exact: true };
  const lower = trimmed.toLowerCase();
  for (const label of labels) if (label.toLowerCase() === lower) return { label, exact: false };
  for (const label of labels) {
    const l = label.toLowerCase();
    if (l.includes(lower) || lower.includes(l)) return { label, exact: false };
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(1, Math.max(0, value));
}

// ── Transport helpers ───────────────────────────────────────────────────

export function composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  return AbortSignal.any([caller, timeout]);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function classifyHttpStatus(status: number): JudgeErrorType {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 404) return "unavailable";
  if (status >= 500) return "unavailable";
  return "unknown";
}
