import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { JevControlConfig } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "jev-control.json");

/** Default configuration values */
const DEFAULT_CONFIG: JevControlConfig = {
  enabled: true,
  language: "en",
  jev: {
    model: "jev-latest",
    timeoutMs: 4000,
  },
  router: {
    enabled: true,
    confidenceThreshold: 0.7,
    fallbackTier: "medium",
    mode: "set-model",
    models: {
      cheap: { provider: "REPLACE_ME", model: "REPLACE_ME" },
      medium: { provider: "REPLACE_ME", model: "REPLACE_ME" },
      strong: { provider: "REPLACE_ME", model: "REPLACE_ME" },
    },
  },
  toolGate: {
    enabled: true,
    useDeterministicFastPath: true,
  },
  retryJudge: {
    enabled: true,
    maxSameFailureRetries: 1,
  },
  contextGate: {
    enabled: false,
    maxCandidates: 40,
    maxSelected: 5,
    relevanceThreshold: 0.55,
  },
  skillGate: {
    enabled: false,
    maxSelected: 4,
    relevanceThreshold: 0.55,
  },
  agentRouter: {
    enabled: true,
  },
  memoryGate: {
    enabled: false,
  },
  compaction: {
    enabled: false,
    preserveRecentMessages: 8,
    minCharsToSave: 8000,
    minTurnsBetweenPlans: 20,
  },
  reviewGate: {
    enabled: true,
  },
  guiRouter: {
    enabled: true,
    confidenceThreshold: 0.7,
  },
};

let cachedConfig: JevControlConfig | null = null;

/**
 * Load configuration with merge order:
 *   defaults → global (~/.pi/agent/jev-control.json) → project (.pi/jev-control.json)
 * Falls back to defaults for any missing keys.
 * Never throws — always returns a valid config.
 */
export function loadConfig(): JevControlConfig {
  if (cachedConfig) return cachedConfig;

  let merged: Partial<JevControlConfig> = {};

  // 1. Global config
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    merged = JSON.parse(raw);
  } catch {
    // Config file doesn't exist or is invalid — use defaults
  }

  // 2. Project config override
  try {
    const projectConfigPath = path.join(process.cwd(), ".pi", "jev-control.json");
    const raw = fs.readFileSync(projectConfigPath, "utf-8");
    const projectConfig = JSON.parse(raw);
    merged = deepMerge(merged as Record<string, unknown>, projectConfig as Record<string, unknown>) as Partial<JevControlConfig>;
  } catch {
    // Project config doesn't exist — use global
  }

  cachedConfig = deepMerge(DEFAULT_CONFIG, merged as Partial<JevControlConfig> & Record<string, unknown>);
  return cachedConfig!
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
 * Invalidate the cached config (call after /reload).
 */
export function invalidateConfig(): void {
  cachedConfig = null;
}

/**
 * Get the config path for display purposes.
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Persist the UI language in the global Jev Control config. */
export function saveLanguage(language: JevControlConfig["language"]): void {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    // Missing or invalid config: create a minimal valid file.
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...config, language }, null, 2)}\n`, "utf-8");
  cachedConfig = null;
}
