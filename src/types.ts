/** Shared type definitions for pi-jev-control */

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
  action?: string;
  result?: string;
  reason?: string;
  retryCount?: number;
  toolName?: string;
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
  reviewRequests: number;
  guiRequests: number;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface JevControlConfig {
  enabled: boolean;
  language: "en" | "zh-CN";
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
    confirmOnLowConfidence: boolean;
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
    relevanceThreshold: number;
  };
  agentRouter: {
    enabled: boolean;
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
  reviewGate: {
    enabled: boolean;
  };
  guiRouter: {
    enabled: boolean;
    confidenceThreshold: number;
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

// ── v0.3 Pruning ──────────────────────────────────────────────────────

export type PruningDecision = "KEEP_RAW" | "TRUNCATE" | "DROP";

export interface PiMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  id?: string;
  details?: Record<string, unknown>;
  usage?: { input_tokens: number; output_tokens: number };
  [key: string]: unknown;
}

export interface ToolGroup {
  callEntry: PiMessage;
  resultEntries: PiMessage[];
  toolName: string;
  inputSummary: string;
  resultSummary: string;
  isError: boolean;
  groupId: string;
  messageIndices: number[];
  charsBefore: number;
  charsAfter: number; // estimated chars after TRUNCATE
}

export interface PruningPlan {
  epochId: string;
  createdAtTurn: number;
  keepIds: Set<string>;
  truncateIds: Set<string>;
  dropIds: Set<string>;
  estimatedCharsBefore: number;
  estimatedCharsAfter: number;
}

// ── v0.3 Review ───────────────────────────────────────────────────────

export type ReviewDecision = "skip" | "normal_review" | "strong_review";

// ── v0.3 GUI Action ──────────────────────────────────────────────────

export interface UIActionCandidate {
  id: string;
  label?: string;
  role?: string;
  description?: string;
}

// ── v0.3 Savings Stats ───────────────────────────────────────────────

export interface SavingsStats {
  contextCandidatesInspected: number;
  contextCandidatesRejected: number;
  toolResultCharsPruned: number;
  toolResultCharsTruncated: number;
  memoryRecordsCreated: number;
  retriesPrevented: number;
  modelTierDecisions: number;
  estimatedContextTokensSaved: number;
}

// ── Dangerous bash patterns ───────────────────────────────────────────

export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i,
  /(?:^|[;&|]\s*)git\s+reset\s+--hard\b/i,
  /(?:^|[;&|]\s*)git\s+clean\s+-[a-zA-Z]*[df]/i,
  /(?:^|[;&|]\s*)git\s+checkout\s+--\s+\./i,
  /(?:^|[;&|]\s*)git\s+restore\s+\./i,
  /(?:^|[;&|]\s*)sudo\b/i,
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+publish\b/i,
  /(?:^|[;&|]\s*)Remove-Item\b[^\r\n;&|]*(?:-Recurse|-Force)/i,
  /(?:^|[;&|]\s*)del\s+\/s/i,
  /(?:^|[;&|]\s*)rmdir\s+\/s/i,
  /(?:^|[;&|]\s*)format\b/i,
  /(?:^|[;&|]\s*)diskpart\b/i,
  /(?:^|\s)find\b[^\r\n;&|]*(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint)\b/i,
];
