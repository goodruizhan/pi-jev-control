import type { PruningPlan } from "../types.js";
/**
 * Epoch Management — cross-turn pruning plan reuse.
 *
 * Core principle: don't re-decide different pruning sets every turn.
 * Once a plan is generated, reuse it for subsequent turns until:
 * 1. minTurnsBetweenPlans turns pass since last plan
 * 2. New tool output exceeds threshold
 * 3. User manually triggers /jev compact plan
 */

interface EpochState {
  plan: PruningPlan | null;
  createdAtTurn: number;
  lastUsedTurn: number;
  currentTurn: number;
  forceRegeneration: boolean;
  skipNextGeneration: boolean;
}

/** Singleton epoch state — shared across all context events */
const epochState: EpochState = {
  plan: null,
  createdAtTurn: 0,
  lastUsedTurn: 0,
  currentTurn: 0,
  forceRegeneration: false,
  skipNextGeneration: false,
};

/**
 * Get the current epoch plan.
 */
export function getEpochPlan(): PruningPlan | null {
  return epochState.plan;
}

/**
 * Set a new epoch plan.
 */
export function setEpochPlan(plan: PruningPlan): void {
  plan.createdAtTurn = epochState.currentTurn;
  epochState.plan = plan;
  epochState.createdAtTurn = epochState.currentTurn;
  epochState.lastUsedTurn = epochState.currentTurn;
  epochState.forceRegeneration = false;
  epochState.skipNextGeneration = false;
}

/**
 * Clear the current epoch plan.
 * Next turn will use the full unpruned messages view.
 */
export function clearEpochPlan(): void {
  epochState.plan = null;
  epochState.createdAtTurn = 0;
  epochState.lastUsedTurn = 0;
  epochState.forceRegeneration = false;
  epochState.skipNextGeneration = true;
}

/** Force a fresh plan on the next context event. */
export function requestEpochPlan(): void {
  epochState.plan = null;
  epochState.forceRegeneration = true;
  epochState.skipNextGeneration = false;
}

/** Count actual Pi turns, rather than approximating turns with wall-clock minutes. */
export function advanceTurn(): void {
  epochState.currentTurn += 1;
}

export function getCurrentTurn(): number {
  return epochState.currentTurn;
}

/**
 * True when someone asked for a new plan that has not been generated yet.
 * In non-auto compaction modes this is the only signal that lets the context hook
 * build a plan, so pruning can never happen without an explicit request.
 */
export function hasPendingGeneration(): boolean {
  return epochState.forceRegeneration;
}

/** Clear deliberately restores one full-history request before planning again. */
export function consumeSkipNextGeneration(): boolean {
  if (!epochState.skipNextGeneration) return false;
  epochState.skipNextGeneration = false;
  return true;
}

/**
 * Update the last used turn timestamp.
 */
export function touchEpoch(): void {
  epochState.lastUsedTurn = epochState.currentTurn;
}

/**
 * Check if a new plan should be generated.
 * Returns true if we should generate a new pruning plan.
 */
export function shouldGeneratePlan(minTurnsBetweenPlans: number): boolean {
  if (epochState.forceRegeneration) return true;
  if (!epochState.plan) return true;
  return epochState.currentTurn - epochState.createdAtTurn >= minTurnsBetweenPlans;
}

/**
 * Get epoch info for display.
 */
export function getEpochInfo(): {
  hasPlan: boolean;
  planAge: number;
  epochId: string | null;
  estimatedSavedChars: number;
} {
  if (!epochState.plan) {
    return { hasPlan: false, planAge: 0, epochId: null, estimatedSavedChars: 0 };
  }

  const age = epochState.currentTurn - epochState.createdAtTurn;
  return {
    hasPlan: true,
    planAge: age,
    epochId: epochState.plan.epochId,
    estimatedSavedChars: epochState.plan.estimatedCharsBefore - epochState.plan.estimatedCharsAfter,
  };
}

/**
 * Reset all epoch state.
 */
export function resetEpoch(): void {
  epochState.plan = null;
  epochState.createdAtTurn = 0;
  epochState.lastUsedTurn = 0;
  epochState.currentTurn = 0;
  epochState.forceRegeneration = false;
  epochState.skipNextGeneration = false;
}
