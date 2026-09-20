/**
 * Judgment backend contract — any fast "System One style" judgment model
 * (TypeSafe Jev, Jev-compatible API clones, small local models) plugs in
 * by implementing this interface.
 *
 * Implementations must NEVER throw from judge(); all failures are reported
 * as { ok: false, errorType } so callers can fall back deterministically.
 */

import type { JudgeAnswers, JudgeQuestions, JudgeUsage } from "./ir.js";

export type JudgeErrorType = "auth" | "quota" | "timeout" | "unavailable" | "aborted" | "unknown";

/**
 * What a backend's confidence/probability numbers actually mean.
 * Callers should treat self-reported confidence with more skepticism than
 * calibrated probabilities — e.g. by raising thresholds.
 */
export type ConfidenceKind =
  /** Native, calibrated probabilities from a purpose-built judgment model. */
  | "calibrated"
  /** Model-reported confidence (e.g. a small LLM asked to output JSON). */
  | "self-reported"
  /** Derived from embedding/reranker similarity scores. */
  | "similarity"
  /** Hard rule outcome — 0 or 1, no real confidence semantics. */
  | "binary";

export interface JudgeRequestInput {
  state: Record<string, unknown>;
  questions: JudgeQuestions;
  /** Model override; backends fall back to their configured default. */
  model?: string;
}

export interface JudgeCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type JudgeOutcome =
  | {
      ok: true;
      answers: JudgeAnswers;
      model: string;
      usage: JudgeUsage;
      latencyMs: number;
      /** Name of the backend that produced this outcome. */
      backend: string;
      confidenceKind: ConfidenceKind;
    }
  | {
      ok: false;
      errorType: JudgeErrorType;
      error: string;
      latencyMs: number;
      backend: string;
    };

export interface JudgmentBackend {
  /** Stable backend name, e.g. "typesafe", "ollama-qwen3b". */
  readonly name: string;
  readonly confidenceKind: ConfidenceKind;
  isAvailable(): boolean;
  unavailableReason(): string | null;
  judge(request: JudgeRequestInput, options: JudgeCallOptions): Promise<JudgeOutcome>;
}
