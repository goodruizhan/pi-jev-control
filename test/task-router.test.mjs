import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/src/config.js";
import { resetJudgeBackends } from "../dist/src/judge/registry.js";
import { routeTask, setNextRouteOverride, setupTaskRouter } from "../dist/src/router/task-router.js";
import { extractRouteRisk, summarizeTask } from "../dist/src/router/risk.js";
import { routeModelDetailed } from "../dist/src/router/model-router.js";
import { resetState, runtimeState } from "../dist/src/state/runtime-state.js";

function configuredModels(config) {
  const previous = { ...config.router.models };
  config.router.models.cheap = { provider: "test", model: "cheap" };
  config.router.models.medium = { provider: "test", model: "medium" };
  config.router.models.strong = { provider: "test", model: "strong" };
  return () => Object.assign(config.router.models, previous);
}

function makeContext() {
  return {
    ui: { notify() {} },
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
  };
}

test("risk floor recognizes UE, verification, multiple files and long trailing constraints", () => {
  assert.equal(extractRouteRisk("Fix typo in README").minimumTier, "cheap");
  assert.equal(extractRouteRisk("Implement C++ gameplay and compile it").minimumTier, "medium");
  assert.equal(extractRouteRisk("Investigate GAS replication crash root cause").minimumTier, "strong");
  assert.equal(extractRouteRisk("Update src/a.ts and src/b.ts").minimumTier, "medium");
  const longInput = `${"ordinary task ".repeat(400)} finally perform a data migration`;
  assert.match(summarizeTask(longInput), /data migration$/);
  assert.equal(extractRouteRisk(longInput).minimumTier, "strong");
});

test("explicit overrides bypass Jev, while unavailable Jev uses a safe tier", async () => {
  const config = loadConfig();
  const restore = configuredModels(config);
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  try {
    const forced = await routeTask("[cheap] refactor GAS replication", "interactive");
    assert.equal(forced.tier, "cheap");
    assert.equal(forced.source, "override");
    setNextRouteOverride("strong");
    assert.equal(await routeTask("继续", "interactive"), null);
    const next = await routeTask("update docs", "interactive");
    assert.equal(next.tier, "strong");
    assert.equal(next.source, "override");
    const fallback = await routeTask("Implement C++ gameplay and compile it", "interactive");
    assert.equal(fallback.tier, "medium");
    assert.equal(fallback.source, "fallback");
  } finally {
    restore();
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    resetJudgeBackends();
  }
});

test("model router falls upward when the requested tier fails", async () => {
  const config = loadConfig();
  const restore = configuredModels(config);
  try {
    const result = await routeModelDetailed({
      setModel: async (model) => model.id === "medium",
      getThinkingLevel: () => "low",
    }, makeContext(), "cheap");
    assert.equal(result.success, true);
    assert.equal(result.tier, "medium");
    assert.equal(result.model, "medium");
    assert.equal(result.candidateIndex, 1);
  } finally {
    restore();
  }
});

test("failed setModel does not commit a successful task tier", async () => {
  const config = loadConfig();
  const restore = configuredModels(config);
  resetState();
  const handlers = new Map();
  setupTaskRouter({
    on: (event, handler) => handlers.set(event, handler),
    setModel: async () => false,
    getThinkingLevel: () => "low",
  });
  try {
    await handlers.get("input")({ text: "[strong] investigate", source: "interactive" }, makeContext());
    assert.equal(runtimeState.lastTaskTier, undefined);
    assert.equal(runtimeState.lastRouteAudit.success, false);
    assert.equal(runtimeState.lastRouteAudit.requestedTier, "strong");
  } finally {
    restore();
    resetState();
  }
});

test("newest input wins over an in-flight model switch", async () => {
  const config = loadConfig();
  const restore = configuredModels(config);
  resetState();
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const handlers = new Map();
  const switched = [];
  setupTaskRouter({
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => {
      if (model.id === "medium") {
        firstStarted();
        await gate;
      }
      switched.push(model.id);
      return true;
    },
    getThinkingLevel: () => "low",
  });
  try {
    const handler = handlers.get("input");
    const first = handler({ text: "[medium] implement feature", source: "interactive" }, makeContext());
    await started;
    const second = handler({ text: "[strong] architecture review", source: "interactive" }, makeContext());
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(switched, ["medium", "strong"]);
    assert.equal(runtimeState.lastTaskTier, "strong");
    assert.equal(runtimeState.lastRouteAudit.model, "strong");
  } finally {
    restore();
    resetState();
  }
});

test("two modified files upgrade a cheap task during tool results", async () => {
  const config = loadConfig();
  const restore = configuredModels(config);
  resetState();
  const handlers = new Map();
  const switched = [];
  setupTaskRouter({
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => { switched.push(model.id); return true; },
    getThinkingLevel: () => "low",
  });
  try {
    await handlers.get("input")({ text: "[cheap] edit files", source: "interactive" }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "a.txt" }, isError: false }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "b.txt" }, isError: false }, makeContext());
    assert.deepEqual(switched, ["cheap", "medium"]);
    assert.equal(runtimeState.lastTaskTier, "medium");
  } finally {
    restore();
    resetState();
  }
});
