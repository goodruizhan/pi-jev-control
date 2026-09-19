import type { SavingsStats } from "../types.js";
import { tr } from "../i18n.js";
import { jevStats } from "./stats.js";

/**
 * Savings Stats — estimated savings from Jev control layer.
 *
 * All values are ESTIMATED, not actual API billing.
 * These help users understand the impact of the control layer.
 */

/** Singleton savings stats */
export const savingsStats: SavingsStats = {
  contextEventsProcessed: 0,
  pruningPlansGenerated: 0,
  pruningPlansSkipped: 0,
  contextCandidatesInspected: 0,
  contextCandidatesRejected: 0,
  toolResultCharsPruned: 0,
  toolResultCharsTruncated: 0,
  memoryRecordsCreated: 0,
  retriesPrevented: 0,
  modelTierDecisions: 0,
  benignFailuresSkipped: 0,
  approvalCacheHits: 0,
  toolGateBlocks: 0,
  decisionCacheHits: 0,
  decisionBudgetSkips: 0,
  guiCacheHits: 0,
  guiRiskDeferrals: 0,
  estimatedContextTokensSaved: 0,
};

export function recordContextEvent(): void { savingsStats.contextEventsProcessed += 1; }
export function recordPruningPlanGenerated(): void { savingsStats.pruningPlansGenerated += 1; }
export function recordPruningPlanSkipped(): void { savingsStats.pruningPlansSkipped += 1; }
export function recordBenignFailureSkipped(): void { savingsStats.benignFailuresSkipped += 1; }
export function recordApprovalCacheHit(): void { savingsStats.approvalCacheHits += 1; }
export function recordToolGateBlock(): void { savingsStats.toolGateBlocks += 1; }
export function recordDecisionCacheHit(): void { savingsStats.decisionCacheHits += 1; }
export function recordDecisionBudgetSkip(): void { savingsStats.decisionBudgetSkips += 1; }
export function recordGUICacheHit(): void { savingsStats.guiCacheHits += 1; }
export function recordGUIRiskDeferral(): void { savingsStats.guiRiskDeferrals += 1; }

/**
 * Record that a context candidate was inspected.
 */
export function recordContextInspected(count: number): void {
  savingsStats.contextCandidatesInspected += count;
}

/**
 * Record that context candidates were rejected.
 */
export function recordContextRejected(count: number): void {
  savingsStats.contextCandidatesRejected += count;
}

/**
 * Record chars pruned (dropped).
 */
export function recordCharsPruned(chars: number): void {
  savingsStats.toolResultCharsPruned += chars;
}

/**
 * Record chars truncated.
 */
export function recordCharsTruncated(chars: number): void {
  savingsStats.toolResultCharsTruncated += chars;
}

/**
 * Record a memory record created.
 */
export function recordMemoryCreated(): void {
  savingsStats.memoryRecordsCreated += 1;
}

/**
 * Record a prevented retry.
 */
export function recordRetryPrevented(): void {
  savingsStats.retriesPrevented += 1;
}

/**
 * Record a model tier decision.
 */
export function recordModelTierDecision(): void {
  savingsStats.modelTierDecisions += 1;
}

/**
 * Record estimated context tokens saved.
 * Rough estimate: 1 token ≈ 4 chars
 */
export function recordTokensSaved(charsSaved: number): void {
  savingsStats.estimatedContextTokensSaved += Math.round(charsSaved / 4);
}

/**
 * Reset all savings stats.
 */
export function resetSavings(): void {
  savingsStats.contextEventsProcessed = 0;
  savingsStats.pruningPlansGenerated = 0;
  savingsStats.pruningPlansSkipped = 0;
  savingsStats.contextCandidatesInspected = 0;
  savingsStats.contextCandidatesRejected = 0;
  savingsStats.toolResultCharsPruned = 0;
  savingsStats.toolResultCharsTruncated = 0;
  savingsStats.memoryRecordsCreated = 0;
  savingsStats.retriesPrevented = 0;
  savingsStats.modelTierDecisions = 0;
  savingsStats.benignFailuresSkipped = 0;
  savingsStats.approvalCacheHits = 0;
  savingsStats.toolGateBlocks = 0;
  savingsStats.decisionCacheHits = 0;
  savingsStats.decisionBudgetSkips = 0;
  savingsStats.guiCacheHits = 0;
  savingsStats.guiRiskDeferrals = 0;
  savingsStats.estimatedContextTokensSaved = 0;
}

/**
 * Format savings stats for display.
 */
export function formatSavings(): string {
  const jevTokensSpent = jevStats.inputTokens + jevStats.outputTokens;
  const netEstimatedTokensSaved = savingsStats.estimatedContextTokensSaved - jevTokensSpent;
  return tr(
    [
      `Savings Estimates (NOT actual API billing)`,
      `─────────────────────────────────────────`,
      `Context Events Processed: ${savingsStats.contextEventsProcessed}`,
      `Pruning Plans: ${savingsStats.pruningPlansGenerated} generated, ${savingsStats.pruningPlansSkipped} skipped locally`,
      `Context Candidates Inspected: ${savingsStats.contextCandidatesInspected}`,
      `Context Candidates Rejected: ${savingsStats.contextCandidatesRejected}`,
      `Tool Result Chars Pruned: ${savingsStats.toolResultCharsPruned}`,
      `Tool Result Chars Truncated: ${savingsStats.toolResultCharsTruncated}`,
      `Memory Records Created: ${savingsStats.memoryRecordsCreated}`,
      `Retries Prevented: ${savingsStats.retriesPrevented}`,
      `Model Tier Decisions: ${savingsStats.modelTierDecisions}`,
      `Benign Failures Skipped Locally: ${savingsStats.benignFailuresSkipped}`,
      `Approval Cache Hits: ${savingsStats.approvalCacheHits}`,
      `Tool Gate Blocks: ${savingsStats.toolGateBlocks}`,
      `Decision Cache Hits: ${savingsStats.decisionCacheHits}`,
      `Decision Budget Skips: ${savingsStats.decisionBudgetSkips}`,
      `GUI Cache Hits: ${savingsStats.guiCacheHits}`,
      `High-risk GUI Actions Deferred: ${savingsStats.guiRiskDeferrals}`,
      `Actual Context Chars Removed: ${savingsStats.toolResultCharsPruned + savingsStats.toolResultCharsTruncated}`,
      `Est. Context Tokens Saved: ${savingsStats.estimatedContextTokensSaved}`,
      `Jev Tokens Spent: ${jevTokensSpent}`,
      `Net Est. Tokens Saved: ${netEstimatedTokensSaved}`,
      `Jev Latency Added: ${jevStats.totalLatencyMs}ms`,
    ].join("\n"),
    [
      `节省量估算（并非实际 API 计费）`,
      `────────────────────────────`,
      `已处理上下文事件：${savingsStats.contextEventsProcessed}`,
      `裁剪计划：已生成 ${savingsStats.pruningPlansGenerated}，本地跳过 ${savingsStats.pruningPlansSkipped}`,
      `已检查上下文候选：${savingsStats.contextCandidatesInspected}`,
      `已排除上下文候选：${savingsStats.contextCandidatesRejected}`,
      `已裁剪工具结果字符：${savingsStats.toolResultCharsPruned}`,
      `已截断工具结果字符：${savingsStats.toolResultCharsTruncated}`,
      `已创建记忆记录：${savingsStats.memoryRecordsCreated}`,
      `已阻止重复重试：${savingsStats.retriesPrevented}`,
      `模型等级决策：${savingsStats.modelTierDecisions}`,
      `本地跳过的良性失败：${savingsStats.benignFailuresSkipped}`,
      `授权缓存命中：${savingsStats.approvalCacheHits}`,
      `工具门控拦截：${savingsStats.toolGateBlocks}`,
      `决策缓存命中：${savingsStats.decisionCacheHits}`,
      `决策预算跳过：${savingsStats.decisionBudgetSkips}`,
      `GUI 缓存命中：${savingsStats.guiCacheHits}`,
      `已暂缓高风险 GUI 操作：${savingsStats.guiRiskDeferrals}`,
      `实际移除上下文字符：${savingsStats.toolResultCharsPruned + savingsStats.toolResultCharsTruncated}`,
      `预计节省上下文 Token：${savingsStats.estimatedContextTokensSaved}`,
      `Jev 消耗 Token：${jevTokensSpent}`,
      `预计净节省 Token：${netEstimatedTokensSaved}`,
      `Jev 累计增加延迟：${jevStats.totalLatencyMs} 毫秒`,
    ].join("\n"),
  );
}
