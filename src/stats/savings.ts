import type { SavingsStats } from "../types.js";

/**
 * Savings Stats — estimated savings from Jev control layer.
 *
 * All values are ESTIMATED, not actual API billing.
 * These help users understand the impact of the control layer.
 */

/** Singleton savings stats */
export const savingsStats: SavingsStats = {
  contextCandidatesInspected: 0,
  contextCandidatesRejected: 0,
  toolResultCharsPruned: 0,
  toolResultCharsTruncated: 0,
  memoryRecordsCreated: 0,
  retriesPrevented: 0,
  modelTierDecisions: 0,
  estimatedContextTokensSaved: 0,
};

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
  savingsStats.contextCandidatesInspected = 0;
  savingsStats.contextCandidatesRejected = 0;
  savingsStats.toolResultCharsPruned = 0;
  savingsStats.toolResultCharsTruncated = 0;
  savingsStats.memoryRecordsCreated = 0;
  savingsStats.retriesPrevented = 0;
  savingsStats.modelTierDecisions = 0;
  savingsStats.estimatedContextTokensSaved = 0;
}

/**
 * Format savings stats for display.
 */
export function formatSavings(): string {
  return [
    `Savings Estimates (NOT actual API billing)`,
    `─────────────────────────────────────────`,
    `Context Candidates Inspected: ${savingsStats.contextCandidatesInspected}`,
    `Context Candidates Rejected: ${savingsStats.contextCandidatesRejected}`,
    `Tool Result Chars Pruned: ${savingsStats.toolResultCharsPruned}`,
    `Tool Result Chars Truncated: ${savingsStats.toolResultCharsTruncated}`,
    `Memory Records Created: ${savingsStats.memoryRecordsCreated}`,
    `Retries Prevented: ${savingsStats.retriesPrevented}`,
    `Model Tier Decisions: ${savingsStats.modelTierDecisions}`,
    `Est. Context Tokens Saved: ${savingsStats.estimatedContextTokensSaved}`,
  ].join("\n");
}
