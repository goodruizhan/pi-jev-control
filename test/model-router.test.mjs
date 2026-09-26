import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, resetConfigToDefaults } from "../dist/src/config.js";
import { modelCandidates, routeModel, routeModelDetailed } from "../dist/src/router/model-router.js";

function makeContext(models, currentModel) {
  return {
    model: currentModel,
    modelRegistry: {
      find(provider, id) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    ui: { notify() {} },
  };
}

test("modelCandidates keeps legacy single targets and ordered target lists compatible", () => {
  const single = { provider: "provider-a", model: "model-a" };
  const ordered = [single, { provider: "provider-b", model: "model-b", thinking: "high" }];

  assert.deepEqual(modelCandidates(single), [single]);
  assert.deepEqual(modelCandidates(ordered), ordered);
});

test("model router respects off and disabled boundaries even when invoked directly", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const target = { provider: "provider-a", id: "model-a" };
  config.router.models.strong = { provider: target.provider, model: target.id };
  const calls = [];
  const pi = {
    async setModel(model) { calls.push(model.id); return true; },
    getThinkingLevel: () => "low",
  };
  const ctx = makeContext([target]);

  for (const [enabled, routerEnabled, mode, reason] of [
    [false, true, "set-model", "router disabled"],
    [true, false, "set-model", "router disabled"],
    [true, true, "off", "router mode is off"],
  ]) {
    config.enabled = enabled;
    config.router.enabled = routerEnabled;
    config.router.mode = mode;
    assert.deepEqual(await routeModelDetailed(pi, ctx, "strong"), {
      success: false, tier: "strong", reason,
    });
  }
  assert.deepEqual(calls, []);

  config.router.mode = "tier-only";
  const advisory = await routeModelDetailed(pi, ctx, "strong");
  assert.equal(advisory.success, true);
  assert.equal(advisory.tier, "strong");
  assert.deepEqual(calls, []);
});

test("model router uses provider/id lookup and only falls upward after missing, unauthenticated, or throwing candidates", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.router.models.cheap = [
    { provider: "provider-missing", model: "not-registered" },
    { provider: "provider-a", model: "unauthed" },
    { provider: "provider-b", model: "throws" },
  ];
  config.router.models.medium = { provider: "provider-c", model: "available", thinking: "high" };
  config.router.models.strong = { provider: "provider-d", model: "not-needed" };
  const models = [
    { provider: "provider-a", id: "unauthed" },
    { provider: "provider-b", id: "throws" },
    { provider: "provider-c", id: "available" },
    { provider: "provider-d", id: "not-needed" },
  ];
  const lookups = [];
  const calls = [];
  const ctx = makeContext(models);
  ctx.modelRegistry.find = (provider, id) => {
    lookups.push(`${provider}/${id}`);
    return models.find((model) => model.provider === provider && model.id === id);
  };
  let thinking = "low";
  const pi = {
    async setModel(model) {
      calls.push(`${model.provider}/${model.id}`);
      if (model.id === "throws") throw new Error("switch rejected");
      return model.id !== "unauthed";
    },
    setThinkingLevel(level) { thinking = level; },
    getThinkingLevel: () => thinking,
  };
  const result = await routeModelDetailed(pi, ctx, "cheap");
  assert.deepEqual(lookups, ["provider-missing/not-registered", "provider-a/unauthed", "provider-b/throws", "provider-c/available"]);
  assert.deepEqual(calls, ["provider-a/unauthed", "provider-b/throws", "provider-c/available"]);
  assert.deepEqual(result, {
    success: true, tier: "medium", provider: "provider-c", model: "available",
    thinking: "high", candidateIndex: 3, reason: "upward fallback from cheap",
  });
});

test("model router reports Pi-clamped thinking and does not retry a model after thinking throws", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.ui.notifications = "important";
  config.router.models.strong = [
    { provider: "provider-a", model: "first", thinking: "max" },
    { provider: "provider-b", model: "second" },
  ];
  const models = [{ provider: "provider-a", id: "first" }, { provider: "provider-b", id: "second" }];
  for (const throws of [false, true]) {
    const calls = [];
    const notifications = [];
    const ctx = makeContext(models);
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    const pi = {
      async setModel(model) { calls.push(model.id); return true; },
      setThinkingLevel() { if (throws) throw new Error("unsupported thinking"); },
      getThinkingLevel: () => "low",
    };
    const result = await routeModelDetailed(pi, ctx, "strong");
    assert.deepEqual(calls, ["first"]);
    assert.equal(result.success, true);
    assert.equal(result.thinking, "low");
    assert.equal(result.candidateIndex, 0);
    assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("max")));
    if (throws) assert.ok(notifications.some(({ message }) => message.includes("unsupported thinking")));
  }
});

test("model router reapplies thinking on the same provider/id when another tier is requested", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const current = { provider: "provider-a", id: "model-a" };
  config.router.models.medium = { provider: current.provider, model: current.id, thinking: "low" };
  config.router.models.strong = { provider: current.provider, model: current.id, thinking: "high" };
  const calls = [];
  let thinking = "off";
  const pi = {
    async setModel(model) { calls.push(model.id); return true; },
    setThinkingLevel(level) { thinking = level; },
    getThinkingLevel: () => thinking,
  };
  const ctx = makeContext([current], current);
  assert.equal((await routeModelDetailed(pi, ctx, "medium")).thinking, "low");
  assert.equal((await routeModelDetailed(pi, ctx, "strong")).thinking, "high");
  assert.deepEqual(calls, []);
});

test("model router tries same-tier candidates in order and applies selected thinking", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const previousMode = config.router.mode;
  const previousEnabled = config.router.enabled;
  const previousStrong = config.router.models.strong;
  let thinking = "low";
  const setModelCalls = [];
  const thinkingCalls = [];

  config.router.mode = "set-model";
  config.router.enabled = true;
  config.router.models.strong = [
    { provider: "sensenova", model: "kimi-k3", thinking: "high" },
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  ];

  const models = [
    { provider: "sensenova", id: "kimi-k3" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  const pi = {
    async setModel(model) {
      setModelCalls.push(`${model.provider}/${model.id}`);
      return model.id === "gpt-5.6-sol";
    },
    setThinkingLevel(level) {
      thinkingCalls.push(level);
      thinking = level;
    },
    getThinkingLevel() {
      return thinking;
    },
  };

  try {
    await routeModel(pi, makeContext(models), "strong");
    assert.deepEqual(setModelCalls, [
      "sensenova/kimi-k3",
      "openai-codex/gpt-5.6-sol",
    ]);
    assert.deepEqual(thinkingCalls, ["high"]);
  } finally {
    config.router.mode = previousMode;
    config.router.enabled = previousEnabled;
    config.router.models.strong = previousStrong;
  }
});

test("model router reapplies per-tier thinking when the model is already active", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const previousMode = config.router.mode;
  const previousEnabled = config.router.enabled;
  const previousMedium = config.router.models.medium;
  let thinking = "high";
  let setModelCalled = false;

  config.router.mode = "set-model";
  config.router.enabled = true;
  config.router.models.medium = {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "medium",
  };

  const currentModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const pi = {
    async setModel() {
      setModelCalled = true;
      return true;
    },
    setThinkingLevel(level) {
      thinking = level;
    },
    getThinkingLevel() {
      return thinking;
    },
  };

  try {
    await routeModel(pi, makeContext([currentModel], currentModel), "medium");
    assert.equal(setModelCalled, false);
    assert.equal(thinking, "medium");
  } finally {
    config.router.mode = previousMode;
    config.router.enabled = previousEnabled;
    config.router.models.medium = previousMedium;
  }
});
