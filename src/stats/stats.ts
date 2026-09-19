import type { JevStats } from "../types.js";

/** Singleton stats — shared across all modules */
export const jevStats: JevStats = {
  requests: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalLatencyMs: 0,
  routerRequests: 0,
  toolGateRequests: 0,
  failureJudgeRequests: 0,
  contextGateRequests: 0,
  skillGateRequests: 0,
  memoryGateRequests: 0,
  compactionRequests: 0,
};

/**
 * Record a successful Jev request.
 */
export function recordRequest(module: string, inputTokens: number, outputTokens: number, latencyMs: number): void {
  jevStats.requests += 1;
  jevStats.inputTokens += inputTokens;
  jevStats.outputTokens += outputTokens;
  jevStats.totalLatencyMs += latencyMs;

  switch (module) {
    case "router":
      jevStats.routerRequests += 1;
      break;
    case "toolGate":
      jevStats.toolGateRequests += 1;
      break;
    case "failureJudge":
      jevStats.failureJudgeRequests += 1;
      break;
    case "contextGate":
      jevStats.contextGateRequests += 1;
      break;
    case "skillGate":
      jevStats.skillGateRequests += 1;
      break;
    case "memoryGate":
      jevStats.memoryGateRequests += 1;
      break;
    case "compaction":
      jevStats.compactionRequests += 1;
      break;
  }
}

/**
 * Record a Jev API failure.
 */
export function recordFailure(): void {
  jevStats.failures += 1;
}

/**
 * Reset all stats.
 */
export function resetStats(): void {
  jevStats.requests = 0;
  jevStats.failures = 0;
  jevStats.inputTokens = 0;
  jevStats.outputTokens = 0;
  jevStats.totalLatencyMs = 0;
  jevStats.routerRequests = 0;
  jevStats.toolGateRequests = 0;
  jevStats.failureJudgeRequests = 0;
  jevStats.contextGateRequests = 0;
  jevStats.skillGateRequests = 0;
  jevStats.memoryGateRequests = 0;
  jevStats.compactionRequests = 0;
}

/**
 * Format stats for display.
 */
export function formatStats(): string {
  const avgLatency = jevStats.requests > 0
    ? (jevStats.totalLatencyMs / jevStats.requests).toFixed(0)
    : "0";
  const totalTokens = jevStats.inputTokens + jevStats.outputTokens;

  return [
    `Jev API Usage`,
    `  Requests: ${jevStats.requests} (failures: ${jevStats.failures})`,
    `  Tokens: ${totalTokens} (in: ${jevStats.inputTokens}, out: ${jevStats.outputTokens})`,
    `  Avg latency: ${avgLatency}ms`,
    `  Router: ${jevStats.routerRequests} calls`,
    `  Tool Gate: ${jevStats.toolGateRequests} calls`,
    `  Failure Judge: ${jevStats.failureJudgeRequests} calls`,
    `  Context Gate: ${jevStats.contextGateRequests} calls`,
    `  Skill Gate: ${jevStats.skillGateRequests} calls`,
    `  Memory Gate: ${jevStats.memoryGateRequests} calls`,
    `  Compaction: ${jevStats.compactionRequests} calls`,
  ].join("\n");
}
