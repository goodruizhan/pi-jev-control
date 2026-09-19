import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { CONTEXT_RELEVANCE_QUESTION } from "../jev/questions.js";
import { Type } from "typebox";
import { noul } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Context Gate — "先筛，再读" (filter first, then read).
 *
 * Registers jev_search_code tool that uses rg (ripgrep) to find code candidates,
 * then uses Jev to rank by relevance.
 *
 * Output: only relevant files with rank, path, line, relevance, preview.
 * Main model then decides whether to read full files.
 */

interface SearchResult {
  path: string;
  line: number;
  preview: string;
  relevance: number;
}

// Default exclude patterns for rg
const RG_EXCLUDES = [
  "Binaries",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  ".vs",
  ".git",
  "node_modules",
];

// UE5 project include patterns
const UE5_INCLUDES = [
  "Source/**/*.cpp",
  "Source/**/*.h",
  "Plugins/**/Source/**/*.cpp",
  "Plugins/**/Source/**/*.h",
  "Config/**/*.ini",
  "*.Build.cs",
  "*.Target.cs",
];

/**
 * Setup the Context Gate — registers the jev_search_code tool.
 */
export function setupContextGate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_search_code",
    label: "Jev Code Search",
    description: "Find code files relevant to a task using Jev-powered relevance ranking. Returns ranked file candidates with previews.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query describing what to find" }),
      patterns: Type.Optional(Type.Array(Type.String(), { description: "Additional file path patterns to search" })),
      roots: Type.Optional(Type.Array(Type.String(), { description: "Root directories to search (defaults to cwd)" })),
      maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const query = params.query as string;
      const patterns = (params.patterns as string[] | undefined) ?? [];
      const roots = (params.roots as string[] | undefined) ?? [process.cwd()];
      const maxResults = (params.maxResults as number | undefined) ?? config.contextGate.maxSelected;
      const maxCandidates = config.contextGate.maxCandidates;
      const threshold = config.contextGate.relevanceThreshold;

      // Step 1: Build candidates using rg
      const candidates = await searchWithRg(query, patterns, roots, maxCandidates);

      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "No code candidates found matching the query." }],
          details: {},
        };
      }

      // Step 2: Rank with Jev relevance
      let ranked = candidates;

      if (isJevAvailable() && candidates.length > 0) {
        try {
          ranked = await rankCandidates(query, candidates, ctx, signal);
        } catch {
          // Jev failed — return all candidates in original order
          ranked = candidates;
        }
      }

      // Step 3: Filter by threshold
      let results = ranked.filter((c) => c.relevance >= threshold);

      // If nothing passes threshold, return top 1-2 with low confidence marker
      if (results.length === 0) {
        results = ranked.slice(0, Math.min(2, ranked.length)).map((c) => ({
          ...c,
          relevance: c.relevance < 0.1 ? 0 : c.relevance,
        }));
      }

      // Limit results
      results = results.slice(0, maxResults);

      // Format output
      const output = formatResults(results);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  });
}

/**
 * Search using rg (ripgrep).
 */
function searchWithRg(
  query: string,
  patterns: string[],
  roots: string[],
  maxCandidates: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const root of roots) {
    const cwd = resolve(root);
    const excludeFlags = RG_EXCLUDES.map((e) => `--glob !${e}`).join(" ");
    const pattern = patterns.length > 0 ? patterns.join(" ") : "*.{ts,tsx,js,jsx,py,java,c,cpp,h,hpp,cs,go,rs,rb,php,swift,kt,sql,sh}";

    // Use -l for files only (less output), -n for line numbers
    const cmd = `rg -n -l --max-count 2 "${query}" ${excludeFlags} ${pattern} 2>/dev/null || true`;

    try {
      const output = execSync(cmd, {
        cwd,
        timeout: 10000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });

      const lines = output.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        // Format: filepath:lineno:content
        const match = line.match(/^(.+):(\d+):(.*)$/);
        if (match) {
          const [, filePath, lineNum, content] = match;
          results.push({
            path: filePath,
            line: parseInt(lineNum),
            preview: content.trim().slice(0, 300),
            relevance: 0,
          });
        }
      }

      if (results.length >= maxCandidates) break;
    } catch {
      // rg failed — try without patterns
    }
  }

  return results.slice(0, maxCandidates);
}

/**
 * Rank candidates using Jev relevance.
 */
async function rankCandidates(
  query: string,
  candidates: SearchResult[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  // Build Noul questions for each candidate
  const questions: Questions = {};
  for (let i = 0; i < candidates.length; i++) {
    questions[`rel_${i}`] = noul(
      `Is this code candidate likely relevant to solving: "${query}"? File: ${candidates[i].path}, Line: ${candidates[i].line}, Preview: "${candidates[i].preview.slice(0, 200)}"`,
    );
  }

  const state = {
    task: query,
    candidates: candidates.map((c) => ({
      path: c.path,
      line: c.line,
      preview: c.preview.slice(0, 200),
    })),
  };

  const result = await callJev(state, questions, {
    module: "contextGate",
    signal,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  // Sort by relevance probability descending
  const scored = candidates.map((c, i) => {
    const answer = result.result.answers[`rel_${i}`] as { noul: number } | undefined;
    return {
      ...c,
      relevance: answer?.noul ?? 0,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Format search results for output.
 */
function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No relevant code candidates found.";
  }

  const lines = results.map((r, i) => {
    return [
      `${i + 1}. ${r.path}`,
      `   relevance: ${r.relevance.toFixed(2)}`,
      `   line: ${r.line}`,
      `   preview: ${r.preview || "(empty)"}`,
      "",
    ].join("\n");
  });

  return lines.join("\n");
}
