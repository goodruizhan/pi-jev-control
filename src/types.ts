/** Shared type definitions for pi-dev-control */

// ── Task Tiers ──────────────────────────────────────────────────────────

export type TaskTier = "cheap" | "medium" | "strong" | "unknown";

// ── Tool Gate Decision ──────────────────────────────────────────────────

export type ToolGateDecision = "allow" | "confirm" | "deny";

// ── Agent Types ───────────────────────────────────────────────────────

export type AgentType = "scout" | "coder" | "reviewer" | "unknown";

// ── Memory Types ──────────────────────────────────────────────────────

export type MemoryType = "fact" | "decision" | "failure" | "constraint" | "none";

export interface MemoryRecord {
  id: string;
  timestamp: number;
  projectHash: string;
  type: Exclude<MemoryType, "none">;
  summary: string;
  rawExcerpt?: string;
  confidence: number;
  source: "user" | "tool_result" | "agent";
  fingerprint: string;
  resolved?: boolean;
}

// ── Failure Classification ─────────────────────────────────────────────

export type FailureType =
  | "transient"
  | "code_error"
  | "configuration"
  | "permission"
  | "environment"
  | "invalid_input"
  | "repeated"
  | "unknown";

export type RecommendedAction =
  | "retry_once"
  | "repair_then_retry"
  | "do_not_retry"
  | "escalate"
  | "ask_user"
  | "unknown";

// ── Router Result ───────────────────────────────────────────────────────

export interface RouterResult {
  tier: TaskTier;
  confidence: number;
  rawChoice: string;
  rawConfidence: number;
  latencyMs: number;
  timestamp: number;
}

// ── Failure Record ──────────────────────────────────────────────────────

export interface FailureRecord {
  signature: string;
  toolName: string;
  inputSummary: string;
  errorExcerpt: string;
  failureType: FailureType;
  recommendedAction: RecommendedAction;
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

// ── Runtime State ───────────────────────────────────────────────────────

export interface RuntimeState {
  lastTaskTier?: TaskTier;
  lastTaskConfidence?: number;
  lastJevModel?: string;
  lastDecision?: {
    type: string;
    value: string;
    confidence?: number;
    timestamp: number;
  };
  recentFailures: FailureRecord[];
}

// ── Jev Stats ───────────────────────────────────────────────────────────

export interface JevStats {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
  routerRequests: number;
  toolGateRequests: number;
  failureJudgeRequests: number;
  contextGateRequests: number;
  skillGateRequests: number;
  memoryGateRequests: number;
  compactionRequests: number;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface JevControlConfig {
  enabled: boolean;
  jev: {
    model: string;
    timeoutMs: number;
  };
  router: {
    enabled: boolean;
    confidenceThreshold: number;
    fallbackTier: TaskTier;
    mode: "set-model" | "tier-only";
    models: {
      cheap: ModelSpec;
      medium: ModelSpec;
      strong: ModelSpec;
    };
  };
  toolGate: {
    enabled: boolean;
    useDeterministicFastPath: boolean;
  };
  retryJudge: {
    enabled: boolean;
    maxSameFailureRetries: number;
  };
  contextGate: {
    enabled: boolean;
    maxCandidates: number;
    maxSelected: number;
    relevanceThreshold: number;
  };
  skillGate: {
    enabled: boolean;
    maxSelected: number;
  };
  memoryGate: {
    enabled: boolean;
  };
  compaction: {
    enabled: boolean;
    preserveRecentMessages: number;
    minCharsToSave: number;
    minTurnsBetweenPlans: number;
  };
}

export interface ModelSpec {
  provider: string;
  model: string;
}

// ── Short confirmation phrases (not routed) ─────────────────────────────

export const SHORT_CONFIRMATIONS: Set<string> = new Set([
  "继续",
  "好的",
  "可以",
  "是",
  "否",
  "ok",
  "yes",
  "go",
  "继续做",
  "下一步",
  "继续吧",
  "继续执行",
  "下一步吧",
]);

// ── Safe readonly tools ─────────────────────────────────────────────────

export const SAFE_READONLY_TOOLS: Set<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
]);

// ── Safe bash commands (prefix-based) ───────────────────────────────────

export const SAFE_BASH_COMMANDS: string[] = [
  "pwd",
  "git status",
  "git diff",
  "git log",
  "rg",
  "grep",
  "find",
  "ls",
];

// ── Dangerous bash patterns ─────────────────────────────────────────────

export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /^git\s+reset\s+--hard\b/,
  /^git\s+clean\s+-[a-zA-Z]*[df]/,
  /^git\s+checkout\s+--\s+\./,
  /^git\s+restore\s+\./,
  /^sudo\b/,
  /^npm\s+publish\b/,
  /^pnpm\s+publish\b/,
  /^yarn\s+publish\b/,
  /^Remove-Item\s+(-[a-zA-Z]*[rf])/i,
  /^del\s+\/s/i,
  /^rmdir\s+\/s/i,
  /^format\b/i,
  /^diskpart\b/i,
];
