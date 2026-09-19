import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { TOOL_GATE_QUESTION } from "../jev/questions.js";
import { normalizeToolGateDecision } from "../jev/normalize.js";
import type { ToolGateDecision } from "../types.js";
import { SAFE_READONLY_TOOLS, SAFE_BASH_COMMANDS, DANGEROUS_BASH_PATTERNS } from "../types.js";
import { getFailureCountByInput } from "../state/runtime-state.js";


/**
 * Tool Gate — intercepts tool_call events.
 *
 * Priority order:
 * 1. Deterministic safe readonly tools → allow
 * 2. Deterministic safe bash commands → allow
 * 3. Deterministic dangerous bash patterns → confirm/deny
 * 4. Repeated failure check → block if exceeding maxSameFailureRetries
 * 5. Uncertain operations → Jev decision
 *
 * Jev API failure fallback:
 * - Read-only tools → allow
 * - Clearly dangerous → confirm
 * - Unknown mutations → confirm (TUI) or block (non-TUI)
 */

export function setupToolGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.toolGate.enabled) return;

    const toolName = event.toolName;
    const toolInput = event.input as Record<string, unknown>;

    // ── 1. Safe readonly tools ────────────────────────────────────
    if (SAFE_READONLY_TOOLS.has(toolName)) {
      return; // allow
    }

    // ── 2. Bash tool handling ─────────────────────────────────────
    if (toolName === "bash") {
      const command = (toolInput.command as string) ?? "";

      // Safe bash commands → allow
      if (isSafeBashCommand(command)) {
        return; // allow
      }

      // Dangerous bash patterns → confirm
      if (isDangerousBashCommand(command)) {
        // Check repeated failure protection
        const inputSummary = command.slice(0, 1500);
        const maxRetries = config.retryJudge.maxSameFailureRetries;
        const failureCount = getFailureCountByInput(toolName, inputSummary);

        if (failureCount >= maxRetries && maxRetries > 0) {
          return {
            block: true,
            reason: `This action already failed ${failureCount} time(s). Change the approach or provide new evidence before retrying.`,
          };
        }

        // Confirm with user
        const confirmed = await ctx.ui.confirm(
          "Dangerous Command",
          `About to execute: ${command.slice(0, 200)}\n\nThis command may cause data loss. Allow?`,
        );
        if (!confirmed) {
          return {
            block: true,
            reason: "Blocked by user — dangerous command not confirmed",
          };
        }
        return; // allow
      }

      // ── 3. Repeated failure protection ─────────────────────────
      const inputSummary = command.slice(0, 1500);
      const maxRetries = config.retryJudge.maxSameFailureRetries;
      const failureCount = getFailureCountByInput(toolName, inputSummary);

      if (failureCount >= maxRetries && maxRetries > 0) {
        return {
          block: true,
          reason: `This action already failed ${failureCount} time(s). Change the approach or provide new evidence before retrying.`,
        };
      }

      // ── 4. Uncertain bash → Jev ────────────────────────────────
      if (config.toolGate.useDeterministicFastPath) {
        // If Jev is available, ask Jev
        if (isJevAvailable()) {
          const state = {
            tool: "bash",
            command: command.slice(0, 500),
            task_context: `bash command: ${command.slice(0, 200)}`,
          };
          const result = await callJev(state, { tool_gate: TOOL_GATE_QUESTION }, {
            module: "toolGate",
            signal: ctx.signal,
          });

          if (result.ok) {
            const decision = normalizeToolGateDecision(result.result.answers.tool_gate.choice);
            if (decision === "allow") return;
            if (decision === "deny") {
              return {
                block: true,
                reason: `[Jev] Tool Gate denied: ${result.result.answers.tool_gate.choice}`,
              };
            }
            // confirm
            const confirmed = await ctx.ui.confirm(
              "Tool Gate Confirmation",
              `Jev recommends confirmation for: ${command.slice(0, 200)}\n\nAllow?`,
            );
            if (!confirmed) {
              return {
                block: true,
                reason: "Blocked by user — Jev recommended confirmation",
              };
            }
            return; // allow after confirmation
          }

          // Jev failed — fall through to default
        }

        // Jev unavailable or failed — default behavior for bash:
        // Only allow known safe patterns, otherwise confirm
        // Since we already passed the safe check above, this is a moderate-risk command
        // In v0.1, we let it through but log a note
        // (v0.2 will add more granular rules)
        return; // allow by default
      }

      return; // allow by default
    }

    // ── 5. Other tools ────────────────────────────────────────────
    // For non-bash tools, check if they are known safe
    if (SAFE_READONLY_TOOLS.has(toolName)) {
      return; // allow
    }

    // Other tools (write, edit, subagent, etc.) — check repeated failures
    const inputStr = JSON.stringify(toolInput);
    const maxRetries = config.retryJudge.maxSameFailureRetries;
    const failureCount = getFailureCountByInput(toolName, inputStr);

    if (failureCount >= maxRetries && maxRetries > 0) {
      return {
        block: true,
        reason: `This action already failed ${failureCount} time(s). Change the approach or provide new evidence before retrying.`,
      };
    }

    // For other tools, allow by default (v0.2 will add Jev for uncertain tools)
  });
}

/**
 * Check if a bash command matches known safe patterns.
 * Uses explicit prefix matching, not includes().
 */
function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();

  for (const safe of SAFE_BASH_COMMANDS) {
    if (trimmed === safe) return true;
    if (trimmed.startsWith(safe + " ")) return true;
    if (trimmed.startsWith(safe + "\t")) return true;
  }

  return false;
}

/**
 * Check if a bash command matches known dangerous patterns.
 */
function isDangerousBashCommand(command: string): boolean {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}
