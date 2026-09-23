import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resetConfigToDefaults } from "../dist/src/config.js";
import { ROUTER_MODES, isRouterMode } from "../dist/src/types.js";
import { resetJudgeBackends } from "../dist/src/judge/registry.js";
import {
  judgeTaskTier,
  modeConsultsJudge,
  modeSwitchesModel,
  readInlineOverride,
  requestModelTier,
  routeTask,
  setNextRouteOverride,
  setupTaskRouter,
} from "../dist/src/router/task-router.js";
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

/**
 * Route through the legacy automatic router. The default mode no longer switches
 * the model at all, so a test that wants the old behavior must ask for it.
 */
function enableSetModel(config) {
  config.router.enabled = true;
  config.router.mode = "set-model";
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

test("mode helpers describe who may decide and who may switch", () => {
  assert.equal(modeSwitchesModel("set-model"), true);
  assert.equal(modeSwitchesModel("advisory"), false);
  assert.equal(modeSwitchesModel("rules-only"), false);
  assert.equal(modeSwitchesModel("off"), false);
  assert.equal(modeConsultsJudge("set-model"), true);
  assert.equal(modeConsultsJudge("advisory"), true);
  assert.equal(modeConsultsJudge("tier-only"), true);
  assert.equal(modeConsultsJudge("rules-only"), false);
  assert.equal(modeConsultsJudge("off"), false);

  // The command /jev router mode used to accept only four of the five modes the
  // config type allows, so "tier-only" could be set by editing the file but not
  // by the command. Everything derives from ROUTER_MODES now.
  for (const mode of ROUTER_MODES) {
    assert.equal(isRouterMode(mode), true, `${mode} should be accepted`);
  }
  for (const bogus of ["advise", "TIER-ONLY", "set_models", "", "rules_only", "model"]) {
    assert.equal(isRouterMode(bogus), false, `${bogus} should be rejected`);
  }

  assert.equal(readInlineOverride("[strong] refactor GAS replication"), "strong");
  assert.equal(readInlineOverride("  [cheap] fix typo"), "cheap");
  assert.equal(readInlineOverride("[Cheap] capitalised"), "cheap");
  assert.equal(readInlineOverride("no prefix here"), undefined);
  assert.equal(readInlineOverride("[strong]"), "strong");
  assert.equal(readInlineOverride("[strong]x"), undefined);
  assert.equal(readInlineOverride("the string [strong] inside prose"), undefined);
});

test("rules-only: the model is never switched, and the risk floor never fires on its own", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  const handlers = new Map();
  resetState();
  const switched = [];
  setupTaskRouter({
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => { switched.push(model.id); return true; },
    getThinkingLevel: () => "low",
  });

  try {
    // Default mode is rules-only. A risky task must not switch anything.
    assert.equal(config.router.mode, "rules-only");
    const risky = await routeTask("Investigate GAS replication crash root cause", "interactive");
    assert.equal(risky, null);

    // Inline override still applies — the user's hard override wins when the
    // task carries no risk features.
    const forced = await routeTask("[cheap] fix a typo in the readme", "interactive");
    assert.equal(forced.tier, "cheap");
    assert.equal(forced.source, "override");

    // ...but the risk floor can still raise an explicit request, never lower it.
    const raised = await routeTask("[cheap] refactor GAS replication", "interactive");
    assert.equal(raised.tier, "strong");
    assert.equal(raised.source, "override");
    assert.match(raised.reason, /raised to strong/);

    await handlers.get("input")({ text: "Investigate GAS replication crash root cause", source: "interactive" }, makeContext());
    await handlers.get("input")({ text: "[medium] implement feature", source: "interactive" }, makeContext());
    // Only the explicit inline override switched the model; the risky task did not.
    assert.deepEqual(switched, ["medium"]);
    assert.equal(runtimeState.lastTaskTier, "medium");

    // A risky task with no override does not switch anything at all.
    resetState();
    switched.length = 0;
    await handlers.get("input")({ text: "Investigate GAS replication crash root cause", source: "interactive" }, makeContext());
    assert.deepEqual(switched, []);
    assert.equal(runtimeState.lastTaskTier, undefined);
    assert.equal(runtimeState.lastTaskTier, undefined);
  } finally {
    restore();
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    resetJudgeBackends();
    resetState();
  }
});

test("off mode returns null for everything, including overrides", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  const previousMode = config.router.mode;
  try {
    config.router.mode = "off";
    assert.equal(await routeTask("[strong] anything", "interactive"), null);
    setNextRouteOverride("strong");
    assert.equal(await routeTask("update docs", "interactive"), null);
  } finally {
    restore();
    config.router.mode = previousMode;
  }
});

test("judgeTaskTier returns a verdict without switching anything", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  const before = runtimeState.lastRouteAudit;

  try {
    // Backend down: the risk floor decides, and it is honest about it.
    const verdict = await judgeTaskTier("Investigate GAS replication crash root cause");
    assert.equal(verdict.tier, "strong");
    assert.equal(verdict.source, "fallback");
    assert.equal(verdict.reason, "judgment backend unavailable");
    assert.deepEqual(verdict.riskFeatures, ["engine-internals", "deep-review"]);

    // A plain task falls back to the configured safe tier, not to strong.
    const plain = await judgeTaskTier("fix a typo in the readme");
    assert.equal(plain.tier, "medium");
    assert.equal(plain.riskFeatures.length, 0);

    // Judgment only: no audit entry is written and the tier is not committed.
    assert.equal(runtimeState.lastRouteAudit, before);
    assert.equal(runtimeState.lastTaskTier, undefined);
  } finally {
    restore();
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    resetJudgeBackends();
  }
});

test("explicit overrides bypass Jev, while unavailable Jev uses a safe tier", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  try {
    enableSetModel(config);
    const forced = await routeTask("[cheap] fix a typo in the readme", "interactive");
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
  resetConfigToDefaults();
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
  resetConfigToDefaults();
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
    enableSetModel(config);
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
  resetConfigToDefaults();
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
    enableSetModel(config);
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

test("automatic tier escalation during tool results only happens in set-model mode", async () => {
  resetConfigToDefaults();
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
    // rules-only: the user's inline override is still honored, but nothing
    // escalates afterwards — the model sees the tool results itself and asks.
    enableSetModel(config);
    config.router.mode = "rules-only";
    await handlers.get("input")({ text: "[cheap] edit files", source: "interactive" }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "a.txt" }, isError: false }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "b.txt" }, isError: false }, makeContext());
    assert.deepEqual(switched, ["cheap"]);

    // set-model: the legacy automatic escalation is preserved for opt-in users.
    config.router.mode = "set-model";
    await handlers.get("input")({ text: "[cheap] edit files", source: "interactive" }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "a.txt" }, isError: false }, makeContext());
    await handlers.get("tool_result")({ toolName: "edit", input: { path: "b.txt" }, isError: false }, makeContext());
    assert.deepEqual(switched, ["cheap", "cheap", "medium"]);
    assert.equal(runtimeState.lastTaskTier, "medium");
  } finally {
    restore();
    resetState();
  }
});

test("model-initiated tier request switches, audits, and applies the risk floor", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  resetState();
  const switched = [];

  try {
    // rules-only: the model is free to switch itself, which is the whole point.
    config.router.enabled = true;
    config.router.mode = "rules-only";

    const pi = {
      setModel: async (model) => { switched.push(model.id); return true; },
      getThinkingLevel: () => "low",
    };

    // Risk features can only raise the request, never lower it.
    const raised = await requestModelTier(pi, makeContext(), {
      tier: "cheap",
      reason: "small mechanical edit",
      context: "rewrite the GAS replication layer",
    });
    assert.equal(raised.success, true);
    assert.equal(raised.requestedTier, "strong");
    assert.equal(raised.wantedTier, "cheap");
    assert.equal(raised.floorApplied, true);
    assert.deepEqual(switched, ["strong"]);
    assert.equal(runtimeState.lastTaskTier, "strong");
    assert.equal(runtimeState.lastRouteAudit.source, "model-request");
    const firstId = runtimeState.lastRouteAudit.requestId;
    assert.ok(firstId > 0);
    assert.match(runtimeState.lastRouteAudit.reason, /risk floor/);

    // A plain request goes through as asked.
    const plain = await requestModelTier(pi, makeContext(), {
      tier: "cheap",
      reason: "quick lookup",
    });
    assert.equal(plain.success, true);
    assert.equal(plain.requestedTier, "cheap");
    assert.equal(plain.floorApplied, false);
    assert.ok(runtimeState.lastRouteAudit.requestId > firstId);
    assert.deepEqual(switched, ["strong", "cheap"]);

    // Router off: refused, nothing switches.
    config.router.enabled = false;
    const refused = await requestModelTier(pi, makeContext(), { tier: "strong", reason: "x" });
    assert.equal(refused.success, false);
    assert.equal(refused.reason, "router disabled");
    assert.deepEqual(switched, ["strong", "cheap"]);
  } finally {
    restore();
    resetState();
  }
});

test("advisory mode records a judgment but never switches the model", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  const restore = configuredModels(config);
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  resetState();
  const handlers = new Map();
  const switched = [];
  const notifications = [];
  setupTaskRouter({
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => { switched.push(model.id); return true; },
    getThinkingLevel: () => "low",
  });
  try {
    config.router.enabled = true;
    config.router.mode = "advisory";
    config.ui.notifications = "all";
    await handlers.get("input")(
      { text: "Investigate GAS replication crash root cause", source: "interactive" },
      { ...makeContext(), ui: { notify: (message) => notifications.push(message) } },
    );
    assert.deepEqual(switched, []);
    assert.equal(runtimeState.lastTaskTier, undefined);
    assert.equal(runtimeState.lastRouteAudit.source, "advisory");
    assert.equal(runtimeState.lastRouteAudit.success, false);
    assert.equal(runtimeState.lastRouteAudit.requestedTier, "strong");
    assert.ok(notifications.length > 0, "the assessment should be announced");
    assert.match(notifications.join("\n"), /(informational|仅供参考)/);
  } finally {
    restore();
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    resetJudgeBackends();
    resetState();
  }
});


test("tool_result escalation respects router.enabled", async () => {
  // Before the fix the handler only checked mode !== "set-model" and relied on
  // runtimeState.lastTaskTier being unset when the router was off. That held
  // only because routeTask() returns null, so it was a property of another code
  // path rather than a deliberate guard.
  resetConfigToDefaults();
  resetState();
  const config = loadConfig();
  config.router.enabled = false;
  config.router.mode = "set-model";

  const handlers = new Map();
  setupTaskRouter({ on: (name, fn) => handlers.set(name, fn), registerTool: () => {} });
  const ctx = { ui: { notify: () => {} } };

  // Advance the request counter; the router is off, so nothing is routed.
  await handlers.get("input")({ text: "investigate a replication bug in the inventory component", source: "user" }, ctx);
  // Pretend an earlier round established a tier — the case the old handler fell through on.
  runtimeState.lastTaskTier = "cheap";
  const auditsBefore = runtimeState.routeAudits.length;

  await handlers.get("tool_result")(
    { isError: true, toolName: "bash", input: { command: "kubectl delete pod web-1 --force" } },
    ctx,
  );

  assert.equal(runtimeState.routeAudits.length, auditsBefore, "no escalation audit may be recorded");
  assert.equal(runtimeState.lastTaskTier, "cheap", "the tier must stay untouched");
});
