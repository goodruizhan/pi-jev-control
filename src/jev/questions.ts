import { choice, noul } from "@typesafe-ai/sdk";

/**
 * Jev questions used across all modules.
 * These are the System One question definitions sent to Jev.
 */

// ── Task Router ────────────────────────────────────────────────────────

export const TASK_TIER_QUESTION = choice(
  "Choose the best complexity tier for this task: cheap (search/grep/read/mechanical changes), medium (standard coding/debug), strong (crash root cause/GAS/GC/multithreading/engine internals), or unknown (insufficient information).",
  {
    cheap: null,
    medium: null,
    strong: null,
    unknown: null,
  },
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

// ── Failure Classifier + Retry Judge (combined) ────────────────────────

export const FAILURE_TYPE_QUESTION = choice(
  "Classify this tool failure type: transient (temporary, retry may work), code_error (bug in code), configuration (wrong config/path/version), permission (access denied), environment (missing dependency/tool), invalid_input (bad arguments), repeated (same failure seen before), or unknown.",
  {
    transient: null,
    code_error: null,
    configuration: null,
    permission: null,
    environment: null,
    invalid_input: null,
    repeated: null,
    unknown: null,
  },
);

export const RECOMMENDED_ACTION_QUESTION = choice(
  "What action is recommended: retry_once (safe retry without changes), repair_then_retry (fix something first), do_not_retry (retrying won't help), escalate (need stronger model/help), ask_user (need user input), or unknown.",
  {
    retry_once: null,
    repair_then_retry: null,
    do_not_retry: null,
    escalate: null,
    ask_user: null,
    unknown: null,
  },
);
