import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { PiMessage, PruningPlan } from "../types.js";
import { loadConfig } from "../config.js";
import { buildToolGroups, buildPruningPlan, applyPruning } from "./pruner.js";
import {
  advanceTurn,
  consumeSkipNextGeneration,
  getEpochPlan,
  setEpochPlan,
  shouldGeneratePlan,
  touchEpoch,
} from "./epoch.js";
import { checkCacheGate } from "./cache-aware.js";
import { readAllFailures } from "../memory/store.js";
import { recordCharsPruned, recordCharsTruncated, recordTokensSaved } from "../stats/savings.js";

/**
 * Context Hook — intercepts the context event to prune old tool output.
 *
 * NEVER modifies the on-disk Pi session.
 * Only modifies the messages view sent to the LLM for this request.
 *
 * Flow:
 * 1. If compaction is disabled, pass through
 * 2. If no epoch plan exists, generate one (with cache-aware gate)
 * 3. Apply the plan to filter messages
 * 4. Return the filtered messages
 */

export function setupContextHook(pi: ExtensionAPI): void {
  pi.on("turn_start", () => {
    advanceTurn();
  });

  (pi as any).on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    const config = loadConfig();

    // If compaction is disabled, pass through
    if (!config.compaction.enabled) return;

    const messages = event.messages as unknown as PiMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return;
    if (consumeSkipNextGeneration()) return;

    const existingPlan = getEpochPlan();
    const needsPlan = shouldGeneratePlan(config.compaction.minTurnsBetweenPlans);

    if (existingPlan && !needsPlan) {
      touchEpoch();
      return applyPlanIfUseful(messages, existingPlan);
    }

    if (needsPlan) {
      try {
        const plan = await buildPruningPlan(messages, ctx.signal);
        const gateResult = checkCacheGate(plan);

        if (!gateResult.shouldPrune) {
          // Keep a still-valid older plan if the replacement has too little benefit.
          return existingPlan ? applyPlanIfUseful(messages, existingPlan) : undefined;
        }

        setEpochPlan(plan);
        return applyPlanIfUseful(messages, plan);
      } catch (e) {
        console.warn("[pi-jev-control] Context pruning failed:", e instanceof Error ? e.message : String(e));
        return existingPlan ? applyPlanIfUseful(messages, existingPlan) : undefined;
      }
    }

    // Default: pass through unchanged
    return;
  });
}

function applyPlanIfUseful(messages: PiMessage[], plan: PruningPlan): { messages: PiMessage[] } | undefined {
  const groups = buildToolGroups(messages).groups;
  const filtered = applyPruning(messages, plan, groups);
  const before = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  const after = filtered.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  const saved = Math.max(0, before - after);
  if (saved === 0) return undefined;

  let pruned = 0;
  let truncated = 0;
  for (const group of groups) {
    if (plan.dropIds.has(group.groupId)) pruned += group.charsBefore;
    if (plan.truncateIds.has(group.groupId)) truncated += Math.max(0, group.charsBefore - group.charsAfter);
  }
  recordCharsPruned(pruned);
  recordCharsTruncated(truncated);
  recordTokensSaved(saved);
  return { messages: filtered };
}

/**
 * Setup session_before_compact handler.
 *
 * Before Pi compacts the session, verify and report unresolved failure records.
 * Does NOT block Pi's native compaction.
 */
export function setupSessionBeforeCompact(pi: ExtensionAPI): void {
  (pi as any).on("session_before_compact", async (_event: SessionBeforeCompactEvent, _ctx: ExtensionContext) => {
    const config = loadConfig();
    if (!config.enabled || !config.memoryGate.enabled) return;

    // Verify unresolved records before compaction.
    try {
      ensureMemoryBeforeCompact();
    } catch (e) {
      // Never block Pi compaction
      console.warn("[pi-jev-control] Session-before-compact memory sync failed:", e instanceof Error ? e.message : String(e));
    }

    // Do NOT block Pi's native compaction
    // Just return (no return value = allow compaction)
  });
}

/**
 * Report unresolved failure records before Pi compacts the session.
 */
function ensureMemoryBeforeCompact(): void {
  const failures = readAllFailures();
  const unresolvedFailures = failures.filter((f) => !f.resolved);

  if (unresolvedFailures.length > 0) {
    console.log(`[pi-jev-control] Found ${unresolvedFailures.length} unresolved failure record(s) before native compaction`);
  }

  // Don't block compaction — Pi's native summary will handle the rest
}
