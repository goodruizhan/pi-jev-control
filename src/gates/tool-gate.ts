import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { TOOL_GATE_QUESTION } from "../jev/questions.js";
import { normalizeToolGateDecision } from "../jev/normalize.js";
import type { ToolGateDecision } from "../types.js";
import { SAFE_READONLY_TOOLS, SAFE_BASH_COMMANDS, DANGEROUS_BASH_PATTERNS } from "../types.js";
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
 * Priority order:
 * 1. Repeated failure check → block if exceeding maxSameFailureRetries
 * 2. Deterministic safe readonly tools → allow
 * 3. Deterministic safe shell commands → allow
 * 4. Deterministic dangerous shell patterns → confirm/deny
 * 5. Uncertain operations → Jev decision
 *
 * Jev API failure fallback:
 * - Only deterministic read-only fast paths are allowed
 * - All other operations require confirmation (TUI) or are blocked (non-TUI)
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

    if (config.memoryGate.enabled) {
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
            `[Jev advisory] Dangerous command detected but not blocked: ${command.slice(0, 300)}`,
            `[Jev 辅助提示] 检测到危险命令，但辅助模式不会拦截：${command.slice(0, 300)}`,
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

    // ── 3. Every unknown or mutating tool is Jev-gated ────────────
    return judgeUnknownTool(toolName, toolInput, actionKey, ctx);
  });
}

type ShellRisk = "safe" | "dangerous" | "uncertain";

/** Classify a complete shell command. Safe fast paths never accept composition. */
export function classifyShellCommand(command: string): ShellRisk {
  if (isDangerousBashCommand(command)) return "dangerous";
  if (isSafeBashCommand(command)) return "safe";
  return "uncertain";
}

async function judgeUnknownTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  actionKey: string,
  ctx: ExtensionContext,
) {
  const config = loadConfig();
  const inputSummary = JSON.stringify(toolInput).slice(0, 1500);

  if (isJevAvailable()) {
    const result = await callJev(
      {
        tool: toolName,
        input_summary: inputSummary,
        mutates_or_has_side_effects: !SAFE_READONLY_TOOLS.has(toolName),
      },
      { tool_gate: TOOL_GATE_QUESTION },
      { module: "toolGate", signal: ctx.signal },
    );

    if (result.ok) {
      const answer = result.result.answers.tool_gate;
      const decision = normalizeToolGateDecision(answer.choice);
      const confidence = answer.confidence;

      const policy = resolveJevGatePolicy(decision, confidence, config.toolGate.confirmOnLowConfidence);
      if (policy === "allow") {
        rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
        return;
      }
      if (policy === "deny") {
        if (config.toolGate.mode === "advisory") {
          notifyAutomatic(ctx, tr(
            `[Jev advisory] Tool Gate recommends denying ${toolName}, but advisory mode will continue.`,
            `[Jev 辅助提示] 工具门控建议拒绝 ${toolName}，但辅助模式将继续执行。`,
          ), "warning");
          rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
          return;
        }
        return block(blockReason(
            tr("[Jev] Tool Gate denied this operation.", "[Jev] 工具门控拒绝了此操作。"),
            getUncertainField(toolName, toolInput),
            tr("Ask the user to explicitly authorize this exact operation, then retry it once.", "请让用户明确授权这一具体操作，然后重试一次。"),
          ));
      }

      if (config.toolGate.mode === "advisory") {
        rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
        return;
      }

      const blocked = await confirmOrBlock(
        ctx,
        tr("Tool Gate Confirmation", "工具门控确认"),
        tr(
          `Jev did not produce a high-confidence allow decision for ${toolName}.\n\nInput: ${inputSummary.slice(0, 300)}\n\nAllow?`,
          `Jev 未能对 ${toolName} 给出高置信度的允许决策。\n\n输入：${inputSummary.slice(0, 300)}\n\n是否允许？`,
        ),
        blockReason(
          tr("Blocked — uncertain or mutating operation was not confirmed.", "已阻止——不确定或会产生修改的操作未获得确认。"),
          getUncertainField(toolName, toolInput),
          tr("Confirm the prompt, or explicitly authorize the exact path/action and retry.", "请在确认框中允许，或明确授权具体路径/操作后重试。"),
        ),
      );
      if (!blocked) rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
      return blocked;
    }
  }

  if (config.toolGate.mode === "advisory") {
    rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
    return;
  }

  // Fail closed: unavailable/failed Jev never silently authorizes an unknown mutation.
  const blocked = await confirmOrBlock(
    ctx,
    tr("Tool Gate Confirmation", "工具门控确认"),
    tr(
      `Jev is unavailable. Confirm this unknown or mutating tool call manually.\n\nTool: ${toolName}\nInput: ${inputSummary.slice(0, 300)}`,
      `Jev 当前不可用，请手动确认这个未知或会产生修改的工具调用。\n\n工具：${toolName}\n输入：${inputSummary.slice(0, 300)}`,
    ),
    blockReason(
      tr("Blocked — Jev unavailable and operation was not confirmed.", "已阻止——Jev 不可用且操作未获得确认。"),
      getUncertainField(toolName, toolInput),
      tr("Confirm the prompt and retry; the approval will be reused for this path during the current task.", "请确认后重试；当前任务内将复用对此路径的授权。"),
    ),
  );
  if (!blocked) rememberApprovedWrite(toolName, actionKey, config.toolGate.reuseApprovedWrites);
  return blocked;
}

function rememberApprovedWrite(toolName: string, actionKey: string, enabled: boolean): void {
  if (enabled && isWriteLikeTool(toolName)) approveAction(actionKey);
}

function blockReason(message: string, uncertainField: string, retryHint: string): string {
  return `${message}\nuncertainField: ${uncertainField}\nretryHint: ${retryHint}`;
}

export function resolveJevGatePolicy(
  decision: ToolGateDecision,
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

/**
 * Check if a bash command matches known safe patterns.
 * Uses explicit prefix matching, not includes().
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();

  // Reject chaining, redirection, command substitution, and multi-line commands.
  if (/[;&|<>`\r\n]/.test(trimmed) || trimmed.includes("$(")) return false;

  // Shell find can execute or delete; the built-in Pi find tool remains safe.
  if (/^find(?:\s|$)/i.test(trimmed)) return false;

  // These options can execute a helper or write output despite a read-like command name.
  if (/^rg(?:\s|$)/i.test(trimmed) && /(?:^|\s)--pre(?:=|\s)/i.test(trimmed)) return false;
  if (/^git\s+(?:diff|log)(?:\s|$)/i.test(trimmed) && /(?:^|\s)(?:--output(?:=|\s)|--ext-diff\b|--textconv\b)/i.test(trimmed)) return false;

  for (const safe of SAFE_BASH_COMMANDS) {
    const lower = trimmed.toLowerCase();
    const safeLower = safe.toLowerCase();
    if (lower === safeLower) return true;
    if (lower.startsWith(safeLower + " ")) return true;
    if (lower.startsWith(safeLower + "\t")) return true;
  }

  return false;
}

/**
 * Check if a bash command matches known dangerous patterns.
 */
export function isDangerousBashCommand(command: string): boolean {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}
