/**
 * TypeSafe API backend — Jev and any Jev-compatible System One endpoint.
 *
 * This is the ONLY file in the project that imports @typesafe-ai/sdk.
 * A Jev-compatible clone (same POST /v1/systemone wire format) plugs in by
 * pointing baseUrl/apiKeyEnv/model at the clone — no code changes needed.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { JudgmentBackend, JudgeCallOptions, JudgeErrorType, JudgeOutcome, JudgeRequestInput } from "./backend.js";
import type { JudgeAnswers } from "./ir.js";

export interface TypeSafeBackendOptions {
  name: string;
  /** Env var holding the API key; defaults to TYPESAFE_API_KEY. */
  apiKeyEnv?: string;
  /** API root override — point at a Jev-compatible clone to replace Jev. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 4000;

export class TypeSafeBackend implements JudgmentBackend {
  readonly name: string;
  readonly confidenceKind = "calibrated" as const;

  private client: TypeSafeClient | null = null;
  private available = false;
  private reason: string | null = null;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: TypeSafeBackendOptions) {
    this.name = options.name;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const keyEnv = options.apiKeyEnv ?? "TYPESAFE_API_KEY";
    const apiKey = process.env[keyEnv];
    if (!apiKey) {
      this.reason = `${keyEnv} not set`;
      return;
    }
    try {
      this.client = new TypeSafeClient({
        apiKey,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        defaultModel: this.model,
      });
      this.available = true;
    } catch (err) {
      this.reason = `init failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  unavailableReason(): string | null {
    return this.available ? null : this.reason;
  }

  async judge(request: JudgeRequestInput, options: JudgeCallOptions): Promise<JudgeOutcome> {
    const startTime = Date.now();
    if (!this.available || !this.client) {
      return {
        ok: false,
        errorType: "unavailable",
        error: this.reason ?? "backend unavailable",
        latencyMs: 0,
        backend: this.name,
      };
    }

    try {
      // The IR is structurally identical to the SDK's question format.
      const result: SystemOneResult<Questions> = await this.client.systemOne(
        {
          state: request.state as EntryType,
          questions: request.questions as Questions,
          model: request.model ?? this.model,
        },
        {
          timeout: options.timeoutMs ?? this.timeoutMs,
          signal: options.signal,
          // Disable SDK retry for fast-fail; the retry-judge module owns retry policy.
          retry: { maxRetries: 0 },
        },
      );

      return {
        ok: true,
        answers: result.answers as JudgeAnswers,
        model: result.model,
        usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
        latencyMs: Date.now() - startTime,
        backend: this.name,
        confidenceKind: this.confidenceKind,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, errorType: "aborted", error: "aborted", latencyMs, backend: this.name };
      }
      return {
        ok: false,
        errorType: classifyError(err),
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
        backend: this.name,
      };
    }
  }
}

/**
 * Classify SDK errors into actionable categories.
 * auth   → bad/missing API key, do not retry
 * quota  → rate limit or billing, retry after backoff
 * timeout/unavailable → transient, retry may help
 */
function classifyError(err: unknown): JudgeErrorType {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "APITimeoutError" || err.name === "APIConnectionTimeoutError") return "timeout";
  if (err.name === "APIConnectionError") return "unavailable";
  if (err.name === "AuthenticationError" || err.name === "PermissionDeniedError") return "auth";
  if (err.name === "RateLimitError") return "quota";
  const msg = err.message.toLowerCase();
  if (msg.includes("quota") || msg.includes("billing") || msg.includes("insufficient")) return "quota";
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")) return "auth";
  return "unknown";
}
