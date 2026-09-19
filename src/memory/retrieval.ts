import type { MemoryRecord, MemoryType } from "../types.js";
import { readAllMemory, readAllFailures } from "./store.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import type { Questions } from "@typesafe-ai/sdk";
import { noul } from "@typesafe-ai/sdk";
import { generateActionFingerprint } from "../jev/normalize.js";

/**
 * Memory Retrieval — search local memory store, then use Jev for relevance ranking.
 *
 * Flow: local lexical filter → max 20 candidates → Jev relevance → return top 5.
 * Never sends entire memory store to Jev.
 */

export interface MemorySearchResult {
  records: MemoryRecord[];
  totalCandidates: number;
  totalAfterJev: number;
}

export interface MemorySearchParams {
  query: string;
  types?: string[];
  limit?: number;
}

/**
 * Search memory store with optional Jev relevance ranking.
 */
export async function searchMemory(
  params: MemorySearchParams,
  signal?: AbortSignal,
): Promise<MemorySearchResult> {
  const query = params.query.trim().slice(0, 500).toLowerCase();
  const types = params.types;
  const limit = params.limit ?? 5;

  // Step 1: Local lexical filter
  const allMemory = readAllMemory();
  const allFailures = readAllFailures();
  const allRecords = [...allMemory, ...allFailures];

  // Filter by type if specified
  let candidates = allRecords;
  if (types && types.length > 0) {
    candidates = candidates.filter((r) => types.includes(r.type));
  }

  // Lexical filter: query terms must appear in summary or rawExcerpt
  const queryTerms = query.split(/\s+/).filter((t) => t.length > 1);
  candidates = candidates.filter((r) => {
    const text = (r.summary + " " + (r.rawExcerpt ?? "")).toLowerCase();
    return queryTerms.some((term) => text.includes(term));
  });

  // Limit to 20 candidates for Jev
  const maxForJev = 20;
  candidates = candidates.slice(0, maxForJev);

  const totalCandidates = candidates.length;

  if (candidates.length === 0) {
    return { records: [], totalCandidates: 0, totalAfterJev: 0 };
  }

  // Step 2: Jev relevance ranking (if available)
  if (isJevAvailable() && candidates.length > 0) {
    try {
      const ranked = await rankWithJev(query, candidates, signal);
      return {
        records: ranked.slice(0, limit),
        totalCandidates,
        totalAfterJev: ranked.length,
      };
    } catch {
      // Jev failed — return lexical order
    }
  }

  // Fallback: return in lexical order
  return {
    records: candidates.slice(0, limit),
    totalCandidates,
    totalAfterJev: candidates.length,
  };
}

/**
 * Rank candidates using Jev relevance.
 */
async function rankWithJev(
  query: string,
  candidates: MemoryRecord[],
  signal?: AbortSignal,
): Promise<MemoryRecord[]> {
  // Build Noul questions for each candidate
  const questions: Questions = {};
  for (let i = 0; i < candidates.length; i++) {
    questions[`rel_${i}`] = noul(
      `Is \`records[${i}]\` relevant evidence for \`query\`?`,
    );
  }

  const state = {
    query,
    records: candidates.map((r) => ({
      type: r.type,
      summary: r.summary.slice(0, 200),
      timestamp: new Date(r.timestamp).toISOString().slice(0, 10),
    })),
  };

  const result = await callJev(state, questions, {
    module: "memoryGate",
    signal,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  // Sort by relevance probability descending
  const scored = candidates.map((r, i) => {
    const answer = result.result.answers[`rel_${i}`] as { noul: number } | undefined;
    return {
      record: r,
      relevance: answer?.noul ?? 0,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.map((s) => s.record);
}

/**
 * Check if a failure with similar action exists in memory.
 * Used by Tool Gate for repeated failure prevention.
 */
export function findSimilarFailure(
  toolName: string,
  inputSummary: string,
): MemoryRecord | undefined {
  const allFailures = readAllFailures();
  const fingerprint = generateActionFingerprint(toolName, inputSummary);

  // Look for unresolved failures with similar action
  const matches = allFailures.filter((r) => {
    if (r.type !== "failure" || r.resolved) return false;
    return r.fingerprint === fingerprint && (!r.toolName || r.toolName === toolName);
  });

  return matches[0];
}
