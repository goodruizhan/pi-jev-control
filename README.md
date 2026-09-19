# pi-dev-control

Jev-powered control layer for Pi Coding Agent. Uses TypeSafe System One (Jev) as a low-cost decision control plane — routing, tool gating, failure classification, retry judgment, context filtering, skill selection, and memory management.

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

## Prerequisites

- Node.js >= 20
- `TYPESAFE_API_KEY` environment variable set (or Jev features will be unavailable)
- Pi Coding Agent

## Install

```bash
# Local development
pi -e ./extensions/index.ts

# After publishing
pi install git:github.com/<user>/pi-dev-control
```

## Configuration

Create `~/.pi/agent/jev-control.json`:

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
    "enabled": true,
    "maxCandidates": 40,
    "maxSelected": 5,
    "relevanceThreshold": 0.55
  },
  "skillGate": {
    "enabled": true,
    "maxSelected": 4
  },
  "memoryGate": {
    "enabled": true
  },
  "compaction": {
    "enabled": false,
    "preserveRecentMessages": 8,
    "minCharsToSave": 8000,
    "minTurnsBetweenPlans": 20
  }
}
```

Project-level config override: `<project>/.pi/jev-control.json` (overrides global).

## Custom Tools

- `jev_search_code` — Find code relevant to a task using rg + Jev ranking
- `jev_select_skills` — Select relevant Pi skills for the current task
- `jev_route_agent` — Determine best agent type (scout/coder/reviewer)
- `jev_memory_search` — Search local memory store with Jev ranking

## Commands

- `/jev` — Show status
- `/jev probe` — Test Jev API connectivity
- `/jev stats` — Show API usage statistics
- `/jev last` — Show last routing decision
- `/jev router on|off` — Toggle Task Router
- `/jev toolgate on|off` — Toggle Tool Gate
- `/jev retry on|off` — Toggle Retry Judge
- `/jev contextgate on|off` — Toggle Context Gate
- `/jev skillgate on|off` — Toggle Skill Gate
- `/jev memory on|off` — Toggle Memory Gate
- `/jev memory clear` — Clear all memory records
- `/jev memory stats` — Show memory store statistics
- `/jev reset` — Reset state and stats

## Development

```bash
npm install
pi -e ./extensions/index.ts
```

Then in Pi: `/jev probe` to verify Jev connectivity.
