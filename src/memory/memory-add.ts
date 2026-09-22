import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import { generateActionFingerprint } from "../judge/normalize.js";
import { appendMemory, getProjectHash, upsertFailure } from "./store.js";
import { recordMemoryCreated } from "../stats/savings.js";
import type { MemoryRecord } from "../types.js";

/**
 * Memory Add — model-initiated memory capture.
 *
 * The old memory gate watched user input and wrote JSONL behind the model's back.
 * That decided for the model which of its own work was worth remembering. The
 * direction is now inverted: the model calls this when it decides something is
 * durable, and nothing writes memory without being asked.
 *
 * It is deliberately gated only on the top-level switch. `memoryGate.enabled`
 * controls the legacy automatic watcher, and it stays irrelevant here — an
 * explicit model call is already authorization.
 */

const VALID_TYPES = ["fact", "decision", "failure", "constraint"] as const;
type AddableMemoryType = (typeof VALID_TYPES)[number];

export interface MemoryAddResult {
  status: "saved" | "skipped" | "disabled";
  id?: string;
  type?: string;
  summary?: string;
  reason?: string;
}

export async function addMemory(input: {
  type: string;
  summary: string;
  rawExcerpt?: string;
  confidence?: number;
}): Promise<MemoryAddResult> {
  const config = loadConfig();
  if (!config.enabled) {
    return { status: "disabled", reason: "pi-jev-control is disabled" };
  }

  const type = input.type.trim().toLowerCase() as AddableMemoryType;
  if (!VALID_TYPES.includes(type)) {
    return {
      status: "skipped",
      type: input.type.trim().toLowerCase(),
      reason: `type must be one of ${VALID_TYPES.join(", ")}`,
    };
  }

  const summary = input.summary.trim();
  if (summary.length === 0) {
    return { status: "skipped", type, reason: "summary is empty" };
  }

  const confidence = Number.isFinite(input.confidence)
    ? Math.min(1, Math.max(0, input.confidence as number))
    : 0.8;

  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    projectHash: getProjectHash(),
    type,
    summary: summary.slice(0, 2000),
    rawExcerpt: input.rawExcerpt?.trim().slice(0, 2000) || undefined,
    confidence,
    source: "agent",
    fingerprint: generateActionFingerprint(type, summary),
  };

  if (type === "failure") upsertFailure(record);
  else appendMemory(record);

  recordMemoryCreated();
  return { status: "saved", id: record.id, type, summary: record.summary };
}

/** Register the `jev_memory_add` tool. */
export function setupMemoryAddTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_memory_add",
    label: tr("Jev Memory Add", "Jev 写入记忆"),
    description: tr(
      "Store one fact, decision, failure or constraint in the local Jev memory store. Use it when the user states a durable preference (\"remember this\", \"always use X\"), when an important architecture decision is made, or right after fixing a non-obvious failure so the mistake is not repeated in a later session. Nothing writes memory on its own — this tool is the only door.",
      "把一个事实、决策、失败或约束写入本地 Jev 记忆库。使用时机：用户表达了持久偏好（「记住」「以后都…」）、做出重要架构决策、或刚修复了一个不明显的踩坑（避免下次再犯）。没有任何东西会自动写记忆，这是唯一的入口。",
    ),
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...VALID_TYPES],
          description: "fact / decision / failure / constraint",
        },
        summary: {
          type: "string",
          description: tr("One-sentence summary of what to remember", "一句话说明要记住什么"),
        },
        rawExcerpt: {
          type: "string",
          description: tr("Optional supporting quote or excerpt", "可选：支撑性的原文片段"),
        },
        confidence: {
          type: "number",
          description: tr("0 to 1, default 0.8", "0 到 1，默认 0.8"),
        },
      },
      required: ["type", "summary"],
    },
    async execute(_toolCallId, params) {
      const type = String(params.type ?? "").slice(0, 40);
      const summary = String(params.summary ?? "").slice(0, 2000);
      const rawExcerpt = typeof params.rawExcerpt === "string" ? params.rawExcerpt.slice(0, 2000) : undefined;
      const confidence = typeof params.confidence === "number" ? params.confidence : undefined;

      const result = await addMemory({ type, summary, rawExcerpt, confidence });

      const lines = [
        result.status === "saved"
          ? tr(`Memory saved [${result.type}]: ${result.summary}`, `记忆已保存 [${result.type}]：${result.summary}`)
          : result.status === "disabled"
            ? tr("pi-jev-control is disabled, nothing was stored.", "pi-jev-control 已关闭，未写入。")
            : tr(`Not stored: ${result.reason}`, `未写入：${result.reason}`),
      ];
      if (result.id) lines.push(tr(`id: ${result.id}`, `ID：${result.id}`));
      if (result.status !== "saved") {
        lines.push(tr(
          `Valid types: ${VALID_TYPES.join(", ")}`,
          `合法类型：${VALID_TYPES.join(", ")}`,
        ));
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
