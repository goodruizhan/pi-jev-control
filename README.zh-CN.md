# pi-jev-control

[English](README.md) | [简体中文](README.zh-CN.md)

为 Pi Coding Agent 提供由 Jev 驱动的控制层。它使用 TypeSafe System One（Jev）作为低成本决策控制平面，涵盖任务路由、工具门控、失败分类、重试判断、上下文过滤、技能选择、记忆管理、上下文裁剪、压缩周期、审查门控和 GUI 操作路由。

## v0.3 新功能

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
pi install git:github.com/<user>/pi-jev-control
```

## 配置

创建 `~/.pi/agent/jev-control.json`：

```json
{
  "enabled": true,
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
    "useDeterministicFastPath": true
  },
  "retryJudge": {
    "enabled": true,
    "maxSameFailureRetries": 1
  },
  "contextGate": {
    "enabled": false,
    "maxCandidates": 40,
    "maxSelected": 5,
    "relevanceThreshold": 0.55
  },
  "skillGate": {
    "enabled": false,
    "maxSelected": 4,
    "relevanceThreshold": 0.55
  },
  "agentRouter": {
    "enabled": true
  },
  "memoryGate": {
    "enabled": false
  },
  "compaction": {
    "enabled": false,
    "preserveRecentMessages": 8,
    "minCharsToSave": 8000,
    "minTurnsBetweenPlans": 20
  },
  "reviewGate": {
    "enabled": true
  },
  "guiRouter": {
    "enabled": true,
    "confidenceThreshold": 0.70
  }
}
```

项目级配置文件为 `<project>/.pi/jev-control.json`，其中的设置会覆盖全局配置。

## 自定义工具

- `jev_search_code` — 使用 rg 与 Jev 排序查找与任务相关的代码
- `jev_select_skills` — 为当前任务选择相关的 Pi 技能
- `jev_route_agent` — 确定最合适的代理类型（侦察/编码/审查）
- `jev_memory_search` — 使用 Jev 排序搜索本地记忆存储
- `jev_review_check` — 判断代码改动是否需要审查（v0.3）
- `jev_choose_ui_action` — 从候选项中选择最佳 UI 控件（v0.3）

## 命令

- `/jev` — 显示状态
- `/jev probe` — 测试 Jev API 连通性
- `/jev stats` — 显示 API 使用统计
- `/jev savings` — 显示预计节省量（v0.3）
- `/jev last` — 显示上一次路由决策
- `/jev router on|off` — 开启或关闭任务路由器
- `/jev toolgate on|off` — 开启或关闭工具门控
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
