import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { SAFE_READONLY_TOOLS } from "../types.js";
import {
  approveAction,
  clearApprovedActions,
  getFailureCountByActionKey,
  getFailureCountByInput,
  isActionApproved,
} from "../state/runtime-state.js";
import { findSimilarFailure } from "../memory/retrieval.js";
import { recordApprovalCacheHit, recordRetryPrevented, recordToolGateBlock } from "../stats/savings.js";
import { tr } from "../i18n.js";
import { getActionKey, getUncertainField, isWriteLikeTool } from "../action-context.js";
import { notifyAutomatic } from "../ui.js";

/**
 * Tool Gate — intercepts tool_call events.
 *
 * This gate is deterministic-only by design. Jev used to sit in the blocking path
 * here, judging every unknown or mutating tool call; that put a cheap judgment model
 * in charge of a stronger model's actions, and every confirm prompt it triggered
 * interrupted the user's flow. It is gone:
 *
 * Priority order:
 * 1. Repeated failure check → warn/block when exceeding maxSameFailureRetries
 * 2. Similar unresolved failure in memory → warn (block only if configured)
 * 3. Deterministic safe readonly tools → allow
 * 4. Deterministic shell classification → allow, warn, or confirm-dangerous
 * 5. Everything else → allow
 *
 * If the model wants a second opinion on an operation it is unsure about, it asks
 * for one itself through `jev_assess_risk` and decides what to do with the answer.
 * advisory/enforce no longer control Jev at all — they only decide whether the
 * deterministic checks warn or actually block.
 */

export function setupToolGate(pi: ExtensionAPI): void {
  // Approvals are scoped to one user task/turn, not the whole process lifetime.
  pi.on("input", (event) => {
    if (event.source !== "extension") clearApprovedActions();
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig();
    if (!config.enabled || !config.toolGate.enabled) return;
    const advisory = config.toolGate.mode === "advisory";

    const toolName = event.toolName;
    const toolInput = event.input as Record<string, unknown>;
    const inputSummary = JSON.stringify(toolInput).slice(0, 1500);
    const actionKey = getActionKey(toolName, toolInput);

    // Repeated-failure protection applies before every allow fast path.
    const maxRetries = config.retryJudge.maxSameFailureRetries;
    const failureCount = Math.max(
      getFailureCountByActionKey(actionKey),
      getFailureCountByInput(toolName, inputSummary),
    );
    if (failureCount >= maxRetries && maxRetries > 0) {
      const reason = blockReason(
          tr(
            `This action already failed ${failureCount} time(s).`,
            `此操作已经失败 ${failureCount} 次。`,
          ),
          getUncertainField(toolName, toolInput),
          tr("Change the approach or input before retrying; use /jev reset only after the cause is fixed.", "请先修改方法或输入再重试；仅在问题已修复后使用 /jev reset 清除熔断记录。"),
        );
      if (advisory) {
        notifyAutomatic(ctx, reason, "warning");
        return;
      }
      recordRetryPrevented();
      return block(reason);
    }

    if (config.toolGate.reuseApprovedWrites && isWriteLikeTool(toolName) && isActionApproved(actionKey)) {
      recordApprovalCacheHit();
      return;
    }

    // Failure records come from the retry judge, not from the memory gate, so the
    // remembered-failure reminder is gated on retryJudge.
    if (config.retryJudge.enabled) {
      const similarFailure = findSimilarFailure(toolName, inputSummary);
      if (similarFailure && !similarFailure.resolved) {
        const message = blockReason(
            tr(`Similar unresolved failure found in memory: ${similarFailure.summary}.`, `记忆中存在相似且尚未解决的失败：${similarFailure.summary}。`),
            getUncertainField(toolName, toolInput),
            tr(`Resolve it with /jev memory resolve ${similarFailure.id}, or change the action.`, `可使用 /jev memory resolve ${similarFailure.id} 将其标记为已解决，或更改操作。`),
          );
        if (config.toolGate.blockOnRememberedFailure) {
          recordRetryPrevented();
          return block(message);
        }
        notifyAutomatic(ctx, message, "warning");
      }
    }

    // ── 1. Safe readonly tools ────────────────────────────────────
    if (config.toolGate.useDeterministicFastPath && SAFE_READONLY_TOOLS.has(toolName)) {
      return; // allow
    }

    // ── 2. Shell tool handling ─────────────────────────────────────
    if (toolName === "bash" || toolName === "powershell") {
      const command = (toolInput.command as string) ?? "";
      const risk = classifyShellCommand(command);

      if (risk === "safe" && config.toolGate.useDeterministicFastPath) return;

      if (risk === "dangerous") {
        if (advisory) {
          notifyAutomatic(ctx, tr(
            `[tool gate, deterministic] Dangerous command detected but not blocked: ${command.slice(0, 300)}`,
            `[工具门控·确定性规则] 检测到危险命令，辅助模式不拦截：${command.slice(0, 300)}`,
          ), "warning");
          return;
        }
        return confirmOrBlock(
          ctx,
          tr("Dangerous Command", "危险命令"),
          tr(
            `About to execute: ${command.slice(0, 300)}\n\nThis command may cause data loss. Allow?`,
            `即将执行：${command.slice(0, 300)}\n\n此命令可能造成数据丢失，是否允许？`,
          ),
          tr("Blocked — dangerous command was not explicitly confirmed", "已阻止——危险命令未获得明确确认"),
        );
      }
    }

    // ── 3. Everything else passes ─────────────────────────────────
    // The model has the full conversation, the tool trail, and the intended
    // outcome — it is the right party to decide whether a call is worth making.
    // When it is unsure it can ask for a second opinion via jev_assess_risk.
    rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
    return;
  });
}

// Shell classification rules live in the rules backend (single source of
// truth); re-exported here for existing callers/tests.
export { classifyShellCommand, isDangerousBashCommand, isSafeBashCommand } from "../judge/rules-backend.js";
import { classifyShellCommand } from "../judge/rules-backend.js";

function rememberApprovedWrite(toolName: string, actionKey: string, enabled: boolean): void {
  if (enabled && isWriteLikeTool(toolName)) approveAction(actionKey);
}

function blockReason(message: string, uncertainField: string, retryHint: string): string {
  return `${message}\nuncertainField: ${uncertainField}\nretryHint: ${retryHint}`;
}

/**
 * Maps a Jev tool-gate verdict + confidence to a policy.
 *
 * Kept exported for the policy tests and for `jev_assess_risk`, which reports the
 * same allow/deny/confirm policy to the model so it can make its own call. The
 * automatic tool_call path no longer uses it.
 */
export function resolveJevGatePolicy(
  decision: "allow" | "deny" | "confirm",
  confidence: number,
  confirmOnLowConfidence: boolean,
): "allow" | "deny" | "confirm" {
  // High-risk allow decisions require stronger confidence than ordinary routing.
  if (decision === "allow" && confidence >= 0.85) return "allow";
  if (decision === "deny" && confidence >= 0.7) return "deny";
  return confirmOnLowConfidence ? "confirm" : "allow";
}

async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  message: string,
  reason: string,
) {
  try {
    const confirmed = await ctx.ui.confirm(title, message);
    if (confirmed) return;
  } catch {
    // Headless/non-interactive contexts cannot confirm, so block.
  }
  return block(reason);
}

function block(reason: string) {
  recordToolGateBlock();
  return { block: true, reason };
}
