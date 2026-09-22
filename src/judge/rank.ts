import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { noul } from "./ir.js";
import type { Questions } from "./ir.js";
import { judge, isJudgeAvailable } from "./facade.js";
import { RANK_RELEVANCE_QUESTION } from "./questions.js";
import { tr } from "../i18n.js";

/**
 * Rank — the generic "many candidates, few answers" primitive.
 *
 * This is the common shape behind context search, skill selection and memory
 * retrieval: a query arrives, dozens of candidates exist, and only a handful of
 * them matter. The expensive part is asking Jev about each one, so the order of
 * operations is fixed: a cheap local lexical prefilter narrows the field first,
 * and Jev only ranks the survivors.
 *
 * It never throws and never comes back empty-handed when candidates exist. When
 * Jev is down the lexical order is returned with status "unavailable", so a call
 * always gives the model something to act on.
 */

export interface RankCandidate {
  id: string;
  text?: string;
}

export interface RankOptions {
  /** Shortlist size (default 5). */
  limit?: number;
  /** Minimum Jev relevance probability (default 0.45). */
  threshold?: number;
  /** Maximum candidates sent to Jev (default 20). */
  maxForJudge?: number;
}

export interface RankedItem {
  id: string;
  score: number;
  source: "judge" | "lexical";
}

export interface RankResult {
  status: "ok" | "unavailable" | "skipped";
  query: string;
  totalCandidates: number;
  totalAfterFilter: number;
  shortlist: RankedItem[];
  backend?: string;
  latencyMs?: number;
  reason?: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "code", "file", "files", "find", "for", "from",
  "how", "in", "is", "of", "on", "or", "that", "the", "this", "to", "where",
  "with", "what", "which", "please",
]);

/** Lowercase, split and drop noise tokens. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

interface LexicalHit {
  candidate: RankCandidate;
  /** Number of query tokens this candidate text contains. */
  hits: number;
}

/**
 * Cheap local prefilter: a candidate is a hit when its text contains at least one
 * query token. More hits means a stronger lexical score.
 */
function lexicalPrefilter(query: string, candidates: RankCandidate[]): LexicalHit[] {
  const tokens = tokenize(query);
  const hits: LexicalHit[] = [];
  for (const candidate of candidates) {
    const text = (candidate.text ?? "").toLowerCase();
    if (text.length === 0) continue;
    let count = 0;
    for (const token of tokens) {
      if (text.includes(token)) count += 1;
    }
    if (count > 0) hits.push({ candidate, hits: count });
  }
  hits.sort((a, b) => b.hits - a.hits);
  return hits;
}

/**
 * Sort, apply the threshold, and fall back to the best few when nothing clears
 * the bar. Kept pure and exported so the fallback contract can be tested without
 * a live judgment backend.
 */
export function applyThresholdFallback(
  scored: RankedItem[],
  threshold: number,
  limit: number,
): { shortlist: RankedItem[]; reason: string | undefined } {
  // Sort before filtering so a below-threshold fallback can hand back the best
  // few instead of an empty answer.
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const shortlist = ranked.filter((item) => item.score >= threshold).slice(0, limit);
  if (shortlist.length > 0) return { shortlist, reason: undefined };
  if (ranked.length === 0) return { shortlist: [], reason: undefined };

  // The tool promises never to come back empty-handed when candidates exist.
  // When every judged score falls below the threshold the caller would see an
  // empty shortlist and learn nothing — mirror jev_search_code's low-confidence
  // fallback and hand back the best few with an explicit note.
  const fallback = ranked.slice(0, Math.min(2, limit));
  return {
    shortlist: fallback,
    reason: `all ${ranked.length} candidate(s) scored below the ${threshold.toFixed(2)} threshold; top ${fallback.length} returned anyway`,
  };
}

/** Clamp a JSON-supplied number into [min, max], falling back when non-finite. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export async function rankCandidates(
  query: string,
  candidates: RankCandidate[],
  options?: RankOptions,
  signal?: AbortSignal,
  module?: string,
): Promise<RankResult> {
  // The model passes these as JSON numbers, so a non-finite value is possible:
  // threshold=NaN filtered every candidate out, and limit=NaN made
  // slice(0, NaN) return an empty shortlist. Both failed silently.
  const limit = clampNumber(options?.limit ?? 5, 1, 200, 5);
  const threshold = clampNumber(options?.threshold ?? 0.45, 0, 1, 0.45);
  const maxForJudge = clampNumber(options?.maxForJudge ?? 20, 1, 200, 20);

  const trimmedQuery = (query ?? "").trim();
  const boundedCandidates = candidates.slice(0, 200);
  const base = { query: trimmedQuery, totalCandidates: boundedCandidates.length };

  if (trimmedQuery.length === 0 || boundedCandidates.length === 0) {
    return { ...base, status: "skipped", totalAfterFilter: 0, shortlist: [], reason: "no query or no candidates" };
  }

  const hits = lexicalPrefilter(trimmedQuery, boundedCandidates);

  // No lexical hit at all: nothing local can rank these. Return them in order so
  // the caller still sees the full set rather than an empty answer.
  if (hits.length === 0) {
    const shortlist = boundedCandidates.slice(0, limit).map((candidate) => ({
      id: candidate.id,
      score: 0,
      source: "lexical" as const,
    }));
    return {
      ...base,
      status: "ok",
      totalAfterFilter: shortlist.length,
      shortlist,
      reason: "no lexical match; original order kept",
    };
  }

  const pool = hits.slice(0, maxForJudge);

  if (!isJudgeAvailable(module)) {
    const shortlist = pool.slice(0, limit).map((hit) => ({
      id: hit.candidate.id,
      score: hit.hits,
      source: "lexical" as const,
    }));
    return {
      ...base,
      status: "unavailable",
      totalAfterFilter: shortlist.length,
      shortlist,
      reason: "judgment backend unavailable; lexical order used",
    };
  }

  const questions: Questions = {};
  pool.forEach((hit, index) => {
    questions[`rel_${index}`] = RANK_RELEVANCE_QUESTION;
  });

  const state = {
    query: trimmedQuery.slice(0, 500),
    candidates: pool.map((hit) => ({
      id: hit.candidate.id,
      candidate_text: (hit.candidate.text ?? "").slice(0, 500),
    })),
  };

  const result = await judge(state, questions, { module: module ?? "rank", signal });
  if (!result.ok) {
    const shortlist = pool.slice(0, limit).map((hit) => ({
      id: hit.candidate.id,
      score: hit.hits,
      source: "lexical" as const,
    }));
    return {
      ...base,
      status: "unavailable",
      totalAfterFilter: shortlist.length,
      shortlist,
      backend: result.backend,
      latencyMs: result.latencyMs,
      reason: `judgment failed: ${result.error}`,
    };
  }

  const scored: RankedItem[] = pool.map((hit, index) => {
    const answer = result.answers[`rel_${index}`];
    const relevance = answer?.type === "noul" ? answer.noul : 0;
    return { id: hit.candidate.id, score: relevance, source: "judge" };
  });

  // Sort before filtering so a below-threshold fallback can hand back the best
  // few instead of an empty answer.
  const { shortlist, reason } = applyThresholdFallback(scored, threshold, limit);

  return {
    ...base,
    status: "ok",
    totalAfterFilter: shortlist.length,
    shortlist,
    backend: result.backend,
    latencyMs: result.latencyMs,
    reason,
  };
}

/** Register the `jev_rank` tool. */
export function setupRankTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_rank",
    label: tr("Jev Rank", "Jev 排序"),
    description: tr(
      "Rank a list of candidates against a query and return a short shortlist. Use this before reading anything when there are more than ~20 candidates (files, skills, memory records, config keys) so you inspect only the relevant few.",
      "按查询对候选列表排序并返回短名单。当候选超过约 20 个（文件、技能、记忆、配置项）时，先用它缩小范围再深读，省 token。",
    ),
    parameters: Type.Object({
      query: Type.String({ description: tr("What you are looking for", "你想找什么") }),
      candidates: Type.Array(
        Type.Object({
          id: Type.String({ description: tr("Stable candidate id", "候选的唯一标识") }),
          text: Type.Optional(Type.String({ description: tr("Candidate text to score", "用于打分的候选文本") })),
        }),
        { description: tr("Candidates to rank (max 200)", "待排序候选（最多 200 个）") },
      ),
      limit: Type.Optional(Type.Number({ description: tr("Shortlist size (default 5)", "短名单大小（默认 5）") })),
      threshold: Type.Optional(Type.Number({ description: tr("Minimum relevance (default 0.45)", "最低相关度（默认 0.45）") })),
    }),
    async execute(_toolCallId, params, signal) {
      const query = String(params.query ?? "").slice(0, 500);
      const raw = Array.isArray(params.candidates) ? (params.candidates as unknown[]) : [];
      const candidates: RankCandidate[] = raw.slice(0, 200).flatMap((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!id) return [];
        return [{ id, text: typeof item.text === "string" ? item.text.slice(0, 2000) : "" }];
      });
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const threshold = typeof params.threshold === "number" ? params.threshold : undefined;

      const result = await rankCandidates(query, candidates, { limit, threshold }, signal, "rank");

      const lines = [
        tr(
          `Rank: "${result.query}" — ${result.totalAfterFilter}/${result.totalCandidates} candidate(s) kept${result.backend ? ` [${result.backend}]` : ""}`,
          `排序：“${result.query}”——${result.totalAfterFilter}/${result.totalCandidates} 个候选入选${result.backend ? ` [${result.backend}]` : ""}`,
        ),
      ];
      if (result.reason) lines.push(tr(`Reason: ${result.reason}`, `原因：${result.reason}`));
      result.shortlist.forEach((item, index) => {
        lines.push(`${index + 1}. [${item.source}] ${item.id} — ${item.score.toFixed(3)}`);
      });
      if (result.shortlist.length === 0) {
        lines.push(tr(
          "No candidate cleared the bar. Widen the query or lower the threshold.",
          "没有候选达到门槛。请放宽查询或降低阈值。",
        ));
      } else {
        lines.push(tr(
          "Scores are advisory. Read the ones you need and decide for yourself.",
          "分数仅供参考，需要哪些由你决定。",
        ));
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
