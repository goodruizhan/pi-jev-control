import type { PiMessage, ToolGroup, PruningPlan, PruningDecision } from "../types.js";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import type { Questions } from "../judge/ir.js";
import { noul } from "../judge/ir.js";
import crypto from "node:crypto";

/**
 * Context Pruner — builds tool groups from messages and decides KEEP/TRUNCATE/DROP.
 *
 * Core principles:
 * 1. Never modify disk session — only modify the messages view sent to LLM
 * 2. Tool call/result must be processed as groups — never keep one without the other
 * 3. Unresolved failures default to KEEP
 * 4. Recent N messages are always protected
 */

// ── Group Builder ─────────────────────────────────────────────────────

interface GroupResult {
  groups: ToolGroup[];
  /** Indices of messages that are NOT tool groups (system/user/standalone assistant) */
  standaloneIndices: number[];
  /** Indices of tool group messages (call + result) */
  groupIndices: number[];
}

/**
 * Build tool call/result groups from the message array.
 *
 * A "tool group" is a pair of:
 *  - Assistant message containing tool call(s) (identified by toolCallId in content)
 *  - Tool result message (identified by matching toolCallId)
 *
 * Messages that are not tool call/result pairs remain standalone.
 */
export function buildToolGroups(messages: PiMessage[]): GroupResult {
  const groups: ToolGroup[] = [];
  const standaloneIndices: number[] = [];
  const groupIndices: number[] = [];
  const matchedIndices = new Set<number>();

  // Step 1: Identify tool result messages.
  const toolResults = new Map<string, number>(); // toolCallId -> message index
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isToolResult(msg)) {
      const id = msg.toolCallId ?? msg.id ?? "";
      if (id) toolResults.set(id, i);
    }
  }

  // Step 2: Treat one assistant message and all of its tool results as one atomic group.
  // Providers commonly emit multiple tool calls in one assistant message. Splitting that
  // message into multiple groups can orphan results when only one group is dropped.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (matchedIndices.has(i)) continue;
    if (!isToolCall(msg)) continue;

    const calls = extractToolCalls(msg);
    const resultIndices = calls.map((call) => toolResults.get(call.id));
    if (resultIndices.some((index) => index === undefined)) continue;

    const concreteResultIndices = resultIndices as number[];
    if (concreteResultIndices.some((index) => matchedIndices.has(index))) continue;

    const resultEntries = concreteResultIndices.map((index) => messages[index]);
    const toolName = calls.map((call) => call.name).join(", ") || "unknown";
    const inputSummary = calls
      .map((call) => `${call.name}: ${JSON.stringify(call.arguments ?? {})}`)
      .join("\n")
      .slice(0, 1000);
    const resultSummary = resultEntries
      .map((entry) => `${entry.toolName ?? "tool"}: ${summarizeResult(entry)}`)
      .join("\n")
      .slice(0, 1000);
    const isError = resultEntries.some((entry) => !!entry.isError);
    const messageIndices = [i, ...concreteResultIndices];
    const charsBefore = messageIndices.reduce((sum, index) => sum + estimateChars(messages[index]), 0);
    const stableIds = calls.map((call) => call.id).join("|");
    const groupId = `group_${crypto.createHash("sha256").update(stableIds).digest("hex").slice(0, 16)}`;

    groups.push({
      callEntry: msg,
      resultEntries,
      toolName,
      inputSummary,
      resultSummary,
      isError,
      groupId,
      messageIndices,
      charsBefore,
      charsAfter: 0,
    });

    for (const index of messageIndices) {
      matchedIndices.add(index);
      groupIndices.push(index);
    }
  }

  // Step 3: Standalone messages
  for (let i = 0; i < messages.length; i++) {
    if (!matchedIndices.has(i)) {
      standaloneIndices.push(i);
    }
  }

  return { groups, standaloneIndices, groupIndices };
}

/**
 * Check if a message is a tool result.
 */
function isToolResult(msg: PiMessage): boolean {
  if (msg.role === "toolResult" || msg.role === "tool") return true;
  // Some formats use toolCallId + isError on a non-tool role
  if (msg.toolCallId && msg.role !== "assistant") return true;
  return false;
}

/**
 * Check if a message is a tool call (assistant with tool calls).
 */
function isToolCall(msg: PiMessage): boolean {
  // role === "assistant" with tool calls in content
  if (msg.role !== "assistant") return false;
  const ids = extractToolCallIds(msg);
  return ids.length > 0;
}

/**
 * Extract toolCallIds from an assistant message's content.
 */
function extractToolCallIds(msg: PiMessage): string[] {
  return extractToolCalls(msg).map((call) => call.id);
}

interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function extractToolCalls(msg: PiMessage): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type !== "toolCall" && b.type !== "tool_call" && b.type !== "tool_use") continue;
        const id = typeof b.id === "string"
          ? b.id
          : typeof b.toolCallId === "string"
            ? b.toolCallId
            : typeof b.tool_call_id === "string"
              ? b.tool_call_id
              : "";
        if (!id) continue;
        const name = typeof b.name === "string" ? b.name : "unknown";
        const args = typeof b.arguments === "object" && b.arguments !== null
          ? b.arguments as Record<string, unknown>
          : typeof b.input === "object" && b.input !== null
            ? b.input as Record<string, unknown>
            : {};
        calls.push({ id, name, arguments: args });
      }
    }
  }
  return calls;
}

/**
 * Summarize the result of a tool call.
 */
function summarizeResult(msg: PiMessage): string {
  const content = msg.content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") text += b.text + "\n";
        if (typeof b.content === "string") text += b.content + "\n";
      } else if (typeof block === "string") {
        text += block + "\n";
      }
    }
    return text.slice(0, 500);
  }
  if (typeof content === "string") return content.slice(0, 500);
  return "";
}

/**
 * Estimate the character count of a message.
 */
function estimateChars(msg: PiMessage): number {
  return JSON.stringify(msg).length;
}

// ── Pruning Decision ──────────────────────────────────────────────────

/**
 * Decide pruning for each tool group using Jev.
 *
 * For each group, Jev answers two Noul questions:
 * 1. Is this group still useful for the current task?
 * 2. Would removing this lose information needed to avoid repeating mistakes?
 *
 * Decision rules:
 * - usefulness >= 0.5 OR repeat_mistake >= 0.6 → KEEP_RAW
 * - usefulness >= 0.2 AND repeat_mistake < 0.3 → TRUNCATE
 * - otherwise → DROP
 *
 * Special protection:
 * - Groups touching the recent N messages: always KEEP_RAW
 * - Unresolved failures: always KEEP_RAW
 * - Jev failure: all groups KEEP_RAW
 */
export async function decidePruning(
  groups: ToolGroup[],
  signal?: AbortSignal,
): Promise<Map<string, PruningDecision>> {
  const decisions = new Map<string, PruningDecision>();

  if (groups.length === 0) return decisions;

  // If Jev unavailable, keep all
  if (!isJudgeAvailable()) {
    for (const g of groups) decisions.set(g.groupId, "KEEP_RAW");
    return decisions;
  }

  // Error groups are always protected. A future resolved-failure policy can relax
  // this only when resolution is proven against the exact action fingerprint.
  const candidateGroups = groups.filter((group) => {
    if (!group.isError) return true;
    decisions.set(group.groupId, "KEEP_RAW");
    return false;
  });

  if (candidateGroups.length === 0) return decisions;

  // Build Noul questions for each group (batch in single Jev request)
  const questions: Questions = {};
  for (let i = 0; i < candidateGroups.length; i++) {
    questions[`useful_${i}`] = noul(
      `Is \`groups[${i}]\` still useful evidence for the current software-development task?`,
    );
    questions[`mistake_${i}`] = noul(
      `Would removing \`groups[${i}]\` lose information needed to avoid repeating a mistake?`,
    );
  }

  const state = {
    groups: candidateGroups.map((g) => ({
      tool: g.toolName,
      input: g.inputSummary.slice(0, 200),
      result: g.resultSummary.slice(0, 200),
      isError: g.isError,
    })),
  };

  const result = await judge(state, questions, {
    module: "compaction",
    signal,
  });

  if (!result.ok) {
    // Jev failed — keep all groups
    for (const g of groups) decisions.set(g.groupId, "KEEP_RAW");
    return decisions;
  }

  for (let i = 0; i < candidateGroups.length; i++) {
    const g = candidateGroups[i];

    // Get Jev answers
    const usefulAnswer = result.answers[`useful_${i}`] as { noul: number } | undefined;
    const mistakeAnswer = result.answers[`mistake_${i}`] as { noul: number } | undefined;
    const usefulness = usefulAnswer?.noul ?? 0.5; // default to keep on missing
    const repeatMistake = mistakeAnswer?.noul ?? 0.3; // default to keep on missing

    // Decision logic
    if (usefulness >= 0.5 || repeatMistake >= 0.6) {
      decisions.set(g.groupId, "KEEP_RAW");
    } else if (usefulness >= 0.2 && repeatMistake < 0.3) {
      decisions.set(g.groupId, "TRUNCATE");
    } else {
      decisions.set(g.groupId, "DROP");
    }
  }

  return decisions;
}

/**
 * Apply a pruning plan to messages, returning filtered messages.
 *
 * - KEEP_RAW: keep both call and result
 * - TRUNCATE: keep both but truncate result to essential info
 * - DROP: remove both call and result
 */
export function applyPruning(
  messages: PiMessage[],
  plan: PruningPlan,
  groups: ToolGroup[],
): PiMessage[] {
  // Build a map from group index to decision
  const groupDecisions = new Map<string, PruningDecision>();
  for (const g of groups) {
    if (plan.keepIds.has(g.groupId)) groupDecisions.set(g.groupId, "KEEP_RAW");
    else if (plan.truncateIds.has(g.groupId)) groupDecisions.set(g.groupId, "TRUNCATE");
    else if (plan.dropIds.has(g.groupId)) groupDecisions.set(g.groupId, "DROP");
  }

  // Find indices that belong to groups
  const groupMessageIndices = new Map<number, ToolGroup>();
  for (const g of groups) {
    for (const index of g.messageIndices) groupMessageIndices.set(index, g);
  }

  const filtered: PiMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const group = groupMessageIndices.get(i);

    if (group) {
      const decision = groupDecisions.get(group.groupId);

      if (decision === "DROP") {
        // Skip this message entirely
        continue;
      }

      if (decision === "TRUNCATE") {
        // Only truncate the result entry, keep call entry
        if (group.callEntry === msg) {
          filtered.push(msg);
        } else {
          // Truncate the result: keep tool name, key error lines, remove bulk output
          const truncated = truncateResult(msg);
          filtered.push(truncated);
        }
      } else {
        // KEEP_RAW
        filtered.push(msg);
      }
    } else {
      // Standalone message — always keep (system, user, standalone assistant)
      filtered.push(msg);
    }
  }

  return filtered;
}

/**
 * Truncate a tool result message, keeping essential info.
 */
function truncateResult(msg: PiMessage): PiMessage {
  const result = { ...msg };
  const content = msg.content;

  if (Array.isArray(content)) {
    const truncatedContent = content.map((block) => {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") {
          // Keep first 500 chars of text
          const text = b.text;
          if (text.length > 500) {
            const truncated = { ...b, text: text.slice(0, 500) + "... [truncated]" };
            return truncated;
          }
        }
      }
      return block;
    });
    result.content = truncatedContent;
  } else if (typeof content === "string" && content.length > 500) {
    result.content = content.slice(0, 500) + "... [truncated]";
  }

  return result;
}

// ── Build Pruning Plan ────────────────────────────────────────────────

/**
 * Build a complete pruning plan from messages.
 *
 * Steps:
 * 1. Build tool groups
 * 2. Apply recent protection (last N groups always KEEP)
 * 3. Decide pruning for older groups
 * 4. Build PruningPlan
 */
export async function buildPruningPlan(
  messages: PiMessage[],
  signal?: AbortSignal,
): Promise<PruningPlan> {
  const config = loadConfig();
  const preserveRecent = config.compaction.preserveRecentMessages;

  // Step 1: Build groups
  const { groups, groupIndices } = buildToolGroups(messages);

  // Step 2: Protect every group touching the last N messages.
  const recentBoundary = Math.max(0, messages.length - preserveRecent);
  const recentGroups = groups.filter((group) => group.messageIndices.some((index) => index >= recentBoundary));
  const recentIds = new Set(recentGroups.map((group) => group.groupId));
  const oldGroups = groups.filter((group) => !recentIds.has(group.groupId));

  // All recent groups are KEEP
  const decisions = new Map<string, PruningDecision>();
  for (const g of recentGroups) {
    decisions.set(g.groupId, "KEEP_RAW");
  }

  // Step 3: Resolve obvious cases locally; ask Jev only about ambiguous groups.
  const local = buildDeterministicPruningDecisions(oldGroups, recentGroups);
  for (const [id, dec] of local.decisions) decisions.set(id, dec);

  if (local.unresolved.length > 0 && isJudgeAvailable()) {
    const oldDecisions = await decidePruning(local.unresolved, signal);
    for (const [id, dec] of oldDecisions) {
      decisions.set(id, dec);
    }
  } else {
    // No Jev or no ambiguous groups — keep unresolved groups.
    for (const g of local.unresolved) {
      decisions.set(g.groupId, "KEEP_RAW");
    }
  }

  // Step 4: Build plan
  const keepIds = new Set<string>();
  const truncateIds = new Set<string>();
  const dropIds = new Set<string>();
  let estimatedCharsAfter = 0;

  for (const g of groups) {
    const dec = decisions.get(g.groupId) ?? "KEEP_RAW";
    if (dec === "KEEP_RAW") {
      keepIds.add(g.groupId);
      estimatedCharsAfter += g.charsBefore;
    } else if (dec === "TRUNCATE") {
      truncateIds.add(g.groupId);
      // Estimate: call entry kept + up to 500 chars per result.
      const callChars = estimateChars(g.callEntry);
      const truncatedChars = callChars + g.resultEntries.reduce((sum, entry) => sum + Math.min(estimateChars(entry), 700), 0);
      g.charsAfter = truncatedChars;
      estimatedCharsAfter += truncatedChars;
    } else {
      dropIds.add(g.groupId);
      // Dropped — 0 chars
    }
  }

  // Add standalone messages (always kept)
  const { standaloneIndices } = buildToolGroups(messages);
  for (const idx of standaloneIndices) {
    estimatedCharsAfter += estimateChars(messages[idx]);
  }

  const estimatedCharsBefore = messages.reduce((sum, m) => sum + estimateChars(m), 0);

  return {
    epochId: crypto.randomUUID(),
    createdAtTurn: 0,
    keepIds,
    truncateIds,
    dropIds,
    estimatedCharsBefore,
    estimatedCharsAfter,
  };
}

/**
 * Cheap, conservative pruning that runs before any network request.
 * It never drops writes or failures. Repeated read-only lookups can be dropped,
 * while very large read-only results can be truncated.
 */
export function buildDeterministicPruningDecisions(
  oldGroups: ToolGroup[],
  protectedGroups: ToolGroup[] = [],
): { decisions: Map<string, PruningDecision>; unresolved: ToolGroup[] } {
  const decisions = new Map<string, PruningDecision>();
  const unresolved: ToolGroup[] = [];
  const seenReads = new Set<string>();

  for (const group of protectedGroups) {
    if (!group.isError && isReadOnlyGroup(group)) seenReads.add(readSignature(group));
  }

  for (let index = oldGroups.length - 1; index >= 0; index -= 1) {
    const group = oldGroups[index];
    if (group.isError) {
      decisions.set(group.groupId, "KEEP_RAW");
      continue;
    }
    if (!isReadOnlyGroup(group)) {
      unresolved.unshift(group);
      continue;
    }

    const signature = readSignature(group);
    if (seenReads.has(signature)) {
      decisions.set(group.groupId, "DROP");
      continue;
    }
    seenReads.add(signature);

    if (group.charsBefore > 2500) {
      decisions.set(group.groupId, "TRUNCATE");
    } else {
      unresolved.unshift(group);
    }
  }

  return { decisions, unresolved };
}

function isReadOnlyGroup(group: ToolGroup): boolean {
  const text = `${group.toolName} ${group.inputSummary}`.toLowerCase();
  if (/\b(write|edit|delete|remove|move|copy|commit|push|install|apply_patch)\b/.test(text)) return false;
  return /\b(read|grep|rg|find|ls|glob|search|status|diff|view|open)\b/.test(text);
}

function readSignature(group: ToolGroup): string {
  return crypto.createHash("sha256")
    .update(`${group.toolName}\n${group.inputSummary}`)
    .digest("hex")
    .slice(0, 20);
}
