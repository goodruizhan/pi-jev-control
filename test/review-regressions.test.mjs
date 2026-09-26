import test from "node:test";
import assert from "node:assert/strict";
import { resetConfigToDefaults, loadConfig } from "../dist/src/config.js";
import { resetJudgeBackends } from "../dist/src/judge/registry.js";
import { assessRisk } from "../dist/src/gates/assess-risk.js";
import { OpenAiCompatibleBackend } from "../dist/src/judge/openai-backend.js";
import { choice } from "../dist/src/judge/ir.js";
import { judge } from "../dist/src/judge/facade.js";
import { TOOL_GATE_QUESTION } from "../dist/src/judge/questions.js";

function rulesOnly() {
  resetConfigToDefaults();
  const config = loadConfig();
  config.judgment.backend = "rules";
  delete config.judgment.fallback;
  resetJudgeBackends();
  return config;
}

test("risk assessment includes details in deterministic checks even without a model", async () => {
  rulesOnly();
  try {
    const result = await assessRisk("清理临时文件", "bash", "rm -rf ./victim");
    assert.equal(result.status, "unavailable");
    assert.equal(result.deterministic.dangerous, true);
    assert.equal(result.deterministic.shellRisk, "dangerous");
    const operationOnly = await assessRisk("rm -rf ./victim", "bash");
    assert.deepEqual(result.deterministic, operationOnly.deterministic);
    const safe = await assessRisk("git status", "bash", "node --version");
    assert.deepEqual(safe.deterministic, { dangerous: false, shellRisk: "safe" });
    const uncertain = await assessRisk("git status", "bash", "custom command");
    assert.equal(uncertain.deterministic.shellRisk, "uncertain");
    const risk = await assessRisk("检查操作", "bash", "批量删除资产");
    assert.ok(risk.riskFeatures.includes("high-impact"));
    assert.equal(risk.minimumTier, "strong");
    loadConfig().enabled = false;
    assert.equal((await assessRisk("检查操作", "bash", "rm -rf ./victim")).deterministic.dangerous, true);
  } finally {
    resetConfigToDefaults();
    resetJudgeBackends();
  }
});

for (const value of ["", "  ", "allow or deny", "a", null]) {
  test(`empty or ambiguous choice is rejected: ${JSON.stringify(value)}`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ answers: { gate: { choice: value, confidence: 1 } } }) } }] }),
    });
    try {
      const backend = new OpenAiCompatibleBackend({ name: "stub", model: "small-test-model" });
      const result = await backend.judge({ state: {}, questions: { gate: choice("Choose", { allow: null, deny: null }) } }, {});
      assert.equal(result.ok, false, "invalid choice must not become the first declared option");
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("invalid choice triggers the deterministic fallback rather than an invented allow", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.judgment.backends.stub = { type: "openai-compatible", model: "small-test-model" };
  config.judgment.backend = "stub";
  config.judgment.modules = {};
  resetJudgeBackends();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"answers":{"tool_gate":{"choice":"","confidence":1}}}' } }] }),
  });
  try {
    const result = await judge({ tool_name: "bash", input: { command: "rm -rf ./victim" } },
      { tool_gate: TOOL_GATE_QUESTION }, { module: "toolGate" });
    assert.equal(result.ok, true);
    assert.equal(result.backend, "rules");
    assert.notEqual(result.answers.tool_gate.choice, "allow");
  } finally {
    globalThis.fetch = original;
    resetConfigToDefaults();
    resetJudgeBackends();
  }
});
