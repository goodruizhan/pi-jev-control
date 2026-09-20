import test from "node:test";
import assert from "node:assert/strict";

import { getActionKey } from "../dist/src/action-context.js";
import { isBenignShellOutcome, isFailureEvent } from "../dist/src/judgment/failure-classifier.js";
import { setupToolGate } from "../dist/src/gates/tool-gate.js";
import { loadConfig } from "../dist/src/config.js";
import { resetClient } from "../dist/src/jev/client.js";
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

test("approved writes are reused within a task and blocked results include retry guidance", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
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

  let confirmations = 0;
  const allowContext = { ui: { confirm: async () => { confirmations += 1; return true; } } };
  await handler({ toolName: "write", input: { path: "same.md", content: "one" } }, allowContext);
  await handler({ toolName: "write", input: { path: "same.md", content: "two" } }, allowContext);
  assert.equal(confirmations, 1);

  await inputHandler({ source: "user", text: "new task" });
  await handler({ toolName: "write", input: { path: "same.md", content: "three" } }, allowContext);
  assert.equal(confirmations, 2);

  const denyContext = { ui: { confirm: async () => false } };
  const blocked = await handler({ toolName: "write", input: { path: "other.md", content: "x" } }, denyContext);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /uncertainField:/);
  assert.match(blocked.reason, /retryHint:/);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
  resetState();
});
