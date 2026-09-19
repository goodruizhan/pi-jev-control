import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { TaskTier } from "../types.js";
import { runtimeState } from "../state/runtime-state.js";

/**
 * Model Router — maps task tier to a configured model and switches via pi.setModel().
 *
 * Modes:
 * - "set-model": directly switch Pi model via pi.setModel()
 * - "tier-only": only record the tier, don't switch model (for auto-model-router compatibility)
 *
 * On failure: keep current model, UI warning, log failure, don't interrupt.
 */

export async function routeModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tier: TaskTier,
): Promise<boolean> {
  const config = loadConfig();

  if (!config.enabled || !config.router.enabled) return false;

  // tier-only mode — just record, don't switch
  if (config.router.mode === "tier-only") {
    return true; // no-op, success
  }

  // set-model mode
  if (tier === "unknown") {
    // No switch for unknown
    return false;
  }

  const modelSpec = config.router.models[tier];
  if (!modelSpec || modelSpec.provider === "REPLACE_ME" || modelSpec.model === "REPLACE_ME") {
    ctx.ui.notify(`[Jev] Model not configured for tier "${tier}", keeping current model`, "info");
    return false;
  }

  try {
    // Find the model in the registry
    const model = ctx.modelRegistry.find(modelSpec.provider, modelSpec.model);
    if (!model) {
      ctx.ui.notify(`[Jev] Model "${modelSpec.provider}/${modelSpec.model}" not found in registry`, "warning");
      return false;
    }

    // Switch model
    const success = await pi.setModel(model);
    if (!success) {
      ctx.ui.notify(`[Jev] Failed to switch to ${modelSpec.provider}/${modelSpec.model} (auth may be missing)`, "warning");
      return false;
    }

    ctx.ui.notify(`[Jev] Switched to ${modelSpec.provider}/${modelSpec.model} (tier: ${tier})`, "info");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.notify(`[Jev] Model switch failed: ${msg}`, "warning");
    return false;
  }
}
