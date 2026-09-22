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
  | "cancelled"
  | "timeout"
  | "network"
  | "rate_limited"
  | "authentication"
  | "not_found"
  | "conflict"
  | "code_error"
  | "configuration"
  | "permission"
  | "environment"
  | "invalid_input"
  | "repeated"
  | "unknown";

export type RecommendedAction =
  | "retry_once"
  | "retry_with_backoff"
  | "repair_then_retry"
  | "change_input"
  | "install_dependency"
  | "request_permission"
  | "inspect_logs"
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
  source?: "judge" | "override" | "fallback" | "risk-floor";
  reason?: string;
  backend?: string;
  riskFeatures?: string[];
  judgeModel?: string;
  confidenceKind?: string;
  probabilities?: Record<string, number>;
}

export interface RouteAudit {
  requestId: number;
  taskFingerprint?: string;
  startedAt?: number;
  timestamp: number;
  source: string;
  rawChoice: string;
  rawConfidence: number;
  requestedTier: TaskTier;
  effectiveTier?: TaskTier;
  provider?: string;
  model?: string;
  thinking?: string;
  candidateIndex?: number;
  success: boolean;
  reason?: string;
  backend?: string;
  judgeModel?: string;
  confidenceKind?: string;
  probabilities?: Record<string, number>;
  latencyMs: number;
  riskFeatures: string[];
}

// ── Failure Record ──────────────────────────────────────────────────────

export interface FailureRecord {
  signature: string;
  actionKey: string;
  commandCategory: string;
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
  lastRouteAudit?: RouteAudit;
  routeAudits: RouteAudit[];
  recentFailures: FailureRecord[];
  approvedActionKeys: Set<string>;
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
  decisionRequests: number;
  /** Per-backend usage, keyed by backend name. */
  backendUsage: Record<string, { requests: number; failures: number }>;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface JevControlConfig {
  enabled: boolean;
  language: "en" | "zh-CN";
  ui: {
    notifications: "errors-only" | "important" | "all";
  };
  /** @deprecated Legacy Jev settings — mapped into judgment.backends.typesafe. Kept for backward compatibility. */
  jev: {
    model: string;
    timeoutMs: number;
  };
  /**
   * Judgment backend configuration — which fast judgment model serves the
   * decision layer. Default backend is "typesafe" (Jev); other backends can
   * replace it or serve specific modules via judgment.modules.
   */
  judgment: JudgmentConfig;
  router: {
    enabled: boolean;
    confidenceThreshold: number;
    fallbackTier: TaskTier;
    routerFailureTier: "medium" | "strong";
    cheapConfidenceThreshold: number;
    /**
     * Who decides the task tier, and whether that decision switches the model.
     *
     * - "rules-only" (default) — no Jev inference. Tiers come only from explicit user
     *   overrides (`[strong]` inline or `/jev route`) and the model's own
     *   `jev_request_model_tier` calls. Deterministic risk features act as a floor.
     *   Nothing switches the model behind its back.
     * - "advisory" (alias: "tier-only") — Jev infers the tier, and the verdict is
     *   recorded + announced as information only. The model is never switched.
     * - "set-model" — legacy: Jev infers the tier and the model is switched.
     * - "off" — routing disabled entirely.
     */
    mode: "rules-only" | "advisory" | "set-model" | "tier-only" | "off";
    models: {
      cheap: ModelRouteSpec;
      medium: ModelRouteSpec;
      strong: ModelRouteSpec;
    };
  };
  toolGate: {
    enabled: boolean;
    mode: "advisory" | "enforce";
    useDeterministicFastPath: boolean;
    confirmOnLowConfidence: boolean;
    reuseApprovedWrites: boolean;
    blockOnRememberedFailure: boolean;
  };
  retryJudge: {
    enabled: boolean;
    maxSameFailureRetries: number;
    timeoutMs: number;
    skipBenignExitCodes: boolean;
    /** Append the assessment block to failed tool results. Set false to keep
     *  failure memory + retry judgment while leaving tool output untouched. */
    appendToResult: boolean;
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
    /**
     * Who decides that pruning should happen.
     * - "off" (default) — the context hook only applies a plan that the model asked
     *   for (`jev_prune_context`) or the user requested (`/jev compact plan`). It
     *   never prunes on its own.
     * - "suggest" — as "off", but announces when the tool-output budget has grown
     *   large enough that pruning would pay off. Still no automatic pruning.
     * - "auto" — legacy: the hook decides and prunes by itself.
     */
    autoMode: "off" | "suggest" | "auto";
  };
  reviewGate: {
    enabled: boolean;
  };
  guiRouter: {
    enabled: boolean;
    confidenceThreshold: number;
    timeoutMs: number;
    cacheTurns: number;
  };
  decisionCopilot: {
    enabled: boolean;
    silent: boolean;
    maxCallsPerTurn: number;
    maxQuestionsPerCall: number;
    timeoutMs: number;
    confidenceThreshold: number;
    cacheTurns: number;
  };
}

export type RouterThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  provider: string;
  model: string;
  /** Optional Pi thinking level applied after this model is selected. */
  thinking?: RouterThinkingLevel;
}

/** A single legacy target or an ordered list of preferred targets. */
export type ModelRouteSpec = ModelSpec | ModelSpec[];

// ── Judgment backend configuration ──────────────────────────────────────

export type JudgmentBackendType = "typesafe-api" | "openai-compatible" | "embedding" | "rules";

export interface JudgmentBackendConfig {
  type: JudgmentBackendType;
  /** Env var holding the API key (never store keys in the config file). */
  apiKeyEnv?: string;
  /** API root override — point typesafe-api at a Jev-compatible clone. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** embedding backends only: softmax temperature over cosine similarities. */
  temperature?: number;
}

export interface JudgmentEvalConfig {
  /**
   * When set, every successful judgment is appended to this JSONL file
   * (state + questions + answers + latency), so `npm run eval` can replay
   * real traffic against other backends and compare quality.
   */
  recordPath?: string;
}

export interface JudgmentConfig {
  /** Name of the default backend. */
  backend: string;
  /** Fallback tried when the default backend fails; null disables the default. */
  fallback?: string | null;
  /** Per-module backend overrides, keyed by module name (router, toolGate, ...). */
  modules?: Record<string, string>;
  backends: Record<string, JudgmentBackendConfig>;
  /** Backend evaluation: record live judgments for offline comparison. */
  eval?: JudgmentEvalConfig;
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
  contextEventsProcessed: number;
  pruningPlansGenerated: number;
  pruningPlansSkipped: number;
  contextCandidatesInspected: number;
  contextCandidatesRejected: number;
  toolResultCharsPruned: number;
  toolResultCharsTruncated: number;
  memoryRecordsCreated: number;
  retriesPrevented: number;
  modelTierDecisions: number;
  benignFailuresSkipped: number;
  approvalCacheHits: number;
  toolGateBlocks: number;
  decisionCacheHits: number;
  decisionBudgetSkips: number;
  guiCacheHits: number;
  guiRiskDeferrals: number;
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
