import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { choice } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { recordDecisionBudgetSkip, recordDecisionCacheHit } from "../stats/savings.js";
import { tr } from "../i18n.js";

interface DecisionOption {
  id: string;
  description?: string;
}

interface DecisionQuestion {
  id: string;
  prompt: string;
  options: DecisionOption[];
}

export interface BatchDecisionResult {
  status: "ok" | "cached" | "skipped" | "unavailable";
  decisions: Record<string, { choice: string; confidence: number; probabilities?: Record<string, number> }>;
  latencyMs?: number;
  reason?: string;
}

interface CacheEntry {
  turn: number;
  result: BatchDecisionResult;
}

const cache = new Map<string, CacheEntry>();
let currentTurn = 0;
let callsThisTurn = 0;

export function beginDecisionTurn(): void {
  currentTurn += 1;
  callsThisTurn = 0;
  const ttl = Math.max(0, loadConfig().decisionCopilot.cacheTurns);
  for (const [key, entry] of cache) {
    if (currentTurn - entry.turn > ttl) cache.delete(key);
  }
}

export function resetDecisionCopilot(): void {
  cache.clear();
  currentTurn = 0;
  callsThisTurn = 0;
}

export async function decideBatch(
  goal: string,
  state: unknown,
  rawQuestions: DecisionQuestion[],
  signal?: AbortSignal,
): Promise<BatchDecisionResult> {
  const config = loadConfig();
  if (!config.enabled || !config.decisionCopilot.enabled) {
    return { status: "skipped", decisions: {}, reason: "disabled" };
  }

  const questions = normalizeDecisionQuestions(rawQuestions, config.decisionCopilot.maxQuestionsPerCall);
  if (questions.length === 0) return { status: "skipped", decisions: {}, reason: "no_valid_questions" };

  const boundedGoal = String(goal ?? "").trim().slice(0, 500);
  const boundedState = boundedJson(state, 6000);
  const key = crypto.createHash("sha256")
    .update(JSON.stringify({ goal: boundedGoal, state: boundedState, questions }))
    .digest("hex")
    .slice(0, 24);
  const cached = cache.get(key);
  if (cached && currentTurn - cached.turn <= config.decisionCopilot.cacheTurns) {
    recordDecisionCacheHit();
    return { ...cached.result, status: "cached" };
  }

  if (callsThisTurn >= Math.max(0, config.decisionCopilot.maxCallsPerTurn)) {
    recordDecisionBudgetSkip();
    return { status: "skipped", decisions: {}, reason: "turn_budget" };
  }
  if (!isJevAvailable()) return { status: "unavailable", decisions: unknownDecisions(questions), reason: "jev_unavailable" };

  callsThisTurn += 1;
  const sdkQuestions: Questions = {};
  const optionMaps = new Map<string, Map<string, string>>();
  questions.forEach((question, questionIndex) => {
    const choices: Record<string, null> = {};
    const map = new Map<string, string>();
    question.options.forEach((option, optionIndex) => {
      const key = `option_${optionIndex}`;
      choices[key] = null;
      map.set(key, option.id);
    });
    const internalId = `q_${questionIndex}`;
    optionMaps.set(internalId, map);
    sdkQuestions[internalId] = choice(
      `${question.prompt}\nChoose the option key that best satisfies the goal using the corresponding option descriptions in state.questions[${questionIndex}].`,
      choices,
    );
  });

  const result = await callJev(
    {
      goal: boundedGoal,
      context: boundedState,
      questions: questions.map((question, index) => ({
        index,
        id: question.id,
        prompt: question.prompt,
        options: question.options.map((option) => ({
          id: option.id,
          description: option.description ?? "",
        })),
      })),
    },
    sdkQuestions,
    { module: "decision", signal, timeoutMs: config.decisionCopilot.timeoutMs },
  );

  if (!result.ok) return { status: "unavailable", decisions: unknownDecisions(questions), reason: result.errorType };

  const decisions: BatchDecisionResult["decisions"] = {};
  questions.forEach((question, index) => {
    const internalId = `q_${index}`;
    const answer = result.result.answers[internalId] as { choice: string; confidence: number; probabilities?: Record<string, number> };
    const map = optionMaps.get(internalId)!;
    const rawChoice = map.get(answer.choice) ?? "unknown";
    const confidence = Number.isFinite(answer.confidence) ? answer.confidence : 0;
    const probabilities: Record<string, number> = {};
    for (const [internalOption, probability] of Object.entries(answer.probabilities ?? {})) {
      const externalOption = map.get(internalOption);
      if (externalOption && typeof probability === "number") probabilities[externalOption] = probability;
    }
    decisions[question.id] = {
      choice: confidence >= config.decisionCopilot.confidenceThreshold ? rawChoice : "unknown",
      confidence,
      probabilities,
    };
  });

  const batchResult: BatchDecisionResult = { status: "ok", decisions, latencyMs: result.latencyMs };
  cache.set(key, { turn: currentTurn, result: batchResult });
  return batchResult;
}

export function setupDecisionCopilot(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    if (event.source !== "extension") beginDecisionTurn();
  });

  pi.registerTool({
    name: "jev_decide_batch",
    label: tr("Jev Decision Copilot", "Jev 决策副驾驶"),
    description: tr(
      "Batch 1-8 bounded choice questions into one fast Jev request. Use only when explicit candidate options already exist.",
      "将 1～8 个已有候选项的判断合并为一次快速 Jev 请求；仅在候选选项明确时使用。",
    ),
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Overall goal" },
        state: { type: "object", description: "Small structured context", additionalProperties: true },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, description: { type: "string" } },
                  required: ["id"],
                },
              },
            },
            required: ["id", "prompt", "options"],
          },
        },
      },
      required: ["goal", "questions"],
    },
    async execute(_toolCallId, params, signal) {
      const result = await decideBatch(
        String(params.goal ?? ""),
        params.state ?? {},
        Array.isArray(params.questions) ? params.questions as unknown as DecisionQuestion[] : [],
        signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

export function normalizeDecisionQuestions(raw: DecisionQuestion[], maxQuestions: number): DecisionQuestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: DecisionQuestion[] = [];
  for (const candidate of raw.slice(0, Math.max(0, maxQuestions))) {
    const id = typeof candidate?.id === "string" ? candidate.id.trim().slice(0, 80) : "";
    const prompt = typeof candidate?.prompt === "string" ? candidate.prompt.trim().slice(0, 500) : "";
    if (!id || !prompt || seen.has(id) || !Array.isArray(candidate.options)) continue;
    const optionIds = new Set<string>();
    const options = candidate.options.slice(0, 12).flatMap((option) => {
      const optionId = typeof option?.id === "string" ? option.id.trim().slice(0, 80) : "";
      if (!optionId || optionIds.has(optionId)) return [];
      optionIds.add(optionId);
      return [{ id: optionId, description: String(option.description ?? "").slice(0, 300) }];
    });
    if (options.length < 2) continue;
    seen.add(id);
    result.push({ id, prompt, options });
  }
  return result;
}

function boundedJson(value: unknown, maxChars: number): string {
  try { return JSON.stringify(value ?? {}).slice(0, maxChars); }
  catch { return "{}"; }
}

function unknownDecisions(questions: DecisionQuestion[]): BatchDecisionResult["decisions"] {
  return Object.fromEntries(questions.map((question) => [question.id, { choice: "unknown", confidence: 0 }]));
}
