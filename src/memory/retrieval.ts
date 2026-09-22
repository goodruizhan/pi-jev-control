import type { MemoryRecord } from "../types.js";
import { readAllMemory, readAllFailures } from "./store.js";
import { rankCandidates } from "../judge/rank.js";
import { generateActionFingerprint } from "../judge/normalize.js";

/**
 * Memory Retrieval — search the local memory store, then Jev for relevance.
 *
 * The narrowing itself lives in the shared rank primitive
 * (src/judge/rank.ts): a lexical prefilter first, then Jev ranks only the
 * survivors. Memory search is a model-initiated read, so it is not gated on the
 * legacy automatic memory watcher.
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

  // Step 1: local read + optional type filter
  const allMemory = readAllMemory();
  const allFailures = readAllFailures();
  const allRecords = [...allMemory, ...allFailures];

  let records = allRecords;
  if (types && types.length > 0) {
    records = records.filter((r) => types.includes(r.type));
  }

  const totalCandidates = records.length;
  if (records.length === 0) {
    return { records: [], totalCandidates: 0, totalAfterJev: 0 };
  }

  // Step 2: lexical prefilter + Jev relevance, via the shared rank primitive
  const ranked = await rankCandidates(
    query,
    records.map((record) => ({
      id: record.id,
      text: `${record.summary} ${record.rawExcerpt ?? ""}`.toLowerCase(),
    })),
    { limit, threshold: 0.45 },
    signal,
    "memoryGate",
  );

  const byId = new Map(records.map((record) => [record.id, record]));
  const hits = ranked.shortlist
    .map((item) => byId.get(item.id))
    .filter((record): record is MemoryRecord => Boolean(record));

  return {
    records: hits,
    totalCandidates,
    totalAfterJev: hits.length,
  };
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
