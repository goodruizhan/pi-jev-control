import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../dist/src/config.js";
import { modelCandidates, routeModel } from "../dist/src/router/model-router.js";

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

test("model router tries same-tier candidates in order and applies selected thinking", async () => {
  const config = loadConfig();
  const previousMode = config.router.mode;
  const previousStrong = config.router.models.strong;
  let thinking = "low";
  const setModelCalls = [];
  const thinkingCalls = [];

  config.router.mode = "set-model";
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
    config.router.models.strong = previousStrong;
  }
});

test("model router reapplies per-tier thinking when the model is already active", async () => {
  const config = loadConfig();
  const previousMode = config.router.mode;
  const previousMedium = config.router.models.medium;
  let thinking = "high";
  let setModelCalled = false;

  config.router.mode = "set-model";
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
    config.router.models.medium = previousMedium;
  }
});
