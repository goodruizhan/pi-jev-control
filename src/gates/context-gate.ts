import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { Type } from "typebox";
import { noul } from "../judge/ir.js";
import type { Questions } from "../judge/ir.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordContextInspected, recordContextRejected } from "../stats/savings.js";
import { tr } from "../i18n.js";

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
  relevance: number | null;
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
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.py",
  "**/*.java",
  "**/*.cs",
  "**/*.go",
  "**/*.rs",
  "**/*.swift",
  "**/*.kt",
  "**/*.sql",
  "**/*.sh",
];

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "code", "file", "files", "find", "for", "from",
  "how", "in", "is", "of", "on", "or", "that", "the", "this", "to", "where", "with",
]);

/**
 * Turn a natural-language search request into bounded literal ripgrep terms.
 * Context Gate used to pass the entire request as one regex, so a query such
 * as "version status backend timeout" only matched that exact phrase and
 * usually returned no candidates. Literal terms also prevent invalid/user-
 * supplied regexes from breaking candidate generation.
 */
export function buildSearchTerms(query: string): string[] {
  const bounded = query.trim().slice(0, 500);
  if (!bounded) return [];

  const rawTokens = bounded.match(/[\p{L}\p{N}_.$:/\\-]+/gu) ?? [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const term = value.trim();
    const key = term.toLocaleLowerCase();
    if (term.length < 2 || SEARCH_STOP_WORDS.has(key) || seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  for (const token of rawTokens) {
    add(token);
    // Unspaced CJK requests need a small recall fallback. The full token stays
    // first; bounded bigrams let comments/identifiers containing part of the
    // request seed candidates for the judgment reranker.
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 4) {
      for (let i = 0; i < token.length - 1 && terms.length < 8; i += 2) {
        add(token.slice(i, i + 2));
      }
    }
    if (terms.length >= 8) break;
  }

  if (terms.length === 0) add(bounded);
  return terms.slice(0, 8);
}

/**
 * Setup the Context Gate — registers the jev_search_code tool.
 */
export function setupContextGate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_search_code",
    label: tr("Jev Code Search", "Jev 代码搜索"),
    description: tr("Find code files relevant to a task using Jev-powered relevance ranking. Returns ranked file candidates with previews.", "使用 Jev 相关性排序查找与任务相关的代码文件，并返回带预览的候选结果。"),
    parameters: Type.Object({
      query: Type.String({ description: tr("Search query describing what to find", "描述查找目标的搜索查询") }),
      patterns: Type.Optional(Type.Array(Type.String(), { description: tr("Additional file path patterns to search", "要搜索的附加文件路径模式") })),
      roots: Type.Optional(Type.Array(Type.String(), { description: tr("Root directories to search (defaults to cwd)", "搜索根目录（默认为当前目录）") })),
      maxResults: Type.Optional(Type.Number({ description: tr("Maximum number of results to return (default: 5)", "最大返回结果数（默认：5）") })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      if (!config.enabled || !config.contextGate.enabled) {
        return {
          content: [{ type: "text", text: tr("Jev Context Gate is disabled.", "Jev 上下文门控已关闭。") }],
          details: {},
        };
      }

      const query = (params.query as string).trim().slice(0, 500);
      const patterns = (params.patterns as string[] | undefined) ?? [];
      const roots = (params.roots as string[] | undefined) ?? [process.cwd()];
      const maxResults = clampInteger((params.maxResults as number | undefined) ?? config.contextGate.maxSelected, 1, 20);
      const maxCandidates = clampInteger(config.contextGate.maxCandidates, 1, 100);
      const threshold = config.contextGate.relevanceThreshold;

      // Step 1: Build candidates using rg
      let candidates: SearchResult[];
      try {
        candidates = await searchWithRg(query, patterns, roots, maxCandidates, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: tr(`Code search failed safely: ${message.slice(0, 300)}`, `代码搜索已安全失败：${message.slice(0, 300)}`) }],
          details: {},
        };
      }

      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: tr("No code candidates found matching the query.", "没有找到与查询匹配的代码候选项。") }],
          details: {},
        };
      }
      recordContextInspected(candidates.length);

      // Step 2: Rank with Jev relevance
      let ranked = candidates;
      let rankedByJev = false;

      if (isJudgeAvailable() && candidates.length > 0) {
        try {
          ranked = await rankCandidates(query, candidates, signal);
          rankedByJev = true;
        } catch {
          // Jev failed — return all candidates in original order
          ranked = candidates;
        }
      }

      // Step 3: Filter only when Jev actually produced relevance scores.
      let results: SearchResult[];
      let lowConfidenceFallback = false;
      if (rankedByJev) {
        results = ranked.filter((c) => (c.relevance ?? 0) >= threshold);
        recordContextRejected(candidates.length - results.length);
        if (results.length === 0) {
          results = ranked.slice(0, Math.min(2, ranked.length));
          lowConfidenceFallback = true;
        }
      } else {
        results = ranked;
      }

      // Limit results
      results = results.slice(0, maxResults);

      // Format output
      const output = formatResults(results, lowConfidenceFallback, rankedByJev);
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
async function searchWithRg(
  query: string,
  patterns: string[],
  roots: string[],
  maxCandidates: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const projectRoot = path.resolve(process.cwd());
  const safeRoots = roots.map((root) => resolveProjectRoot(projectRoot, root));
  const includePatterns = patterns.length > 0 ? patterns : UE5_INCLUDES;

  const searchTerms = buildSearchTerms(query);
  if (searchTerms.length === 0) return [];

  const args = [
    "--json",
    "--line-number",
    "--max-count", "2",
    "--max-filesize", "2M",
    "--fixed-strings",
    "--ignore-case",
  ];

  for (const excluded of RG_EXCLUDES) {
    args.push("--glob", `!**/${excluded}/**`);
  }
  for (const pattern of includePatterns) {
    args.push("--glob", pattern);
  }

  for (const term of searchTerms) {
    args.push("--regexp", term);
  }

  const relativeRoots = safeRoots.map((root) => {
    const relative = path.relative(projectRoot, root);
    return relative.length === 0 ? "." : relative;
  });
  args.push("--", ...relativeRoots);

  const output = await runRipgrep(args, projectRoot, signal);
  const rawLimit = Math.min(400, Math.max(maxCandidates, maxCandidates * 4));
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match") continue;

    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const preview = event.data?.lines?.text;
    if (typeof filePath !== "string" || typeof lineNumber !== "number" || typeof preview !== "string") continue;

    const key = `${filePath}:${lineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      path: filePath,
      line: lineNumber,
      preview: preview.trim().slice(0, 500),
      relevance: null,
    });

    if (results.length >= rawLimit) break;
  }

  return results
    .map((result, index) => ({ result, index, score: lexicalCandidateScore(result, query, searchTerms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxCandidates)
    .map(({ result }) => result);
}

function lexicalCandidateScore(candidate: SearchResult, query: string, terms: string[]): number {
  const pathText = candidate.path.toLocaleLowerCase();
  const previewText = candidate.preview.toLocaleLowerCase();
  const exact = query.trim().toLocaleLowerCase();
  let score = exact && (pathText.includes(exact) || previewText.includes(exact)) ? 20 : 0;
  for (const term of terms) {
    const lower = term.toLocaleLowerCase();
    const weight = Math.min(4, Math.max(1, lower.length / 4));
    if (pathText.includes(lower)) score += 4 * weight;
    if (previewText.includes(lower)) score += weight;
  }
  return score;
}

function resolveProjectRoot(projectRoot: string, requestedRoot: string): string {
  const resolved = path.resolve(projectRoot, requestedRoot);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Search root is outside the current project: ${requestedRoot}`);
  }
  return resolved;
}

/**
 * Resolve the ripgrep binary. The Pi extension host's PATH usually does NOT
 * include Pi's own bundled tools directory (~/.pi/agent/bin), so a bare
 * spawn("rg") fails with ENOENT inside the extension even though Pi ships rg.
 * Probe order: PI_JEV_RG_PATH override → Pi bundled binary → "rg" on PATH.
 */
export function resolveRgBinary(): string {
  const override = process.env.PI_JEV_RG_PATH?.trim();
  if (override && fs.existsSync(override)) return override;
  const bundled = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (fs.existsSync(bundled)) return bundled;
  return "rg";
}

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRgBinary(), args, {
      cwd,
      windowsHide: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill(), 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal?.aborted) return reject(new Error("Search aborted"));
      if (stdout.length > 2 * 1024 * 1024) return reject(new Error("Search output exceeded 2 MiB"));
      if (code === 0 || code === 1) return resolve(stdout);
      reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
    });
  });
}

/**
 * Rank candidates using Jev relevance.
 */
async function rankCandidates(
  query: string,
  candidates: SearchResult[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  // Build Noul questions for each candidate
  const questions: Questions = {};
  for (let i = 0; i < candidates.length; i++) {
    questions[`rel_${i}`] = noul(
      `Is \`candidates[${i}]\` likely to contain evidence or implementation needed to solve \`task\`?`,
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

  const result = await judge(state, questions, {
    module: "contextGate",
    signal,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  // Sort by relevance probability descending
  const scored = candidates.map((c, i) => {
    const answer = result.answers[`rel_${i}`] as { noul: number } | undefined;
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
function formatResults(results: SearchResult[], lowConfidenceFallback: boolean, rankedByJev: boolean): string {
  if (results.length === 0) {
    return tr("No relevant code candidates found.", "没有找到相关代码候选项。");
  }

  const lines: string[] = [];
  if (!rankedByJev) lines.push(tr("Jev ranking unavailable; returning unfiltered ripgrep candidates.", "Jev 排序不可用，将返回未经筛选的 ripgrep 候选项。"), "");
  if (lowConfidenceFallback) lines.push(tr("No candidate met the relevance threshold; showing the top low-confidence candidates.", "没有候选项达到相关性阈值，将显示置信度最高的低置信候选项。"), "");

  lines.push(...results.map((r, i) => {
    return [
      `${i + 1}. ${r.path}`,
      tr(`   relevance: ${r.relevance === null ? "n/a" : r.relevance.toFixed(2)}`, `   相关性：${r.relevance === null ? "无" : r.relevance.toFixed(2)}`),
      tr(`   line: ${r.line}`, `   行号（line: ${r.line}）`),
      tr(`   preview: ${r.preview || "(empty)"}`, `   预览（preview: ${r.preview || "（空）"}）`),
      "",
    ].join("\n");
  }));

  return lines.join("\n");
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
