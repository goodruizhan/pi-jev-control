import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, getConfigPath, saveLanguage } from "../src/config.js";
import { normalizeLanguage, onOff, tr, trFor } from "../src/i18n.js";
import { PLUGIN_VERSION } from "../src/version.js";
import { ROUTER_MODES, isRouterMode } from "../src/types.js";
import { runtimeState, resetState } from "../src/state/runtime-state.js";
import { resetStats, formatStats } from "../src/stats/stats.js";
import { resetSavings, formatSavings } from "../src/stats/savings.js";
import { isJudgeAvailable, getJudgeUnavailableReason, judge } from "../src/judge/facade.js";
import { allConfiguredBackends } from "../src/judge/registry.js";
import { setNextRouteOverride, setupTaskRouter } from "../src/router/task-router.js";
import { modelCandidates } from "../src/router/model-router.js";
import { setupToolGate } from "../src/gates/tool-gate.js";
import { setupFailureClassifier } from "../src/judgment/failure-classifier.js";
import { setupContextGate } from "../src/gates/context-gate.js";
import { setupSkillGate } from "../src/gates/skill-gate.js";
import { setupAgentRouter } from "../src/router/agent-router.js";
import { analyzeUserInput } from "../src/memory/memory-gate.js";
import { searchMemory } from "../src/memory/retrieval.js";
import { clearAllMemory, ensureMemoryStore, getMemoryCount, getDataPath, markFailureResolved } from "../src/memory/store.js";
import { choice } from "../src/judge/ir.js";
import { Type } from "typebox";
// v0.3 imports
import { setupContextHook, setupSessionBeforeCompact } from "../src/compaction/context-hook.js";
import { clearEpochPlan, requestEpochPlan, resetEpoch, getEpochInfo } from "../src/compaction/epoch.js";
import { setupReviewGate } from "../src/review/review-gate.js";
import { setupGUIActionRouter } from "../src/gui/action-router.js";
import { resetDecisionCopilot, setupDecisionCopilot } from "../src/decision/batch.js";
// Model-initiated inquiry tools (architecture inversion: the model asks Jev,
// Jev never decides on the model's behalf)
import { setupAssessTaskTool } from "../src/router/assess-task.js";
import { setupModelTierTool } from "../src/router/model-tier.js";
import { setupAssessRiskTool } from "../src/gates/assess-risk.js";
import { setupDiagnoseFailureTool } from "../src/judgment/diagnose-failure.js";
import { setupPruneContextTool } from "../src/compaction/prune-context.js";
import { setupMemoryAddTool } from "../src/memory/memory-add.js";
import { setupRankTool } from "../src/judge/rank.js";


/**
 * pi-jev-control — Jev-powered control layer for Pi Coding Agent
 *
 * v0.2: Task Router, Model Router, Tool Gate, Failure Classifier, Retry Judge, Stats,
 *        Context Gate (jev_search_code), Skill Gate (jev_select_skills),
 *        Agent Router (jev_route_agent), Memory Gate, Memory Store, Memory Search,
 *        Project config override
 */

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (!config.enabled) {
    console.log(tr("[pi-jev-control] Disabled in config", "[pi-jev-control] 已在配置中禁用"));
    return;
  }

  if (config.memoryGate.enabled) ensureMemoryStore();

  // Warn once when the model router still has placeholder targets — routing
  // silently no-ops in that state, which is confusing without a hint.
  if (config.router.enabled && config.router.mode === "set-model") {
    const specs = Object.values(config.router.models).flatMap(modelCandidates);
    if (specs.some((spec) => spec.provider === "REPLACE_ME" || spec.model === "REPLACE_ME")) {
      console.log(tr(
        `[pi-jev-control] router.models contains REPLACE_ME placeholders — set real provider/model in ${getConfigPath()} to enable model routing`,
        `[pi-jev-control] router.models 仍是 REPLACE_ME 占位符——请在 ${getConfigPath()} 中配置真实的 provider/model 以启用模型路由`,
      ));
    }
  }

  // ── Setup event handlers ────────────────────────────────────────

  // Task Router (input event)
  setupTaskRouter(pi);

  // Tool Gate (tool_call event)
  setupToolGate(pi);

  // Failure Classifier (tool_result event)
  setupFailureClassifier(pi);

  // Context Gate (jev_search_code tool)
  setupContextGate(pi);

  // Skill Gate (jev_select_skills tool)
  setupSkillGate(pi);

  // Agent Router (jev_route_agent tool)
  setupAgentRouter(pi);

  // Memory Search (jev_memory_search tool)
  registerMemorySearchTool(pi);

  // Memory Gate (input event for constraint/decision detection)
  setupMemoryGate(pi);

  // ── v0.3: Compaction ─────────────────────────────────────────────

  // Context Hook (context event — pruning)
  setupContextHook(pi);

  // Session Before Compact (ensure memory before Pi compacts)
  setupSessionBeforeCompact(pi);

  // ── v0.3: Review Gate ────────────────────────────────────────────

  setupReviewGate(pi);

  // ── v0.3: GUI Action Router ──────────────────────────────────────

  setupGUIActionRouter(pi);

  // Silent, bounded multi-question decision copilot
  setupDecisionCopilot(pi);

  // ── Model-initiated inquiry tools ─────────────────────────────────

  // Task complexity, asked by the model instead of being inferred on its behalf.
  setupAssessTaskTool(pi);

  // The model switches its own tier; nothing does it automatically anymore.
  setupModelTierTool(pi);

  // Second opinion on an operation before running it.
  setupAssessRiskTool(pi);

  // Failure diagnosis pulled on demand.
  setupDiagnoseFailureTool(pi);

  // Context pruning requested by the model.
  setupPruneContextTool(pi);

  // Memory captured by explicit request.
  setupMemoryAddTool(pi);

  // Generic candidate ranking primitive.
  setupRankTool(pi);

  // ── Register /jev command ───────────────────────────────────────

  pi.registerCommand("jev", {
    description: tr("Jev control layer — status, probe, stats, router/gate toggles", "Jev 控制层——状态、测试、统计和路由/门控开关"),
    handler: async (args, ctx) => {
      const config = loadConfig();
      const arg = (args ?? "").trim().toLowerCase();

      // /jev or /jev status — show status
      if (arg === "" || arg === "status") {
        const status = buildStatus(config);
        ctx.ui.notify(status, "info");
        return;
      }

      // /jev language en|zh-CN — persist UI language
      if (arg.startsWith("language ")) {
        const language = normalizeLanguage(arg.slice("language ".length));
        if (!language) {
          ctx.ui.notify(tr("Usage: /jev language en|zh-CN", "用法：/jev language en|zh-CN"), "warning");
          return;
        }
        saveLanguage(language);
        ctx.ui.notify(trFor(language, "Language changed to English.", "语言已切换为简体中文。"), "info");
        return;
      }

      // /jev probe — test Jev API
      if (arg === "probe") {
        await runProbe(ctx);
        return;
      }

      // /jev stats — show stats
      if (arg === "stats") {
        ctx.ui.notify(formatStats(), "info");
        return;
      }

      // /jev last — show last routing decision
      if (arg === "last") {
        const state = runtimeState;
        if (state.lastRouteAudit) {
          const audit = state.lastRouteAudit;
          ctx.ui.notify(tr(
            `Last route: ${audit.success ? "success" : "failed"}\nraw: ${audit.rawChoice} (${audit.rawConfidence.toFixed(2)})\nrequested: ${audit.requestedTier}; effective: ${audit.effectiveTier ?? "none"}\nmodel: ${audit.provider ?? "?"}/${audit.model ?? "?"}; thinking: ${audit.thinking ?? "?"}\nsource: ${audit.source}; reason: ${audit.reason ?? "none"}\ntime: ${new Date(audit.timestamp).toLocaleTimeString()}`,
            `上次路由：${audit.success ? "成功" : "失败"}\n原始判断：${audit.rawChoice}（${audit.rawConfidence.toFixed(2)}）\n请求等级：${audit.requestedTier}；实际等级：${audit.effectiveTier ?? "无"}\n模型：${audit.provider ?? "?"}/${audit.model ?? "?"}；思考等级：${audit.thinking ?? "?"}\n来源：${audit.source}；原因：${audit.reason ?? "无"}\n时间：${new Date(audit.timestamp).toLocaleTimeString()}`,
          ), "info");
        } else {
          ctx.ui.notify(tr("No routing decision recorded yet.", "尚未记录路由决策。"), "info");
        }
        return;
      }

      if (/^route (cheap|medium|strong)$/.test(arg)) {
        if (!config.router.enabled || config.router.mode === "off") {
          ctx.ui.notify(tr("Router is disabled; enable it before setting a route override.", "路由器已关闭；请先开启再指定等级。"), "warning");
          return;
        }
        const tier = arg.split(" ")[1] as "cheap" | "medium" | "strong";
        setNextRouteOverride(tier);
        ctx.ui.notify(tr(
          `Next substantive input will use ${tier} tier.`,
          `下一条实质性输入将使用 ${tier} 等级。`,
        ), "info");
        return;
      }

      // /jev router mode <rules-only|advisory|tier-only|set-model|off>
      if (arg.startsWith("router mode ")) {
        const mode = arg.slice("router mode ".length).trim();
        if (!isRouterMode(mode)) {
          ctx.ui.notify(tr(
            `Usage: /jev router mode ${ROUTER_MODES.join("|")}`,
            `用法：/jev router mode ${ROUTER_MODES.join("|")}`,
          ), "warning");
          return;
        }
        config.router.mode = mode;
        ctx.ui.notify(tr(`Router mode: ${mode}`, `路由模式：${mode}`), "info");
        ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
        return;
      }

      // /jev router on|off — toggle Task Router
      if (arg.startsWith("router ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "router", config, ctx);
        return;
      }

      // /jev toolgate on|off — toggle Tool Gate
      if (arg.startsWith("toolgate ")) {
        const action = arg.split(" ")[1];
        if (action === "advisory" || action === "enforce") {
          config.toolGate.mode = action;
          ctx.ui.notify(tr(
            `Tool Gate mode: ${action}`,
            `工具门控模式：${action === "advisory" ? "辅助（不确认、不拦截）" : "严格（允许确认和拦截）"}`,
          ), "info");
          return;
        }
        toggleModule(action, "toolGate", config, ctx);
        return;
      }

      // /jev retry append on|off — whether assessments are appended to tool results
      if (arg.startsWith("retry append ")) {
        const action = arg.slice("retry append ".length).trim();
        if (action !== "on" && action !== "off") {
          ctx.ui.notify(tr("Usage: /jev retry append on|off", "用法：/jev retry append on|off"), "warning");
          return;
        }
        config.retryJudge.appendToResult = action === "on";
        ctx.ui.notify(tr(
          `Retry Judge appends assessments to tool results: ${action.toUpperCase()}`,
          `重试判断向工具结果追加评估：${action === "on" ? "开启" : "关闭"}`,
        ), "info");
        ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
        return;
      }

      // /jev decision on|off — toggle Decision Copilot
      if (arg.startsWith("decision ")) {
        toggleModule(arg.split(" ")[1], "decisionCopilot", config, ctx);
        return;
      }

      // /jev retry on|off — toggle Retry Judge
      if (arg.startsWith("retry ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "retryJudge", config, ctx);
        return;
      }

      // /jev contextgate on|off — toggle Context Gate
      if (arg.startsWith("contextgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "contextGate", config, ctx);
        return;
      }

      // /jev skillgate on|off — toggle Skill Gate
      if (arg.startsWith("skillgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "skillGate", config, ctx);
        return;
      }

      if (arg.startsWith("agentrouter ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "agentRouter", config, ctx);
        return;
      }

      if (arg.startsWith("reviewgate ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "reviewGate", config, ctx);
        return;
      }

      if (arg.startsWith("guirouter ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "guiRouter", config, ctx);
        return;
      }

      // /jev memory clear — clear all memory
      if (arg === "memory clear") {
        clearAllMemory();
        ctx.ui.notify(tr("All memory records cleared.", "所有记忆记录已清除。"), "info");
        return;
      }

      if (arg.startsWith("memory resolve ")) {
        const id = arg.slice("memory resolve ".length).trim();
        const resolved = id.length > 0 && markFailureResolved(id);
        ctx.ui.notify(
          resolved
            ? tr(`Failure ${id} marked resolved.`, `失败记录 ${id} 已标记为解决。`)
            : tr(`Failure ${id || "(missing id)"} not found.`, `未找到失败记录 ${id || "（缺少 ID）"}。`),
          resolved ? "info" : "warning",
        );
        return;
      }

      // /jev memory stats — show memory store info
      if (arg === "memory stats") {
        const counts = getMemoryCount();
        ctx.ui.notify(
          tr(
            `Memory Store:\n  Path: ${getDataPath()}\n  Memory records: ${counts.memory}\n  Failure records: ${counts.failures}`,
            `记忆存储（Memory Store:）\n  路径：${getDataPath()}\n  记忆记录：${counts.memory}\n  失败记录：${counts.failures}`,
          ),
          "info",
        );
        return;
      }

      // /jev memory mode <suggest|auto>
      if (arg.startsWith("memory mode ")) {
        const mode = arg.slice("memory mode ".length).trim();
        if (mode !== "suggest" && mode !== "auto") {
          ctx.ui.notify(tr("Usage: /jev memory mode suggest|auto", "用法：/jev memory mode suggest|auto"), "warning");
          return;
        }
        config.memoryGate.mode = mode;
        ctx.ui.notify(tr(
          `Memory Gate mode: ${mode}`,
          `记忆门控模式：${mode === "suggest" ? "建议（只通知不写入）" : "自动（自动写入）"}`,
        ), "info");
        ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
        return;
      }

      // /jev memory on|off — toggle Memory Gate (after exact memory commands)
      if (arg.startsWith("memory ")) {
        const action = arg.split(" ")[1];
        toggleModule(action, "memoryGate", config, ctx);
        return;
      }

      // /jev reset — reset state and stats
      if (arg === "reset") {
        resetState();
        resetStats();
        resetSavings();
        resetEpoch();
        resetDecisionCopilot();
        ctx.ui.notify(tr("State, stats, savings, and epoch reset.", "状态、统计、节省信息和压缩周期已重置。"), "info");
        return;
      }

      // ── v0.3: /jev compact commands ───────────────────────────

      // /jev compact status — show epoch/compaction status
      if (arg === "compact status") {
        const info = getEpochInfo();
        const config = loadConfig();
        const status = [
          tr(`Compaction: ${onOff(config.compaction.enabled)}`, `上下文压缩：${onOff(config.compaction.enabled)}`),
          tr(`Min turns between plans: ${config.compaction.minTurnsBetweenPlans}`, `计划最小间隔轮次：${config.compaction.minTurnsBetweenPlans}`),
          tr(`Min chars to save: ${config.compaction.minCharsToSave}`, `最少节省字符数：${config.compaction.minCharsToSave}`),
          tr(`Preserve recent messages: ${config.compaction.preserveRecentMessages}`, `保留最近消息数：${config.compaction.preserveRecentMessages}`),
          ``,
          tr(`Epoch Plan: ${info.hasPlan ? "ACTIVE" : "NONE"}`, `周期计划：${info.hasPlan ? "生效中" : "无"}`),
          tr(`Epoch ID: ${info.epochId ?? "N/A"}`, `周期 ID：${info.epochId ?? "无"}`),
          tr(`Plan age: ${info.planAge} turn(s)`, `计划已使用：${info.planAge} 轮`),
          tr(`Est. chars saved: ${info.estimatedSavedChars}`, `预计节省字符数：${info.estimatedSavedChars}`),
        ].join("\n");
        ctx.ui.notify(status, "info");
        return;
      }

      // /jev compact plan — generate a new pruning plan
      if (arg === "compact plan") {
        ctx.ui.notify(tr("Generating new pruning plan...", "正在生成新的裁剪计划……"), "info");
        // We can't access the current messages directly from the command context
        // The plan will be generated on the next context event
        requestEpochPlan();
        ctx.ui.notify(tr("Plan will be regenerated on the next turn.", "将在下一轮重新生成计划。"), "info");
        return;
      }

      // /jev compact clear — clear the pruning plan
      if (arg === "compact clear") {
        clearEpochPlan();
        ctx.ui.notify(tr("Pruning plan cleared. Next turn will use full history view.", "裁剪计划已清除，下一轮将使用完整历史视图。"), "info");
        return;
      }

      // /jev compaction mode <off|suggest|auto>
      // NB: must be checked before the "compact " branch below.
      if (arg.startsWith("compaction mode ")) {
        const mode = arg.slice("compaction mode ".length).trim();
        const modes = ["off", "suggest", "auto"];
        if (!modes.includes(mode)) {
          ctx.ui.notify(tr(
            `Usage: /jev compaction mode ${modes.join("|")}`,
            `用法：/jev compaction mode ${modes.join("|")}`,
          ), "warning");
          return;
        }
        config.compaction.autoMode = mode as "off" | "suggest" | "auto";
        ctx.ui.notify(tr(
          `Compaction autoMode: ${mode}`,
          `上下文压缩自动模式：${mode === "off" ? "关闭（仅模型或用户请求才裁剪）" : mode === "suggest" ? "建议（只提示不裁剪）" : "自动（历史行为）"}`,
        ), "info");
        ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
        return;
      }

      // /jev compact on|off — toggle compaction
      if (arg.startsWith("compact ")) {
        const action = arg.split(" ")[1];
        if (action === "on" || action === "off") {
          config.compaction.enabled = action === "on";
          ctx.ui.notify(tr(`Compaction: ${action.toUpperCase()}`, `上下文压缩：${action === "on" ? "开启" : "关闭"}`), "info");
          ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
        } else {
          ctx.ui.notify(tr("Usage: /jev compact on|off|status|plan|clear", "用法：/jev compact on|off|status|plan|clear"), "info");
        }
        return;
      }

      // ── v0.3: /jev savings — show savings stats ──────────────

      // /jev savings — show savings estimates
      if (arg === "savings") {
        ctx.ui.notify(formatSavings(), "info");
        return;
      }

      // Unknown subcommand
      ctx.ui.notify(
        tr(
          `Unknown /jev command: "${arg}"\nAvailable: status, probe, stats, savings, last, route cheap|medium|strong, language en|zh-CN, toolgate advisory|enforce|on|off, router on|off, router mode ${ROUTER_MODES.join("|")}, decision on|off, retry on|off, retry append on|off, contextgate/skillgate/agentrouter/reviewgate/guirouter on|off, memory on|off|clear|stats|resolve <id>, memory mode suggest|auto, compact on|off|status|plan|clear, compaction mode off|suggest|auto, reset`,
          `未知的 /jev 命令：“${arg}”\n可用命令：status、probe、stats、savings、last、route cheap|medium|strong、language en|zh-CN、toolgate advisory|enforce|on|off、router on|off、router mode ${ROUTER_MODES.join("|")}、decision on|off、retry on|off、retry append on|off、contextgate/skillgate/agentrouter/reviewgate/guirouter on|off、memory on|off|clear|stats|resolve <id>、memory mode suggest|auto、compact on|off|status|plan|clear、compaction mode off|suggest|auto、reset`,
        ),
        "info",
      );
    },
  });
}

// ── Helper functions ──────────────────────────────────────────────

function buildStatus(config: ReturnType<typeof loadConfig>): string {
  const jevStatus = isJudgeAvailable()
    ? trFor(config.language, "READY", "就绪")
    : trFor(config.language, `UNAVAILABLE (${getJudgeUnavailableReason() ?? "unknown"})`, `不可用（${getJudgeUnavailableReason() ?? "未知原因"}）`);

  const backendLines = allConfiguredBackends().map((backend) => {
    const state = backend.isAvailable() ? "ready" : `unavailable (${backend.unavailableReason() ?? "?"})`;
    return `    ${backend.name} [${backend.confidenceKind}]: ${state}`;
  });

  const epochInfo = getEpochInfo();
  const epochStatus = epochInfo.hasPlan
    ? trFor(config.language, `ACTIVE (${epochInfo.estimatedSavedChars} chars saved)`, `生效中（已节省 ${epochInfo.estimatedSavedChars} 字符）`)
    : trFor(config.language, "NO PLAN", "无计划");

  const lastTier = runtimeState.lastTaskTier ?? "none";
  const lastConfidence = runtimeState.lastTaskConfidence !== undefined
    ? runtimeState.lastTaskConfidence.toFixed(2)
    : "N/A";

  return [
    `pi-jev-control v${PLUGIN_VERSION}`,
    trFor(config.language, `Judgment: ${jevStatus} (default: ${config.judgment.backend})`, `判断后端：${jevStatus}（默认：${config.judgment.backend}）`),
    ...backendLines,
    trFor(config.language, `Language: ${config.language}`, `语言：简体中文（zh-CN）`),
    trFor(config.language, `Timeout: ${config.jev.timeoutMs}ms`, `超时：${config.jev.timeoutMs} 毫秒`),
    trFor(config.language, `Router: ${onOff(config.router.enabled, config.language)} (mode: ${config.router.mode})`, `任务路由：${onOff(config.router.enabled, config.language)}（模式：${config.router.mode}）`),
    trFor(config.language, `Tool Gate: ${onOff(config.toolGate.enabled, config.language)} (mode: ${config.toolGate.mode})`, `工具门控：${onOff(config.toolGate.enabled, config.language)}（模式：${config.toolGate.mode === "advisory" ? "辅助" : "严格"}）`),
    trFor(config.language, `Retry Judge: ${onOff(config.retryJudge.enabled, config.language)} (appendToResult: ${config.retryJudge.appendToResult ? "on" : "off"})`, `重试判断：${onOff(config.retryJudge.enabled, config.language)}（追加结果：${config.retryJudge.appendToResult ? "开启" : "关闭"}）`),
    trFor(config.language, `Context Gate: ${onOff(config.contextGate.enabled, config.language)}`, `上下文门控：${onOff(config.contextGate.enabled, config.language)}`),
    trFor(config.language, `Skill Gate: ${onOff(config.skillGate.enabled, config.language)}`, `技能门控：${onOff(config.skillGate.enabled, config.language)}`),
    trFor(config.language, `Agent Router: ${onOff(config.agentRouter.enabled, config.language)}`, `代理路由：${onOff(config.agentRouter.enabled, config.language)}`),
    trFor(config.language, `Memory Gate: ${onOff(config.memoryGate.enabled, config.language)} (mode: ${config.memoryGate.mode})`, `记忆门控：${onOff(config.memoryGate.enabled, config.language)}（模式：${config.memoryGate.mode}）`),
    trFor(config.language, `Compaction: ${onOff(config.compaction.enabled, config.language)} (autoMode: ${config.compaction.autoMode}, epoch: ${epochStatus})`, `上下文压缩：${onOff(config.compaction.enabled, config.language)}（自动模式：${config.compaction.autoMode}，周期：${epochStatus}）`),
    trFor(config.language, `Review Gate: ${onOff(config.reviewGate.enabled, config.language)}`, `审查门控：${onOff(config.reviewGate.enabled, config.language)}`),
    trFor(config.language, `GUI Router: ${onOff(config.guiRouter.enabled, config.language)}`, `GUI 路由：${onOff(config.guiRouter.enabled, config.language)}`),
    trFor(config.language, `Decision Copilot: ${onOff(config.decisionCopilot.enabled, config.language)} (max ${config.decisionCopilot.maxCallsPerTurn}/turn)`, `决策副驾驶：${onOff(config.decisionCopilot.enabled, config.language)}（每轮最多 ${config.decisionCopilot.maxCallsPerTurn} 次）`),
    trFor(config.language, `Automatic notifications: ${config.ui.notifications}`, `自动通知：${config.ui.notifications}`),
    trFor(config.language, `Last routing: ${lastTier}`, `上次路由：${lastTier}`),
    trFor(config.language, `confidence: ${lastConfidence}`, `置信度：${lastConfidence}`),
    trFor(config.language, `Config: ${getConfigPath()}`, `配置文件：${getConfigPath()}`),
  ].join("\n");
}

async function runProbe(ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): Promise<void> {
  // Test with a simple choice question
  const probeQuestion = choice(
    "Choose whether this task is cheap, medium, strong, or unknown.",
    {
      cheap: null,
      medium: null,
      strong: null,
      unknown: null,
    },
  );

  const state = {
    task: "find all files containing EnemyPatrol",
  };

  ctx.ui.notify(tr("Running /jev probe...", "正在运行 /jev probe……"), "info");

  const result = await judge(state, { probe: probeQuestion }, {
    module: "router",
  });

  if (result.ok === false) {
    const err = result;
    ctx.ui.notify(
      tr(
        `[Jev probe FAILED]\nerrorType: ${err.errorType}\nerror: ${err.error}\n\nIf TYPESAFE_API_KEY is not set, Jev features will be unavailable.`,
        `[Jev 测试失败]\n错误类型：${err.errorType}\n错误：${err.error}\n\n如果未设置 TYPESAFE_API_KEY，Jev 功能将不可用。`,
      ),
      "error",
    );
    return;
  }

  const answer = result.answers.probe;
  ctx.ui.notify(
    tr(
      `[Jev probe SUCCESS]\nbackend: ${result.backend}\nmodel: ${result.model}\nchoice: ${answer.type === "choice" ? answer.choice : "?"}\nconfidence: ${answer.type !== "noul" ? answer.confidence.toFixed(4) : "?"}\nprobabilities: ${JSON.stringify(answer.type !== "noul" ? answer.probabilities : answer.noul)}\ninput_tokens: ${result.usage.input_tokens}\noutput_tokens: ${result.usage.output_tokens}\nlatency: ${result.latencyMs}ms`,
      `[Jev 测试成功]\n后端：${result.backend}\n模型：${result.model}\n选择：${answer.type === "choice" ? answer.choice : "?"}\n置信度：${answer.type !== "noul" ? answer.confidence.toFixed(4) : "?"}\n概率：${JSON.stringify(answer.type !== "noul" ? answer.probabilities : answer.noul)}\n输入 token：${result.usage.input_tokens}\n输出 token：${result.usage.output_tokens}\n延迟：${result.latencyMs} 毫秒`,
    ),
    "info",
  );
}

function toggleModule(
  action: string | undefined,
  moduleName: "router" | "toolGate" | "retryJudge" | "decisionCopilot" | "contextGate" | "skillGate" | "agentRouter" | "memoryGate" | "reviewGate" | "guiRouter",
  config: ReturnType<typeof loadConfig>,
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
): void {
  if (action === "on" || action === "off") {
    // Toggle in-memory config
    if (moduleName === "router") config.router.enabled = action === "on";
    else if (moduleName === "toolGate") config.toolGate.enabled = action === "on";
    else if (moduleName === "retryJudge") config.retryJudge.enabled = action === "on";
    else if (moduleName === "decisionCopilot") config.decisionCopilot.enabled = action === "on";
    else if (moduleName === "contextGate") config.contextGate.enabled = action === "on";
    else if (moduleName === "skillGate") config.skillGate.enabled = action === "on";
    else if (moduleName === "agentRouter") config.agentRouter.enabled = action === "on";
    else if (moduleName === "memoryGate") config.memoryGate.enabled = action === "on";
    else if (moduleName === "reviewGate") config.reviewGate.enabled = action === "on";
    else if (moduleName === "guiRouter") config.guiRouter.enabled = action === "on";

    const label = moduleName === "toolGate" ? "Tool Gate" :
                  moduleName === "retryJudge" ? "Retry Judge" :
                  moduleName === "contextGate" ? "Context Gate" :
                   moduleName === "skillGate" ? "Skill Gate" :
                   moduleName === "agentRouter" ? "Agent Router" :
                   moduleName === "memoryGate" ? "Memory Gate" : "Task Router";
    const finalLabel = moduleName === "decisionCopilot" ? "Decision Copilot" :
                       moduleName === "reviewGate" ? "Review Gate" :
                       moduleName === "guiRouter" ? "GUI Router" : label;
    const chineseLabel = moduleName === "decisionCopilot" ? "决策副驾驶" :
                         moduleName === "toolGate" ? "工具门控" :
                         moduleName === "retryJudge" ? "重试判断" :
                         moduleName === "contextGate" ? "上下文门控" :
                         moduleName === "skillGate" ? "技能门控" :
                         moduleName === "agentRouter" ? "代理路由" :
                         moduleName === "memoryGate" ? "记忆门控" :
                         moduleName === "reviewGate" ? "审查门控" :
                         moduleName === "guiRouter" ? "GUI 路由" : "任务路由";
    ctx.ui.notify(tr(`${finalLabel}: ${action.toUpperCase()}`, `${chineseLabel}：${action === "on" ? "开启" : "关闭"}`), "info");

    // Note: /reload required for persistent changes
    ctx.ui.notify(tr("Note: Use /reload for persistent changes.", "注意：如需持久化，请修改配置后使用 /reload。"), "info");
  } else {
    ctx.ui.notify(tr(`Usage: /jev ${moduleName} on|off`, `用法：/jev ${moduleName} on|off`), "info");
  }
}

// ── Memory Gate setup ─────────────────────────────────────────────

function setupMemoryGate(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    // Analyze user input for memory-worthy content
    await analyzeUserInput(event.text, ctx, event.source);
  });
}

// ── Memory Search Tool ────────────────────────────────────────────

function registerMemorySearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_memory_search",
    label: tr("Jev Memory Search", "Jev 记忆搜索"),
    description: tr("Search local memory store for relevant information using Jev-powered relevance ranking.", "使用 Jev 相关性排序搜索本地记忆存储。"),
    parameters: Type.Object({
      query: Type.String({ description: tr("Search query", "搜索查询") }),
      types: Type.Optional(Type.Array(Type.String(), { description: tr("Filter by memory types: fact, decision, failure, constraint", "按记忆类型筛选：fact、decision、failure、constraint") })),
      limit: Type.Optional(Type.Number({ description: tr("Maximum results (default: 5)", "最大结果数（默认：5）") })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      // Searching memory is a read-only model-initiated action, so it is gated
      // only on the top-level switch — not on the automatic memory watcher, which
      // defaults to off in the inverted architecture.
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: tr("Jev control is disabled.", "Jev 控制层已关闭。") }],
          details: {},
        };
      }
      const query = params.query as string;
      const types = params.types as string[] | undefined;
      const limit = params.limit as number | undefined;

      const result = await searchMemory({ query, types, limit }, signal);

      if (result.records.length === 0) {
        return {
          content: [{ type: "text", text: tr(`No memory records found for: "${query}"`, `未找到与“${query}”相关的记忆记录。`) }],
          details: {},
        };
      }

      const lines = [
        tr(
          `Memory search: "${query}" (${result.totalCandidates} candidates, ${result.totalAfterJev} after Jev)`,
          `记忆搜索：“${query}”（${result.totalCandidates} 个候选，Jev 筛选后 ${result.totalAfterJev} 个）`,
        ),
        ``,
      ];

      result.records.forEach((r, i) => {
        lines.push(`${i + 1}. [${r.type}] ${r.summary}`);
        lines.push(tr(`   id: ${r.id}`, `   ID：${r.id}`));
        lines.push(tr(`   date: ${new Date(r.timestamp).toISOString().slice(0, 10)}`, `   日期：${new Date(r.timestamp).toISOString().slice(0, 10)}`));
        lines.push(tr(`   confidence: ${r.confidence.toFixed(2)}`, `   置信度：${r.confidence.toFixed(2)}`));
        lines.push(tr(`   source: ${r.source}`, `   来源：${r.source}`));
        if (r.resolved !== undefined) lines.push(tr(`   resolved: ${r.resolved}`, `   已解决：${r.resolved ? "是" : "否"}`));
        lines.push(``);
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
