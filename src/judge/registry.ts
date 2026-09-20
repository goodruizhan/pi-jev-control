/**
 * Judgment backend registry — builds backends from config, resolves which
 * backend serves a given module, and manages the fallback chain.
 */

import { loadConfig } from "../config.js";
import type { JudgmentBackendConfig, JudgmentConfig } from "../types.js";
import type { JudgmentBackend } from "./backend.js";
import { TypeSafeBackend } from "./typesafe-backend.js";
import { OpenAiCompatibleBackend } from "./openai-backend.js";
import { EmbeddingBackend } from "./embedding-backend.js";

const instances = new Map<string, JudgmentBackend>();

function createBackend(name: string, config: JudgmentBackendConfig): JudgmentBackend | null {
  switch (config.type) {
    case "typesafe-api":
      return new TypeSafeBackend({
        name,
        apiKeyEnv: config.apiKeyEnv,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    case "openai-compatible":
      return new OpenAiCompatibleBackend({
        name,
        apiKeyEnv: config.apiKeyEnv,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    case "embedding":
      return new EmbeddingBackend({
        name,
        apiKeyEnv: config.apiKeyEnv,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        temperature: config.temperature,
      });
    default:
      return null;
  }
}

function getBackend(name: string): JudgmentBackend | null {
  const cached = instances.get(name);
  if (cached) return cached;

  const config = loadConfig().judgment.backends[name];
  if (!config) return null;

  const backend = createBackend(name, config);
  if (backend) instances.set(name, backend);
  return backend;
}

function judgmentConfig(): JudgmentConfig {
  return loadConfig().judgment;
}

/** Instantiate a configured backend by name — used by the offline eval runner. */
export function getBackendByName(name: string): JudgmentBackend | null {
  return getBackend(name);
}

/**
 * Resolve the backend that should serve a module right now:
 *   judgment.modules[module] → judgment.backend → "typesafe"
 * Falls back to the default backend when the override name is unknown.
 */
export function resolveBackend(module: string): JudgmentBackend {
  const config = judgmentConfig();
  const override = config.modules?.[module];
  if (override) {
    const backend = getBackend(override);
    if (backend) return backend;
  }
  return getBackend(config.backend) ?? getBackend("typesafe") ?? unreachableDefault();
}

/**
 * The configured fallback backend, if any, distinct from the primary one.
 */
export function resolveFallback(primary: JudgmentBackend): JudgmentBackend | null {
  const fallbackName = judgmentConfig().fallback;
  if (!fallbackName || fallbackName === primary.name) return null;
  return getBackend(fallbackName);
}

/**
 * Backends in resolution order for status display: default + fallback +
 * every configured module override, deduplicated.
 */
export function allConfiguredBackends(): JudgmentBackend[] {
  const config = judgmentConfig();
  const names = new Set<string>([config.backend]);
  if (config.fallback) names.add(config.fallback);
  for (const name of Object.values(config.modules ?? {})) names.add(name);
  const result: JudgmentBackend[] = [];
  for (const name of names) {
    const backend = getBackend(name);
    if (backend) result.push(backend);
  }
  return result;
}

/** Last-resort guard so resolveBackend never returns undefined. */
function unreachableDefault(): JudgmentBackend {
  const backend = new TypeSafeBackend({ name: "typesafe" });
  instances.set("typesafe", backend);
  return backend;
}

/** Drop all cached backend instances (call after config reload / in tests). */
export function resetJudgeBackends(): void {
  instances.clear();
}
