import type { PruningPlan } from "../types.js";
import { loadConfig } from "../config.js";

/**
 * Cache-aware Gate — conservative heuristic to decide if pruning is worth it.
 *
 * Rules: only generate a new pruning plan if ALL conditions are met:
 * 1. Estimated chars saved >= minCharsToSave (default 8000)
 * 2. Drop ratio >= 15%
 * 3. Epoch scheduling separately enforces minTurnsBetweenPlans
 *
 * Rationale: if we can only save a few hundred chars, it's not worth
 * changing the prompt prefix every turn (would reduce cache hits).
 */

export interface CacheGateResult {
  shouldPrune: boolean;
  reason: string;
  estimatedCharsBefore: number;
  estimatedCharsAfter: number;
  charsSaved: number;
  dropRatio: number;
}

/**
 * Check if a pruning plan is worth applying based on cache-aware heuristics.
 */
export function checkCacheGate(plan: PruningPlan): CacheGateResult {
  const config = loadConfig();
  const minCharsToSave = config.compaction.minCharsToSave;
  const dropRatio = plan.estimatedCharsBefore > 0
    ? (plan.estimatedCharsBefore - plan.estimatedCharsAfter) / plan.estimatedCharsBefore
    : 0;
  const charsSaved = plan.estimatedCharsBefore - plan.estimatedCharsAfter;

  // Condition 1: chars saved threshold
  if (charsSaved < minCharsToSave) {
    return {
      shouldPrune: false,
      reason: `chars saved (${charsSaved}) < minCharsToSave (${minCharsToSave})`,
      estimatedCharsBefore: plan.estimatedCharsBefore,
      estimatedCharsAfter: plan.estimatedCharsAfter,
      charsSaved,
      dropRatio,
    };
  }

  // Condition 2: drop ratio threshold
  if (dropRatio < 0.15) {
    return {
      shouldPrune: false,
      reason: `drop ratio (${(dropRatio * 100).toFixed(1)}%) < 15%`,
      estimatedCharsBefore: plan.estimatedCharsBefore,
      estimatedCharsAfter: plan.estimatedCharsAfter,
      charsSaved,
      dropRatio,
    };
  }

  return {
    shouldPrune: true,
    reason: `OK: saved ${charsSaved} chars, drop ratio ${(dropRatio * 100).toFixed(1)}%`,
    estimatedCharsBefore: plan.estimatedCharsBefore,
    estimatedCharsAfter: plan.estimatedCharsAfter,
    charsSaved,
    dropRatio,
  };
}
