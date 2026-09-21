/**
 * Embedding similarity backend — zero-shot judgment via an embeddings
 * endpoint (Ollama /v1/embeddings, vLLM, or any OpenAI-compatible
 * embeddings API). No chat model involved: each question becomes a
 * query text, each option/anchor becomes a candidate text, and cosine
 * similarity picks the answer.
 *
 * Confidence semantics: "similarity" — probabilities come from a softmax
 * over cosine similarities, not from a calibrated model. They only say
 * "how much closer is the winner than the rest". Callers should keep
 * thresholds conservative.
 *
 * Candidate texts (option labels/descriptions) are static across calls,
 * so their embeddings are cached in-memory; each judge() call embeds
 * only the fresh query texts in a single batched HTTP request.
 */

import type { JudgmentBackend, JudgeCallOptions, JudgeOutcome, JudgeRequestInput } from "./backend.js";
import type { EntryValue, JudgeAnswer, JudgeAnswers, JudgeQuestionIR } from "./ir.js";
import { classifyHttpStatus, composeSignal, isAbortError } from "./openai-backend.js";

export interface EmbeddingBackendOptions {
  name: string;
  /** API root, e.g. http://localhost:11434/v1 (Ollama default). */
  baseUrl?: string;
  /** Env var holding the API key. Optional — local servers often need none. */
  apiKeyEnv?: string;
  /** Embedding model, e.g. nomic-embed-text. Required. */
  model?: string;
  timeoutMs?: number;
  /**
   * Softmax temperature over cosine similarities. Embedding sims live in a
   * narrow band (~0.4-0.8); a small temperature turns small gaps into
   * meaningful probability spread. Default 0.025.
   */
  temperature?: number;
}

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_TEMPERATURE = 0.025;
const CACHE_LIMIT = 512;

interface EmbeddingsPayload {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class EmbeddingBackend implements JudgmentBackend {
  readonly name: string;
  readonly confidenceKind = "similarity" as const;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string | null;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly reason: string | null = null;
  /** Candidate-text embedding cache; queries are never cached. */
  private readonly cache = new Map<string, number[]>();

  constructor(options: EmbeddingBackendOptions) {
    this.name = options.name;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const configuredTemperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.temperature = Number.isFinite(configuredTemperature) && configuredTemperature > 0
      ? configuredTemperature
      : DEFAULT_TEMPERATURE;

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
    if (!this.isAvailable() || !this.model) {
      return { ok: false, errorType: "unavailable", error: this.reason ?? "backend unavailable", latencyMs: 0, backend: this.name };
    }
    if (!request || typeof request !== "object" || !request.questions || typeof request.questions !== "object") {
      return { ok: false, errorType: "unknown", error: "malformed judge request: missing questions", latencyMs: 0, backend: this.name };
    }

    // Build query + candidate texts for every question up front so one
    // batched HTTP call embeds everything not already cached.
    const stateText = safeJson(request.state);
    const plans: QuestionPlan[] = [];
    for (const [name, question] of Object.entries(request.questions)) {
      plans.push(buildPlan(name, question, stateText));
    }

    const pendingTexts: string[] = [];
    const pendingKeys: string[] = [];
    const queryTexts: string[] = [];
    for (const plan of plans) {
      queryTexts.push(plan.query);
      for (const candidate of plan.candidates) {
        const key = this.cacheKey(candidate);
        if (!this.cache.has(key) && !pendingKeys.includes(key)) {
          pendingKeys.push(key);
          pendingTexts.push(candidate);
        }
      }
    }

    const signal = composeSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
    try {
      const allTexts = [...queryTexts, ...pendingTexts];
      const { vectors, promptTokens } = await this.embed(allTexts, signal);
      if (vectors.length !== allTexts.length) {
        return {
          ok: false,
          errorType: "unknown",
          error: `embedding count mismatch: got ${vectors.length}, expected ${allTexts.length}`,
          latencyMs: Date.now() - startTime,
          backend: this.name,
        };
      }
      const dimension = vectors[0]?.length ?? 0;
      if (dimension === 0 || vectors.some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))) {
        return {
          ok: false,
          errorType: "unknown",
          error: "invalid embedding vectors: empty, non-finite, or inconsistent dimensions",
          latencyMs: Date.now() - startTime,
          backend: this.name,
        };
      }

      const queryVectors = vectors.slice(0, queryTexts.length);
      vectors.slice(queryTexts.length).forEach((vector, index) => {
        this.cacheSet(pendingKeys[index], vector);
      });

      const answers: JudgeAnswers = {};
      plans.forEach((plan, index) => {
        const queryVector = queryVectors[index];
        const candidateVectors = plan.candidates.map((candidate) => this.cache.get(this.cacheKey(candidate)));
        if (candidateVectors.some((vector) => !vector)) return; // defensive; embed() covered every candidate
        const similarities = (candidateVectors as number[][]).map((vector) => cosine(queryVector, vector));
        const answer = plan.toAnswer(similarities, this.temperature);
        if (answer) answers[plan.name] = answer;
      });

      return {
        ok: true,
        answers,
        model: this.model,
        usage: { input_tokens: promptTokens ?? estimateTokens(allTexts), output_tokens: 0 },
        latencyMs: Date.now() - startTime,
        backend: this.name,
        confidenceKind: this.confidenceKind,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      if (isAbortError(err)) {
        return { ok: false, errorType: options.signal?.aborted ? "aborted" : "timeout", error: "timed out", latencyMs, backend: this.name };
      }
      if (err instanceof HttpError) {
        return { ok: false, errorType: classifyHttpStatus(err.status), error: `HTTP ${err.status}`, latencyMs, backend: this.name };
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

  private async embed(texts: string[], signal: AbortSignal | undefined): Promise<{ vectors: number[][]; promptTokens: number | null }> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal,
    });
    if (!response.ok) throw new HttpError(response.status);
    const payload = (await response.json()) as EmbeddingsPayload;
    const rows = payload.data ?? [];
    // OpenAI-style responses carry an index per row; sort defensively.
    const ordered = rows.some((row) => typeof row.index === "number")
      ? [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : rows;
    const vectors = ordered.map((row) => row.embedding ?? []);
    return { vectors, promptTokens: payload.usage?.prompt_tokens ?? payload.usage?.total_tokens ?? null };
  }

  private cacheKey(text: string): string {
    return `${this.model}${text}`;
  }

  private cacheSet(key: string, vector: number[]): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, vector);
  }
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

// ── Question planning ───────────────────────────────────────────────────

interface QuestionPlan {
  name: string;
  query: string;
  candidates: string[];
  toAnswer(similarities: number[], temperature: number): JudgeAnswer | null;
}

function buildPlan(name: string, question: JudgeQuestionIR, stateText: string): QuestionPlan {
  const instructions = flatten(question.instructions ?? "");
  const query = `${instructions}\n${stateText}`;

  if (question.type === "choice") {
    const entries = Object.entries(question.criteria ?? {});
    const labels = entries.map(([label]) => label);
    const candidates = entries.map(([label, desc]) => {
      const text = flatten(desc ?? "");
      return text ? `${label}: ${text}` : label;
    });
    return {
      name,
      query,
      candidates,
      toAnswer(similarities, temperature) {
        if (labels.length === 0) return null;
        const probabilities = softmax(similarities, temperature);
        const best = argmax(probabilities);
        const probabilitiesByLabel: Record<string, number> = {};
        labels.forEach((label, index) => {
          probabilitiesByLabel[label] = probabilities[index];
        });
        return { type: "choice", choice: labels[best], confidence: probabilities[best], probabilities: probabilitiesByLabel };
      },
    };
  }

  if (question.type === "noul") {
    const trueAnchor = flatten(question.criteria?.true ?? "") || "yes";
    const falseAnchor = flatten(question.criteria?.false ?? "") || "no";
    return {
      name,
      query,
      candidates: [trueAnchor, falseAnchor],
      toAnswer(similarities, temperature) {
        const [yes] = softmax(similarities, temperature);
        return { type: "noul", noul: yes };
      },
    };
  }

  // score: rubric entries, index = score value
  const rubric = question.criteria ?? [];
  return {
    name,
    query,
    candidates: rubric.map((entry, index) => {
      const text = flatten(entry ?? "");
      return text ? `${index}: ${text}` : `level ${index}`;
    }),
    toAnswer(similarities, temperature) {
      if (rubric.length === 0) return null;
      const probabilities = softmax(similarities, temperature);
      const best = argmax(probabilities);
      const probabilitiesByIndex: Record<string, number> = {};
      probabilities.forEach((probability, index) => {
        probabilitiesByIndex[String(index)] = probability;
      });
      return { type: "score", score: best, confidence: probabilities[best], probabilities: probabilitiesByIndex };
    },
  };
}

// ── Math helpers ────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function softmax(values: number[], temperature: number): number[] {
  if (values.length === 0) return [];
  const scaled = values.map((value) => value / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) best = i;
  }
  return best;
}

function flatten(value: EntryValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

/** Rough token estimate when the endpoint reports no usage (~4 chars/token). */
function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((total, text) => total + text.length, 0) / 4);
}
