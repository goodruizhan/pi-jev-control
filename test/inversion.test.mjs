import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, resetConfigToDefaults } from "../dist/src/config.js";
import { resetJudgeBackends } from "../dist/src/judge/registry.js";
import { rankCandidates } from "../dist/src/judge/rank.js";
import { requestPrune } from "../dist/src/compaction/prune-context.js";
import { resetEpoch, setEpochPlan } from "../dist/src/compaction/epoch.js";
import { setupContextHook } from "../dist/src/compaction/context-hook.js";
import { addMemory } from "../dist/src/memory/memory-add.js";
import { clearAllMemory, getMemoryCount } from "../dist/src/memory/store.js";
import { assessRisk } from "../dist/src/gates/assess-risk.js";
import { diagnoseFailure } from "../dist/src/judgment/diagnose-failure.js";
import { assessTask } from "../dist/src/router/assess-task.js";
import { judgeTaskTier } from "../dist/src/router/task-router.js";
import { applyThresholdFallback } from "../dist/src/judge/rank.js";
import { isSkillRelevant } from "../dist/src/gates/skill-gate.js";

/** Turn the judgment backends off so every tool takes its degraded path. */
function withJudgeDown(fn) {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJudgeBackends();
  return fn().finally(() => {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    resetJudgeBackends();
  });
}

function emptyPlan(id) {
  return {
    epochId: id,
    createdAtTurn: 0,
    keepIds: new Set(),
    truncateIds: new Set(),
    dropIds: new Set(),
    estimatedCharsBefore: 0,
    estimatedCharsAfter: 0,
  };
}

// ── Defaults: the contract of the inversion ─────────────────────────────────

test("defaults keep the model in charge of everything", () => {
  resetConfigToDefaults();
  const config = loadConfig();

  assert.equal(config.router.mode, "rules-only");
  assert.equal(config.compaction.autoMode, "off");
  assert.equal(config.compaction.enabled, true);
  assert.equal(config.retryJudge.appendToResult, false);
  assert.equal(config.memoryGate.enabled, false);
  assert.equal(config.memoryGate.mode, "suggest");
  assert.equal(config.judgment.backend, "typesafe");
  assert.equal(config.judgment.fallback, "rules");
});

test("resetConfigToDefaults is not undone by an on-disk config", () => {
  resetConfigToDefaults();
  const first = loadConfig().router.mode;
  const second = loadConfig().router.mode;
  assert.equal(first, second);
  assert.equal(first, "rules-only");
});

// ── rank primitive ───────────────────────────────────────────────────────────

test("rank: lexical prefilter orders by hit count and degrades instead of throwing", async () => {
  await withJudgeDown(async () => {
    const result = await rankCandidates(
      "how to write a login screen",
      [
        { id: "login-screen", text: "Login screen: form, validation and session handling" },
        { id: "billing", text: "Billing webhook signatures and retries" },
        { id: "forms", text: "Form validation helpers for login and signup screens" },
        { id: "empty" },
      ],
      { limit: 2 },
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.totalCandidates, 4);
    assert.deepEqual(
      result.shortlist.map((item) => item.id),
      ["login-screen", "forms"],
    );
    assert.equal(result.shortlist[0].source, "lexical");
  });
});

test("rank: empty query is skipped without touching a backend", async () => {
  const result = await rankCandidates("", [{ id: "a", text: "anything" }]);
  assert.equal(result.status, "skipped");
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.reason, "no query or no candidates");
});

test("rank: when nothing matches, the caller still sees candidates", async () => {
  // No lexical hit means no judgment call was even needed, so this is "ok" with
  // the original order rather than "unavailable".
  const result = await rankCandidates(
    "login screen",
    [{ id: "billing", text: "Billing webhook signatures" }],
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.shortlist, [{ id: "billing", score: 0, source: "lexical" }]);
  assert.equal(result.reason, "no lexical match; original order kept");
});

test("rank: lexical hits but no backend means lexical order is returned", async () => {
  await withJudgeDown(async () => {
    const result = await rankCandidates(
      "how to write a login screen",
      [
        { id: "login-screen", text: "Login screen: form and validation" },
        { id: "forms", text: "Form validation helpers for login and signup screens" },
      ],
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "judgment backend unavailable; lexical order used");
    assert.ok(result.shortlist.length > 0);
    assert.equal(result.shortlist[0].source, "lexical");
  });
});

test("rank: no candidates is skipped", async () => {
  const result = await rankCandidates("anything", []);
  assert.equal(result.status, "skipped");
  assert.equal(result.totalCandidates, 0);
});

test("rank: nothing clearing the threshold still returns a shortlist", () => {
  // The tool promises never to come back empty-handed when candidates exist.
  const scored = [
    { id: "a", score: 0.1, source: "judge" },
    { id: "b", score: 0.3, source: "judge" },
    { id: "c", score: 0.2, source: "judge" },
  ];
  const { shortlist, reason } = applyThresholdFallback(scored, 0.45, 5);
  assert.equal(shortlist.length, 2, "falls back to the best two");
  assert.deepEqual(shortlist.map((item) => item.id), ["b", "c"], "still sorted by score");
  assert.match(reason ?? "", /below the 0.45 threshold/);
});

test("rank: the fallback never outruns the requested limit", () => {
  const scored = [
    { id: "a", score: 0.1, source: "judge" },
    { id: "b", score: 0.3, source: "judge" },
  ];
  assert.equal(applyThresholdFallback(scored, 0.45, 1).shortlist.length, 1);
  assert.equal(applyThresholdFallback(scored, 0.45, 3).shortlist.length, 2);
});

test("rank: a passing shortlist is left alone", () => {
  const scored = [
    { id: "a", score: 0.9, source: "judge" },
    { id: "b", score: 0.1, source: "judge" },
  ];
  const { shortlist, reason } = applyThresholdFallback(scored, 0.45, 5);
  assert.deepEqual(shortlist.map((item) => item.id), ["a"]);
  assert.equal(reason, undefined);
});

test("rank: nothing scored returns an empty shortlist without inventing one", () => {
  const { shortlist, reason } = applyThresholdFallback([], 0.45, 5);
  assert.deepEqual(shortlist, []);
  assert.equal(reason, undefined);
});

test("rank: non-finite limit and threshold are clamped, not silently fatal", async () => {
  // threshold=NaN filtered every candidate out; limit=NaN made slice(0, NaN)
  // return an empty shortlist. Both failed without saying so.
  await withJudgeDown(async () => {
    const candidates = [
      { id: "login-screen", text: "Login screen: form and validation" },
      { id: "forms", text: "Form validation helpers for login and signup screens" },
    ];
    for (const [limit, threshold] of [
      [Number.NaN, 0.45],
      [5, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [-1, -1],
      [9999, 99],
    ]) {
      const result = await rankCandidates(
        "how to write a login screen",
        candidates,
        { limit, threshold },
      );
      assert.ok(result.shortlist.length > 0, `limit=${limit} threshold=${threshold} returned nothing`);
      assert.ok(result.shortlist.length <= 200);
    }
  });
});

// ── prune context ────────────────────────────────────────────────────────────

test("prune: disabled, then requested, then skipped when a plan is active", () => {
  resetConfigToDefaults();
  const config = loadConfig();
  resetEpoch();

  config.compaction.enabled = false;
  assert.equal(requestPrune().status, "disabled");

  config.compaction.enabled = true;
  const requested = requestPrune("slim the session");
  assert.equal(requested.status, "requested");
  assert.equal(requested.reason, "slim the session");

  setEpochPlan(emptyPlan("manual"));
  assert.equal(requestPrune().status, "skipped");

  resetEpoch();
});

test("context hook passes messages through when nobody asked for pruning", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.compaction.enabled = true;
  config.compaction.autoMode = "off";
  resetEpoch();

  const handlers = new Map();
  setupContextHook({ on: (event, handler) => handlers.set(event, handler) });
  const handler = handlers.get("context");

  const event = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
  };
  const ctx = { signal: undefined, ui: { notify() {} } };

  // No plan, no explicit request: the model's memory is untouched.
  assert.equal(await handler(event, ctx), undefined);

  // Same in suggest mode.
  config.compaction.autoMode = "suggest";
  assert.equal(await handler(event, ctx), undefined);

  // Compaction disabled: still untouched.
  config.compaction.enabled = false;
  assert.equal(await handler(event, ctx), undefined);
  config.compaction.enabled = true;
});

test("context hook applies a plan that someone explicitly requested", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.compaction.enabled = true;
  config.compaction.autoMode = "off";
  resetEpoch();

  const handlers = new Map();
  setupContextHook({ on: (event, handler) => handlers.set(event, handler) });
  const handler = handlers.get("context");

  const bigText = "x".repeat(5000);
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } }],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: bigText }],
      isError: false,
    },
    { role: "user", content: [{ type: "text", text: "next step" }] },
  ];
  const ctx = { signal: undefined, ui: { notify() {} } };

  const groups = (await import("../dist/src/compaction/pruner.js")).buildToolGroups(messages).groups;
  const plan = {
    ...emptyPlan("requested"),
    dropIds: new Set(groups.map((group) => group.groupId)),
    estimatedCharsBefore: messages.length * bigText.length,
    estimatedCharsAfter: 0,
  };

  // Without an explicit request the plan is not applied in non-auto modes.
  setEpochPlan(plan);
  const applied = await handler({ messages }, ctx);
  assert.ok(applied, "an explicit plan is applied");
  assert.ok(applied.messages.length < messages.length);

  resetEpoch();
});

// ── memory add ───────────────────────────────────────────────────────────────

test("memory add: validates type and clamps confidence", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  clearAllMemory();
  try {
    const badType = await addMemory({ type: "weird", summary: "x" });
    assert.equal(badType.status, "skipped");
    assert.equal(badType.type, "weird");
    assert.match(badType.reason, /must be one of/);

    const empty = await addMemory({ type: "fact", summary: "   " });
    assert.equal(empty.status, "skipped");
    assert.equal(empty.reason, "summary is empty");

    config.enabled = false;
    assert.equal((await addMemory({ type: "fact", summary: "x" })).status, "disabled");
    config.enabled = true;

    const saved = await addMemory({
      type: "Fact",
      summary: " the user prefers tabs ",
      confidence: 1.9,
      rawExcerpt: "  remember this  ",
    });
    assert.equal(saved.status, "saved");
    assert.equal(saved.type, "fact");
    assert.equal(saved.summary, "the user prefers tabs");
    assert.ok(saved.id);
    assert.equal(getMemoryCount().memory, 1);
  } finally {
    clearAllMemory();
  }
});

test("memory add: failures are upserted by fingerprint instead of duplicated", async () => {
  resetConfigToDefaults();
  clearAllMemory();
  try {
    await addMemory({ type: "failure", summary: "the build fails when CWD is the repo root" });
    await addMemory({ type: "failure", summary: "the build fails when CWD is the repo root" });
    assert.equal(getMemoryCount().failures, 1);
    assert.equal(getMemoryCount().memory, 0);
  } finally {
    clearAllMemory();
  }
});

// ── assess risk ──────────────────────────────────────────────────────────────

test("assess risk: the deterministic floor is always present, even when Jev is down", async () => {
  await withJudgeDown(async () => {
    const dangerous = await assessRisk("rm -rf ./victim", "bash");
    assert.equal(dangerous.status, "unavailable");
    assert.equal(dangerous.deterministic.dangerous, true);
    assert.equal(dangerous.deterministic.shellRisk, "dangerous");
    assert.equal(dangerous.gateVerdict, undefined);
    assert.equal(dangerous.policy, undefined);

    const ordinary = await assessRisk("read notes/readme.md", "read");
    assert.equal(ordinary.deterministic.dangerous, false);
    assert.equal(ordinary.deterministic.shellRisk, "uncertain");
  });
});

test("assess risk: a disabled gate reports itself instead of enforcing", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.enabled = false;
  const result = await assessRisk("rm -rf ./victim");
  assert.equal(result.status, "disabled");
  assert.equal(result.deterministic.dangerous, true);
  config.enabled = true;
});

// ── diagnose failure ─────────────────────────────────────────────────────────

test("diagnose failure: a repeated failure answers with a local rule", async () => {
  await withJudgeDown(async () => {
    const verdict = await diagnoseFailure("bash", "failed", "npm test", 3);
    assert.equal(verdict.status, "ok");
    assert.equal(verdict.failureType, "repeated");
    assert.equal(verdict.recommendedAction, "do_not_retry");
    assert.equal(verdict.deterministic.source, "local-rule");
    assert.equal(verdict.deterministic.sameFailureCount, 3);
    assert.match(verdict.deterministic.reason, /3/);
    assert.equal(verdict.backend, undefined);
  });
});

test("diagnose failure: a first failure asks Jev and degrades honestly", async () => {
  await withJudgeDown(async () => {
    // zero prior occurrences: no local rule applies, so the model gets asked.
    const verdict = await diagnoseFailure("bash", "Command failed with exit code 1", "npm test", 0);
    assert.equal(verdict.status, "unavailable");
    assert.equal(verdict.recommendedAction, undefined);
    assert.equal(verdict.confidence, 0);
    assert.equal(verdict.deterministic, undefined);
  });
});

// ── assess task ──────────────────────────────────────────────────────────────

test("assess task: returns a tier and a confidence, changing nothing", async () => {
  await withJudgeDown(async () => {
    const result = await assessTask("Fix a typo in the README", "small documentation edit");
    assert.ok(["cheap", "medium", "strong", "unknown"].includes(result.tier));
    assert.equal(typeof result.confidence, "number");
    assert.equal(result.status, "unavailable");
    assert.equal(result.backend, undefined);
  });
});

test("assess task: a disabled gate answers disabled", async () => {
  resetConfigToDefaults();
  const config = loadConfig();
  config.enabled = false;
  const result = await assessTask("anything");
  assert.equal(result.status, "disabled");
  assert.equal(result.tier, "unknown");
  config.enabled = true;
});

test("assess task: a backend error is unavailable, not a zero-confidence verdict", async () => {
  // The rules backend is always "available" but cannot answer task_tier, so the
  // call takes the error path instead of the unavailable-backend path. Before
  // the fix, assessTask matched the literal reason "judgment backend
  // unavailable", so this returned status "ok" with a confidence of zero and no
  // hint that the tier was a floor rather than a judgment.
  resetConfigToDefaults();
  const config = loadConfig();
  config.judgment.backend = "rules";
  resetJudgeBackends();
  try {
    const judge = await judgeTaskTier("Fix a typo in the README");
    assert.equal(judge.source, "fallback");
    assert.equal(judge.backendDown, true);
    assert.equal(judge.confidence, 0);

    const result = await assessTask("Fix a typo in the README");
    assert.equal(result.status, "unavailable");
  } finally {
    resetConfigToDefaults();
    resetJudgeBackends();
  }
});

test("assess task: a transport failure keeps status unavailable", async () => {
  // A reachable-looking backend that errors at the wire is the path the literal
  // reason match missed: the reason was "<errorType>: <message>", never the
  // unavailable-backend string. Port 9 (discard) refuses immediately, so this
  // fails deterministically without a real network round trip.
  resetConfigToDefaults();
  const config = loadConfig();
  config.judgment.backend = "loopback";
  config.judgment.backends.loopback = {
    type: "openai-compatible",
    model: "test-model",
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 300,
  };
  resetJudgeBackends();
  try {
    const judge = await judgeTaskTier("Fix a typo in the README");
    assert.equal(judge.backendDown, true);
    assert.notEqual(judge.reason, "judgment backend unavailable");

    const result = await assessTask("Fix a typo in the README");
    assert.equal(result.status, "unavailable");
  } finally {
    resetConfigToDefaults();
    resetJudgeBackends();
  }
});

// ── skill exclusion ────────────────────────────────────────────────────────

const SKILL_NAME = "ue5-blueprint-workflow";
const SKILL_DESC = "Blueprint graph workflow for feature implementation";

test("skill exclusion: plural and CJK surface forms both exclude", () => {
  // "no blueprints" carried the plural while skillTokens() had already reduced
  // the token to "blueprint", so the whitespace-or-punctuation look-ahead never
  // matched. The same gap affected CJK queries: "不涉及蓝图" carries the CJK
  // surface form, never the English canonical token the regex looked for.
  // Known limit: a qualifier AFTER the noun ("与蓝图无关") is still not excluded,
  // because making the trailing qualifier optional would exclude harmless phrases
  // such as "蓝图, 继续".
  for (const query of [
    "no blueprints",
    "not blueprints",
    "without blueprints",
    "excluding blueprints",
    "no blueprint",
    "不涉及蓝图",
    "不需要蓝图",
    "无需蓝图",
    "排除蓝图",
    "不使用蓝图",
    "不要使用蓝图",
  ]) {
    assert.equal(
      isSkillRelevant(query, SKILL_NAME, SKILL_DESC, 0.95, 0.4),
      false,
      `should exclude: ${query}`,
    );
  }
});

test("skill exclusion: a plain mention still matches", () => {
  assert.equal(
    isSkillRelevant("how do I wire a blueprint graph", SKILL_NAME, SKILL_DESC, 0.95, 0.4),
    true,
  );
  assert.equal(
    isSkillRelevant("蓝图工作流怎么接线", SKILL_NAME, SKILL_DESC, 0.95, 0.4),
    true,
  );
});

test("skill exclusion: a lookalike phrase does not exclude", () => {
  // "蓝色" (blue, as a colour) shares a prefix with "蓝图" (blueprint) but is a
  // different word, so the exclusion must not fire on it.
  assert.equal(
    isSkillRelevant("不涉及蓝色主题", SKILL_NAME, SKILL_DESC, 0.95, 0.4),
    true,
  );
});
