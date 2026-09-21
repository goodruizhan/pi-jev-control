import type { JevStats } from "../types.js";
import { tr } from "../i18n.js";

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
  reviewRequests: 0,
  guiRequests: 0,
  decisionRequests: 0,
  backendUsage: {},
};

/**
 * Record a successful Jev request.
 */
export function recordRequest(module: string, usage: { input_tokens: number; output_tokens: number }, latencyMs: number): void {
  jevStats.requests += 1;
  jevStats.inputTokens += usage.input_tokens;
  jevStats.outputTokens += usage.output_tokens;
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
    case "review":
      jevStats.reviewRequests += 1;
      break;
    case "gui":
      jevStats.guiRequests += 1;
      break;
    case "decision":
      jevStats.decisionRequests += 1;
      break;
  }
}

/**
 * Record a judgment request failure.
 */
export function recordFailure(_module?: string): void {
  jevStats.failures += 1;
}

/**
 * Record per-backend usage (which judgment model actually served requests).
 */
export function recordBackendUsage(backendName: string, ok: boolean): void {
  const entry = jevStats.backendUsage[backendName] ?? { requests: 0, failures: 0 };
  entry.requests += 1;
  if (!ok) entry.failures += 1;
  jevStats.backendUsage[backendName] = entry;
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
  jevStats.reviewRequests = 0;
  jevStats.guiRequests = 0;
  jevStats.decisionRequests = 0;
  jevStats.backendUsage = {};
}

/**
 * Format stats for display.
 */
export function formatStats(): string {
  const avgLatency = jevStats.requests > 0
    ? (jevStats.totalLatencyMs / jevStats.requests).toFixed(0)
    : "0";
  const totalTokens = jevStats.inputTokens + jevStats.outputTokens;

  return tr(
    [
      `Judgment Backend Usage`,
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
      `  Review Gate: ${jevStats.reviewRequests} calls`,
      `  GUI Action Router: ${jevStats.guiRequests} calls`,
      `  Decision Copilot: ${jevStats.decisionRequests} calls`,
      `  Backends: ${formatBackendUsage()}`,
    ].join("\n"),
    [
      `判断后端使用情况`,
      `  请求：${jevStats.requests}（失败：${jevStats.failures}）`,
      `  Token：${totalTokens}（输入：${jevStats.inputTokens}，输出：${jevStats.outputTokens}）`,
      `  平均延迟：${avgLatency} 毫秒`,
      `  任务路由：${jevStats.routerRequests} 次`,
      `  工具门控：${jevStats.toolGateRequests} 次`,
      `  失败判断：${jevStats.failureJudgeRequests} 次`,
      `  上下文门控：${jevStats.contextGateRequests} 次`,
      `  技能门控：${jevStats.skillGateRequests} 次`,
      `  记忆门控：${jevStats.memoryGateRequests} 次`,
      `  上下文压缩：${jevStats.compactionRequests} 次`,
      `  审查门控：${jevStats.reviewRequests} 次`,
      `  GUI 操作路由：${jevStats.guiRequests} 次`,
      `  决策副驾驶：${jevStats.decisionRequests} 次`,
      `  后端：${formatBackendUsage()}`,
    ].join("\n"),
  );
}

function formatBackendUsage(): string {
  const entries = Object.entries(jevStats.backendUsage);
  if (entries.length === 0) return "-";
  return entries.map(([name, usage]) => `${name} ${usage.requests}${usage.failures > 0 ? ` (${usage.failures} failed)` : ""}`).join(", ");
}
