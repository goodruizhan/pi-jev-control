import test from "node:test";
import assert from "node:assert/strict";

import { classifyShellCommand, setupToolGate } from "../dist/src/gates/tool-gate.js";
import { loadConfig } from "../dist/src/config.js";
import { resetJudgeBackends as resetClient } from "../dist/src/judge/registry.js";
import { judgeReview } from "../dist/src/review/review-gate.js";
import extension from "../dist/extensions/index.js";

test("safe shell fast path rejects composition and destructive find", () => {
  assert.equal(classifyShellCommand("git status --short"), "safe");
  assert.equal(classifyShellCommand("git status && rm -rf ./victim"), "dangerous");
  assert.equal(classifyShellCommand("find . -delete"), "dangerous");
  assert.equal(classifyShellCommand("rg --pre dangerous-helper pattern ."), "uncertain");
  assert.equal(classifyShellCommand("git diff --output=result.patch"), "uncertain");
  assert.equal(classifyShellCommand("npm install left-pad"), "uncertain");
});

test("review gate falls back conservatively and forces core-system review", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const config = loadConfig();
  config.enabled = true;
  config.reviewGate.enabled = true;
  const base = {
    modifiedFiles: 1,
    fileTypes: [".ts"],
    isCoreSystem: false,
    involvesGC: false,
    involvesThreading: false,
    involvesReplication: false,
    involvesGAS: false,
    hasFailures: false,
    description: "rename a local variable",
  };

  const fallback = await judgeReview(base);
  assert.equal(fallback.decision, "normal_review");
  const core = await judgeReview({ ...base, isCoreSystem: true });
  assert.equal(core.decision, "strong_review");
  assert.equal(core.forced, true);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

function createToolGateHarness() {
  const handlers = new Map();
  setupToolGate({ on: (event, handler) => handlers.set(event, handler) });
  return handlers.get("tool_call");
}

test("enforce mode fails closed when Jev is unavailable", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.memoryGate.enabled = false;
  let confirmations = 0;
  const ctx = { signal: undefined, ui: { confirm: async () => { confirmations += 1; return false; } } };

  const unknown = await handler({ toolName: "bash", input: { command: "npm install left-pad" } }, ctx);
  assert.equal(unknown?.block, true);
  const write = await handler({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
  assert.equal(write?.block, true);
  assert.equal(confirmations, 2);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("advisory mode never confirms or blocks when Jev is unavailable", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "advisory";
  config.memoryGate.enabled = false;
  let confirmations = 0;
  const ctx = {
    signal: undefined,
    ui: {
      confirm: async () => { confirmations += 1; return false; },
      notify() {},
    },
  };

  const write = await handler({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
  const dangerous = await handler({ toolName: "bash", input: { command: "rm -rf ./victim" } }, ctx);
  assert.equal(write, undefined);
  assert.equal(dangerous, undefined);
  assert.equal(confirmations, 0);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("memory stats command is reachable", async () => {
  let command;
  const pi = { on() {}, registerTool() {}, registerCommand(_name, definition) { command = definition; } };
  extension(pi);
  const notifications = [];
  await command.handler("memory stats", { ui: { notify: (message) => notifications.push(message) } });
  assert.match(notifications.join("\n"), /Memory Store:/);
  assert.doesNotMatch(notifications.join("\n"), /memoryGate on\|off/);
});
