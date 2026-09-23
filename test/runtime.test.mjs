import test from "node:test";
import assert from "node:assert/strict";

import { getActionKey, getCommandCategory } from "../dist/src/action-context.js";
import { isBenignShellOutcome, isFailureEvent, setupFailureClassifier } from "../dist/src/judgment/failure-classifier.js";
import { setupToolGate } from "../dist/src/gates/tool-gate.js";
import { loadConfig, resetConfigToDefaults } from "../dist/src/config.js";
import { resetJudgeBackends as resetClient } from "../dist/src/judge/registry.js";
import {
  getFailureCountByActionKey,
  getFailureCountByFamily,
  recordFailure,
  resetState,
} from "../dist/src/state/runtime-state.js";

test("write approvals use tool plus path rather than changing content", () => {
  const first = getActionKey("write", { path: "notes/failures.md", content: "first" });
  const second = getActionKey("write", { path: "notes/failures.md", content: "second" });
  assert.equal(first, second);
});

test("benign no-match outcomes skip failure judgment", () => {
  assert.equal(isBenignShellOutcome("bash", "rg missing .", 1, ""), true);
  assert.equal(isBenignShellOutcome("bash", "grep missing file", 1, ""), true);
  assert.equal(isBenignShellOutcome("bash", "ls *.none", 1, "cannot find the path"), true);
  assert.equal(isBenignShellOutcome("bash", "ls private", 1, "permission denied"), false);
  assert.equal(isFailureEvent(false, null, "Operation aborted"), true);
});

test("failure counts accumulate by action and command family", () => {
  resetState();
  const base = {
    actionKey: "bash|command:npm test",
    commandCategory: "bash:npm test",
    toolName: "bash",
    inputSummary: '{"command":"npm test"}',
    errorExcerpt: "failed",
    failureType: "code_error",
    recommendedAction: "repair_then_retry",
  };
  recordFailure({ ...base, signature: "first" });
  recordFailure({ ...base, signature: "second", errorExcerpt: "failed differently" });
  assert.equal(getFailureCountByActionKey(base.actionKey), 2);
  assert.equal(getFailureCountByFamily(base.toolName, base.commandCategory), 2);
  resetState();
});

test("appendToResult=false keeps failure records but leaves tool output untouched", async () => {
  resetState();
  const handlers = new Map();
  setupFailureClassifier({ on: (event, handler) => handlers.set(event, handler) });
  const handler = handlers.get("tool_result");

  const input = { path: "missing-file-append-toggle.ts" };
  recordFailure({
    signature: "seed",
    actionKey: getActionKey("read", input),
    commandCategory: getCommandCategory("read", input),
    toolName: "read",
    inputSummary: JSON.stringify(input),
    errorExcerpt: "File not found",
    failureType: "code_error",
    recommendedAction: "repair_then_retry",
  });

  const config = loadConfig();
  config.enabled = true;
  config.retryJudge.enabled = true;
  const event = {
    toolName: "read",
    input,
    isError: true,
    content: [{ type: "text", text: "File not found" }],
    details: {},
  };

  config.retryJudge.appendToResult = false;
  const silent = await handler(event, {});
  assert.equal(silent, undefined);
  assert.equal(getFailureCountByActionKey(getActionKey("read", input)), 2);

  config.retryJudge.appendToResult = true;
  const annotated = await handler(event, {});
  assert.equal(getFailureCountByActionKey(getActionKey("read", input)), 3);
  const texts = annotated.content.map((block) => block.text ?? "").join("\n");
  assert.match(texts, /pi-jev-control/);
  assert.match(texts, /File not found/);

  resetState();
});

test("failure counting survives a backend outage, and silent mode makes no automatic model call", async () => {
  resetConfigToDefaults();
  resetClient();
  resetState();
  const config = loadConfig();
  config.judgment.backend = "test-offline";
  config.judgment.backends["test-offline"] = { type: "openai-compatible", model: "small-test", baseUrl: "http://localhost:1/v1" };
  config.retryJudge.enabled = true;
  config.memoryGate.enabled = false;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.retryJudge.maxSameFailureRetries = 1;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 503 }; };
  try {
    const handlers = new Map();
    setupFailureClassifier({ on: (name, handler) => handlers.set(name, handler) });
    setupToolGate({ on: (name, handler) => handlers.set(`gate:${name}`, handler) });
    const classify = handlers.get("tool_result");
    const gate = handlers.get("gate:tool_call");
    const event = (toolName, path) => ({ toolName, input: { path }, isError: true,
      content: [{ type: "text", text: "File not found" }], details: {} });

    config.retryJudge.appendToResult = false;
    assert.equal(await classify(event("read", "silent-missing.ts"), {}), undefined);
    assert.equal(calls, 0, "default silent mode should not call a judgment backend");
    assert.equal(getFailureCountByActionKey(getActionKey("read", { path: "silent-missing.ts" })), 1);
    assert.equal((await gate({ toolName: "read", input: { path: "silent-missing.ts" } }, {})).block, true);

    config.retryJudge.appendToResult = true;
    const result = await classify(event("write", "annotated-missing.ts"), {});
    assert.equal(calls, 1);
    assert.match(result.content.at(-1).text, /skipped/);
    assert.equal(getFailureCountByActionKey(getActionKey("write", { path: "annotated-missing.ts" })), 1);
    assert.equal((await gate({ toolName: "write", input: { path: "annotated-missing.ts" } }, {})).block, true);

    config.retryJudge.enabled = false;
    assert.equal(await classify(event("read", "judge-off-missing.ts"), {}), undefined);
    assert.equal(getFailureCountByActionKey(getActionKey("read", { path: "judge-off-missing.ts" })), 1,
      "disabled retry judgment must not disable local failure observation");
    assert.equal(calls, 1, "disabled retry judgment must not contact the backend");
    assert.equal(await gate({ toolName: "read", input: { path: "judge-off-missing.ts" } }, {}), undefined);
    assert.equal(await gate({ toolName: "write", input: { path: "annotated-missing.ts" } }, {}), undefined,
      "turning off the retry judge must also turn off its circuit breaker");
  } finally {
    globalThis.fetch = originalFetch;
    resetState();
    resetClient();
    resetConfigToDefaults();
  }
});

test("ordinary writes are never confirmed; the approval cache still scopes to a task", async () => {
  // Writes no longer pass through Jev, so there is nothing to confirm. The
  // approval cache still clears at the task boundary — that is the observable
  // part of the old behavior that survives the inversion.
  const originalKey = process.env.TYPESSAFE_API_KEY;
  delete process.env.TYPESSAFE_API_KEY;
  resetClient();
  resetState();

  const handlers = new Map();
  setupToolGate({ on: (event, handler) => handlers.set(event, handler) });
  const handler = handlers.get("tool_call");
  const inputHandler = handlers.get("input");
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.toolGate.reuseApprovedWrites = true;
  config.memoryGate.enabled = false;
  config.retryJudge.enabled = false;

  let confirmations = 0;
  const ctx = { ui: { confirm: async () => { confirmations += 1; return true; } } };

  const first = await handler({ toolName: "write", input: { path: "same.md", content: "one" } }, ctx);
  const second = await handler({ toolName: "write", input: { path: "same.md", content: "two" } }, ctx);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(confirmations, 0);

  // Nothing is blocked any more just because a write repeats.
  await inputHandler({ source: "user", text: "new task" });
  const third = await handler({ toolName: "write", input: { path: "same.md", content: "three" } }, ctx);
  assert.equal(third, undefined);
  assert.equal(confirmations, 0);

  // A dangerous command is still confirmed, and a refusal blocks.
  const dangerous = await handler({ toolName: "bash", input: { command: "rm -rf ./victim" } }, {
    ui: { confirm: async () => false },
  });
  assert.equal(dangerous?.block, true);
  assert.equal(confirmations, 0);

  if (originalKey === undefined) delete process.env.TYPESSAFE_API_KEY;
  else process.env.TYPESSAFE_API_KEY = originalKey;
  resetClient();
  resetState();
});

test("repeated failures block and the block reason carries retry guidance", async () => {
  // blockReason() with uncertainField + retryHint now comes from the
  // deterministic repeated-failure circuit breaker, not from a Jev verdict.
  resetState();
  const handlers = new Map();
  setupToolGate({ on: (event, handler) => handlers.set(event, handler) });
  const handler = handlers.get("tool_call");

  const input = { command: "npm test" };
  const actionKey = getActionKey("bash", input);
  const config = loadConfig();
  config.language = "en";
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.retryJudge.enabled = true;
  config.retryJudge.maxSameFailureRetries = 2;
  config.memoryGate.enabled = false;

  for (let i = 0; i < 2; i += 1) {
    recordFailure({
      signature: `seed-${i}`,
      actionKey,
      commandCategory: getCommandCategory("bash", input),
      toolName: "bash",
      inputSummary: JSON.stringify(input),
      errorExcerpt: "failed",
      failureType: "code_error",
      recommendedAction: "repair_then_retry",
    });
  }

  const blocked = await handler({ toolName: "bash", input }, { ui: { confirm: async () => false } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /uncertainField:/);
  assert.match(blocked.reason, /retryHint:/);
  assert.match(blocked.reason, /already failed 2 time/);

  // Advisory mode warns instead of blocking.
  config.toolGate.mode = "advisory";
  const advisory = await handler({ toolName: "bash", input }, { ui: { confirm: async () => false, notify() {} } });
  assert.equal(advisory, undefined);

  resetState();
});
