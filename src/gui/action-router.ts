import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { choice } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { UIActionCandidate } from "../types.js";
import { tr } from "../i18n.js";

/**
 * GUI Action Router — selects the best target from candidate UI controls.
 *
 * Only responsible for selection. Actual execution is done by
 * Computer Use, UE MCP, or other GUI tools.
 *
 * If confidence < threshold → return unknown, never force-click.
 */

/**
 * Choose a UI action target from candidates using Jev.
 */
export async function chooseUIAction(
  goal: string,
  candidates: UIActionCandidate[],
  signal?: AbortSignal,
): Promise<{ id: string; confidence: number }> {
  const config = loadConfig();
  if (!config.enabled || !config.guiRouter.enabled) {
    return { id: "unknown", confidence: 0 };
  }
  if (!isJevAvailable()) {
    return { id: "unknown", confidence: 0 };
  }

  if (candidates.length === 0) {
    return { id: "unknown", confidence: 0 };
  }

  // Use generated option keys instead of untrusted candidate IDs as object keys.
  const boundedCandidates = candidates
    .filter((candidate) => typeof candidate.id === "string" && candidate.id.trim().length > 0)
    .slice(0, 50);
  if (boundedCandidates.length === 0) {
    return { id: "unknown", confidence: 0 };
  }
  const choices: Record<string, null> = {};
  const optionToCandidate = new Map<string, UIActionCandidate>();
  for (let i = 0; i < boundedCandidates.length; i++) {
    const option = `candidate_${i}`;
    choices[option] = null;
    optionToCandidate.set(option, boundedCandidates[i]);
  }

  const question = choice(
    "Choose the option key whose corresponding entry in `candidates` best satisfies `goal`.",
    choices,
  );

  const state = {
    goal: goal.slice(0, 300),
    candidates: boundedCandidates.map((c, index) => ({
      option: `candidate_${index}`,
      id: c.id,
      label: c.label ?? "",
      role: c.role ?? "",
      description: (c.description ?? "").slice(0, 200),
    })),
  };

  const questions: Questions = {
    ui_action: question,
  };

  const result = await callJev(state, questions, {
    module: "gui",
    signal,
  });

  if (!result.ok) {
    return { id: "unknown", confidence: 0 };
  }

  const choiceAnswer = result.result.answers.ui_action as { choice: string; confidence: number };
  const id = optionToCandidate.get(choiceAnswer.choice)?.id ?? "unknown";
  const confidence = choiceAnswer.confidence;

  // Check confidence threshold
  if (id === "unknown" || confidence < config.guiRouter.confidenceThreshold) {
    return { id: "unknown", confidence: 0 };
  }

  return { id, confidence };
}

/**
 * Setup the GUI Action Router — registers the jev_choose_ui_action tool.
 */
export function setupGUIActionRouter(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_choose_ui_action",
    label: tr("Jev GUI Action Router", "Jev GUI 操作路由"),
    description: tr("Select the best UI control from candidates for a goal using Jev. Returns the best match ID or unknown.", "使用 Jev 从候选项中选择最符合目标的 UI 控件，并返回匹配 ID 或 unknown。"),
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: tr("What action to perform (e.g. 'click the save button')", "要执行的操作（例如“点击保存按钮”）"),
        },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: tr("Unique identifier for this control", "此控件的唯一标识符") },
              label: { type: "string", description: tr("Display label", "显示标签") },
              role: { type: "string", description: tr("UI role (button, text, menu, etc.)", "UI 角色（按钮、文本、菜单等）") },
              description: { type: "string", description: tr("Additional description", "附加说明") },
            },
            required: ["id"],
          },
          description: tr("Candidate UI controls to choose from", "可供选择的候选 UI 控件"),
        },
      },
      required: ["goal", "candidates"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const goal = params.goal as string;
      const candidates = params.candidates as UIActionCandidate[];

      if (!candidates || candidates.length === 0) {
        return {
          content: [{ type: "text", text: tr("No candidates provided.", "未提供候选项。") }],
          details: {},
        };
      }

      const result = await chooseUIAction(goal, candidates, signal);

      const output = formatGUIActionResult(goal, candidates, result);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  });
}

/**
 * Format GUI action result for output.
 */
function formatGUIActionResult(
  goal: string,
  candidates: UIActionCandidate[],
  result: { id: string; confidence: number },
): string {
  const lines = [
    tr("GUI Action Selection", "GUI 操作选择"),
    tr(`Goal: "${goal}"`, `目标：“${goal}”`),
    ``,
  ];

  if (result.id === "unknown") {
    lines.push(tr("Result: UNKNOWN (insufficient confidence or Jev unavailable)", "结果：未知（置信度不足或 Jev 不可用）"));
    lines.push(tr(`Candidates (${candidates.length}):`, `候选项（${candidates.length} 个）：`));
    for (const c of candidates) {
      lines.push(`  - ${c.id}: ${c.label ?? ""} ${c.description ?? ""}`.trim());
    }
  } else {
    const matched = candidates.find((c) => c.id === result.id);
    lines.push(tr(`Result: ${result.id}`, `结果：${result.id}`));
    lines.push(tr(`Confidence: ${result.confidence.toFixed(2)}`, `置信度：${result.confidence.toFixed(2)}`));
    if (matched) {
      lines.push(tr(`Label: ${matched.label ?? "N/A"}`, `标签：${matched.label ?? "无"}`));
      lines.push(tr(`Role: ${matched.role ?? "N/A"}`, `角色：${matched.role ?? "无"}`));
      lines.push(tr(`Description: ${matched.description ?? "N/A"}`, `说明：${matched.description ?? "无"}`));
    }
    lines.push(``, tr("Action: Use the matched control with the GUI tool (Computer Use, UE MCP, etc.).", "操作：使用 GUI 工具（Computer Use、UE MCP 等）操作匹配的控件。"));
  }

  return lines.join("\n");
}
