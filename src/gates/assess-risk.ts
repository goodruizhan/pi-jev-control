import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { tr } from "../i18n.js";
import { getJudgeUnavailableReason, judge, isJudgeAvailable } from "../judge/facade.js";
import { choiceOf } from "../judge/ir.js";
import { normalizeToolGateDecision } from "../judge/normalize.js";
import { classifyShellCommand } from "../judge/rules-backend.js";
import { OPERATION_RISK_QUESTION, TOOL_GATE_QUESTION } from "../judge/questions.js";
import { extractRouteRisk } from "../router/risk.js";
import { resolveJevGatePolicy } from "./tool-gate.js";

/**
 * Assess Risk — the model asks for a second opinion before acting.
 *
 * The tool gate used to put Jev in the blocking path: every unknown or mutating
 * call was judged and possibly denied, by a cheap model standing in front of a
 * stronger one. That path is gone. What remains here is a tool the model calls
 * when *it* is unsure — which is the only arrangement where the party with the
 * full context is also the party deciding.
 *
 * The deterministic part always runs and always lands in the answer. If
 * `isDangerousBashCommand` matches, that outranks any Jev verdict, because the
 * safety floor must not depend on a model.
 */

export type RiskLevel = "low" | "moderate" | "high";
export type GateVerdict = "allow" | "confirm" | "deny";

export interface AssessRiskResult {
  status: "ok" | "unavailable" | "disabled";
  risk?: RiskLevel;
  gateVerdict?: GateVerdict;
  policy?: "allow" | "deny" | "confirm";
  confidence: number;
  deterministic: {
    shellRisk: "safe" | "dangerous" | "uncertain";
    dangerous: boolean;
  };
  riskFeatures: string[];
  minimumTier: "cheap" | "medium" | "strong";
  backend?: string;
  latencyMs?: number;
}

export async function assessRisk(
  operation: string,
  tool?: string,
  details?: string,
  signal?: AbortSignal,
): Promise<AssessRiskResult> {
  const config = loadConfig();

  // ── Deterministic part: computed always, included always ────────────
  const bounded = operation.slice(0, 2000);
  const boundedDetails = (details ?? "").slice(0, 2000);
  // Classify each field independently: a prose summary must not conceal the
  // actual command in details, or turn two safe commands into shell composition.
  const shellRisks = [classifyShellCommand(bounded)];
  if (boundedDetails.trim()) shellRisks.push(classifyShellCommand(boundedDetails));
  const dangerous = shellRisks.includes("dangerous");
  const shellRisk = dangerous ? "dangerous" : shellRisks.includes("uncertain") ? "uncertain" : "safe";
  const route = extractRouteRisk(`${bounded}\n${boundedDetails}`);
  const base: AssessRiskResult = {
    status: "ok",
    confidence: 0,
    deterministic: { shellRisk, dangerous },
    riskFeatures: route.features,
    minimumTier: route.minimumTier,
  };

  if (!config.enabled) {
    return { ...base, status: "disabled" };
  }

  if (!isJudgeAvailable("toolGate")) {
    return { ...base, status: "unavailable" };
  }

  const result = await judge(
    {
      tool: (tool ?? "").slice(0, 120),
      operation: bounded,
      details: boundedDetails,
      risk_features: route.features,
      minimum_tier: route.minimumTier,
    },
    {
      risk: OPERATION_RISK_QUESTION,
      gate: TOOL_GATE_QUESTION,
    },
    { module: "toolGate", signal },
  );

  if (!result.ok) {
    return { ...base, status: "unavailable", backend: result.backend, latencyMs: result.latencyMs };
  }

  const riskAnswer = choiceOf(result.answers.risk);
  const gateAnswer = choiceOf(result.answers.gate);
  const riskChoice = riskAnswer.choice.trim().toLowerCase();
  const risk: RiskLevel | undefined =
    riskChoice === "low" || riskChoice === "moderate" || riskChoice === "high" ? riskChoice : undefined;
  const verdict = normalizeToolGateDecision(gateAnswer.choice);
  const policy = resolveJevGatePolicy(verdict, gateAnswer.confidence, config.toolGate.confirmOnLowConfidence);

  return {
    ...base,
    status: "ok",
    risk,
    gateVerdict: verdict,
    policy,
    confidence: gateAnswer.confidence,
    backend: result.backend,
    latencyMs: result.latencyMs,
  };
}

/** Register the `jev_assess_risk` tool. */
export function setupAssessRiskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_assess_risk",
    label: tr("Jev Assess Risk", "Jev 风险自查"),
    description: tr(
      "Check how risky an operation is before you run it. Use it when you are about to do something you are not sure is safe: bulk renames, deletions, migrations, regenerating assets, publishing, or any action you would not want to have to undo. Returns a Jev risk rating and gate verdict, plus a deterministic classification of any shell command in the description. The tool gate no longer blocks you automatically — the decision stays yours.",
      "在执行一个操作前自查风险。使用时机：批量重命名、删除、迁移、资产重生成、发布，或任何你不希望不得不撤销的操作。返回 Jev 的风险评级与门控结论，以及对描述中 shell 命令的确定性分类。工具门控不再自动拦截你，决定权在你。",
    ),
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: tr("What you intend to do", "你打算做什么"),
        },
        tool: {
          type: "string",
          description: tr("Optional tool name involved", "可选：涉及的工具名"),
        },
        details: {
          type: "string",
          description: tr("Optional specifics (paths, counts, command)", "可选：具体细节（路径、数量、命令）"),
        },
      },
      required: ["operation"],
    },
    async execute(_toolCallId, params, signal) {
      const operation = String(params.operation ?? "").slice(0, 2000);
      const tool = typeof params.tool === "string" ? params.tool.slice(0, 120) : undefined;
      const details = typeof params.details === "string" ? params.details.slice(0, 2000) : undefined;

      const result = await assessRisk(operation, tool, details, signal);

      const lines = [
        result.status === "disabled"
          ? tr("pi-jev-control is disabled, nothing was assessed.", "pi-jev-control 已关闭，未评估。")
          : tr(
            `Risk check: ${result.risk ?? "unknown"}${result.backend ? ` [${result.backend}]` : ""}`,
            `风险检查：${result.risk ?? "未知"}${result.backend ? ` [${result.backend}]` : ""}`,
          ),
      ];

      if (result.status === "unavailable") {
        lines.push(tr(
          `Jev is unavailable (${getJudgeUnavailableReason() ?? "unknown"}), so only the deterministic result below is meaningful.`,
          `Jev 不可用（${getJudgeUnavailableReason() ?? "未知"}），因此只有下面的确定性结果有效。`,
        ));
      }

      if (result.deterministic.dangerous) {
        lines.push(tr(
          "DETERMINISTIC: this matches a known dangerous shell pattern. This outranks any model verdict.",
          "确定性规则：命中已知危险 shell 模式。该结论优先于任何模型判断。",
        ));
      } else {
        lines.push(tr(
          `Deterministic shell risk: ${result.deterministic.shellRisk}`,
          `确定性 shell 风险：${result.deterministic.shellRisk}`,
        ));
      }

      if (result.riskFeatures.length > 0) {
        lines.push(tr(
          `Deterministic risk features: ${result.riskFeatures.join(", ")} (minimum tier ${result.minimumTier})`,
          `确定性风险特征：${result.riskFeatures.join(", ")}（最低等级 ${result.minimumTier}）`,
        ));
      }
      if (result.gateVerdict) {
        lines.push(tr(
          `Jev gate verdict: ${result.gateVerdict} (confidence ${result.confidence.toFixed(2)}), suggested policy: ${result.policy}`,
          `Jev 门控结论：${result.gateVerdict}（置信度 ${result.confidence.toFixed(2)}），建议策略：${result.policy}`,
        ));
      }

      lines.push("");
      lines.push(tr(
        "This is a second opinion, not a verdict. Decide whether to proceed.",
        "这只是第二意见，不是判决。是否执行由你决定。",
      ));

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
}
