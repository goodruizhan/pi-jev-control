# pi-jev-control

[English](README.md) | [简体中文](README.zh-CN.md)

Jev-powered control layer for Pi Coding Agent. Uses TypeSafe System One (Jev) as a low-cost decision control plane — routing, tool gating, failure classification, retry judgment, context filtering, skill selection, memory management, context pruning, compaction epoch, review gate, and GUI action routing.

## v0.3 Features (New)

- **Bilingual UI** — switch user-facing prompts and results with `/jev language en|zh-CN`
- **Context Pruning** — `pi.on("context")` to prune old tool output from messages view (never modifies on-disk session)
  - Tool Call/Result group builder — pairs call+result, never leaves orphans
  - Recent N protection — last 8 messages always kept
  - Failure protection — unresolved failures always KEEP
  - KEEP_RAW / TRUNCATE / DROP three-level decisions
- **Compaction Epoch** — cross-turn pruning plan reuse, stable prompt prefix
  - `/jev compact status|plan|clear|on|off`
- **Cache-aware Gate** — only prune when savings >= 8000 chars AND drop ratio >= 15%
- **Native Pi Compaction** — `session_before_compact` reports important Memory records before native compaction
- **Review Gate** (`jev_review_check`) — skip/normal_review/strong_review
  - Forced strong: GC, Multithreading, Replication, GAS, Engine internals
- **GUI Action Router** (`jev_choose_ui_action`) — select target from candidate UI controls
  - confidence < threshold → unknown, never force-click
- **Savings Stats** — `/jev savings` estimated context tokens saved

## v0.2 Features

- **Task Router** — Classify incoming tasks as cheap/medium/strong, switch model tier
- **Model Router** — Map task tier to configured model, `pi.setModel()`
- **Tool Gate** — Deterministic safe/dangerous rules + Jev for uncertain operations
- **Failure Classifier + Retry Judge** — Classify failures, suggest retry strategy
- **Context Gate** (`jev_search_code`) — rg-based code search + Jev relevance ranking
- **Skill Gate** (`jev_select_skills`) — Skill discovery + Jev relevance ranking
- **Agent Router** (`jev_route_agent`) — scout/coder/reviewer classification
- **Memory Gate** — User input analysis, constraint/decision/failure detection
- **Memory Store** — Local JSONL persistence (`~/.pi/agent/jev-control-data/`)
- **Memory Search** (`jev_memory_search`) — Local filter + Jev relevance ranking
- **Stats** — Track Jev API usage across all modules
- **Project config override** — `.pi/jev-control.json` overrides global config

## v0.1 Features

- Jev Client — unified TypeSafe SDK wrapper with graceful degradation
- /jev command — status, probe, stats, toggles

## Prerequisites

- Node.js >= 20
- `TYPESAFE_API_KEY` environment variable set (or Jev features will be unavailable)
- Pi Coding Agent

## Install

```bash
# Local development
pi -e ./extensions/index.ts

# After publishing
pi install git:github.com/goodruizhan/pi-jev-control
```

## Configuration

Create `~/.pi/agent/jev-control.json`:

```json
{
  "enabled": true,
  "language": "en",
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
    "useDeterministicFastPath": true,
    "confirmOnLowConfidence": false
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

Project-level config override: `<project>/.pi/jev-control.json` (overrides global).

### Language

User-facing prompts, confirmations, status messages, and tool results support English and Simplified Chinese. English is the default. Set `"language": "zh-CN"` in the config, or switch and persist the global language from Pi:

```text
/jev language en
/jev language zh-CN
```

Internal decision values such as `allow`, `deny`, `cheap`, and `strong` remain unchanged for API compatibility.

### Tool Gate confirmation policy

`toolGate.confirmOnLowConfidence` defaults to `false` for a smoother workflow. Low-confidence Jev decisions continue without prompting. Deterministically dangerous commands still require confirmation, high-confidence denials are still blocked, and unavailable Jev still falls back to manual confirmation. Set it to `true` for the stricter previous behavior.

## Custom Tools

- `jev_search_code` — Find code relevant to a task using rg + Jev ranking
- `jev_select_skills` — Select relevant Pi skills for the current task
- `jev_route_agent` — Determine best agent type (scout/coder/reviewer)
- `jev_memory_search` — Search local memory store with Jev ranking
- `jev_review_check` — Determine if code change needs review (v0.3)
- `jev_choose_ui_action` — Select best UI control from candidates (v0.3)

## Commands

- `/jev` — Show status
- `/jev probe` — Test Jev API connectivity
- `/jev stats` — Show API usage statistics
- `/jev savings` — Show estimated savings (v0.3)
- `/jev last` — Show last routing decision
- `/jev language en|zh-CN` — Switch and persist the UI language
- `/jev router on|off` — Toggle Task Router
- `/jev toolgate on|off` — Toggle Tool Gate
- `/jev retry on|off` — Toggle Retry Judge
- `/jev contextgate on|off` — Toggle Context Gate
- `/jev skillgate on|off` — Toggle Skill Gate
- `/jev agentrouter on|off` — Toggle Agent Router
- `/jev memory on|off` — Toggle Memory Gate
- `/jev memory clear` — Clear all memory records
- `/jev memory stats` — Show memory store statistics
- `/jev memory resolve <id>` — Mark a persistent failure as resolved (IDs are shown by `jev_memory_search`)
- `/jev reviewgate on|off` — Toggle Review Gate
- `/jev guirouter on|off` — Toggle GUI Action Router
- `/jev compact on|off` — Toggle compaction (v0.3)
- `/jev compact status` — Show epoch/compaction status (v0.3)
- `/jev compact plan` — Generate new pruning plan (v0.3)
- `/jev compact clear` — Clear pruning plan (v0.3)
- `/jev reset` — Reset state, stats, savings, and epoch

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:jev # requires TYPESAFE_API_KEY
pi -e ./extensions/index.ts
```

Then in Pi: `/jev probe` to verify Jev connectivity.
