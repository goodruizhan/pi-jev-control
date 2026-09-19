import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { Type } from "typebox";
import { noul } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// Directories to scan for skills
const SKILL_DIRS = [
  path.join(os.homedir(), ".pi", "agent", "skills"),
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
    label: "Jev Skill Selection",
    description: "Select the most relevant Pi skills for the current task using Jev-powered relevance ranking.",
    parameters: Type.Object({
      query: Type.String({ description: "The current task or goal" }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum skills to return (default: 4)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      if (!config.enabled || !config.skillGate.enabled) {
        return {
          content: [{ type: "text", text: "Jev Skill Gate is disabled." }],
          details: {},
        };
      }
      const query = (params.query as string).trim().slice(0, 500);
      const maxResults = Math.min(20, Math.max(1, Math.floor((params.maxResults as number | undefined) ?? config.skillGate.maxSelected)));

      // Step 1: Discover skills
      const skills = discoverSkills();

      if (skills.length === 0) {
        return {
          content: [{ type: "text", text: "No skills discovered." }],
          details: {},
        };
      }

      // Step 2: Rank with Jev
      let ranked = skills;
      let rankedByJev = false;

      if (isJevAvailable() && skills.length > 0) {
        try {
          ranked = await rankSkills(query, skills, signal);
          rankedByJev = true;
        } catch {
          // Jev failed — return all skills
          ranked = skills;
        }
      }

      if (rankedByJev) {
        ranked = ranked.filter((skill) => (skill.relevance ?? 0) >= config.skillGate.relevanceThreshold);
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
function extractDescription(content: string): string {
  // Try frontmatter description
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    if (descMatch) {
      return descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  // Fallback: first non-empty paragraph after the title
  const lines = content.split("\n");
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

  const result = await callJev(state, questions, {
    module: "skillGate",
    signal,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  // Sort by relevance probability descending
  const scored = skills.map((s, i) => {
    const answer = result.result.answers[`rel_${i}`] as { noul: number } | undefined;
    return {
      ...s,
      relevance: answer?.noul ?? 0,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Format skills for output.
 */
function formatSkills(query: string, skills: SkillCandidate[]): string {
  if (skills.length === 0) {
    return "No relevant skills found.";
  }

  const lines = [
    `Relevant skills for: "${query}"`,
    ``,
  ];

  skills.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name}`);
    lines.push(`   relevance: ${s.relevance === null ? "n/a" : s.relevance.toFixed(2)}`);
    lines.push(`   ${s.description.slice(0, 150)}`);
    lines.push(`   Path: ${s.path}`);
    lines.push(``);
  });

  lines.push("Use `read` on the Path to load the full skill content.");
  return lines.join("\n");
}
