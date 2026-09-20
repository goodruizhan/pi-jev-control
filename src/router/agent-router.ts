import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { AGENT_TYPE_QUESTION } from "../judge/questions.js";
import { normalizeAgentType } from "../judge/normalize.js";
import { Type } from "typebox";
import type { AgentType } from "../types.js";
import { tr } from "../i18n.js";

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
    label: tr("Jev Agent Router", "Jev 代理路由"),
    description: tr("Determine which agent type (scout/coder/reviewer) is best for the current task using Jev.", "使用 Jev 判断当前任务最适合侦察、编码还是审查代理。"),
    parameters: Type.Object({
      query: Type.String({ description: tr("The task or goal", "任务或目标") }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      if (!config.enabled || !config.agentRouter.enabled) {
        return {
          content: [{ type: "text", text: tr("Jev Agent Router is disabled.", "Jev 代理路由已关闭。") }],
          details: {},
        };
      }
      const query = (params.query as string).trim().slice(0, 1000);

      if (!isJudgeAvailable()) {
        return {
          content: [{ type: "text", text: tr("Jev API unavailable — cannot route agent.", "Jev API 不可用——无法进行代理路由。") }],
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

      const result = await judge(state, questions, {
        module: "router",
        signal,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: tr(`Jev routing failed: ${result.error}`, `Jev 路由失败：${result.error}`) }],
          details: {},
        };
      }

      const { choice, confidence } = choiceOf(result.answers.agent_type);
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
    scout: tr("Search, read, locate files, filter logs, gather evidence.", "搜索、阅读、定位文件、筛选日志并收集证据。"),
    coder: tr("Implement, fix, standard coding/debug.", "实现功能、修复问题以及常规编码和调试。"),
    reviewer: tr("High-risk code review, complex architecture, crash, GC, GAS, threading.", "高风险代码审查、复杂架构、崩溃、GC、GAS 和多线程。"),
    unknown: tr("Insufficient information to determine agent type.", "信息不足，无法确定代理类型。"),
  };

  const lines = [
    tr(`Agent routing for: "${query}"`, `任务“${query}”的代理路由`),
    ``,
    tr(`Recommended: ${agent}`, `建议代理：${agent}`),
    tr(`Confidence: ${confidence.toFixed(2)}`, `置信度：${confidence.toFixed(2)}`),
    ``,
    tr(`Description: ${descriptions[agent]}`, `说明：${descriptions[agent]}`),
  ];

  if (availableSubagents.length > 0) {
    lines.push(``, tr(`Available subagent tools: ${availableSubagents.join(", ")}`, `可用子代理工具：${availableSubagents.join(", ")}`));
    lines.push(tr("Consider using the subagent tool to delegate this task.", "可考虑使用子代理工具委派此任务。"));
  } else {
    lines.push(``, tr("No subagent tools available. Use the recommended approach directly.", "没有可用的子代理工具，请直接采用建议的方法。"));
  }

  return lines.join("\n");
}
