import test from "node:test";
import assert from "node:assert/strict";

import {
  RulesBackend,
  classifyShellCommand,
  classifyMemoryText,
  evaluateReviewForced,
  evaluateRepeatedFailure,
} from "../dist/src/judge/rules-backend.js";
import {
  TOOL_GATE_QUESTION,
  FAILURE_TYPE_QUESTION,
  RECOMMENDED_ACTION_QUESTION,
  REVIEW_NEEDED_QUESTION,
  MEMORY_TYPE_QUESTION,
} from "../dist/src/judge/questions.js";
import { noul, choice, choiceOf } from "../dist/src/judge/ir.js";
import { resetJudgeBackends, backendTypeOf } from "../dist/src/judge/registry.js";

const SIGNAL = { signal: AbortSignal.timeout(1000) };

async function run(backend, questions, state) {
  return backend.judge({ state, questions }, SIGNAL);
}

// ── RulesBackend surface ─────────────────────────────────────────────

test("RulesBackend is always available, binary confidence, no unavailable reason", () => {
  const backend = new RulesBackend({ name: "rules" });
  assert.equal(backend.name, "rules");
  assert.equal(backend.isAvailable(), true);
  assert.equal(backend.unavailableReason(), null);
  assert.equal(backend.confidenceKind, "binary");
});

test("RulesBackend handles tool-gate states deterministically", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const questions = { tool_gate: TOOL_GATE_QUESTION };

  const allow = await run(backend, questions, { tool: "read", input_summary: "{}" });
  assert.equal(allow.ok, true);
  assert.equal(allow.usage.input_tokens, 0);
  assert.equal(allow.usage.output_tokens, 0);
  assert.equal(allow.backend, "rules");
  assert.equal(choiceOf(allow.answers["tool_gate"]).choice, "allow");

  const confirm = await run(backend, questions, { tool: "bash", command: "rm -rf /", input_summary: "{\"command\":\"rm -rf /\"}" });
  assert.equal(choiceOf(confirm.answers["tool_gate"]).choice, "confirm");

  const unknown = await run(backend, questions, { tool: "bash", input_summary: "echo hi" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorType, "unavailable");
});

test("RulesBackend accepts serialized tool-call state", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const questions = { tool_gate: TOOL_GATE_QUESTION };

  const allow = await run(backend, questions, {
    tool_name: "read",
    input: { path: "src/index.ts" },
  });
  assert.equal(allow.ok, true);
  assert.equal(choiceOf(allow.answers["tool_gate"]).choice, "allow");

  const confirm = await run(backend, questions, {
    tool_name: "bash",
    input: { command: "rm -rf node_modules" },
  });
  assert.equal(confirm.ok, true);
  assert.equal(choiceOf(confirm.answers["tool_gate"]).choice, "confirm");
});

test("RulesBackend classifies repeated failures", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const questions = {
    failure_type: FAILURE_TYPE_QUESTION,
    recommended_action: RECOMMENDED_ACTION_QUESTION,
  };

  const repeated = await run(backend, questions, { same_failure_count: 2 });
  assert.equal(choiceOf(repeated.answers["failure_type"]).choice, "repeated");
  assert.equal(choiceOf(repeated.answers["recommended_action"]).choice, "do_not_retry");

  const unknown = await run(backend, questions, { same_failure_count: 0 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errorType, "unavailable");
});

test("RulesBackend forces strong_review when involvesGC is true", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const questions = { review_needed: REVIEW_NEEDED_QUESTION };

  const outcome = await run(backend, questions, {
    modifiedFiles: 1,
    fileTypes: [".cpp"],
    involvesGC: true,
    involvesThreading: false,
    involvesReplication: false,
    involvesGAS: false,
    isCoreSystem: false,
    description: "",
  });

  assert.equal(choiceOf(outcome.answers["review_needed"]).choice, "strong_review");
});

test("RulesBackend classifies memory types by pattern", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const questions = { memory_type: MEMORY_TYPE_QUESTION };

  const constraint = await run(backend, questions, { text: "不要修改这个文件" });
  assert.equal(choiceOf(constraint.answers["memory_type"]).choice, "constraint");

  const none = await run(backend, questions, { text: "hello world" });
  assert.equal(none.ok, false);
  assert.equal(none.errorType, "unavailable");
});

test("RulesBackend abstains from noul questions", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const q = noul("How would you do this task?");
  const outcome = await run(backend, { free: q }, {});

  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorType, "unavailable");
});

test("RulesBackend abstains from unregistered choice questions", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const q = choice("Pick one", { a: null, b: null });
  const outcome = await run(backend, { pick: q }, {});

  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorType, "unavailable");
});

test("RulesBackend never returns partial answers for mixed requests", async () => {
  const backend = new RulesBackend({ name: "rules" });
  const outcome = await run(backend, {
    tool_gate: TOOL_GATE_QUESTION,
    relevance: noul("Is this relevant?"),
  }, { tool: "read" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorType, "unavailable");
});
// ── Pure functions ───────────────────────────────────────────────────

test("classifyShellCommand categorises shell commands", () => {
  assert.equal(classifyShellCommand("git status --short"), "safe");
  assert.equal(classifyShellCommand("rm -rf ./x"), "dangerous");
  assert.equal(classifyShellCommand("npm run build"), "uncertain");
});

test("evaluateReviewForced escalates to strong_review on large refactor", () => {
  const result = evaluateReviewForced({
    modifiedFiles: 10,
    fileTypes: [],
    isCoreSystem: false,
    involvesGC: false,
    involvesThreading: false,
    involvesReplication: false,
    involvesGAS: false,
  });
  assert.equal(result.choice, "strong_review");
  assert.equal(result.confidence, 0.9);
});

test("classifyMemoryText recognises decision phrases", () => {
  assert.equal(classifyMemoryText("decided to use postgres"), "decision");
});

test("evaluateRepeatedFailure maps counts to failure verdicts", () => {
  const hit = evaluateRepeatedFailure(3);
  assert.equal(hit.choice, "repeated");
  assert.equal(hit.confidence, 1);
  assert.equal(evaluateRepeatedFailure(0), null);
});

// ── Registry integration ─────────────────────────────────────────────

test("registry exposes the rules backend type after reset", () => {
  resetJudgeBackends();
  assert.equal(backendTypeOf("rules"), "rules");
});
