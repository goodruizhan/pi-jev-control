import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { appendEvalRecord, parseEvalRecords, compareAnswer, compareAnswers } from "../dist/src/judge/eval.js";
import { choice, noul, score } from "../dist/src/judge/ir.js";
import { judge } from "../dist/src/judge/facade.js";
import { loadConfig } from "../dist/src/config.js";
import { resetJudgeBackends } from "../dist/src/judge/registry.js";

// ── Recording roundtrip ─────────────────────────────────────────────────

test("appendEvalRecord writes JSONL and parseEvalRecords reads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-eval-"));
  const file = path.join(dir, "nested", "log.jsonl"); // nested: exercises mkdir

  appendEvalRecord(file, {
    ts: 1,
    module: "toolGate",
    backend: "typesafe",
    model: "jev",
    state: { tool_name: "read" },
    questions: { tool_gate: choice("?", { allow: null, deny: null }) },
    answers: { tool_gate: { type: "choice", choice: "allow", confidence: 0.9 } },
    latencyMs: 12,
  });
  appendEvalRecord(file, {
    ts: 2,
    module: "router",
    backend: "typesafe",
    state: {},
    questions: { task_tier: choice("?", { cheap: null }) },
    answers: { task_tier: { type: "choice", choice: "cheap", confidence: 0.8 } },
    latencyMs: 9,
  });

  const records = parseEvalRecords(fs.readFileSync(file, "utf-8"));
  assert.equal(records.length, 2);
  assert.equal(records[0].module, "toolGate");
  assert.equal(records[0].answers.tool_gate.choice, "allow");
  assert.equal(records[1].latencyMs, 9);
});

test("parseEvalRecords skips malformed lines and non-judgment rows", () => {
  const text = [
    '{"questions": {"q": {"type":"noul"}}, "answers": {}}',
    "not json at all",
    '{"answers": {}}',
    '{"questions": {"q": {"type":"noul"}}, "expect": {"q": true}}',
    "",
  ].join("\n");
  const records = parseEvalRecords(text);
  assert.equal(records.length, 2);
});

// ── Answer comparison ───────────────────────────────────────────────────

test("compareAnswer: choice agreement is label equality", () => {
  const q = choice("?", { a: null, b: null });
  const ref = { type: "choice", choice: "a", confidence: 0.9 };
  assert.deepEqual(compareAnswer("q", q, ref, { type: "choice", choice: "a", confidence: 0.4 }), {
    question: "q", type: "choice", agree: true, distance: 0,
  });
  const miss = compareAnswer("q", q, ref, { type: "choice", choice: "b", confidence: 0.9 });
  assert.equal(miss.agree, false);
  assert.equal(miss.distance, 1);
});

test("compareAnswer: noul agreement is threshold-based, distance is |Δp|", () => {
  const q = noul("?");
  const ref = { type: "noul", noul: 0.8 };
  const sameSide = compareAnswer("q", q, ref, { type: "noul", noul: 0.6 });
  assert.equal(sameSide.agree, true);
  assert.ok(Math.abs(sameSide.distance - 0.2) < 1e-9);
  const opposite = compareAnswer("q", q, ref, { type: "noul", noul: 0.2 });
  assert.equal(opposite.agree, false);
  assert.ok(Math.abs(opposite.distance - 0.6) < 1e-9);
});

test("compareAnswer: score distance normalizes by rubric span", () => {
  const q = score("?", ["zero", "one", "two", "three", "four"]); // span = 4
  const ref = { type: "score", score: 1, confidence: 0.9 };
  const near = compareAnswer("q", q, ref, { type: "score", score: 3, confidence: 0.5 });
  assert.equal(near.agree, false);
  assert.equal(near.distance, 0.5);
  const exact = compareAnswer("q", q, ref, { type: "score", score: 1, confidence: 0.1 });
  assert.equal(exact.agree, true);
  assert.equal(exact.distance, 0);
});

test("compareAnswers skips questions missing on either side", () => {
  const questions = { a: choice("?", { x: null, y: null }), b: noul("?") };
  const ref = { a: { type: "choice", choice: "x", confidence: 1 } };
  const cand = {
    a: { type: "choice", choice: "x", confidence: 0.5 },
    b: { type: "noul", noul: 0.9 },
  };
  const comparisons = compareAnswers(questions, ref, cand);
  assert.equal(comparisons.length, 1); // b missing from reference → skipped
  assert.equal(comparisons[0].question, "a");
});

// ── Facade recording hook ───────────────────────────────────────────────

test("facade appends successful judgments to judgment.eval.recordPath", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-eval-"));
  const recordPath = path.join(dir, "log.jsonl");

  const config = loadConfig();
  const saved = {
    backends: config.judgment.backends,
    backend: config.judgment.backend,
    fallback: config.judgment.fallback,
    eval: config.judgment.eval,
  };
  const originalFetch = globalThis.fetch;

  config.judgment.backends = { stub: { type: "openai-compatible", model: "m" } };
  config.judgment.backend = "stub";
  delete config.judgment.fallback;
  config.judgment.eval = { recordPath };
  resetJudgeBackends();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ answers: { risky: { probability: 0.7 } } }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });

  try {
    const outcome = await judge({ tool_name: "read" }, { risky: noul("?") }, { module: "toolGate" });
    assert.equal(outcome.ok, true);

    const records = parseEvalRecords(fs.readFileSync(recordPath, "utf-8"));
    assert.equal(records.length, 1);
    assert.equal(records[0].module, "toolGate");
    assert.equal(records[0].backend, "stub");
    assert.equal(records[0].state.tool_name, "read");
    assert.equal(records[0].answers.risky.noul, 0.7);

    // Failed judgments are NOT recorded (they carry no usable answers)
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const failed = await judge({}, { risky: noul("?") }, { module: "toolGate" });
    assert.equal(failed.ok, false);
    const after = parseEvalRecords(fs.readFileSync(recordPath, "utf-8"));
    assert.equal(after.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    config.judgment.backends = saved.backends;
    config.judgment.backend = saved.backend;
    if (saved.fallback) config.judgment.fallback = saved.fallback;
    if (saved.eval) config.judgment.eval = saved.eval;
    else delete config.judgment.eval;
    resetJudgeBackends();
  }
});
