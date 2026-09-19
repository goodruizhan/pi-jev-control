import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { callJev, isJevAvailable } from "../jev/client.js";
import { AGENT_TYPE_QUESTION } from "../jev/questions.js";
import { normalizeAgentType } from "../jev/normalize.js";
import { Type } from "typebox";
import type { AgentType } from "../types.js";

/**
 * Agent Router — determines which agent type is best for the current task.
 *
 * Output: scout, coder, reviewer, or unknown.
 * - scout: search, read, locate files, filter logs, gather evidence
 * - coder: implement, fix, standard coding/debug
 * - reviewer: high-risk code review, complex architecture, crash, GC, GAS, threading
 * - unknown: insufficient information
 *
 * Provides jev_route_agent tool. Does NOT directly import pi-subagents.
 * Detects subagent tools via pi.getAllTools() if available.
 */

export interface AgentRouteResult {
  agent: AgentType;
  confidence: number;
  availableSubagents: string[];
}

/**
 * Setup the Agent Router — registers the jev_route_agent tool.
 */
export function setupAgentRouter(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_route_agent",
    label: "Jev Agent Router",
    description: "Determine which agent type (scout/coder/reviewer) is best for the current task using Jev.",
    parameters: Type.Object({
      query: Type.String({ description: "The task or goal" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      if (!config.enabled || !config.agentRouter.enabled) {
        return {
          content: [{ type: "text", text: "Jev Agent Router is disabled." }],
          details: {},
        };
      }
      const query = (params.query as string).trim().slice(0, 1000);

      if (!isJevAvailable()) {
        return {
          content: [{ type: "text", text: "Jev API unavailable — cannot route agent." }],
          details: {},
        };
      }

      // Check for available subagent tools
      let availableSubagents: string[] = [];
      try {
        const allTools = pi.getAllTools();
        availableSubagents = allTools
          .filter((t) => t.name === "subagent" || t.name.includes("agent"))
          .map((t) => t.name);
      } catch {
        // pi.getAllTools() not available
      }

      // Use Jev to classify
      const state = {
        task: query,
        domain: "software development with Pi; often Unreal Engine 5",
      };

      const questions = {
        agent_type: AGENT_TYPE_QUESTION,
      };

      const result = await callJev(state, questions, {
        module: "router",
        signal,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Jev routing failed: ${result.error}` }],
          details: {},
        };
      }

      const choice = result.result.answers.agent_type.choice;
      const confidence = result.result.answers.agent_type.confidence;
      const agent = normalizeAgentType(choice);

      const output = formatAgentRoute(query, agent, confidence, availableSubagents);
      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  });
}

/**
 * Format agent route result.
 */
function formatAgentRoute(
  query: string,
  agent: AgentType,
  confidence: number,
  availableSubagents: string[],
): string {
  const descriptions: Record<AgentType, string> = {
    scout: "Search, read, locate files, filter logs, gather evidence.",
    coder: "Implement, fix, standard coding/debug.",
    reviewer: "High-risk code review, complex architecture, crash, GC, GAS, threading.",
    unknown: "Insufficient information to determine agent type.",
  };

  const lines = [
    `Agent routing for: "${query}"`,
    ``,
    `Recommended: ${agent}`,
    `Confidence: ${confidence.toFixed(2)}`,
    ``,
    `Description: ${descriptions[agent]}`,
  ];

  if (availableSubagents.length > 0) {
    lines.push(``, `Available subagent tools: ${availableSubagents.join(", ")}`);
    lines.push(`Consider using the subagent tool to delegate this task.`);
  } else {
    lines.push(``, `No subagent tools available. Use the recommended approach directly.`);
  }

  return lines.join("\n");
}
