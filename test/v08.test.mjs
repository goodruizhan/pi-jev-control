import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildSearchTerms } from "../dist/src/gates/context-gate.js";
import { extractDescription, scoreSkillLexically } from "../dist/src/gates/skill-gate.js";
import { validateJudgeAnswers } from "../dist/src/judge/facade.js";
import { choice, noul, score } from "../dist/src/judge/ir.js";
import { PLUGIN_VERSION } from "../dist/src/version.js";

test("natural-language code search creates bounded literal terms", () => {
  assert.deepEqual(
    buildSearchTerms("find version status judgment backend fallback timeout"),
    ["version", "status", "judgment", "backend", "fallback", "timeout"],
  );
  assert.ok(buildSearchTerms("判断后端超时问题").length > 1);
  assert.equal(buildSearchTerms("   ").length, 0);
});

test("skill descriptions support folded and literal YAML frontmatter", () => {
  assert.equal(
    extractDescription("---\nname: folded\ndescription: >\n  Fast semantic routing for\n  TypeScript tools.\n---\n# Folded"),
    "Fast semantic routing for TypeScript tools.",
  );
  assert.equal(
    extractDescription("---\nname: literal\ndescription: |\n  First line\n  Second line\n---\n# Literal"),
    "First line\nSecond line",
  );
});

test("skill lexical floor favors exact technology and skill-name matches", () => {
  const query = "build a TypeSafe Jev judgment backend and validate calibrated confidence";
  const typesafe = scoreSkillLexically(
    query,
    "typesafe-ai",
    "TypeSafe System One models including Jev return typed judgments and probabilities.",
  );
  const unrelated = scoreSkillLexically(query, "kdocs", "Create and edit cloud documents and spreadsheets.");
  assert.ok(typesafe >= 0.55, `expected an exact-match floor, got ${typesafe}`);
  assert.equal(unrelated, 0);
});

test("judgment answer validation rejects incomplete and invalid results", () => {
  const questions = {
    pick: choice("Pick", { a: null, b: null }),
    risk: noul("Risk?"),
    grade: score("Grade", ["low", "high"]),
  };
  assert.equal(validateJudgeAnswers(questions, {
    pick: { type: "choice", choice: "a", confidence: 0.8 },
    risk: { type: "noul", noul: 0.2 },
    grade: { type: "score", score: 1, confidence: 0.7 },
  }), null);
  assert.match(validateJudgeAnswers(questions, {}) ?? "", /missing answer/);
  assert.match(validateJudgeAnswers(questions, {
    pick: { type: "choice", choice: "undeclared", confidence: 0.8 },
    risk: { type: "noul", noul: 0.2 },
    grade: { type: "score", score: 1, confidence: 0.7 },
  }) ?? "", /declared criteria/);
  assert.match(validateJudgeAnswers(questions, {
    pick: { type: "choice", choice: "a", confidence: 0.8 },
    risk: { type: "noul", noul: Number.NaN },
    grade: { type: "score", score: 1, confidence: 0.7 },
  }) ?? "", /finite number/);
});

test("runtime version stays synchronized with package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PLUGIN_VERSION, pkg.version);
});
