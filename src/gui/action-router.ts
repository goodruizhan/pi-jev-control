import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { choice } from "../judge/ir.js";
import type { Questions } from "../judge/ir.js";
import type { UIActionCandidate } from "../types.js";
import { tr } from "../i18n.js";
import crypto from "node:crypto";
import { recordGUICacheHit, recordGUIRiskDeferral } from "../stats/savings.js";

export interface UIActionResult {
  id: string;
  confidence: number;
  risk: "low" | "needs_user";
  cached?: boolean;
}

const uiCache = new Map<string, { turn: number; result: UIActionResult }>();
let uiTurn = 0;

const HIGH_RISK_GOAL = /\b(password|credential|login|sign in|payment|purchase|buy|delete|publish|send|submit|transfer)\b|密码|凭据|登录|支付|购买|删除|发布|发送|提交|转账/i;

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
): Promise<UIActionResult> {
  const config = loadConfig();
  if (!config.enabled || !config.guiRouter.enabled) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }
  if (HIGH_RISK_GOAL.test(goal)) {
    recordGUIRiskDeferral();
    return { id: "unknown", confidence: 1, risk: "needs_user" };
  }
  if (!isJudgeAvailable()) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }

  if (candidates.length === 0) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }

  // Use generated option keys instead of untrusted candidate IDs as object keys.
  const boundedCandidates = candidates
    .filter((candidate) => typeof candidate.id === "string" && candidate.id.trim().length > 0)
    .slice(0, 50);
  if (boundedCandidates.length === 0) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }
  const cacheKey = crypto.createHash("sha256")
    .update(JSON.stringify({ goal: goal.slice(0, 300), candidates: boundedCandidates }))
    .digest("hex")
    .slice(0, 24);
  const cached = uiCache.get(cacheKey);
  if (cached && uiTurn - cached.turn <= config.guiRouter.cacheTurns) {
    recordGUICacheHit();
    return { ...cached.result, cached: true };
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

  const result = await judge(state, questions, {
    module: "gui",
    signal,
    timeoutMs: config.guiRouter.timeoutMs,
  });

  if (!result.ok) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }

  const choiceAnswer = result.answers.ui_action as { choice: string; confidence: number };
  const id = optionToCandidate.get(choiceAnswer.choice)?.id ?? "unknown";
  const confidence = choiceAnswer.confidence;

  // Check confidence threshold
  if (id === "unknown" || confidence < config.guiRouter.confidenceThreshold) {
    return { id: "unknown", confidence: 0, risk: "low" };
  }

  const actionResult: UIActionResult = { id, confidence, risk: "low" };
  uiCache.set(cacheKey, { turn: uiTurn, result: actionResult });
  return actionResult;
}

/**
 * Setup the GUI Action Router — registers the jev_choose_ui_action tool.
 */
export function setupGUIActionRouter(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    uiTurn += 1;
    const ttl = Math.max(0, loadConfig().guiRouter.cacheTurns);
    for (const [key, entry] of uiCache) {
      if (uiTurn - entry.turn > ttl) uiCache.delete(key);
    }
  });

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
  result: UIActionResult,
): string {
  const matched = result.id === "unknown" ? undefined : candidates.find((candidate) => candidate.id === result.id);
  return JSON.stringify({
    goal: goal.slice(0, 120),
    ...result,
    label: matched?.label,
    instruction: result.risk === "needs_user" ? "request_user_control" : result.id === "unknown" ? "inspect_ui_again" : "execute_with_gui_tool",
  });
}
