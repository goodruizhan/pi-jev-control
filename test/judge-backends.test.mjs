import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, invalidateConfig } from "../dist/src/config.js";
import { resolveBackend, resolveFallback, allConfiguredBackends, resetJudgeBackends } from "../dist/src/judge/registry.js";
import { OpenAiCompatibleBackend } from "../dist/src/judge/openai-backend.js";
import { choice, noul, score } from "../dist/src/judge/ir.js";

// ── Config backward compatibility ───────────────────────────────────────

test("legacy jev.* settings flow into the typesafe judgment backend", () => {
  invalidateConfig();
  resetJudgeBackends();
  const config = loadConfig();
  assert.equal(config.judgment.backend, "typesafe");
  const typesafe = config.judgment.backends.typesafe;
  assert.equal(typesafe.type, "typesafe-api");
  assert.equal(typesafe.apiKeyEnv, "TYPESAFE_API_KEY");
  // model/timeoutMs inherit the legacy jev.* values
  assert.equal(typesafe.model, config.jev.model);
  assert.equal(typesafe.timeoutMs, config.jev.timeoutMs);
});

test("registry resolves the default backend and no fallback by default", () => {
  resetJudgeBackends();
  const backend = resolveBackend("router");
  assert.equal(backend.name, "typesafe");
  assert.equal(backend.confidenceKind, "calibrated");
  assert.equal(resolveFallback(backend), null);
  assert.equal(allConfiguredBackends().length, 1);
});

// ── IR builders ─────────────────────────────────────────────────────────

test("IR builders match the System One wire shape", () => {
  assert.deepEqual(noul("Is it risky?"), { type: "noul", instructions: "Is it risky?", criteria: undefined });
  assert.deepEqual(choice("Pick one", { a: "A option", b: null }), {
    type: "choice",
    instructions: "Pick one",
    criteria: { a: "A option", b: null },
  });
  assert.deepEqual(score("Rate it", ["low", "high"]), { type: "score", instructions: "Rate it", criteria: ["low", "high"] });
});

// ── OpenAI-compatible backend ───────────────────────────────────────────

function mockFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

function makeBackend() {
  return new OpenAiCompatibleBackend({ name: "test-local", model: "qwen3:1.7b", timeoutMs: 5000 });
}

test("openai-compatible backend requires a configured model", () => {
  const backend = new OpenAiCompatibleBackend({ name: "no-model" });
  assert.equal(backend.isAvailable(), false);
  assert.match(backend.unavailableReason() ?? "", /no model configured/);
});

test("openai-compatible backend requires the api key env when one is named", () => {
  const backend = new OpenAiCompatibleBackend({ name: "needs-key", model: "m", apiKeyEnv: "PI_JEV_TEST_MISSING_KEY" });
  assert.equal(backend.isAvailable(), false);
  assert.match(backend.unavailableReason() ?? "", /PI_JEV_TEST_MISSING_KEY not set/);
});

test("openai-compatible backend normalizes a well-formed response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    choices: [{
      message: {
        content: JSON.stringify({
          answers: {
            tier: { choice: "Cheap", confidence: 0.9 },
            risky: { probability: 1.4 },
          },
        }),
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 20 },
  });
  try {
    const backend = makeBackend();
    const outcome = await backend.judge(
      {
        state: { task: "rename a variable" },
        questions: {
          tier: choice("Pick a tier", { cheap: null, strong: null }),
          risky: noul("Is this risky?"),
        },
      },
      {},
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.backend, "test-local");
    assert.equal(outcome.confidenceKind, "self-reported");
    // Fuzzy case-insensitive choice matching
    assert.deepEqual(outcome.answers.tier, { type: "choice", choice: "cheap", confidence: 0.9 * 0.6 });
    // Probabilities clamp to [0, 1]
    assert.deepEqual(outcome.answers.risky, { type: "noul", noul: 1 });
    assert.equal(outcome.usage.input_tokens, 120);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible backend discounts unmatched choices and skips missing answers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    choices: [{ message: { content: '{"answers": {"tier": {"choice": "bogus", "confidence": 0.8}}}' } }],
  });
  try {
    const backend = makeBackend();
    const outcome = await backend.judge(
      { state: { task: "x" }, questions: { tier: choice("Pick", { cheap: null, strong: null }), missing: noul("?") } },
      {},
    );
    assert.equal(outcome.ok, true);
    const tier = outcome.answers.tier;
    assert.equal(tier.type, "choice");
    assert.equal(tier.choice, "bogus");
    assert.ok(tier.confidence <= 0.3, `unmatched choice should be discounted, got ${tier.confidence}`);
    assert.equal(outcome.answers.missing, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible backend extracts JSON from prose and fences", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    choices: [{ message: { content: 'Sure! Here you go:\n```json\n{"answers": {"risky": {"probability": 0.2}}}\n```\nDone.' } }],
  });
  try {
    const backend = makeBackend();
    const outcome = await backend.judge({ state: { task: "x" }, questions: { risky: noul("?") } }, {});
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.answers.risky, { type: "noul", noul: 0.2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible backend maps HTTP errors to error types", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({}, 401);
  try {
    const backend = makeBackend();
    const outcome = await backend.judge({ state: { task: "x" }, questions: { risky: noul("?") } }, {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "auth");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible backend never throws on connection failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const backend = makeBackend();
    const outcome = await backend.judge({ state: { task: "x" }, questions: { risky: noul("?") } }, {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
