import { TypeSafeClient, type RequestOptions, type SystemOneResult, type EntryType } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { loadConfig } from "../config.js";
import { recordRequest, recordFailure } from "../stats/stats.js";

/**
 * Jev Client — unified wrapper around TypeSafe SDK.
 * - Creates a single client instance
 * - Handles missing API key gracefully (unavailable mode)
 * - Unified timeout, AbortSignal, retry
 * - Unified stats tracking
 * - Never throws to caller — always returns a result or null
 */

interface JevClientOptions {
  /** Module name for stats tracking */
  module: "router" | "toolGate" | "failureJudge" | "contextGate" | "skillGate" | "memoryGate" | "compaction";
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Override timeout in ms */
  timeoutMs?: number;
}

type JevResult<Q extends Questions> = {
  ok: true;
  result: SystemOneResult<Q>;
  latencyMs: number;
};

type JevError = {
  ok: false;
  error: string;
  errorType: "unavailable" | "timeout" | "api" | "abort" | "unknown";
};

let client: TypeSafeClient | null = null;
let unavailableReason: string | null = null;

/**
 * Check if Jev API is available.
 * Tries to create the client once; if TYPESAFE_API_KEY is missing, marks as unavailable.
 */
export function isJevAvailable(): boolean {
  if (unavailableReason) return false;
  if (client) return true;

  // Try to create client — this will throw if API key is missing
  try {
    const config = loadConfig();
    client = new TypeSafeClient({
      defaultModel: config.jev.model,
      timeout: config.jev.timeoutMs,
      logLevel: "error",
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Check if this is an API key issue
    if (msg.includes("API key") || msg.includes("TYPESAFE_API_KEY") || msg.includes("apiKey")) {
      unavailableReason = "TYPESAFE_API_KEY not set";
    } else {
      // Other client init error — still unavailable
      unavailableReason = msg;
    }
    return false;
  }
}

/**
 * Get the unavailable reason, or null if available.
 */
export function getUnavailableReason(): string | null {
  return unavailableReason;
}

/**
 * Call Jev System One.
 * Returns { ok: true, result, latencyMs } on success.
 * Returns { ok: false, error, errorType } on any failure.
 * NEVER throws — all errors are caught and returned.
 */
export async function callJev<Q extends Questions>(
  state: EntryType,
  questions: Q,
  options: JevClientOptions,
): Promise<JevResult<Q> | JevError> {
  // Check availability first
  if (!isJevAvailable()) {
    return {
      ok: false,
      error: unavailableReason ?? "Jev API unavailable",
      errorType: "unavailable",
    };
  }

  const config = loadConfig();
  const timeoutMs = options.timeoutMs ?? config.jev.timeoutMs;

  // Merge AbortSignal with timeout
  const signal = options.signal;
  const reqOptions: RequestOptions = {
    timeout: timeoutMs,
    signal: signal,
    // Disable retry for fast-fail (we handle our own retry logic in retry-judge)
    retry: { maxRetries: 0 },
  };

  const startTime = Date.now();

  try {
    const c = client!;
    const result = await c.systemOne(
      {
        state,
        questions,
        model: config.jev.model,
      },
      reqOptions,
    );

    const latencyMs = Date.now() - startTime;
    recordRequest(options.module, result.usage.input_tokens, result.usage.output_tokens, latencyMs);

    return { ok: true, result, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startTime;
    recordFailure();

    // Determine error type
    let errorType: JevError["errorType"];
    let errorMessage: string;

    if (e instanceof Error) {
      errorMessage = e.message;

      // Check for abort
      if (signal?.aborted || e.name === "APIUserAbortError") {
        errorType = "abort";
      }
      // Check for timeout
      else if (e.name === "APITimeoutError") {
        errorType = "timeout";
      }
      // Check for API errors
      else if (e.name === "APIError" || e.name === "APIConnectionError" || e.name === "TypeSafeError") {
        errorType = "api";
      }
      else {
        errorType = "unknown";
      }
    } else {
      errorMessage = String(e);
      errorType = "unknown";
    }

    return {
      ok: false,
      error: errorMessage,
      errorType,
    };
  }
}

/**
 * Reset client (for testing or config reload).
 */
export function resetClient(): void {
  client = null;
  unavailableReason = null;
}
