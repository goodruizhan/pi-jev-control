import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { choice } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { UIActionCandidate } from "../types.js";

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
    label: "Jev GUI Action Router",
    description: "Select the best UI control from candidates for a goal using Jev. Returns the best match ID or unknown.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What action to perform (e.g. 'click the save button')",
        },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for this control" },
              label: { type: "string", description: "Display label" },
              role: { type: "string", description: "UI role (button, text, menu, etc.)" },
              description: { type: "string", description: "Additional description" },
            },
            required: ["id"],
          },
          description: "Candidate UI controls to choose from",
        },
      },
      required: ["goal", "candidates"],
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const goal = params.goal as string;
      const candidates = params.candidates as UIActionCandidate[];

      if (!candidates || candidates.length === 0) {
        return {
          content: [{ type: "text", text: "No candidates provided." }],
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
    `GUI Action Selection`,
    `Goal: "${goal}"`,
    ``,
  ];

  if (result.id === "unknown") {
    lines.push(`Result: UNKNOWN (insufficient confidence or Jev unavailable)`);
    lines.push(`Candidates (${candidates.length}):`);
    for (const c of candidates) {
      lines.push(`  - ${c.id}: ${c.label ?? ""} ${c.description ?? ""}`.trim());
    }
  } else {
    const matched = candidates.find((c) => c.id === result.id);
    lines.push(`Result: ${result.id}`);
    lines.push(`Confidence: ${result.confidence.toFixed(2)}`);
    if (matched) {
      lines.push(`Label: ${matched.label ?? "N/A"}`);
      lines.push(`Role: ${matched.role ?? "N/A"}`);
      lines.push(`Description: ${matched.description ?? "N/A"}`);
    }
    lines.push(``, `Action: Use the matched control with the GUI tool (Computer Use, UE MCP, etc.).`);
  }

  return lines.join("\n");
}
