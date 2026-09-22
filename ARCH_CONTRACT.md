# 架构反转 — 共享契约（所有子代理必须严格遵守）

> 唯一真相源。本文件由主代理编写；实现细节以本文件为准。
> 项目：`D:\Project\AI插件\Pi插件\pi-jev-control`（TypeScript ESM，`npm run typecheck` 必须 0 错误）

## 0. 控制方向铁律

**Jev 永不自动改变**：模型本身（setModel）、模型可见上下文（context 裁剪）、模型的行动（tool 拦截）、持久记忆（自动写入）。
所有 Jev 输出都是**情报**，以工具结果形式交给模型。安全底线（危险命令、熔断）只用确定性规则。

## 1. 已完成、禁止改动的部分

- `src/types.ts` 中 `router.mode`（四档 `"rules-only" | "advisory" | "set-model" | "tier-only" | "off"`，默认 `rules-only`）与 `compaction.autoMode`（`"off" | "suggest" | "auto"`，默认 `off`）— 已定义，**只读**。
- `src/config.ts` 中 `router.mode: "rules-only"`、`retryJudge.appendToResult: false`、`memoryGate.enabled: false`、`compaction.autoMode: "off"` — 已定义，**只读**（例外见 §4-C1）。
- `src/router/task-router.ts` — 已重写，导出 `judgeTaskTier`、`requestModelTier`、`routeTask`、`setNextRouteOverride`、`readInlineOverride`、`modeConsultsJudge`、`modeSwitchesModel`、`hasConfiguredRouterTarget`、`setupTaskRouter`、类型 `RouteMode` / `NamedTier` / `ModelTierRequest` / `ModelTierRequestResult`。**只读，不修改**。
- `src/gates/tool-gate.ts` — 已删除 Jev 阻塞路径，保留 `resolveJevGatePolicy`、`classifyShellCommand`、`isDangerousBashCommand`、`isSafeBashCommand`、`setupToolGate`。**只读，不修改**。
- `src/compaction/context-hook.ts` — 已有 autoMode 分支，**只有 C-B 可修改**（见 §4-B）。
- `src/judge/**`（除 §2 新增问题外）、`src/stats/**`、`src/state/**`、`src/i18n.ts`、`src/ui.ts` — **只读**。

## 2. 问题库已就绪（`src/judge/questions.ts`，只读）

已新增：`TASK_COMPLEXITY_QUESTION`、`OPERATION_RISK_QUESTION`、`RANK_RELEVANCE_QUESTION`。
已存在可复用：`TASK_TIER_QUESTION`、`TOOL_GATE_QUESTION`、`FAILURE_TYPE_QUESTION`、`RECOMMENDED_ACTION_QUESTION`、`MEMORY_TYPE_QUESTION`、`MEMORY_DURABILITY_QUESTION`、`PRUNING_USEFULNESS_QUESTION`。

**不要再往 questions.ts 添加内容。** 需要新问题时回报主代理。

## 3. 通用约定

### 3.1 工具结果格式（所有新工具统一）
```ts
return {
  content: [{ type: "text", text: <人类可读多行文本> }],
  details: <机器可读对象>,
};
```
`details` 里必须包含 `status` 字段，取值 `"ok" | "unavailable" | "disabled" | "skipped"`，
成功时再加 `backend`、`latencyMs`。人类可读文本与 `details` 信息一致（不要只给 JSON）。

### 3.2 Jev 不可用 / 被禁用的处理
- `isJudgeAvailable()` 为 false → **不得抛错、不得阻塞**。返回 `status: "unavailable"`，
  同时**仍然返回确定性部分**（`riskFeatures`、`classifyShellCommand` 结果、重复失败计数等）。
- 相关配置模块 `enabled: false` → `status: "disabled"`，文本说明关闭的是哪个开关。
- 例外：`jev_memory_add` 与 `jev_request_model_tier` **不受** `memoryGate.enabled` /
  `router.mode` 的"谁来决策"开关限制（模型显式调用就是授权）。`jev_request_model_tier`
  仅在 `router.enabled === false` 或 `mode === "off"` 时返回 `status: "disabled"`。

### 3.3 注册函数与文件命名
每个新工具 = 一个新文件，导出一个 `setupXxxTool(pi: ExtensionAPI): void`。
用 `pi.registerTool({ name, label, description, parameters, execute })`。
`parameters` 用手写 JSON Schema 对象（同 `src/decision/batch.ts` 风格），**不要**用 typebox
（除非同目录已用 typebox）。`execute` 签名：`async execute(toolCallId, params, signal, onUpdate, ctx)`
—— `ctx` 是第 5 个参数，需要时用它（拿 `ctx.signal`、`ctx.ui`）。

### 3.4 i18n
`import { tr } from "../i18n.js";` —— `tr(英文, 中文)`。`description`、`label`、工具输出文本都要双语。

### 3.5 输入截断
所有用户/模型传入的长文本先 `.slice(0, N)` 再进 Jev，避免撑爆请求：
`task`/`operation`/`error` 上限 2000；`context`/`details`/`rawExcerpt` 上限 2000。

## 4. 四个并行任务的文件所有权

### 4-A. 判断类咨询工具（3 个文件，全新增）
`src/router/assess-task.ts`、`src/gates/assess-risk.ts`、`src/judgment/diagnose-failure.ts`

#### `jev_assess_task`（`src/router/assess-task.ts`）
```ts
export function setupAssessTaskTool(pi: ExtensionAPI): void;
```
- 参数：`{ task: string, context?: string }`（`task` 必填）
- 实现：`const text = [context, task].filter(Boolean).join("\n")`，调用 `judgeTaskTier(text, signal)`
  （从 `../router/task-router.js` 导入）。**不要调用 `routeTask`**（它带 hook 语义）。
- 输出 `details`：`{ status, tier, confidence, source, reason, riskFeatures, backend, latencyMs, judgeModel }`
- `judgeTaskTier` 永不抛错且不可用时自带 fallback tier，所以 `status` 取
  `result.source === "fallback" && result.reason === "judgment backend unavailable" ? "unavailable" : "ok"`。
- 文本要点：等级、置信度、风险特征、"这是参考情报，最终由你决定"。
- 文本必须写明：如需切换模型请调用 `jev_request_model_tier`。
- 工具 `description` 必须写明使用场景：任务做到一半发现变复杂了 / 拿不准要不要升级模型时。

#### `jev_assess_risk`（`src/gates/assess-risk.ts`）
```ts
export function setupAssessRiskTool(pi: ExtensionAPI): void;
```
- 参数：`{ operation: string, tool?: string, details?: string }`（`operation` 必填）
- 实现分两段：
  1. **确定性**（永远先算，永远包含在结果里）：
     从 `../judge/rules-backend.js` 导入 `classifyShellCommand`、`isDangerousBashCommand`。
     `operation` 若看起来是 shell 命令则跑 `classifyShellCommand(operation)`，得到 `risk` 与 `features`；
     再用 `isDangerousBashCommand(operation)` 得出 `dangerous: boolean`。
     同时跑 `extractRouteRisk(operation)`（`../router/risk.js`）取 `riskFeatures` / `minimumTier`。
  2. **Jev**：`judge({ operation, tool, details }, { risk: OPERATION_RISK_QUESTION, gate: TOOL_GATE_QUESTION }, { module: "toolGate", signal })`。
- 输出 `details`：`{ status, risk, gateVerdict, policy, confidence, deterministic: { risk, dangerous, features }, riskFeatures, minimumTier, backend, latencyMs }`
  - `risk`: `"low" | "moderate" | "high"`（Jev 结果）
  - `gateVerdict`: `"allow" | "confirm" | "deny"`（Jev 的 TOOL_GATE 结果，经 `normalizeToolGateDecision`）
  - `policy`: 用 `resolveJevGatePolicy(gateVerdict, confidence, config.toolGate.confirmOnLowConfidence)`（`../gates/tool-gate.js`）
  - `confidence` 取 gate 答案的 confidence
  - Jev 不可用时 `risk/gateVerdict/policy/confidence` 全为 `undefined`，`status: "unavailable"`，**但 `deterministic` 和 `riskFeatures` 照常有值**
- 确定性优先级说明：若 `deterministic.dangerous === true`，文本里明确提示"确定性规则已判定为危险命令"，
  即使 Jev 说 low 也不得下调。
- 文本末尾写：最终是否执行由你决定。

#### `jev_diagnose_failure`（`src/judgment/diagnose-failure.ts`）
```ts
export function setupDiagnoseFailureTool(pi: ExtensionAPI): void;
```
- 参数：`{ tool: string, error: string, input?: string, sameFailureCount?: number }`（`tool`、`error` 必填）
- 实现：`judge({ tool, input_summary: input, error_excerpt: error, command_category: "", same_failure_count: sameFailureCount ?? 0 }, { type: FAILURE_TYPE_QUESTION, action: RECOMMENDED_ACTION_QUESTION }, { module: "failureJudge", signal })`
- 确定性兜底：同时调 `evaluateRepeatedFailure(sameFailureCount)`（`../judge/rules-backend.js`）；
  若它返回非空则**覆盖** Jev 的结果为 `{ failureType: "repeated", recommendedAction: "do_not_retry" }`，
  `details.deterministic: { source: "local-rule", ... }`。
- 输出 `details`：`{ status, failureType, recommendedAction, confidence, backend, latencyMs }`
  （`failureType`/`recommendedAction` 经 `normalizeFailureType` / `normalizeRecommendedAction`）
- 文本：类型 + 建议动作 + 一句"这是建议，重试与否由你决定"。

### 4-B. 状态类工具（3 个文件 + 2 个既有文件小改）
新增：`src/router/model-tier.ts`、`src/compaction/prune-context.ts`
修改：`src/compaction/epoch.ts`、`src/compaction/context-hook.ts`

#### `epoch.ts` 新增导出
```ts
export function hasPendingGeneration(): boolean { return epochState.forceRegeneration; }
```

#### `context-hook.ts` 修改（**唯一允许的修改**）
当前 non-auto 分支：
```ts
if (config.compaction.autoMode !== "auto") {
  const pendingPlan = getEpochPlan();
  if (!pendingPlan) {
    if (config.compaction.autoMode === "suggest") maybeSuggestPruning(ctx, messages);
    return;
  }
  ...
}
```
改为：当 `getEpochPlan()` 为空但 `hasPendingGeneration()` 为 true 时，**生成并应用计划**（一次性，
等价于 auto 路径的生成逻辑），因为这是模型或用户显式请求过的。生成后 `setEpochPlan()` 会把
`forceRegeneration` 置 false，所以不会重复。请把 auto 路径里的"生成计划"抽成局部函数复用，
不要复制粘贴。`suggest` 通知仅在既无计划也无 pending generation 时触发。
注意：`consumeSkipNextGeneration()` 的语义不变。

#### `jev_request_model_tier`（`src/router/model-tier.ts`）
```ts
export function setupModelTierTool(pi: ExtensionAPI): void;
```
- 参数：`{ tier: "cheap" | "medium" | "strong", reason: string, context?: string }`（`tier`、`reason` 必填）
- 实现：`requestModelTier(pi, ctx, { tier, reason, context })`
- 输出 `details`：直接返回 `requestModelTier` 的结果（已含 `success`、`requestedTier`、`floorApplied`、
  `riskFeatures`、`provider`、`model`、`thinking`、`reason`），外加 `status: selected.success ? "ok" : "failed"`。
- 文本：说明请求的等级、实际生效的等级/模型、是否被风险下限上调、是否切换成功。
- 工具 `description` 写明：长任务中途复杂度上升时主动请求升级；风险特征只能上调不能下调。

#### `jev_prune_context`（`src/compaction/prune-context.ts`）
```ts
export function setupPruneContextTool(pi: ExtensionAPI): void;
```
- 参数：`{ reason?: string }`
- 实现：`loadConfig()`；若 `!config.compaction.enabled` → `status: "disabled"`；
  若 `getEpochPlan()` 已有计划 → `status: "skipped"`，附 `getEpochInfo()`；
  否则 `requestEpochPlan()` → `status: "requested"`。
- 输出 `details`：`{ status, reason, epoch: getEpochInfo() }`
- 文本：说明"下一轮上下文事件会生成并应用裁剪计划"（工具本身看不到消息，不能直接裁剪）。
- 工具 `description` 写明使用场景：长会话里堆积了大量已过时的 grep/编译日志。

### 4-C1. 记忆工具（2 个新文件 + 2 个既有文件小改）
新增：`src/memory/memory-add.ts`
修改：`src/memory/memory-gate.ts`、`src/types.ts`（只加 `memoryGate.mode`）、`src/config.ts`（只加默认值）

#### `jev_memory_add`（`src/memory/memory-add.ts`）
```ts
export function setupMemoryAddTool(pi: ExtensionAPI): void;
```
- 参数：`{ type: "fact" | "decision" | "failure" | "constraint", summary: string, rawExcerpt?: string, confidence?: number }`
  （`type`、`summary` 必填）
- 实现：
  - `config.enabled === false` → `status: "disabled"`（**不要**看 `memoryGate.enabled`）
  - 校验 `type`，非法值 → `status: "skipped"`，文本说明合法取值
  - `summary` 为空 → `status: "skipped"`
  - `confidence` 缺省 0.8，夹到 `[0,1]`
  - 构建 `MemoryRecord`：`id: crypto.randomUUID()`、`timestamp: Date.now()`、
    `projectHash: getProjectHash()`、`source: "agent"`、
    `fingerprint: generateActionFingerprint(type, summary)`、`rawExcerpt` 截断 2000
  - `type === "failure"` → `upsertFailure(record)`，否则 `appendMemory(record)`
  - `recordMemoryCreated()`（`../stats/savings.js`）
- 输出 `details`：`{ status: "saved", id, type, summary }`
- 工具 `description` 写明时机：用户说"记住""以后都"、重大架构决策、踩坑修复后。

#### `memoryGate` 模式（types.ts + config.ts + memory-gate.ts）
- `src/types.ts` 的 `memoryGate` 改为：
  ```ts
  memoryGate: {
    enabled: boolean;
    /** "suggest" (default) — announce a possible memory, never write it.
     *  "auto" — legacy: write automatically. */
    mode: "suggest" | "auto";
  };
  ```
- `src/config.ts` 默认 `memoryGate: { enabled: false, mode: "suggest" }`
- `src/memory/memory-gate.ts` 的 `analyzeUserInput`：在真正写入前判断
  `config.memoryGate.mode`。`"suggest"` 时**不写**，只 `notifyAutomatic` 一条"检测到一条可能的记忆，
  要存请调用 jev_memory_add"（附 Jev 判定的 type 与摘要）。`"auto"` 保留原写入行为。
  Jev 判定逻辑（分类 type + durability）要**保留并复用**，不要删。
- 注意：`storeFailureMemory` 由 failure-classifier 调用，属于确定性失败熔断路径，**不要改**。

### 4-C2. 排序原语（1 个新文件 + 1 个既有文件重构）
新增：`src/judge/rank.ts`
重构：`src/memory/retrieval.ts`（内部改用 rank 原语，**公开 API 与返回结构不变**）

#### `src/judge/rank.ts`
```ts
export interface RankCandidate { id: string; text?: string; }
export interface RankOptions { limit?: number; threshold?: number; maxForJudge?: number; }
export interface RankedItem { id: string; score: number; source: "judge" | "lexical"; }
export interface RankResult {
  status: "ok" | "unavailable" | "skipped";
  query: string;
  totalCandidates: number;
  totalAfterFilter: number;
  shortlist: RankedItem[];
  backend?: string;
  latencyMs?: number;
  reason?: string;
}
export async function rankCandidates(
  query: string,
  candidates: RankCandidate[],
  options?: RankOptions,
  signal?: AbortSignal,
  module?: string,          // 默认 "rank"
): Promise<RankResult>;
export function setupRankTool(pi: ExtensionAPI): void;  // 注册 jev_rank
```
- `rankCandidates` 逻辑：
  1. query 空 → `status: "skipped"`
  2. 词法预筛：query 分词（`\s+`，去 ≤1 字符 token），候选文本包含任一 token 即命中，
     命中 token 数多者得分高；无命中时保留原顺序但标记 `source: "lexical"`、`score: 0`
  3. 命中数 > `maxForJudge ?? 20` 时截断到前 20（按词法分降序）
  4. Jev 可用且候选 > 0：逐条 `noul` 打分（`RANK_RELEVANCE_QUESTION`，state 带 `query` 与
     `candidate_text`），按 confidence 降序；相关者 `source: "judge"`；
     把词法命中但 Jev 判为不相关的留在短名单末尾还是丢弃：**丢弃**
  5. 无关项按 `threshold ?? 0.45` 过滤
  6. 截断到 `limit ?? 5`
  7. Jev 不可用 → 返回词法排序结果，`status: "unavailable"`
- `jev_rank` 参数：`{ query: string, candidates: { id: string, text?: string }[], limit?: number, threshold?: number }`
  （`query`、`candidates` 必填；候选上限 200）
- 工具 `description` 写明：候选 > 20 个（文件/技能/记忆）时先用它缩小范围再深读。

#### `src/memory/retrieval.ts` 重构
- 保留 `searchMemory(params, signal)` 签名、`MemorySearchResult` / `MemorySearchParams` 结构不变。
- 内部改为：读出全部记录 → 按 `types` 过滤 → 交给 `rankCandidates(query, candidates, { limit, threshold: 0.45 }, signal, "memoryGate")`。
  注意 `MemoryRecord` → `RankCandidate` 映射：`id: r.id`、`text: r.summary + " " + (r.rawExcerpt ?? "")`。
  结果反查回 `MemoryRecord`。
- **`findSimilarFailure` 不动**（tool-gate 熔断依赖它）。
- 测试 `test/runtime.test.mjs`、`test/p0-fixes.test.mjs` 依赖其返回结构，务必保持不变。

### 4-D. 装配层（只改 1 个文件）
只改：`extensions/index.ts`

1. 顶部 import 全部新 `setup*Tool` 并在主函数里按现有风格注册：
   `setupAssessTaskTool`、`setupAssessRiskTool`、`setupDiagnoseFailureTool`、
   `setupModelTierTool`、`setupPruneContextTool`、`setupMemoryAddTool`、`setupRankTool`。
2. `buildStatus` 增加：`Router: ... (mode: X)` 已有 → 追加一行显示
   `Compaction: ... (autoMode: X)`；`Memory Gate: ... (mode: X)`；`Retry Judge: ... (appendToResult: on|off)`。
3. `/jev` 命令新增子命令：
   - `/jev router mode <rules-only|advisory|set-model|off>` — 设置 `config.router.mode`（内存生效，提示需 /reload 持久化）
   - `/jev router on|off` 保留现有行为
   - `/jev toolgate advisory|enforce` 保留
   - `/jev compaction mode <off|suggest|auto>` — 设置 `config.compaction.autoMode`
   - `/jev memory mode <suggest|auto>` — 设置 `config.memoryGate.mode`
   - `/jev retry append on|off` — 设置 `config.retryJudge.appendToResult`
4. 未知子命令提示文本同步更新。
5. `setupMemoryGate` 内联函数保留（`memory-gate.ts` 内部已按 mode 分流）。
6. **不要**改 `registerMemorySearchTool`、`runProbe`、`toggleModule` 的既有行为。

## 5. 质量红线

- `npm run typecheck` 必须 0 错误。
- `npm run build && node --test test/*.test.mjs` — 现有测试**不应当因你的改动而变红**。
  已知事实：用户真实配置 `~/.pi/agent/jev-control.json` 里 `router.enabled: false`、`compaction.enabled: false`，
  所以依赖这些开关默认开启的旧测试本来就跑不过（主代理负责修测试，**不要去改默认值迁就测试**）。
- 不得引入新依赖。不得修改 `package.json`。
- 不得删任何现有导出（会有测试 import）。只能新增或按 §4 指定的方式修改。
- 代码风格：2 空格、无尾随空格、文件末尾留一个换行、不用 `any` 除非既有代码已用。
- 所有新文件必须能被 tsc 编译（`src/**/*.ts`）。
