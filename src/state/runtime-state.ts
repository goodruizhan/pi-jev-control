import type { RuntimeState, FailureRecord } from "../types.js";

const MAX_FAILURE_RECORDS = 50;

/** Singleton runtime state — shared across all modules */
export const runtimeState: RuntimeState = {
  recentFailures: [],
  approvedActionKeys: new Set<string>(),
};

/**
 * Add a failure record. If same signature exists, increment count.
 */
export function recordFailure(record: Omit<FailureRecord, "count" | "firstTimestamp" | "lastTimestamp">): void {
  const existing = runtimeState.recentFailures.find(
    (f) => f.signature === record.signature,
  );

  if (existing) {
    existing.count += 1;
    existing.lastTimestamp = Date.now();
    existing.failureType = record.failureType;
    existing.recommendedAction = record.recommendedAction;
  } else {
    const now = Date.now();
    runtimeState.recentFailures.push({
      ...record,
      count: 1,
      firstTimestamp: now,
      lastTimestamp: now,
    });

    // Trim to MAX_FAILURE_RECORDS
    if (runtimeState.recentFailures.length > MAX_FAILURE_RECORDS) {
      runtimeState.recentFailures = runtimeState.recentFailures.slice(-MAX_FAILURE_RECORDS);
    }
  }
}

/**
 * Get the failure record matching a signature, if any.
 */
export function findFailureBySignature(signature: string): FailureRecord | undefined {
  return runtimeState.recentFailures.find((f) => f.signature === signature);
}

/**
 * Get failure count for a given tool + normalized input signature.
 */
export function getFailureCountBySignature(signature: string): number {
  return runtimeState.recentFailures.find((f) => f.signature === signature)?.count ?? 0;
}

/**
 * Get the total failure count for a given tool + input prefix.
 * Used for pre-call repeated failure check (before we know the error).
 */
export function getFailureCountByInput(toolName: string, inputSummary: string): number {
  const normalizedInput = inputSummary.toLowerCase().trim().replace(/\s+/g, " ");
  let totalCount = 0;
  for (const f of runtimeState.recentFailures) {
    if (f.toolName === toolName) {
      // Check if the input summary matches (first 200 chars)
      const fInput = f.inputSummary.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
      const checkInput = normalizedInput.slice(0, 200);
      if (fInput.startsWith(checkInput) || checkInput.startsWith(fInput)) {
        totalCount += f.count;
      }
    }
  }
  return totalCount;
}

/** Count failures for the same normalized action (for example write + path). */
export function getFailureCountByActionKey(actionKey: string): number {
  return runtimeState.recentFailures
    .filter((failure) => failure.actionKey === actionKey)
    .reduce((total, failure) => total + failure.count, 0);
}

/** Count failures in the same tool/command family within the current session. */
export function getFailureCountByFamily(toolName: string, commandCategory: string): number {
  return runtimeState.recentFailures
    .filter((failure) => failure.toolName === toolName && failure.commandCategory === commandCategory)
    .reduce((total, failure) => total + failure.count, 0);
}

export function approveAction(actionKey: string): void {
  runtimeState.approvedActionKeys.add(actionKey);
}

export function isActionApproved(actionKey: string): boolean {
  return runtimeState.approvedActionKeys.has(actionKey);
}

export function clearApprovedActions(): void {
  runtimeState.approvedActionKeys.clear();
}

/**
 * Reset all runtime state.
 */
export function resetState(): void {
  runtimeState.lastTaskTier = undefined;
  runtimeState.lastTaskConfidence = undefined;
  runtimeState.lastJevModel = undefined;
  runtimeState.lastDecision = undefined;
  runtimeState.recentFailures = [];
  runtimeState.approvedActionKeys.clear();
}
