# 交接文档 — pi-jev-control

> 面向接手开发的代理/开发者。README 讲「怎么用」，这份讲「内部怎么回事、哪里要小心」。

## 1. 项目定位（不要偏离）

**pi 的决策层**：让 pi 的主 LLM（Claude/GPT 等推理模型）借助**快速判断模型**做决策，提升速度、准确度、节省 token。

- Jev 是 TypeSafe 的 System One 判断模型：输入 `state + questions`，输出**类型化答案 + 校准概率**，不生成文本。
- **通用化的正确方向**：接入"其他类 Jev 的快速判断模型"（决策模型/分类器/reranker/guard 模型）。
- **绝对不要**把通用大 LLM 当判断后端——那违背了"快"和"省"的设计初衷。`openai-compatible` 后端只面向 1～4B 级小快模型。

## 2. 当前状态

| 项 | 值 |
|---|---|
| 版本 | 1.0.1 + 本地未发布修复（以 package.json / git diff 为准） |
| 基线提交 | v1.0.1 为 020faf6；当前状态以 `git log -1` 与 `git diff` 为准 |
| 测试 | 运行 `npm test`，以当前输出为准；新增 details 风险、无效 choice 和 eval 在线参考分支回归 |
| 真实 Jev 冒烟 | 通过（`npm run test:jev`，需 `TYPESAFE_API_KEY`） |
| 依赖 | 运行依赖 `@typesafe-ai/sdk`、`typebox`；开发依赖 `typescript`（详见 `package.json`） |

### 1.1 控制方向（v1.0.0 起，最重要的一条）

**模型问 Jev，Jev 从不替模型做决定。** Jev 不切换模型、不剪 context、不阻塞工具调用、不自动写记忆——它只返回信息，模型自己做主。确定性规则是安全底线，从不问模型。

实现方式是 7 个「模型主动问」的工具：

| 工具 | 作用 | 代码 |
|---|---|---|
| `jev_assess_task` | 任务复杂度意见（cheap/medium/strong） | `src/router/assess-task.ts` |
| `jev_assess_risk` | 操作风险 + 工具门 verdict | `src/gates/assess-risk.ts` |
| `jev_diagnose_failure` | 失败根因 + 下一步建议 | `src/judgment/diagnose-failure.ts` |
| `jev_request_model_tier` | 唯一能切模型的显式入口 | `src/router/model-tier.ts` |
| `jev_prune_context` | 唯一的剪枝入口（需模型请求） | `src/compaction/prune-context.ts` |
| `jev_memory_add` | 唯一写记忆的入口（无需过门） | `src/memory/memory-add.ts` |
| `jev_rank` | 排序原语：词法预筛 + Jev 重排 | `src/judge/rank.ts` |

另外 7 个保留的模型主动工具：`jev_search_code`、`jev_select_skills`、`jev_route_agent`、`jev_memory_search`、`jev_review_check`、`jev_choose_ui_action`、`jev_decide_batch`。共注册 14 个 `jev_*` 工具。

路由兼容模式包含 `rules-only`、`advisory`、`tier-only`、`set-model`、`off`，由 `ROUTER_MODES` 统一校验。配置默认值因此全部改了：`router.mode="rules-only"`、`compaction.autoMode="off"`、
`memoryGate.enabled=false` + `mode="suggest"`、`retryJudge.appendToResult=false`。
想恢复旧行为：`router.mode="set-model"`、`compaction.autoMode="auto"`。

**配套技能**：`skills/pi-jev-control/SKILL.md` 教模型什么时候用哪个工具——计划里
「决定成败的一环」，改这些工具的行为时必须同步更新它。

**关键：改完插件代码后必须重启 pi 才生效**（插件在 pi 启动时加载）。

### 1.2 测试与真实配置分离（踩过的坑）

`loadConfig()` 有进程内缓存。**测试必须先调 `resetConfigToDefaults()` 再读配置**，
否则读到的是用户机器的真实配置 `~/.pi/agent/jev-control.json`（那台机器上
`router.mode` 是 `set-model`），旧测试就会莫名失败。这是 v0.9.0 遗留 10 个失败测试的
根因，v1.0.0 已修：断言改成新默认值，测试本身保持 hermetic。

**改 `src/config.ts` 时永远不要同时改 `resetConfigToDefaults()`**——它是测试的地基。

**部署位置（易混淆）**：pi 加载的是安装包副本 `~/.pi/agent/git/github.com/goodruizhan/pi-jev-control`（直接加载 TS 源码，不需要 dist），**不是** `D:\Project\...` 开发副本。两者版本可能差好几个大版本。升级：`pi update --extensions`（安装的是无 ref 锁定的 git 包，reconcile 会拉最新 main 并自动 `npm install`），然后重启 pi。安装副本通常没有开发依赖 `typescript`；若要在该目录就地运行 `npm test`，先运行 `npm install --include=dev --ignore-scripts`。

## 3. 架构

```
src/judge/          ← 中立判断核心（v0.6 新增，替换旧 src/jev/）
  ir.ts             中立 IR：choice/noul/score + 构建器；答案字段名沿用 SDK 习惯
  backend.ts        JudgmentBackend 接口 + JudgeOutcome + ConfidenceKind
  typesafe-backend.ts  Jev 及 Jev 兼容克隆 ← 全项目唯一 import @typesafe-ai/sdk 的文件
  openai-backend.ts     Ollama/小模型：JSON 输出 + 完整标签匹配（允许大小写差异）+ 概率钳制
  embedding-backend.ts  向量相似度（v0.7）：余弦相似度+softmax，候选向量内存缓存
  rules-backend.ts      确定性规则后端：复用各模块的本地规则；无匹配规则则整次请求返回 unavailable
  eval.ts               后端评测（v0.7）：JSONL 记录 + 两后端答案对比（agree/distance）
  registry.ts       后端解析：judgment.modules → judgment.backend → fallback
  facade.ts         judge() 统一入口 + 答案契约验证 + 统计 + 一次性 fallback 链 + eval 记录钩子
  questions.ts      各模块的问题文本（prompt）
  normalize.ts      选择串 → 类型枚举（便宜/中等/强等），无 SDK 依赖

其余模块（12 个都通过 facade 调用判断）：
  router/           task-router（分级）、model-router、agent-router、
                    assess-task（jev_assess_task）、model-tier（jev_request_model_tier）
  gates/            tool-gate、context-gate（jev_search_code）、skill-gate、
                    assess-risk（jev_assess_risk）
  compaction/       prune-context（jev_prune_context）、epoch、pruner、context-hook
  judgment/         diagnose-failure（jev_diagnose_failure）
  memory/           memory-add（jev_memory_add）、memory-gate、retrieval、store
  gates/            tool-gate、context-gate（jev_search_code）、skill-gate
  judgment/         failure-classifier（本地计数/可选注记）、diagnose-failure
  memory/           memory-gate、retrieval
  compaction/       pruner、epoch、context-hook
  review/           review-gate
  gui/              action-router
  decision/         batch（jev_decide_batch）
  stats/ state/ i18n.ts ui.ts config.ts types.ts
```

### 后端契约（实现新后端必读）

```ts
interface JudgmentBackend {
  readonly name: string;
  readonly confidenceKind: "calibrated" | "self-reported" | "similarity" | "binary";
  isAvailable(): boolean;
  unavailableReason(): string | null;
  judge(request: JudgeRequestInput, options: JudgeCallOptions): Promise<JudgeOutcome>;
}
```

**硬规则：`judge()` 永不抛异常**，所有失败都返回 `{ ok: false, errorType }`。
上层模块依赖这个契约做确定性降级。新后端必须遵守。

### 置信度语义

- `calibrated`：Jev 原生概率；对本项目任务路由的正确率仍需用专属数据集检验，不能把 0.8 当作正确率保证。
- `self-reported`：小模型自报的置信度，**未校准**。阈值应对这类后端更保守。
- 这个字段是给上层区分对待用的，别糊弄着都填 `calibrated`。

## 4. 关键设计决策

1. **IR 字段名刻意对齐 SDK**（`noul`/`choice`/`confidence`/`probabilities`/`score`），这样换后端时上层几乎不用改。
2. **两层答案防线**：facade 先拒绝缺失、越界、类型错误或候选外答案并触发 fallback；`choiceOf(answer)` 再把模块侧异常形状收窄成 `{choice:"unknown", confidence:0}`，而不是崩。
3. **向后兼容**：旧版顶层 `jev.model` / `jev.timeoutMs` 仍然有效，`config.ts` 的 `normalizeJudgmentConfig()` 会把它补进 `judgment.backends.typesafe`。老用户零迁移。
4. **advisory 是默认门控模式**：`toolGate.mode: "advisory"` 时**从不弹确认框、从不拦截**，只发通知（且 `errors-only` 下通知也被抑制）。只有改成 `"enforce"` 才有 `ctx.ui.confirm()`。用户明确要求不打断工作流。
5. **失败计数与注记**：失败事件始终本地计数；`retryJudge.enabled=false` 关闭自动注记、Jev 分类和重试熔断，但不抹掉失败历史；`appendToResult: false`（默认）只做本地计数，不自动请求 Jev、不改工具输出。设为 `true` 才调用 Jev 并附上标明插件来源的注记；后端不可用也必须计数。自动持久化失败记忆还需开启注记并设置 `memoryGate.mode: "auto"`，`suggest` 不写。
6. **模型候选与思考等级（v0.9）**：`router.models.<tier>` 接受单个 `ModelSpec` 或按优先级排列的数组；`thinking` 在模型选中后调用 `pi.setThinkingLevel()`。同一模型命中不同 tier 时也必须重新应用 thinking，不能因为模型未变化就提前返回。候选回退仅覆盖模型未注册、缺少认证或 `setModel()` 抛错，不负责已开始请求后的 429/网络重试。

## 5. 环境坑（踩过的，别再踩）

1. **pi 主进程的 PATH 不含 `~/.pi/agent/bin`**。扩展里直接 `spawn("rg")` 会 ENOENT，但 `npm test` 里发现不了（bash 工具注入了该目录）。所以 `context-gate.ts` 的 `resolveRgBinary()` 必须显式探测 `PI_JEV_RG_PATH` → `~/.pi/agent/bin/rg[.exe]` → PATH。
2. **TypeSafe SDK 的端点**是 `baseURL + "/v1/systemone"`。配置里的 `baseUrl` **不要带 `/v1`**（否则变 `/v1/v1/systemone`）。Jev 兼容克隆接入只需 `type: "typesafe-api"` + `baseUrl` + `apiKeyEnv` + `model`。
3. **测试跑的是编译产物**：所有测试 `import "../dist/src/..."`，所以必须先 build。`npm test` 里已经 `npm run build &&` 前缀了。
4. **`node --test test/` 在 Windows 上报 MODULE_NOT_FOUND**（把目录当模块解析）。必须用 glob：`node --test "test/*.test.mjs"`。
5. **decisionCopilot 每回合最多 1 次调用**（`maxCallsPerTurn: 1`），第二次会返回 `turn_budget`。这是**设计如此**（鼓励批量），不是 bug。
6. **各模块超时不能太紧**：冷连接实测约 0.8～1.2 秒；v0.8 默认 `guiRouter=2500ms`、`retryJudge=2500ms`、`decisionCopilot=5000ms`，用户配置仍可覆盖。
7. **代码检索查询不能整句直接交给 rg**：自然语言整句几乎零命中且正则字符会破坏搜索。v0.8 用最多 8 个字面量术语扩大召回，再做本地词法排序和 Jev rerank。
8. **技能排序要保留精确命中下限**：SKILL.md 的 `description: >` / `|` 必须读取后续缩进行；大批量 Noul 偶尔会压低显式技术名的分数，当前用 `max(model*0.8, lexical)` 保护精确术语/技能名匹配，并对常见中英双语交互术语做归一化，别退回纯模型排序。
9. **编辑工具是原子操作**：一个 `oldText` 不匹配则整批全部不生效，容易误以为改成功了。改完务必看返回值。
10. **思考等级由 Pi 最终限制**：插件请求的 `thinking` 可能被模型的 `thinkingLevelMap` 映射或钳制；路由器会读取实际等级并在不一致时发 warning。Kimi K3 当前不支持 `medium`，而 GPT-5.6 Sol 支持 `low/medium/high/xhigh/max`。

## 6. 已知待办（v0.8 后仍留，不是丢了）

| 项 | 说明 |
|---|---|
| Reranker / Guard 后端 | 仅留接口未实现 |
| 技能排序拒答 | 已增加语义弱匹配置信度门槛和明确排除词处理 |
| 检索根目录模式 | 已改为从每个请求 root 解释 glob pattern |
| RulesBackend 序列化状态 | 已兼容 `tool_name`/`input` 评测与外部调用格式 |
| 部分后端评测 | binary 后端主动拒答现在单独统计为 `unsupported` |

已完成：P4 EmbeddingBackend（`embedding-backend.ts`，`type: "embedding"`，余弦相似度+softmax，候选向量内存缓存）；P5 后端评测（facade 记录钩子 `judgment.eval.recordPath` → JSONL，`npm run eval` 用 `test/eval-backends.mjs` 重放对比，`test/eval/cases.jsonl` 为带标注的种子数据集）；RulesBackend 收编（本地规则共享，默认备用后端；无法回答的问题返回 `unavailable`，模型专用功能仍按模型可用性判断）。

## 7. 开发流程

未发布边界修复：`assessRisk` 对有界 operation/details 分别分类并取保守风险；openai-compatible 拒绝空白/部分/歧义 choice，不再从子串推测合法选项；eval 的 referenceCache 必须在重放循环之前初始化。相关回归在 `test/review-regressions.test.mjs` 和 `test/eval-cli.test.mjs`（后者只使用 rules 后端，不联网）。

```bash
npm run typecheck     # tsc --noEmit
npm test              # build + 本地单测（不联网）
npm run test:jev      # 真实 Jev 冒烟，需要 TYPESAFE_API_KEY
npm run eval          # 后端对比评测，重放 test/eval/cases.jsonl（联网）
```

验证清单（改判断层后必跑）：

1. `npx tsc --noEmit` 通过
2. `npm test` 全绿
3. `node -e "import('./dist/extensions/index.js').then(m=>console.log(typeof m.default))"` → `function`（模块加载不报错）
4. `npm run test:jev` → 后端应答、判断合理（危险命令应判 `confirm` 而非 `allow`）
5. **重启 pi** 验证实际效果：`/jev status`（后端列表）、`/jev probe`（谁应答）、`/jev stats`（后端级用量）

提交前：`git status --short` 必须为空，`git push` 后确认本地 HEAD == 远端 HEAD。

## 8. 参考资料

- 类 Jev 模型完整说明：`D:\Project\AI插件\参考文档\jev是什么.md`
- TypeSafe 技能文档：`C:\Users\LHC\.agents\skills\typesafe-ai\SKILL.md`
- GitHub：`https://github.com/goodruizhan/pi-jev-control`
