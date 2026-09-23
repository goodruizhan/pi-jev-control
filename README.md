# pi-jev-control

[English](README.md) | [简体中文](README.zh-CN.md)

Jev-powered control layer for Pi Coding Agent. Uses TypeSafe System One (Jev) as a low-cost decision control plane — routing, tool gating, failure classification, retry judgment, context filtering, skill selection, memory management, context pruning, compaction epoch, review gate, and GUI action routing.

## v0.9 Model Priority and Thinking Levels

- **Multiple models per tier** — `router.models.<tier>` accepts an ordered candidate list; later candidates are used when a preferred model is missing or lacks authentication
- **Per-route thinking** — each model target can set `thinking`, applied through Pi's `setThinkingLevel()` after model selection; the same model can use different thinking levels for `medium` and `strong`
- **Backward compatible** — existing single-object model targets continue to work

## v0.8 Search & Backend Reliability

### v0.8.2 Search roots, fallback compatibility, and skill abstention

- **Root-relative search globs** — `jev_search_code` evaluates include patterns from each requested root, so nested roots correctly honor patterns such as `src/**/*.ts`
- **Serialized fallback state** — the deterministic rules backend accepts both internal tool state and serialized `tool_name`/`input` calls used by evaluation logs
- **Skill abstention** — semantic-only skill matches require higher confidence, and explicit exclusions such as “不涉及 UE5” prevent unrelated skills from being selected

### v0.8.1 Skill ranking precision

- **Bilingual skill matching** — Chinese interaction terms such as pickup, overlap, trace, actor, and blueprint are normalized before the lexical floor, protecting explicit user intent when skill descriptions are English

- **Natural-language code search** — `jev_search_code` expands requests into bounded literal terms, applies local lexical ranking, then delegates to the judgment reranker instead of treating a full sentence as one regex
- **Skill ranking** — folded/literal YAML frontmatter is parsed correctly, and an exact-token relevance floor stabilizes Jev scores for explicit technology/skill-name matches
- **Answer contract validation** — missing, out-of-range, or undeclared backend answers fail safely and enter the configured fallback chain
- **Embedding hardening** — empty, non-finite, and inconsistent vectors are rejected; invalid temperatures use the safe default
- **Runtime diagnostics** — `/jev status` reports the real version, usage labels are backend-neutral, and short default timeouts allow for cold connections

## v0.7 Embedding Backend & Backend Evaluation

- **Embedding backend** — zero-shot judgment via any OpenAI-compatible embeddings endpoint (cosine similarity + softmax; candidate embeddings cached in-memory)
- **Backend evaluation** — record live judgments to JSONL (`judgment.eval.recordPath`) and replay them against other backends with `npm run eval` before switching models; intentional abstentions from partial backends such as rules are reported as `unsupported`, not model failures

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
- With `retryJudge.appendToResult: false` (default), failed calls are counted locally without an automatic Jev request or changes to tool output. Opting into annotations calls Jev; failures are still counted when the backend is down. Automatic persistent failure memory additionally requires `memoryGate.mode: "auto"` and annotations enabled.
- Failure Judge timeout is bounded and configurable (2500 ms by default since v0.8)
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
- **Model-asked tools** (`jev_assess_task`, `jev_assess_risk`, `jev_diagnose_failure`, `jev_request_model_tier`, `jev_prune_context`, `jev_memory_add`, `jev_rank`) — Jev asked on demand, never automatic
- **Stats** — Track Jev API usage across all modules
- **Project config override** — `.pi/jev-control.json` overrides global config

## Control direction

Since v1.0.0 the plugin is inverted: **the model calls Jev, Jev never calls the model**.
Nothing changes your model, prunes your context, blocks your tools, or writes to memory
unless you — the model — ask for it through a `jev_*` tool. Jev never blocks a tool call,
only appends information to a tool result. Deterministic rules remain the safety floor and
never ask a model for permission.

The seven tools that implement this are `jev_assess_task`, `jev_assess_risk`,
`jev_diagnose_failure`, `jev_request_model_tier`, `jev_prune_context`, `jev_memory_add`,
and `jev_rank`. A bundled skill at `skills/pi-jev-control/SKILL.md` explains when to use
each one.

Enable `router.mode: "set-model"` or `"tier-only"` if you want routing back on, and
`compaction.autoMode: "suggest"` or `"auto"` if you want pruning back on.

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
    "cheapConfidenceThreshold": 0.85,
    "fallbackTier": "medium",
    "routerFailureTier": "medium",
    "mode": "rules-only",
    "models": {
      "cheap": {
        "provider": "openai-codex",
        "model": "gpt-5.6-luna",
        "thinking": "low"
      },
      "medium": {
        "provider": "openai-codex",
        "model": "gpt-5.6-sol",
        "thinking": "medium"
      },
      "strong": [
        {
          "provider": "sensenova",
          "model": "kimi-k3",
          "thinking": "high"
        },
        {
          "provider": "openai-codex",
          "model": "gpt-5.6-sol",
          "thinking": "high"
        }
      ]
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
    "timeoutMs": 2500,
    "skipBenignExitCodes": true,
    "appendToResult": false
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
    "enabled": false,
    "mode": "suggest"
  },
  "compaction": {
    "enabled": true,
    "autoMode": "off",
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
    "timeoutMs": 2500,
    "cacheTurns": 3
  },
  "decisionCopilot": {
    "enabled": true,
    "silent": true,
    "maxCallsPerTurn": 1,
    "maxQuestionsPerCall": 8,
    "timeoutMs": 5000,
    "confidenceThreshold": 0.72,
    "cacheTurns": 5
  }
}
```

Project-level config override: `<project>/.pi/jev-control.json` (overrides global).

`router.mode` is the only thing that makes routing happen: `rules-only` (default) and
`off` compute a tier but never switch the model, `"tier-only"` computes a tier and never
switches, `"set-model"` switches with Jev input and no Jev without, `"off"` disables the
module. Only the model's own `jev_request_model_tier` call or a `/jev route <tier>`
command can switch models while `router.mode` is `rules-only`.

`memoryGate.mode` is `suggest` (default) or `auto`. `suggest` only notifies and never
writes to memory; `auto` lets the gate write records to disk. Either way,
`jev_memory_add` writes straight through — it does not pass through the gate.
`memoryGate.enabled: false` disables the gate's detection entirely.

`compaction.autoMode` is `off` (default), `suggest`, or `auto`. `off` and `suggest` never
prune without the model calling `jev_prune_context`; `suggest` also notifies before
applying. `auto` restores the pre-v1.0 automatic behavior.

Each `router.models` tier accepts either the legacy single object or an ordered candidate array. `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Pi maps or clamps the requested level to the selected model's supported levels. If every candidate in a tier fails, routing tries higher tiers. It never falls downward or retries a model API request that has already started.

Routing includes recent conversation, tool activity, failures, and deterministic risk features. Risk rules set a minimum tier; `cheapConfidenceThreshold` adds a stricter threshold for cheap, with a 0.95 minimum for self-reported or similarity confidence. These thresholds still need evaluation on real tasks. If judgment is unavailable or fails, `routerFailureTier` is used instead of retaining the previous model. Short confirmations inherit the current task tier. Long inputs preserve both the beginning and final constraints while risk extraction scans the full input. Tool results can upgrade the model for later steps after multiple file changes or repeated failures.

Prefix an input with `[cheap]`, `[medium]`, or `[strong]` to force its initial tier; newly observed tool risk may still upgrade it. `/jev route strong` sets the next substantive input's initial tier. `/jev last` shows raw judgment, requested tier, actual model, and switch outcome. The last 50 structured route records remain in process memory and are written to Pi's console log. Config file changes are detected on the next read; source changes require reloading the extension. A Git-installed Pi copy is separate from this development checkout and must be updated before the changes run there.

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
2. **Replay** — `npm run eval` replays a dataset against every other configured backend and reports agreement rate, average distance, average confidence, and latency per backend. `--dataset <file>` points at your recording; the default is the bundled seed set `test/eval/cases.jsonl` with expected labels. `--backends a,b` and `--reference name` override the lineup. Partial binary backends may report intentionally unsupported questions separately.

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

In `enforce` mode, deterministic dangerous commands require confirmation. `confirmOnLowConfidence` only affects the policy reported by the model-invoked `jev_assess_risk` tool; it does not control automatic Tool Gate prompts. Set `toolGate.enabled` to `false` to disable Tool Gate evaluation entirely.

## Custom Tools

Model-invoked judgment tools:

- `jev_assess_task` — Assess task complexity and suggest a model tier
- `jev_assess_risk` — Assess an operation and report the deterministic command policy
- `jev_diagnose_failure` — Classify a failure and suggest the next action
- `jev_request_model_tier` — Explicitly request a model tier change
- `jev_prune_context` — Request a context pruning plan
- `jev_memory_add` — Save a durable memory entry
- `jev_rank` — Rank an explicit set of candidates

Additional tools:

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
- `/jev route cheap|medium|strong` — Set the next substantive input's initial tier
- `/jev language en|zh-CN` — Switch and persist the UI language
- `/jev router on|off` — Toggle Task Router
- `/jev router mode rules-only|advisory|tier-only|set-model|off` — Select routing mode
- `/jev decision on|off` — Toggle Decision Copilot
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
npm install --include=dev
npm run typecheck
npm test
npm run test:jev # requires TYPESAFE_API_KEY
pi -e ./extensions/index.ts
```

Pi's installed Git copy may contain only production dependencies (no `tsc`). To run tests **in that copy**, first run `npm install --include=dev --ignore-scripts` there; development builds/tests require TypeScript. Then in Pi: `/jev probe` to verify Jev connectivity.
