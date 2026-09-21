# pi-jev-control

[English](README.md) | [简体中文](README.zh-CN.md)

Jev-powered control layer for Pi Coding Agent. Uses TypeSafe System One (Jev) as a low-cost decision control plane — routing, tool gating, failure classification, retry judgment, context filtering, skill selection, memory management, context pruning, compaction epoch, review gate, and GUI action routing.

## v0.7 Embedding Backend & Backend Evaluation

- **Embedding backend** — zero-shot judgment via any OpenAI-compatible embeddings endpoint (cosine similarity + softmax; candidate embeddings cached in-memory)
- **Backend evaluation** — record live judgments to JSONL (`judgment.eval.recordPath`) and replay them against other backends with `npm run eval` before switching models

## v0.6 Pluggable Judgment Backends

- **Judgment backend abstraction** — every decision flows through a neutral IR (`choice`/`noul`/`score`); Jev is now the default *backend*, not the core
- **Jev-compatible clones** — any endpoint speaking the System One wire format (`POST /v1/systemone`) plugs in with config only (`type: "typesafe-api"` + `baseUrl`/`apiKeyEnv`/`model`)
- **Small local models** — the `openai-compatible` backend targets Ollama/vLLM/LM Studio for offline or private judgment (self-reported confidence, fuzzy answer normalization)
- **Per-module routing** — `judgment.modules` assigns a backend per module (router, toolGate, ...); `judgment.fallback` adds a standby backend
- **Honest confidence** — each backend declares its confidence kind (`calibrated` vs `self-reported`) so thresholds are interpreted correctly
- **Per-backend stats** — `/jev stats` breaks usage down by backend
- **Field fixes** — ripgrep resolution no longer depends on PATH, decision batches get a realistic timeout, skill discovery covers `pi-hermes-memory` skills, startup warns about unconfigured `REPLACE_ME` router models

## v0.5 Silent Decision Copilot

- **Batch decisions** — `jev_decide_batch` resolves up to 8 bounded choice questions in one Jev request
- **Per-turn budget** — one Decision Copilot request per turn by default; repeated inputs use a five-turn cache
- **Quiet by default** — automatic notifications use `errors-only`; explicit `/jev` commands still show their results
- **Local-first pruning** — duplicate read-only calls are dropped and large read-only results are truncated before Jev is consulted
- **No-op routing removed** — model-tier classification is skipped when no target models are configured
- **Safer GUI routing** — low-risk target selection is cached; high-risk actions return control to the user
- **Measurable ROI** — `/jev savings` reports Jev token cost, added latency, and estimated net tokens saved

## v0.4 Runtime Reliability

- Reuses an approved `write`/`edit` path within the same user task
- Block messages include `uncertainField` and `retryHint`
- Skips benign `rg`/`grep` exit code 1 locally without a Jev request
- Sends exit code, stderr, command category, abort state, and failure count to Jev
- Repeated action/failure families short-circuit locally to `do_not_retry`
- Retry circuit breaking starts after two same-family failures; remembered failures warn by default instead of blocking
- Failure assessments are explicitly labeled as plugin output; set `retryJudge.appendToResult: false` to keep failure memory and retry judgment without touching tool output
- Failure Judge timeout reduced to 1200 ms by default
- Context, skill, memory, and compaction gates are enabled by default
- Compaction skips Jev locally when available tool output cannot meet the savings threshold
- Savings report includes actual removed characters and operational counters

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

Project-level config override: `<project>/.pi/jev-control.json` (overrides global).

### Judgment backends

All modules ask a **judgment backend** for decisions. The default backend is `typesafe` (Jev via the TypeSafe API). You can add backends, swap the default, assign backends per module, and configure a fallback — without touching code.

```json
{
  "judgment": {
    "backend": "typesafe",
    "fallback": "local-small",
    "modules": {
      "contextGate": "local-small"
    },
    "backends": {
      "typesafe": {
        "type": "typesafe-api",
        "apiKeyEnv": "TYPESAFE_API_KEY",
        "model": "jev-latest",
        "timeoutMs": 4000
      },
      "openjev": {
        "type": "typesafe-api",
        "baseUrl": "https://api.openjev.example",
        "apiKeyEnv": "OPENJEV_API_KEY",
        "model": "openjev-1"
      },
      "local-small": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen3:1.7b",
        "timeoutMs": 8000
      },
      "local-embed": {
        "type": "embedding",
        "baseUrl": "http://localhost:11434/v1",
        "model": "nomic-embed-text"
      }
    },
    "eval": {
      "recordPath": "~/.pi/agent/jev-control-eval.jsonl"
    }
  }
}
```

Backend types:

- **`typesafe-api`** — Jev or any Jev-compatible clone exposing the System One wire format (`POST {baseUrl}/v1/systemone`). `baseUrl` is the API root without a `/v1` suffix (e.g. `https://api.typesafe.ai`). Returns calibrated probabilities (`confidenceKind: "calibrated"`).
- **`openai-compatible`** — any OpenAI chat-completions endpoint, intended for **small, fast judgment models** (1–4B class, e.g. Ollama locally). Answers are parsed from strict JSON with fuzzy choice matching; confidence is `self-reported`, so treat thresholds more conservatively. Pointing this at a large general LLM defeats the purpose of a fast decision layer.
- **`embedding`** — any OpenAI-compatible embeddings endpoint (`POST {baseUrl}/embeddings`). Zero-shot judgment: the question+state becomes a query text, each option becomes a candidate text, cosine similarity + softmax picks the answer. Confidence is `similarity` — it only measures how much the winner beats the rest, so keep thresholds conservative. Static candidate texts (option labels) are cached in memory, so each judgment costs one batched HTTP call.
- **`rules`** — bundled deterministic rules for known shell risks, repeated failures, forced code review, and memory type patterns. It is configured as the default last-resort fallback and uses no API key or tokens. If any question in a request has no matching rule, the backend returns `unavailable` and the calling module uses its existing safe fallback; it never presents a zero probability as a model judgment. Rules do not make Jev or another model appear available to model-only features.

### Comparing backends (`npm run eval`)

Before swapping `judgment.backend` to a new model, measure it against the current one:

1. **Record real traffic** — set `judgment.eval.recordPath` and use Pi normally. Every successful judgment is appended as one JSONL line (state, questions, answers, latency).
2. **Replay** — `npm run eval` replays a dataset against every other configured backend and reports agreement rate, average distance, average confidence, and latency per backend. `--dataset <file>` points at your recording; the default is the bundled seed set `test/eval/cases.jsonl` with expected labels. `--backends a,b` and `--reference name` override the lineup.

The recording hook is best-effort and never blocks or breaks live judgments.

Notes:

- API keys come from environment variables named by `apiKeyEnv` — never put keys in the config file.
- The legacy top-level `jev.model` / `jev.timeoutMs` keys keep working; they fill gaps in `judgment.backends.typesafe`.
- `judgment.modules` keys are module names: `router`, `toolGate`, `failureJudge`, `contextGate`, `skillGate`, `memoryGate`, `memorySearch`, `compaction`, `reviewGate`, `guiRouter`, `decision`.
- When the primary backend is unavailable or fails, `judgment.fallback` gets one attempt; beyond that each module falls back to its local heuristics as before.
- Set `judgment.fallback` to `null` to disable the built-in rules fallback.

### Language

User-facing prompts, confirmations, status messages, and tool results support English and Simplified Chinese. English is the default. Set `"language": "zh-CN"` in the config, or switch and persist the global language from Pi:

```text
/jev language en
/jev language zh-CN
```

Internal decision values such as `allow`, `deny`, `cheap`, and `strong` remain unchanged for API compatibility.

### Tool Gate confirmation policy

Tool Gate defaults to `"mode": "advisory"`. It never asks for confirmation or blocks a tool call. With the default `ui.notifications: "errors-only"`, routine advisory notices remain silent. Pi's own built-in security confirmations are separate and may still appear.

Switch modes for the current session:

```text
/jev toolgate advisory
/jev toolgate enforce
```

In `enforce` mode, `confirmOnLowConfidence` controls low-confidence prompts. Set `toolGate.enabled` to `false` to disable Tool Gate evaluation entirely.

## Custom Tools

- `jev_search_code` — Find code relevant to a task using rg + judgment ranking (ripgrep is resolved via `PI_JEV_RG_PATH`, then Pi's bundled `~/.pi/agent/bin/rg`, then PATH)
- `jev_select_skills` — Select relevant Pi skills for the current task
- `jev_route_agent` — Determine best agent type (scout/coder/reviewer)
- `jev_memory_search` — Search local memory store with Jev ranking
- `jev_review_check` — Determine if code change needs review (v0.3)
- `jev_choose_ui_action` — Select best UI control from candidates (v0.3)
- `jev_decide_batch` — Resolve 1–8 explicit choice questions in one bounded, cached request (v0.5)

## Commands

- `/jev` — Show status
- `/jev probe` — Test Jev API connectivity
- `/jev stats` — Show API usage statistics
- `/jev savings` — Show estimated savings (v0.3)
- `/jev last` — Show last routing decision
- `/jev language en|zh-CN` — Switch and persist the UI language
- `/jev router on|off` — Toggle Task Router
- `/jev toolgate on|off` — Toggle Tool Gate
- `/jev toolgate advisory|enforce` — Switch between non-blocking assistance and strict enforcement
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
