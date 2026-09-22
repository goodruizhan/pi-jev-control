import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import { getEpochInfo, getEpochPlan, requestEpochPlan } from "./epoch.js";

/**
 * Prune Context — the model asks to slim its own context.
 *
 * Pruning deletes information from the model's own view, so it must not happen
 * on the hook's say-so. The context hook only applies a plan that was explicitly
 * requested: either by this tool, or by the user via `/jev compact plan`.
 *
 * A tool cannot see the messages it would be pruning, so it cannot prune. It only
 * records the request; the next `context` event is where the plan gets built and
 * applied, because that is the one place the messages are visible.
 */

export interface PruneRequestResult {
  status: "requested" | "skipped" | "disabled";
  reason?: string;
  epoch: ReturnType<typeof getEpochInfo>;
}

export function requestPrune(reason?: string): PruneRequestResult {
  const config = loadConfig();
  const epoch = getEpochInfo();

  if (!config.compaction.enabled) {
    return { status: "disabled", reason: "compaction is disabled", epoch };
  }
  if (getEpochPlan()) {
    return { status: "skipped", reason: "a pruning plan is already active", epoch };
  }

  requestEpochPlan();
  return { status: "requested", reason: reason ?? undefined, epoch };
}

/** Register the `jev_prune_context` tool. */
export function setupPruneContextTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_prune_context",
    label: tr("Jev Prune Context", "Jev 裁剪上下文"),
    description: tr(
      "Ask the next context event to generate and apply a pruning plan for old tool output. Use it when a long session has accumulated a lot of obsolete grep output, compiler logs, or search dumps you no longer need. You cannot see the messages being pruned, so you are asking, not doing. A plan will be built and applied on the next context event. Pruning never happens automatically unless compaction.autoMode is set to auto.",
      "请求在下一个上下文事件中生成并应用裁剪计划，清理过时的工具输出。使用时机：长会话累积了大量不再需要的 grep 输出、编译日志、搜索转储。你看不见被裁剪的消息，所以这是请求而非执行。计划会在下一个上下文事件生成并应用。除非把 compaction.autoMode 设为 auto，否则裁剪不会自动发生。",
    ),
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: tr("Why the context should be slimmed down", "为什么要瘦身上下文"),
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      const reason = typeof params.reason === "string" ? params.reason.slice(0, 500) : undefined;
      const result = requestPrune(reason);

      const lines = [
        result.status === "requested"
          ? tr(
              `Pruning requested — a plan will be generated and applied on the next context event.`,
              `已请求裁剪——计划将在下一个上下文事件生成并应用。`,
            )
          : result.status === "disabled"
            ? tr(
                `Not requested: ${result.reason}. Enable compaction in the config or use /jev compact on.`,
                `未请求：${result.reason}。请在配置中开启 compaction，或用 /jev compact on。`,
              )
            : tr(
                `Not requested: ${result.reason}.`,
                `未请求：${result.reason}。`,
              ),
      ];

      if (result.epoch.hasPlan) {
        lines.push(tr(
          `Active plan: ${result.epoch.estimatedSavedChars} chars saved across the current epoch.`,
          `生效中的计划：当前周期已节省 ${result.epoch.estimatedSavedChars} 字符。`,
        ));
      }
      if (result.reason && result.status === "requested") {
        lines.push(tr(`Reason: ${result.reason}`, `原因：${result.reason}`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
