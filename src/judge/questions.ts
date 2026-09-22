import { choice, noul } from "./ir.js";

/**
 * Judgment questions used across all modules.
 * Backend-neutral IR definitions — any judgment backend can answer them.
 */

// ── Task Router ────────────────────────────────────────────────────────

export const TASK_TIER_QUESTION = choice(
  "Choose the minimum capable model tier for the whole task, including recent conversation, tool failures, files, and delivery constraints in state. cheap: bounded read/search or one mechanical edit with no build or meaningful risk. medium: normal implementation/debugging, multiple files, assets, build or tests. strong: architecture or cross-module changes, engine internals, GAS/GC/threads/replication, crash root cause, high-impact refactor, or detailed final review. unknown: insufficient information. Do not treat confidence as proof that the selected tier is safe.",
  {
    cheap: null,
    medium: null,
    strong: null,
    unknown: null,
  },
);

// ── Context Relevance (Noul) ─────────────────────────────────────────

export const CONTEXT_RELEVANCE_QUESTION = noul(
  "Is this code candidate likely relevant to solving the current task?",
);

// ── Skill Relevance (Noul) ────────────────────────────────────────────

export const SKILL_RELEVANCE_QUESTION = noul(
  "Is this skill useful for the current task?",
);

// ── Agent Router ──────────────────────────────────────────────────────

export const AGENT_TYPE_QUESTION = choice(
  "Choose the best agent type for this task: scout (search/read/locate/filter/gather evidence), coder (implement/fix/standard coding/debug), reviewer (high-risk code review/complex architecture/crash/GC/GAS/threading), or unknown (insufficient information).",
  {
    scout: null,
    coder: null,
    reviewer: null,
    unknown: null,
  },
);

// ── Memory Type ───────────────────────────────────────────────────────

export const MEMORY_TYPE_QUESTION = choice(
  "Classify this information's memory type: fact (objective technical fact), decision (architecture/design choice), failure (important error/issue), constraint (user requirement/limitation), or none (not worth remembering).",
  {
    fact: null,
    decision: null,
    failure: null,
    constraint: null,
    none: null,
  },
);

export const MEMORY_DURABILITY_QUESTION = noul(
  "Should this information remain useful beyond the next few turns of the conversation?",
);

// ── Tool Gate ──────────────────────────────────────────────────────────

export const TOOL_GATE_QUESTION = choice(
  "Should this tool call be allowed, require user confirmation, or be denied? Consider: does it modify files, delete data, change repo state, launch external programs, or have unclear scope?",
  {
    allow: null,
    confirm: null,
    deny: null,
  },
);

// ── Task complexity (model-asked) ───────────────────────────────────────

export const TASK_COMPLEXITY_QUESTION = choice(
  "Choose how complex this task really is: cheap (bounded read/search or one mechanical edit, no build), medium (normal implementation or debugging across a few files, assets, or a build/test cycle), or strong (architecture or cross-module change, engine internals, replication/GC/threads, crash root cause, or a high-impact refactor).",
  {
    cheap: null,
    medium: null,
    strong: null,
  },
);

// ── Operation risk (model-asked) ────────────────────────────────────────

export const OPERATION_RISK_QUESTION = choice(
  "Rate the risk of performing this operation: low (read-only, easily reversible, or confined to one throwaway file), moderate (writes or modifies existing files, regenerates assets, or touches more than a few files but is reversible through git), or high (deletes or bulk-overwrites data, changes repo state irreversibly, publishes or ships something, touches credentials or production, or has unclear scope).",
  {
    low: null,
    moderate: null,
    high: null,
  },
);

// ── Ranking relevance (rank primitive) ──────────────────────────────────

export const RANK_RELEVANCE_QUESTION = noul(
  "Is this candidate relevant to answering the query in state.query?",
);

// ── Failure Classifier + Retry Judge (combined) ────────────────────────

export const FAILURE_TYPE_QUESTION = choice(
  "Classify this tool failure using all structured evidence (exit_code, stderr_excerpt, command_category, same_failure_count). Choose: transient, cancelled, timeout, network, rate_limited, authentication, not_found, conflict, code_error, configuration, permission, environment, invalid_input, repeated, or unknown.",
  {
    transient: null,
    cancelled: null,
    timeout: null,
    network: null,
    rate_limited: null,
    authentication: null,
    not_found: null,
    conflict: null,
    code_error: null,
    configuration: null,
    permission: null,
    environment: null,
    invalid_input: null,
    repeated: null,
    unknown: null,
  },
);

// ── Pruning (Context Pruning) ─────────────────────────────────────────

export const PRUNING_USEFULNESS_QUESTION = noul(
  "Is this tool call/result group still useful for the current task?",
);

export const PRUNING_REPEAT_MISTAKE_QUESTION = noul(
  "Would removing this tool group lose information needed to avoid repeating mistakes?",
);

// ── Review Gate ────────────────────────────────────────────────────────

export const REVIEW_NEEDED_QUESTION = choice(
  "Should this code change be reviewed? Options: skip (no review needed, trivial change), normal_review (standard review), or strong_review (high-risk change requiring detailed review).",
  {
    skip: null,
    normal_review: null,
    strong_review: null,
  },
);

// ── Failure Classifier + Retry Judge (combined) ────────────────────────

export const RECOMMENDED_ACTION_QUESTION = choice(
  "Choose the most concrete next action from the evidence: retry_once, retry_with_backoff, repair_then_retry, change_input, install_dependency, request_permission, inspect_logs, do_not_retry, escalate, ask_user, or unknown. If same_failure_count is at least 1, do not recommend an unchanged retry.",
  {
    retry_once: null,
    retry_with_backoff: null,
    repair_then_retry: null,
    change_input: null,
    install_dependency: null,
    request_permission: null,
    inspect_logs: null,
    do_not_retry: null,
    escalate: null,
    ask_user: null,
    unknown: null,
  },
);
