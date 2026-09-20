# pi-jev-control

[English](README.md) | [简体中文](README.zh-CN.md)

为 Pi Coding Agent 提供由 Jev 驱动的控制层。它使用 TypeSafe System One（Jev）作为低成本决策控制平面，涵盖任务路由、工具门控、失败分类、重试判断、上下文过滤、技能选择、记忆管理、上下文裁剪、压缩周期、审查门控和 GUI 操作路由。

## v0.6 可插拔判断后端

- **判断后端抽象** — 所有决策都经过中立 IR（`choice`/`noul`/`score`），Jev 从「核心」变成「默认后端」
- **Jev 兼容克隆** — 任何实现 System One 线协议（`POST /v1/systemone`）的端点，纯配置即可接入（`type: "typesafe-api"` + `baseUrl`/`apiKeyEnv`/`model`）
- **本地小模型** — `openai-compatible` 后端面向 Ollama/vLLM/LM Studio 的小快模型，支持离线与私有判断（自报置信度 + 模糊匹配归一化）
- **按模块路由** — `judgment.modules` 可为 router、toolGate 等模块分别指定后端；`judgment.fallback` 配置备用后端
- **诚实的置信度** — 每个后端声明自己的置信度性质（`calibrated` 校准概率 vs `self-reported` 自报置信度），避免阈值被误读
- **按后端统计** — `/jev stats` 分后端展示用量
- **现场修复** — ripgrep 不再依赖 PATH、决策批量超时更合理、技能发现覆盖 `pi-hermes-memory` 目录、启动时提醒未配置的 `REPLACE_ME` 路由模型

## v0.5 静默决策副驾驶

- **批量判断** — `jev_decide_batch` 在一次 Jev 请求中处理最多 8 个边界明确的选择题
- **每轮预算** — 默认每轮最多请求决策副驾驶一次；相同输入可命中 5 轮缓存
- **默认安静** — 自动通知默认为 `errors-only`；用户主动执行的 `/jev` 命令仍正常显示结果
- **本地优先裁剪** — 请求 Jev 前先删除重复的只读调用，并截断超长只读结果
- **跳过无效路由** — 未配置目标模型时，不再调用 Jev 做无实际作用的模型分级
- **更安全的 GUI 路由** — 缓存低风险控件选择，高风险操作交还用户决定
- **可验证收益** — `/jev savings` 同时显示 Jev token 成本、增加的延迟和预计净节省 token

## v0.4 运行可靠性优化

- 在同一用户任务内复用已授权的 `write`/`edit` 路径
- 拦截消息提供 `uncertainField` 和 `retryHint`
- 在本地短路 `rg`/`grep` 无匹配产生的 exit code 1，不再请求 Jev
- 向 Jev 提供退出码、stderr、命令类别、中止状态和失败计数
- 相同操作/失败类别重复出现时，本地直接建议 `do_not_retry`
- 同类失败累计两次后才熔断；历史失败默认提醒而非硬拦截
- 明确标注失败评估来自插件，并非工具输出；设 `retryJudge.appendToResult: false` 可保留失败记忆与重试判断、但不再改动工具输出
- 失败判断默认超时缩短至 1200 毫秒
- 上下文、技能、记忆和压缩门控改为默认开启
- 工具输出不足以达到节省阈值时，压缩功能在本地跳过 Jev
- 节省报告新增实际移除字符数和运行计数

## v0.3 新功能

- **双语界面** — 使用 `/jev language en|zh-CN` 切换面向用户的提示和结果
- **上下文裁剪** — 通过 `pi.on("context")` 裁剪消息视图中的旧工具输出，不修改磁盘上的会话
  - 工具调用/结果分组器：将调用与结果配对，不留下孤立项
  - 近期消息保护：始终保留最近 8 条消息
  - 失败保护：始终保留尚未解决的失败
  - `KEEP_RAW`、`TRUNCATE`、`DROP` 三级决策
- **压缩周期** — 跨轮次复用裁剪计划，保持提示词前缀稳定
  - `/jev compact status|plan|clear|on|off`
- **缓存感知门控** — 仅在节省字符数不少于 8000 且丢弃比例不低于 15% 时执行裁剪
- **Pi 原生压缩** — `session_before_compact` 会在原生压缩前报告重要的记忆记录
- **审查门控**（`jev_review_check`）— 支持跳过审查、普通审查和强审查
  - 强制强审查：GC、多线程、复制、GAS、引擎内部实现
- **GUI 操作路由**（`jev_choose_ui_action`）— 从候选 UI 控件中选择目标
  - 置信度低于阈值时返回 `unknown`，绝不强制点击
- **节省统计** — `/jev savings` 显示预计节省的上下文 token 数量

## v0.2 功能

- **任务路由器** — 将传入任务分为轻量、中等和强推理等级，并切换模型层级
- **模型路由器** — 将任务等级映射到已配置的模型，并调用 `pi.setModel()`
- **工具门控** — 对明确安全或危险的操作采用确定性规则，对不确定操作使用 Jev
- **失败分类器与重试判断器** — 对失败进行分类并建议重试策略
- **上下文门控**（`jev_search_code`）— 基于 rg 搜索代码，并使用 Jev 进行相关性排序
- **技能门控**（`jev_select_skills`）— 发现技能，并使用 Jev 进行相关性排序
- **代理路由器**（`jev_route_agent`）— 在侦察、编码和审查代理之间进行分类
- **记忆门控** — 分析用户输入，检测约束、决策和失败
- **记忆存储** — 使用本地 JSONL 持久化（`~/.pi/agent/jev-control-data/`）
- **记忆搜索**（`jev_memory_search`）— 本地过滤并使用 Jev 进行相关性排序
- **统计信息** — 跟踪所有模块的 Jev API 使用情况
- **项目级配置覆盖** — `.pi/jev-control.json` 覆盖全局配置

## v0.1 功能

- Jev 客户端：统一封装 TypeSafe SDK，并支持优雅降级
- `/jev` 命令：提供状态、连通性测试、统计和开关功能

## 前置条件

- Node.js 20 或更高版本
- 已设置 `TYPESAFE_API_KEY` 环境变量；未设置时 Jev 功能不可用
- Pi Coding Agent

## 安装

```bash
# 本地开发
pi -e ./extensions/index.ts

# 发布后安装
pi install git:github.com/goodruizhan/pi-jev-control
```

## 配置

创建 `~/.pi/agent/jev-control.json`：

```json
{
  "enabled": true,
  "language": "zh-CN",
  "ui": {
    "notifications": "errors-only"
  },
  "jev": {
    "model": "jev-latest",
    "timeoutMs": 4000
  },
  "router": {
    "enabled": true,
    "confidenceThreshold": 0.70,
    "fallbackTier": "medium",
    "mode": "set-model",
    "models": {
      "cheap": { "provider": "REPLACE_ME", "model": "REPLACE_ME" },
      "medium": { "provider": "REPLACE_ME", "model": "REPLACE_ME" },
      "strong": { "provider": "REPLACE_ME", "model": "REPLACE_ME" }
    }
  },
  "toolGate": {
    "enabled": true,
    "mode": "advisory",
    "useDeterministicFastPath": true,
    "confirmOnLowConfidence": false,
    "reuseApprovedWrites": true,
    "blockOnRememberedFailure": false
  },
  "retryJudge": {
    "enabled": true,
    "maxSameFailureRetries": 2,
    "timeoutMs": 1200,
    "skipBenignExitCodes": true,
    "appendToResult": true
  },
  "contextGate": {
    "enabled": true,
    "maxCandidates": 40,
    "maxSelected": 5,
    "relevanceThreshold": 0.55
  },
  "skillGate": {
    "enabled": true,
    "maxSelected": 4,
    "relevanceThreshold": 0.55
  },
  "agentRouter": {
    "enabled": true
  },
  "memoryGate": {
    "enabled": true
  },
  "compaction": {
    "enabled": true,
    "preserveRecentMessages": 8,
    "minCharsToSave": 8000,
    "minTurnsBetweenPlans": 20
  },
  "reviewGate": {
    "enabled": true
  },
  "guiRouter": {
    "enabled": true,
    "confidenceThreshold": 0.70,
    "timeoutMs": 900,
    "cacheTurns": 3
  },
  "decisionCopilot": {
    "enabled": true,
    "silent": true,
    "maxCallsPerTurn": 1,
    "maxQuestionsPerCall": 8,
    "timeoutMs": 3000,
    "confidenceThreshold": 0.72,
    "cacheTurns": 5
  }
}
```

项目级配置文件为 `<project>/.pi/jev-control.json`，其中的设置会覆盖全局配置。

### 语言

面向用户的提示、确认框、状态消息和工具结果支持英文与简体中文。英文为默认语言。可在配置中设置 `"language": "zh-CN"`，也可以在 Pi 中切换并持久保存全局语言：

```text
/jev language en
/jev language zh-CN
```

为保持 API 兼容，`allow`、`deny`、`cheap`、`strong` 等内部决策值不会翻译。

### 工具门控确认策略

工具门控默认使用 `"mode": "advisory"`，绝不会要求确认，也不会拦截工具调用。默认 `ui.notifications: "errors-only"` 时，日常辅助提示保持静默。Pi 自身内置的安全确认属于另一套机制，仍可能出现。

在当前会话中切换模式：

```text
/jev toolgate advisory
/jev toolgate enforce
```

在 `enforce` 严格模式中，`confirmOnLowConfidence` 控制低置信度确认。如需完全停止工具门控评估，可将 `toolGate.enabled` 设为 `false`。

## 自定义工具

- `jev_search_code` — 使用 rg 与判断排序查找与任务相关的代码（ripgrep 解析顺序：`PI_JEV_RG_PATH` → Pi 自带 `~/.pi/agent/bin/rg` → PATH）
- `jev_select_skills` — 为当前任务选择相关的 Pi 技能
- `jev_route_agent` — 确定最合适的代理类型（侦察/编码/审查）
- `jev_memory_search` — 使用 Jev 排序搜索本地记忆存储
- `jev_review_check` — 判断代码改动是否需要审查（v0.3）
- `jev_choose_ui_action` — 从候选项中选择最佳 UI 控件（v0.3）
- `jev_decide_batch` — 在一次有界且带缓存的请求中处理 1～8 个明确选择题（v0.5）

## 命令

- `/jev` — 显示状态
- `/jev probe` — 测试 Jev API 连通性
- `/jev stats` — 显示 API 使用统计
- `/jev savings` — 显示预计节省量（v0.3）
- `/jev last` — 显示上一次路由决策
- `/jev language en|zh-CN` — 切换并持久保存界面语言
- `/jev router on|off` — 开启或关闭任务路由器
- `/jev toolgate on|off` — 开启或关闭工具门控
- `/jev toolgate advisory|enforce` — 在非阻塞辅助模式和严格执行模式之间切换
- `/jev retry on|off` — 开启或关闭重试判断器
- `/jev contextgate on|off` — 开启或关闭上下文门控
- `/jev skillgate on|off` — 开启或关闭技能门控
- `/jev agentrouter on|off` — 开启或关闭代理路由器
- `/jev memory on|off` — 开启或关闭记忆门控
- `/jev memory clear` — 清除所有记忆记录
- `/jev memory stats` — 显示记忆存储统计
- `/jev memory resolve <id>` — 将持久化失败标记为已解决，ID 由 `jev_memory_search` 显示
- `/jev reviewgate on|off` — 开启或关闭审查门控
- `/jev guirouter on|off` — 开启或关闭 GUI 操作路由器
- `/jev compact on|off` — 开启或关闭压缩（v0.3）
- `/jev compact status` — 显示周期/压缩状态（v0.3）
- `/jev compact plan` — 生成新的裁剪计划（v0.3）
- `/jev compact clear` — 清除裁剪计划（v0.3）
- `/jev reset` — 重置状态、统计、节省信息和压缩周期

## 开发

```bash
npm install
npm run typecheck
npm test
npm run test:jev # 需要 TYPESAFE_API_KEY
pi -e ./extensions/index.ts
```

随后在 Pi 中运行 `/jev probe`，验证 Jev 连通性。
