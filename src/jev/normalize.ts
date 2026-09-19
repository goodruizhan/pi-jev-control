import crypto from "node:crypto";

/**
 * Result normalization utilities for Jev responses.
 */

import type { TaskTier, FailureType, RecommendedAction, RouterResult, ToolGateDecision } from "../types.js";

/**
 * Normalize a Jev choice to a valid TaskTier.
 * Returns "unknown" if the choice is not a recognized tier.
 */
export function normalizeTaskTier(choice: string): TaskTier {
  const lower = choice.toLowerCase().trim();
  if (lower === "cheap" || lower === "medium" || lower === "strong" || lower === "unknown") {
    return lower as TaskTier;
  }
  return "unknown";
}

/**
 * Normalize a Jev choice to a valid FailureType.
 */
export function normalizeFailureType(choice: string): FailureType {
  const lower = choice.toLowerCase().trim().replace(/\s+/g, "_");
  const valid: FailureType[] = [
    "transient", "code_error", "configuration", "permission",
    "environment", "invalid_input", "repeated", "unknown",
  ];
  return valid.includes(lower as FailureType) ? (lower as FailureType) : "unknown";
}

/**
 * Normalize a Jev choice to a valid RecommendedAction.
 */
export function normalizeRecommendedAction(choice: string): RecommendedAction {
  const lower = choice.toLowerCase().trim().replace(/\s+/g, "_");
  const valid: RecommendedAction[] = [
    "retry_once", "repair_then_retry", "do_not_retry", "escalate", "ask_user", "unknown",
  ];
  return valid.includes(lower as RecommendedAction) ? (lower as RecommendedAction) : "unknown";
}

/**
 * Normalize a Jev choice to a valid ToolGateDecision.
 */
export function normalizeToolGateDecision(choice: string): ToolGateDecision {
  const lower = choice.toLowerCase().trim();
  if (lower === "allow" || lower === "confirm" || lower === "deny") {
    return lower as ToolGateDecision;
  }
  return "confirm"; // default to confirm for unknown decisions
}

/**
 * Build a RouterResult from Jev response.
 */
export function buildRouterResult(choice: string, confidence: number, latencyMs: number, model: string): RouterResult {
  return {
    tier: normalizeTaskTier(choice),
    confidence,
    rawChoice: choice,
    rawConfidence: confidence,
    latencyMs,
    timestamp: Date.now(),
  };
}

/**
 * Generate a deterministic signature for failure deduplication.
 * SHA-256 of: toolName + normalized input + normalized first error lines.
 */
export function generateFailureSignature(toolName: string, inputSummary: string, errorExcerpt: string): string {
  // Normalize: lowercase, trim, collapse whitespace
  const normalizedInput = normalizeText(inputSummary);
  const normalizedError = normalizeText(errorExcerpt);

  // Take first 200 chars of error for signature (more robust)
  const errorFirst = normalizedError.slice(0, 200);

  const combined = `${toolName}|${normalizedInput}|${errorFirst}`;
  return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Normalize text for hashing: lowercase, trim, collapse whitespace.
 */
function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}
