import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDecisionQuestions } from "./dist/src/decision/batch.js";
import { buildDeterministicPruningDecisions } from "./dist/src/compaction/pruner.js";
import { chooseUIAction } from "./dist/src/gui/action-router.js";
import { notifyAutomatic } from "./dist/src/ui.js";
import { loadConfig } from "./dist/src/config.js";
import { hasConfiguredRouterTarget } from "./dist/src/router/task-router.js";

function group(id, overrides = {}) {
  return {
    groupId: id,
    toolName: "read",
    inputSummary: "read: {\"path\":\"a.ts\"}",
    resultSummary: "ok",
    isError: false,
    charsBefore: 500,
    charsAfter: 0,
    messageIndices: [],
    callEntry: { role: "assistant", content: [] },
    resultEntries: [],
    ...overrides,
  };
}

test("decision questions are bounded and duplicate ids are removed", () => {
  const normalized = normalizeDecisionQuestions([
    { id: "route", prompt: "Choose", options: [{ id: "a" }, { id: "b" }] },
    { id: "route", prompt: "Duplicate", options: [{ id: "x" }, { id: "y" }] },
    { id: "invalid", prompt: "Only one", options: [{ id: "a" }] },
    { id: "second", prompt: "Choose", options: [{ id: "a" }, { id: "b" }] },
  ], 2);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, "route");
});

test("local pruning drops duplicate reads, truncates large reads, and preserves failures", () => {
  const duplicate = group("old-duplicate");
  const large = group("old-large", { inputSummary: "read: {\"path\":\"large.ts\"}", charsBefore: 5000 });
  const failure = group("old-failure", { isError: true, charsBefore: 9000 });
  const protectedRead = group("recent");
  const result = buildDeterministicPruningDecisions([duplicate, large, failure], [protectedRead]);
  assert.equal(result.decisions.get("old-duplicate"), "DROP");
  assert.equal(result.decisions.get("old-large"), "TRUNCATE");
  assert.equal(result.decisions.get("old-failure"), "KEEP_RAW");
  assert.equal(result.unresolved.length, 0);
});

test("high-risk GUI goals are handed back without a Jev call", async () => {
  const config = loadConfig();
  config.enabled = true;
  config.guiRouter.enabled = true;
  const result = await chooseUIAction("delete the production database", [{ id: "confirm", label: "Confirm" }]);
  assert.equal(result.id, "unknown");
  assert.equal(result.risk, "needs_user");
});

test("automatic notifications stay quiet except for configured errors", () => {
  const config = loadConfig();
  config.ui.notifications = "errors-only";
  const events = [];
  const ctx = { ui: { notify: (message, level) => events.push({ message, level }) } };
  notifyAutomatic(ctx, "routine", "info");
  notifyAutomatic(ctx, "important", "warning");
  notifyAutomatic(ctx, "failed", "error");
  assert.deepEqual(events, [{ message: "failed", level: "error" }]);
});

test("task routing skips Jev when no model target is configured", () => {
  assert.equal(hasConfiguredRouterTarget({
    cheap: { provider: "REPLACE_ME", model: "REPLACE_ME" },
    medium: { provider: "REPLACE_ME", model: "REPLACE_ME" },
    strong: { provider: "REPLACE_ME", model: "REPLACE_ME" },
  }), false);
  assert.equal(hasConfiguredRouterTarget({
    cheap: { provider: "openai", model: "small" },
    medium: { provider: "REPLACE_ME", model: "REPLACE_ME" },
    strong: { provider: "REPLACE_ME", model: "REPLACE_ME" },
  }), true);
});
