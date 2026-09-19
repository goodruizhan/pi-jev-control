# pi-dev-control

Jev-powered control layer for Pi Coding Agent. Uses TypeSafe System One (Jev) as a low-cost decision control plane — routing, tool gating, failure classification, retry judgment.

## v0.1 Features

- **Task Router** — Classify incoming tasks as cheap/medium/strong, switch model tier
- **Model Router** — Map task tier to configured model, `pi.setModel()`
- **Tool Gate** — Deterministic safe/dangerous rules + Jev for uncertain operations
- **Failure Classifier + Retry Judge** — Classify failures, suggest retry strategy
- **Stats** — Track Jev API usage across all modules
- **/jev commands** — `/jev probe`, `/jev status`, `/jev stats`, `/jev router on/off`, etc.

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
  }
}
```

## Commands

- `/jev` — Show status
- `/jev probe` — Test Jev API connectivity
- `/jev stats` — Show API usage statistics
- `/jev last` — Show last routing decision
- `/jev router on|off` — Toggle Task Router
- `/jev toolgate on|off` — Toggle Tool Gate
- `/jev retry on|off` — Toggle Retry Judge

## Development

```bash
npm install
pi -e ./extensions/index.ts
```

Then in Pi: `/jev probe` to verify Jev connectivity.
