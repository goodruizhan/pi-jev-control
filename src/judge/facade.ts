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
  const outcome = await backend.judge(request, { timeoutMs: options.timeoutMs, signal: options.signal });
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

/**
 * Whether any backend in the module's chain can serve requests right now.
 */
export function isJudgeAvailable(module?: string): boolean {
  const primary = resolveBackend(module ?? "");
  if (primary.isAvailable()) return true;
  return resolveFallback(primary)?.isAvailable() ?? false;
}

/** Human-readable reason when no backend can serve the module. */
export function getJudgeUnavailableReason(module?: string): string | null {
  if (isJudgeAvailable(module)) return null;
  const reasons = allConfiguredBackends()
    .map((backend) => `${backend.name}: ${backend.unavailableReason() ?? "ok"}`)
    .join("; ");
  return reasons || "no judgment backend configured";
}
