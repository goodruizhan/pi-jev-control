import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { JevControlConfig } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "jev-control.json");

/** Default configuration values */
const DEFAULT_CONFIG: JevControlConfig = {
  enabled: true,
  language: "en",
  ui: {
    notifications: "errors-only",
  },
  jev: {
    model: "jev-latest",
    timeoutMs: 4000,
  },
  judgment: {
    // Default decision backend; "typesafe" = Jev via the TypeSafe API.
    // Add more entries under backends and point judgment.backend (or
    // judgment.modules.<module>) at them to swap the judgment model.
    backend: "typesafe",
    // Deterministic rules backend as the last resort — keeps judge()
    // answers deterministic when every model backend is down.
    fallback: "rules",
    backends: {
      typesafe: {
        type: "typesafe-api",
        apiKeyEnv: "TYPESAFE_API_KEY",
        // model/timeoutMs fall back to the legacy jev.* values below.
      },
      rules: { type: "rules" },
    },
  },
  router: {
    enabled: true,
    confidenceThreshold: 0.7,
    fallbackTier: "medium",
    routerFailureTier: "medium",
    cheapConfidenceThreshold: 0.85,
    // Default: the model stays in control of its own tier. Jev never switches it
    // automatically; the model opts in via jev_request_model_tier, and the user can
    // still force a tier with `[strong]` or `/jev route`.
    mode: "rules-only",
    models: {
      cheap: { provider: "REPLACE_ME", model: "REPLACE_ME" },
      medium: { provider: "REPLACE_ME", model: "REPLACE_ME" },
      strong: { provider: "REPLACE_ME", model: "REPLACE_ME" },
    },
  },
  toolGate: {
    enabled: true,
    mode: "advisory",
    useDeterministicFastPath: true,
    confirmOnLowConfidence: false,
    reuseApprovedWrites: true,
    blockOnRememberedFailure: false,
  },
  retryJudge: {
    enabled: true,
    maxSameFailureRetries: 2,
    timeoutMs: 2500,
    skipBenignExitCodes: true,
    // Failure counting, circuit-breaking and memory records stay on; the tool
    // output itself is left untouched so the model reads exactly what the tool said.
    appendToResult: false,
  },
  contextGate: {
    enabled: true,
    maxCandidates: 40,
    maxSelected: 5,
    relevanceThreshold: 0.55,
  },
  skillGate: {
    enabled: true,
    maxSelected: 4,
    relevanceThreshold: 0.55,
  },
  agentRouter: {
    enabled: true,
  },
  // Auto memory capture is off by default: the model records what it wants to
  // remember itself through jev_memory_add. jev_memory_search is unaffected.
  memoryGate: {
    enabled: false,
    // Even when the watcher is re-enabled it only announces; the model decides.
    mode: "suggest",
  },
  compaction: {
    enabled: true,
    preserveRecentMessages: 8,
    minCharsToSave: 8000,
    minTurnsBetweenPlans: 20,
    // The model asks for pruning (jev_prune_context) instead of the hook deciding.
    autoMode: "off",
  },
  reviewGate: {
    enabled: true,
  },
  guiRouter: {
    enabled: true,
    confidenceThreshold: 0.7,
    timeoutMs: 2500,
    cacheTurns: 3,
  },
  decisionCopilot: {
    enabled: true,
    silent: true,
    maxCallsPerTurn: 1,
    maxQuestionsPerCall: 8,
    timeoutMs: 5000,
    confidenceThreshold: 0.72,
    cacheTurns: 5,
  },
};

let cachedConfig: JevControlConfig | null = null;
let cachedConfigStamp = "";
// When set, loadConfig() returns cachedConfig verbatim and never re-reads the
// config files. Used by tests, which want to exercise the defaults themselves.
let ignoreConfigFiles = false;

function configStamp(paths: string[]): string {
  return paths.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${file}:missing`;
    }
  }).join("|");
}

function readConfigFile(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[pi-jev-control] Invalid config ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }
}

/**
 * Load configuration with merge order:
 *   defaults → global (~/.pi/agent/jev-control.json) → project (.pi/jev-control.json)
 * Falls back to defaults for any missing keys.
 * Never throws — always returns a valid config.
 */
export function loadConfig(): JevControlConfig {
  const projectConfigPath = path.join(process.cwd(), ".pi", "jev-control.json");
  const stamp = configStamp([CONFIG_PATH, projectConfigPath]);
  if (cachedConfig && (ignoreConfigFiles || stamp === cachedConfigStamp)) return cachedConfig;

  const merged = deepMerge(readConfigFile(CONFIG_PATH), readConfigFile(projectConfigPath));

  cachedConfig = normalizeJudgmentConfig(
    deepMerge(DEFAULT_CONFIG, merged as Partial<JevControlConfig> & Record<string, unknown>),
  );
  cachedConfigStamp = stamp;
  return cachedConfig!
}

/**
 * Backward compatibility: the legacy top-level jev.{model,timeoutMs} section
 * keeps working by filling gaps in judgment.backends.typesafe. Ensures the
 * typesafe backend entry always exists and judgment.backend is valid.
 */
function normalizeJudgmentConfig(config: JevControlConfig): JevControlConfig {
  const judgment = config.judgment;
  judgment.backends = judgment.backends ?? {};
  const typesafe = judgment.backends["typesafe"] ?? { type: "typesafe-api" as const };
  typesafe.type = typesafe.type ?? "typesafe-api";
  typesafe.apiKeyEnv = typesafe.apiKeyEnv ?? "TYPESAFE_API_KEY";
  typesafe.model = typesafe.model ?? config.jev.model;
  typesafe.timeoutMs = typesafe.timeoutMs ?? config.jev.timeoutMs;
  judgment.backends["typesafe"] = typesafe;
  // Keep a rules entry available for the default or a custom fallback.
  judgment.backends["rules"] = judgment.backends["rules"] ?? { type: "rules" };
  if (!judgment.backend || !judgment.backends[judgment.backend]) {
    judgment.backend = "typesafe";
  }
  if (judgment.fallback && !judgment.backends[judgment.fallback]) {
    delete judgment.fallback;
  }
  return config;
}

/**
 * Deep merge: source overrides target, recursively.
 */
function deepMerge<T>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== undefined &&
      targetVal !== undefined &&
      typeof sourceVal === "object" &&
      typeof targetVal === "object" &&
      !Array.isArray(sourceVal) &&
      !Array.isArray(targetVal)
    ) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      (result as Record<string, unknown>)[key as string] = sourceVal;
    }
  }
  return result;
}

/**
 * Restore the pure default configuration, discarding the global and project
 * config files. Tests use this to be independent of whatever a real user has on
 * disk — the defaults themselves are the contract under test.
 *
 * The file reader is also bypassed, otherwise the first loadConfig() call would
 * re-merge the on-disk config over the defaults and undo the reset.
 */
export function resetConfigToDefaults(): void {
  ignoreConfigFiles = true;
  cachedConfig = normalizeJudgmentConfig(structuredClone(DEFAULT_CONFIG));
  cachedConfigStamp = "";
}

/**
 * Invalidate the cached config (call after /reload).
 */
export function invalidateConfig(): void {
  ignoreConfigFiles = false;
  cachedConfig = null;
  cachedConfigStamp = "";
}

/**
 * Get the config path for display purposes.
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Persist the UI language in the global Jev Control config. */
export function saveLanguage(language: JevControlConfig["language"]): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("expected a JSON object");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Refuse rather than overwrite: readConfigFile() already warned that this
      // file is broken, and a user seeing that warning would naturally try to
      // repair it through /jev language. Writing here would silently erase their
      // config instead.
      console.warn(
        `[pi-jev-control] Invalid config ${CONFIG_PATH}: ` +
        `${error instanceof Error ? error.message : String(error)}. Refusing to save the language ` +
        "because that would overwrite it. Fix the file first.",
      );
      cachedConfig = null;
      return;
    }
  }

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...config, language }, null, 2)}\n`, "utf-8");
  cachedConfig = null;
}
