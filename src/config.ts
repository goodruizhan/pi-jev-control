import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { JevControlConfig } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "jev-control.json");

/** Default configuration values */
const DEFAULT_CONFIG: JevControlConfig = {
  enabled: true,
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
};

let cachedConfig: JevControlConfig | null = null;

/**
 * Load configuration from ~/.pi/agent/jev-control.json.
 * Falls back to defaults for any missing keys.
 * Never throws — always returns a valid config.
 */
export function loadConfig(): JevControlConfig {
  if (cachedConfig) return cachedConfig;

  let fileConfig: Partial<JevControlConfig> = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    fileConfig = JSON.parse(raw);
  } catch {
    // Config file doesn't exist or is invalid — use defaults
  }

  cachedConfig = deepMerge(DEFAULT_CONFIG, fileConfig as Partial<JevControlConfig> & Record<string, unknown>);
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
