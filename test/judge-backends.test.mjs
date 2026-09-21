import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, invalidateConfig } from "../dist/src/config.js";
import { resolveBackend, resolveFallback, allConfiguredBackends, resetJudgeBackends } from "../dist/src/judge/registry.js";
import { OpenAiCompatibleBackend } from "../dist/src/judge/openai-backend.js";
import { choice, noul, score } from "../dist/src/judge/ir.js";
import { isJudgeAvailable, judge } from "../dist/src/judge/facade.js";

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

test("registry resolves the default backend and the rules fallback by default", () => {
  resetJudgeBackends();
  const backend = resolveBackend("router");
  assert.equal(backend.name, "typesafe");
  assert.equal(backend.confidenceKind, "calibrated");
  const fallback = resolveFallback(backend);
  assert.ok(fallback);
  assert.equal(fallback.name, "rules");
  assert.equal(fallback.confidenceKind, "binary");
  assert.equal(allConfiguredBackends().length, 2);
});

test("rules fallback does not masquerade as a model or invent Noul probabilities", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    resetJudgeBackends();
    assert.equal(isJudgeAvailable(), false);
    const outcome = await judge({}, { relevance: noul("Is this relevant?") }, { module: "contextGate" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "unavailable");
    assert.equal(outcome.backend, "rules");
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    resetJudgeBackends();
  }
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

test("openai-compatible backend rejects incomplete answer sets", async () => {
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
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "unknown");
    assert.match(outcome.error, /unparseable model output/);
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

// ── Embedding backend ───────────────────────────────────────────────────

import { EmbeddingBackend } from "../dist/src/judge/embedding-backend.js";
import { getBackendByName } from "../dist/src/judge/registry.js";

/** Mock /embeddings: fn maps each input text to a vector; calls are recorded. */
function mockEmbeddingFetch(vectorFor, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((text, index) => ({ embedding: vectorFor(text), index })),
        usage: { prompt_tokens: 42 },
      }),
    };
  };
}

test("embedding backend requires a configured model", () => {
  const backend = new EmbeddingBackend({ name: "no-model" });
  assert.equal(backend.isAvailable(), false);
  assert.match(backend.unavailableReason() ?? "", /no model configured/);
});

test("embedding backend picks the most similar choice candidate", async () => {
  const originalFetch = globalThis.fetch;
  // query/candidate containing the marker are close; everything else is orthogonal
  globalThis.fetch = mockEmbeddingFetch((text) => (text.includes("alpha-ish") ? [1, 0] : [0, 1]));
  try {
    const backend = new EmbeddingBackend({ name: "emb", model: "nomic-embed-text" });
    const outcome = await backend.judge(
      {
        state: { hint: "this state is alpha-ish" },
        questions: { pick: choice("Pick one", { alpha: "alpha-ish option", beta: "something else" }) },
      },
      {},
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.confidenceKind, "similarity");
    assert.equal(outcome.answers.pick.type, "choice");
    assert.equal(outcome.answers.pick.choice, "alpha");
    const probs = Object.values(outcome.answers.pick.probabilities);
    assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-9, "probabilities sum to 1");
    assert.equal(outcome.usage.input_tokens, 42);
    assert.equal(outcome.usage.output_tokens, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding backend answers noul with a softmax probability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockEmbeddingFetch((text) => (text === "no" ? [0, 1] : [1, 0]));
  try {
    const backend = new EmbeddingBackend({ name: "emb", model: "nomic-embed-text" });
    const outcome = await backend.judge(
      { state: { x: 1 }, questions: { risky: noul("Is this risky?") } },
      {},
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.answers.risky.type, "noul");
    // query ≈ "yes" anchor, far from "no" → high probability with default temperature
    assert.ok(outcome.answers.risky.noul > 0.9, `expected high noul, got ${outcome.answers.risky.noul}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding backend caches candidate embeddings across calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = mockEmbeddingFetch((text) => (text.includes("x") ? [1, 0] : [0, 1]), calls);
  try {
    const backend = new EmbeddingBackend({ name: "emb", model: "nomic-embed-text" });
    const questions = { pick: choice("Pick", { a: "ax", b: "b" }) };
    await backend.judge({ state: { run: 1, x: true }, questions }, {});
    await backend.judge({ state: { run: 2, x: true }, questions }, {});
    assert.equal(calls.length, 2);
    // First call embeds query + 2 candidates; second call only the fresh query
    assert.equal(calls[0].input.length, 3);
    assert.equal(calls[1].input.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding backend rejects invalid vector payloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockEmbeddingFetch((text) => (text === "no" ? [0] : [1, Number.NaN]));
    const backend = new EmbeddingBackend({ name: "emb", model: "m", temperature: 0 });
    const outcome = await backend.judge({ state: {}, questions: { q: noul("?") } }, {});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /invalid embedding vectors/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedding backend maps HTTP errors and never throws", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    let backend = new EmbeddingBackend({ name: "emb", model: "m" });
    let outcome = await backend.judge({ state: {}, questions: { q: noul("?") } }, {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "auth");

    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    backend = new EmbeddingBackend({ name: "emb", model: "m" });
    outcome = await backend.judge({ state: {}, questions: { q: noul("?") } }, {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorType, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registry instantiates embedding backends from config", () => {
  const config = loadConfig();
  config.judgment.backends["emb-test"] = { type: "embedding", model: "nomic-embed-text" };
  resetJudgeBackends();
  const backend = getBackendByName("emb-test");
  assert.ok(backend);
  assert.equal(backend.confidenceKind, "similarity");
  assert.equal(backend.isAvailable(), true);
  delete config.judgment.backends["emb-test"];
  resetJudgeBackends();
});
