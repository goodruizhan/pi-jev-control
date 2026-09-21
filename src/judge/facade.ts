/**
 * Judgment facade — the single entry point every module calls.
 * Routes each request through the configured backend chain
 * (module override → default → fallback) and records stats.
 *
 * Migration note: this replaces the old src/jev/client.ts callJev().
 */

import type { JudgeOutcome, JudgeRequestInput } from "./backend.js";
import type { JudgeQuestions } from "./ir.js";
import { resolveBackend, resolveFallback, allConfiguredBackends } from "./registry.js";
import { recordRequest, recordFailure, recordBackendUsage } from "../stats/stats.js";
import { loadConfig } from "../config.js";
import { appendEvalRecord } from "./eval.js";

export interface JudgeCallContext {
  /** Module name for stats and per-module backend overrides. */
  module: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Run a judgment request. Never throws.
 *
 * When the primary backend fails with a potentially backend-specific error
 * (unavailable/auth/quota/timeout), the configured fallback backend gets one
 * attempt. Aborts propagate immediately without fallback.
 */
export async function judge(
  state: Record<string, unknown>,
  questions: JudgeQuestions,
  options: JudgeCallContext,
): Promise<JudgeOutcome> {
  const primary = resolveBackend(options.module);
  const request: JudgeRequestInput = { state, questions };

  if (!primary.isAvailable()) {
    const fallback = resolveFallback(primary);
    if (fallback?.isAvailable()) {
      return runAndRecord(fallback, request, options);
    }
    // No stats recorded for skipped calls (same policy as the old client).
    return {
      ok: false,
      errorType: "unavailable",
      error: primary.unavailableReason() ?? "judgment backend unavailable",
      latencyMs: 0,
      backend: primary.name,
    };
  }

  const outcome = await runAndRecord(primary, request, options);
  if (outcome.ok || outcome.errorType === "aborted") return outcome;

  const fallback = resolveFallback(primary);
  if (fallback && fallback.isAvailable()) {
    return runAndRecord(fallback, request, options);
  }
  return outcome;
}

async function runAndRecord(
  backend: ReturnType<typeof resolveBackend>,
  request: JudgeRequestInput,
  options: JudgeCallContext,
): Promise<JudgeOutcome> {
  const rawOutcome = await backend.judge(request, { timeoutMs: options.timeoutMs, signal: options.signal });
  const validationError = rawOutcome.ok ? validateJudgeAnswers(request.questions, rawOutcome.answers) : null;
  const outcome: JudgeOutcome = validationError
    ? {
        ok: false,
        errorType: "unknown",
        error: `invalid judgment response: ${validationError}`,
        latencyMs: rawOutcome.latencyMs,
        backend: rawOutcome.backend,
      }
    : rawOutcome;
  recordBackendUsage(backend.name, outcome.ok);
  if (outcome.ok) {
    recordRequest(options.module, outcome.usage, outcome.latencyMs);
    const recordPath = loadConfig().judgment.eval?.recordPath;
    if (recordPath) {
      appendEvalRecord(recordPath, {
        ts: Date.now(),
        module: options.module,
        backend: backend.name,
        model: outcome.model,
        confidenceKind: outcome.confidenceKind,
        state: request.state ?? {},
        questions: request.questions,
        answers: outcome.answers ?? {},
        latencyMs: outcome.latencyMs,
      });
    }
  } else if (outcome.errorType !== "aborted") {
    recordFailure(options.module);
  }
  return outcome;
}

/** Validate the backend-neutral answer contract before module code consumes it. */
export function validateJudgeAnswers(questions: JudgeQuestions, answers: Record<string, unknown>): string | null {
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer || typeof answer !== "object") return `missing answer for ${name}`;
    const value = answer as Record<string, unknown>;
    if (value.type !== question.type) return `${name} has type ${String(value.type)}, expected ${question.type}`;

    if (question.type === "noul") {
      if (!isUnitNumber(value.noul)) return `${name}.noul must be a finite number in [0, 1]`;
      continue;
    }

    if (!isUnitNumber(value.confidence)) return `${name}.confidence must be a finite number in [0, 1]`;
    if (question.type === "choice") {
      if (typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice)) {
        return `${name}.choice is not one of the declared criteria`;
      }
      continue;
    }

    const maxScore = question.criteria.length - 1;
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > maxScore) {
      return `${name}.score must be a finite number in [0, ${maxScore}]`;
    }
  }
  return null;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Whether a model backend in the module's chain can serve requests. */
export function isJudgeAvailable(module?: string): boolean {
  const primary = resolveBackend(module ?? "");
  if (primary.confidenceKind !== "binary" && primary.isAvailable()) return true;
  const fallback = resolveFallback(primary);
  return fallback?.confidenceKind !== "binary" && fallback?.isAvailable() === true;
}

/** Human-readable reason when no model backend can serve the module. */
export function getJudgeUnavailableReason(module?: string): string | null {
  if (isJudgeAvailable(module)) return null;
  const reasons = allConfiguredBackends()
    .filter((backend) => backend.confidenceKind !== "binary")
    .map((backend) => `${backend.name}: ${backend.unavailableReason() ?? "ok"}`)
    .join("; ");
  return reasons || "no judgment backend configured";
}
