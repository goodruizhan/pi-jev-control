import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { Type } from "typebox";
import { noul } from "../judge/ir.js";
import type { Questions } from "../judge/ir.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tr } from "../i18n.js";

/**
 * Skill Gate — select the most relevant Pi skills for the current task.
 *
 * Scans skill directories, reads name + description only,
 * then uses Jev to rank by relevance.
 *
 * Does NOT replace Pi's skill loader — only provides recommendations.
 */

interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  relevance: number | null;
}

// Directories to scan for skills (exported for tests)
export const SKILL_DIRS = [
  path.join(os.homedir(), ".pi", "agent", "skills"),
  path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(process.cwd(), ".pi", "skills"),
  path.join(process.cwd(), ".agents", "skills"),
];

/**
 * Setup the Skill Gate — registers the jev_select_skills tool.
 */
export function setupSkillGate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_select_skills",
    label: tr("Jev Skill Selection", "Jev 技能选择"),
    description: tr("Select the most relevant Pi skills for the current task using Jev-powered relevance ranking.", "使用 Jev 相关性排序为当前任务选择最相关的 Pi 技能。"),
    parameters: Type.Object({
      query: Type.String({ description: tr("The current task or goal", "当前任务或目标") }),
      maxResults: Type.Optional(Type.Number({ description: tr("Maximum skills to return (default: 4)", "最大返回技能数（默认：4）") })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      if (!config.enabled || !config.skillGate.enabled) {
        return {
          content: [{ type: "text", text: tr("Jev Skill Gate is disabled.", "Jev 技能门控已关闭。") }],
          details: {},
        };
      }
      const query = (params.query as string).trim().slice(0, 500);
      const maxResults = Math.min(20, Math.max(1, Math.floor((params.maxResults as number | undefined) ?? config.skillGate.maxSelected)));

      // Step 1: Discover skills
      const skills = discoverSkills();

      if (skills.length === 0) {
        return {
          content: [{ type: "text", text: tr("No skills discovered.", "未发现任何技能。") }],
          details: {},
        };
      }

      // Step 2: Rank with Jev
      let ranked = skills;
      let rankedByJev = false;

      if (isJudgeAvailable() && skills.length > 0) {
        try {
          ranked = await rankSkills(query, skills, signal);
          rankedByJev = true;
        } catch {
          // Jev failed — return all skills
          ranked = skills;
        }
      }

      if (rankedByJev) {
        ranked = ranked.filter((skill) => isSkillRelevant(
          query,
          skill.name,
          skill.description,
          skill.relevance ?? 0,
          config.skillGate.relevanceThreshold,
        ));
      }

      // Limit results. When Jev is unavailable, preserve discovery order instead of pretending it was ranked.
      ranked = ranked.slice(0, maxResults);

      // Format output
      const output = formatSkills(query, ranked);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  });
}

/**
 * Discover skills from known directories.
 * Only reads name + description, not full SKILL.md content.
 */
function discoverSkills(): SkillCandidate[] {
  const skills: SkillCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const dir of SKILL_DIRS) {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) continue;

    try {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillMdPath = path.join(absDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;
        const normalizedPath = path.resolve(skillMdPath).toLowerCase();
        if (seenPaths.has(normalizedPath)) continue;

        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const name = entry.name;
          const description = extractDescription(content);

          skills.push({
            name,
            description,
            path: skillMdPath,
            relevance: null,
          });
          seenPaths.add(normalizedPath);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return skills;
}

/**
 * Extract description from SKILL.md frontmatter or first paragraph.
 */
export function extractDescription(content: string): string {
  // Parse the small frontmatter subset used by Pi skills. In particular,
  // support YAML folded/literal descriptions (`description: >` / `|`);
  // returning the marker itself used to make those skills effectively
  // invisible to semantic ranking.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    const descriptionIndex = lines.findIndex((line) => /^description\s*:/i.test(line));
    if (descriptionIndex >= 0) {
      const first = lines[descriptionIndex].replace(/^description\s*:\s*/i, "").trim();
      if (/^[>|][+-]?$/.test(first)) {
        const continuation: string[] = [];
        for (const line of lines.slice(descriptionIndex + 1)) {
          if (!/^\s+/.test(line) && line.trim()) break;
          if (line.trim()) continuation.push(line.trim());
        }
        if (continuation.length > 0) {
          return first.startsWith(">") ? continuation.join(" ") : continuation.join("\n");
        }
      } else if (first) {
        return first.replace(/^["']|["']$/g, "");
      }
    }
  }

  // Fallback: first non-empty paragraph after frontmatter and the title.
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const lines = body.split("\n");
  const paragraphs: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.trim() === "" && current.trim()) {
      paragraphs.push(current.trim());
      current = "";
    } else if (!line.startsWith("#")) {
      current += line + "\n";
    }
  }
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs[0]?.slice(0, 200) ?? "No description";
}

/**
 * Rank skills using Jev relevance.
 */
async function rankSkills(
  query: string,
  skills: SkillCandidate[],
  signal?: AbortSignal,
): Promise<SkillCandidate[]> {
  // Build Noul questions for each skill
  const questions: Questions = {};
  for (let i = 0; i < skills.length; i++) {
    questions[`rel_${i}`] = noul(
      `Would loading \`skills[${i}]\` materially help complete \`task\`?`,
    );
  }

  const state = {
    task: query,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description.slice(0, 200),
    })),
  };

  const result = await judge(state, questions, {
    module: "skillGate",
    signal,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  // Blend calibrated semantic relevance with a deterministic lexical floor.
  // The floor protects exact technology/skill-name matches from occasional
  // low Noul scores in large multi-skill batches, while Jev still handles
  // semantic and cross-language matches with no token overlap.
  const scored = skills.map((s, i) => {
    const answer = result.answers[`rel_${i}`] as { noul: number } | undefined;
    const modelRelevance = answer?.noul ?? 0;
    const lexicalRelevance = scoreSkillLexically(query, s.name, s.description);
    return {
      ...s,
      relevance: lexicalRelevance > 0
        ? Math.max(modelRelevance * 0.8, lexicalRelevance)
        : modelRelevance,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

const SKILL_STOP_WORDS = new Set([
  "a", "an", "and", "build", "for", "in", "is", "of", "on", "the", "to", "use", "with",
  // Common Chinese function words and task scaffolding add noise to the
  // lexical floor; Jev still sees the complete natural-language query.
  "在", "中", "为", "和", "及", "的", "一个", "简单", "实现", "功能", "使用", "进行", "然后", "后", "检测",
]);

// The skill catalogue is predominantly English while user tasks are often
// Chinese. Normalize high-signal bilingual terms before calculating the
// deterministic floor. This does not replace Jev ranking; it only protects an
// explicit technology/workflow match from a low Noul in a large batch.
const SKILL_TERM_ALIASES: Record<string, string> = {
  "pickup": "pickup", "pickups": "pickup", "拾取": "pickup", "拾取物": "pickup", "捡起": "pickup",
  "交互": "interaction", "互动": "interaction", "interaction": "interaction", "interactions": "interaction",
  "生成": "spawn", "生成器": "spawner", "生成逻辑": "spawn", "spawn": "spawn", "spawner": "spawner",
  "重叠": "overlap", "重叠检测": "overlap", "碰撞": "collision", "overlap": "overlap",
  "射线": "trace", "追踪": "trace", "trace": "trace",
  "角色": "actor", "actor": "actor", "生命周期": "lifecycle", "销毁": "destroy", "销毁actor": "destroy",
  "半径": "radius", "交互半径": "radius", "可视反馈": "feedback", "视觉反馈": "feedback", "反馈": "feedback",
  "数据表": "datatable", "表格": "table", "网格体": "mesh", "网格": "mesh", "同步": "sync",
  "材质": "material", "蓝图": "blueprint", "行为树": "behavior", "黑板": "blackboard",
};

/**
 * Decide whether a ranked skill is relevant enough to recommend.
 *
 * Semantic-only matches need a slightly higher bar than explicit lexical
 * matches. This prevents generic tasks from loading an unrelated skill merely
 * because a large batch produced a marginal Noul score, while preserving
 * cross-language matches when the query contains a known technology/workflow
 * term.
 */
export function isSkillRelevant(
  query: string,
  name: string,
  description: string,
  relevance: number,
  threshold: number,
): boolean {
  if (!Number.isFinite(relevance) || relevance < threshold) return false;
  if (hasExplicitSkillExclusion(query, name, description)) return false;
  const lexicalRelevance = scoreSkillLexically(query, name, description);
  const semanticOnlyThreshold = Math.max(threshold, 0.65);
  return lexicalRelevance > 0 || relevance >= semanticOnlyThreshold;
}

/** Exact-token relevance floor used to stabilize semantic skill ranking. */
export function scoreSkillLexically(query: string, name: string, description: string): number {
  const queryTerms = skillTokens(query);
  if (queryTerms.size === 0) return 0;
  const nameTerms = skillTokens(name);
  const descriptionTerms = skillTokens(description);
  let matchedWeight = 0;
  for (const term of queryTerms) {
    if (nameTerms.has(term)) matchedWeight += 2;
    else if (descriptionTerms.has(term)) matchedWeight += 1;
  }
  return Math.min(1, matchedWeight / queryTerms.size);
}

function hasExplicitSkillExclusion(query: string, name: string, description: string): boolean {
  const queryTokens = skillTokens(query);
  const candidateTokens = new Set([...skillTokens(name), ...skillTokens(description)]);
  const lowerQuery = query.toLowerCase();

  for (const token of queryTokens) {
    if (!candidateTokens.has(token)) continue;
    // Tokens come from letters/numbers/CJK only, so they are safe to interpolate.
    const exclusion = new RegExp(
      `(?:不涉及|不使用|不要(?:使用)?|不需要|无需|不包括|排除|无关|not|without|excluding|no)\\s*(?:the\\s*)?${token}(?=$|[\\s,，。；;、])`,
      "i",
    );
    if (exclusion.test(lowerQuery)) return true;
  }
  return false;
}

function skillTokens(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const tokens = lowered.match(/[\p{L}\p{N}]+/gu) ?? [];
  const normalized = new Set<string>();

  for (const rawToken of tokens) {
    const token = rawToken.length > 4 && rawToken.endsWith("s") ? rawToken.slice(0, -1) : rawToken;
    if (token.length < 2 || SKILL_STOP_WORDS.has(token)) continue;
    const canonical = SKILL_TERM_ALIASES[token];
    // Long unsegmented Chinese sentences are not useful lexical terms. Their
    // meaningful parts are recovered by the substring aliases below.
    if (canonical) normalized.add(canonical);
    else if (!/[\u3400-\u9fff]/u.test(token) || token.length <= 4) normalized.add(token);
  }

  // CJK has no whitespace boundaries, so recover aliases embedded in phrases
  // such as “角色拾取物交互功能”. English terms are already tokenized above.
  for (const [alias, canonical] of Object.entries(SKILL_TERM_ALIASES)) {
    if (/^[\u3400-\u9fff]+$/u.test(alias) && lowered.includes(alias)) {
      normalized.add(canonical);
    }
  }
  return normalized;
}

/**
 * Format skills for output.
 */
function formatSkills(query: string, skills: SkillCandidate[]): string {
  if (skills.length === 0) {
    return tr("No relevant skills found.", "未找到相关技能。");
  }

  const lines = [
    tr(`Relevant skills for: "${query}"`, `与“${query}”相关的技能`),
    ``,
  ];

  skills.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name}`);
    lines.push(tr(`   relevance: ${s.relevance === null ? "n/a" : s.relevance.toFixed(2)}`, `   相关性：${s.relevance === null ? "无" : s.relevance.toFixed(2)}`));
    lines.push(`   ${s.description.slice(0, 150)}`);
    lines.push(tr(`   Path: ${s.path}`, `   路径：${s.path}`));
    lines.push(``);
  });

  lines.push(tr("Use `read` on the Path to load the full skill content.", "对该路径使用 `read` 可加载完整技能内容。"));
  return lines.join("\n");
}
