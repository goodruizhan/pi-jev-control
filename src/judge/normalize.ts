import crypto from "node:crypto";

/**
 * Result normalization utilities for Jev responses.
 */

import type { TaskTier, FailureType, RecommendedAction, RouterResult, ToolGateDecision, AgentType, MemoryType, ReviewDecision } from "../types.js";

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

/** Multi-word variants that Jev or a model tends to emit but that are not valid labels. */
const FAILURE_TYPE_ALIASES: Record<string, FailureType> = {
  rate_limit: "rate_limited",
  rate_limited_error: "rate_limited",
  network_error: "network",
  network_failure: "network",
  network_unavailable: "network",
  connection_error: "network",
  connection_refused: "network",
  timeout_error: "timeout",
  request_timeout: "timeout",
  auth_error: "authentication",
  auth_failed: "authentication",
  authentication_error: "authentication",
  permission_denied: "permission",
  access_denied: "permission",
  invalid_input_error: "invalid_input",
  repeated_failure: "repeated",
};

/**
 * Normalize a Jev choice to a valid FailureType.
 */
export function normalizeFailureType(choice: string): FailureType {
  const lower = choice.toLowerCase().trim().replace(/\s+/g, "_");
  const valid: FailureType[] = [
    "transient", "cancelled", "timeout", "network", "rate_limited",
    "authentication", "not_found", "conflict", "code_error",
    "configuration", "permission", "environment", "invalid_input",
    "repeated", "unknown",
  ];
  if (valid.includes(lower as FailureType)) return lower as FailureType;
  const aliased = FAILURE_TYPE_ALIASES[lower];
  if (aliased) return aliased;
  // Last resort: "network error" is not a label, but its first word still
  // identifies the class. Collapsing these to "unknown" throws away information
  // the caller already supplied, and the classifier then cannot learn anything.
  const first = lower.split("_")[0];
  return valid.includes(first as FailureType) ? (first as FailureType) : "unknown";
}

/**
 * Normalize a Jev choice to a valid RecommendedAction.
 */
export function normalizeRecommendedAction(choice: string): RecommendedAction {
  const lower = choice.toLowerCase().trim().replace(/\s+/g, "_");
  const valid: RecommendedAction[] = [
    "retry_once", "retry_with_backoff", "repair_then_retry", "change_input",
    "install_dependency", "request_permission", "inspect_logs", "do_not_retry",
    "escalate", "ask_user", "unknown",
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
 * Normalize a Jev choice to a valid AgentType.
 */
export function normalizeAgentType(choice: string): AgentType {
  const lower = choice.toLowerCase().trim();
  if (lower === "scout" || lower === "coder" || lower === "reviewer" || lower === "unknown") {
    return lower as AgentType;
  }
  return "unknown";
}

/**
 * Normalize a Jev choice to a valid MemoryType.
 */
export function normalizeMemoryType(choice: string): MemoryType {
  const lower = choice.toLowerCase().trim();
  const valid: MemoryType[] = ["fact", "decision", "failure", "constraint", "none"];
  return valid.includes(lower as MemoryType) ? (lower as MemoryType) : "none";
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

/** Stable fingerprint for a tool action, shared by runtime and persistent memory. */
export function generateActionFingerprint(toolName: string, inputSummary: string): string {
  const combined = `${toolName.toLowerCase().trim()}|${normalizeText(inputSummary)}`;
  return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Normalize text for hashing: lowercase, trim, collapse whitespace.
 */
function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Normalize a Jev choice to a valid ReviewDecision.
 */
export function normalizeReviewDecision(choice: string): ReviewDecision {
  const lower = choice.toLowerCase().trim().replace(/\s+/g, "_");
  if (lower === "skip" || lower === "normal_review" || lower === "strong_review") {
    return lower as ReviewDecision;
  }
  return "normal_review"; // default to normal review for unknown decisions
}

/**
 * Normalize a Jev choice to a UI action candidate ID.
 * Returns "unknown" if no valid match found.
 */
export function normalizeUIActionChoice(choice: string, candidateIds: string[]): string {
  const lower = choice.toLowerCase().trim();
  if (!lower || lower === "unknown" || lower === "none") return "unknown";
  for (const id of candidateIds) {
    if (id.toLowerCase() === lower) return id;
  }
  // Try partial match
  for (const id of candidateIds) {
    if (id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase())) return id;
  }
  return "unknown";
}
