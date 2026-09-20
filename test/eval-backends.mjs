#!/usr/bin/env node
/**
 * Offline backend comparison runner (P5).
 *
 * Replays a JSONL dataset of judgment cases against the configured backends
 * and reports agreement / distance / latency per backend. Use it before
 * switching judgment.backend to a new model.
 *
 * Dataset line shapes (both supported):
 *   Seed case:     { "name": "...", "module": "toolGate", "state": {...},
 *                    "questions": {...}, "expect": { "tool_gate": "allow" } }
 *   Recorded log:  output of judgment.eval.recordPath — its `answers` act as
 *                  the reference when the case has no `expect`.
 *
 * Usage:
 *   node test/eval-backends.mjs [--dataset path] [--backends a,b] [--reference name] [--timeoutMs N]
 *
 * Defaults: dataset=test/eval/cases.jsonl, backends=<all configured except the
 * reference>, reference=<configured judgment.backend>.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/src/config.js";
import { getBackendByName } from "../dist/src/judge/registry.js";
import { parseEvalRecords, compareAnswers } from "../dist/src/judge/eval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = path.join(HERE, "eval", "cases.jsonl");

const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(args.dataset ?? DEFAULT_DATASET);

if (!fs.existsSync(datasetPath)) {
  console.error(`dataset not found: ${datasetPath}`);
  process.exit(2);
}

const cases = parseEvalRecords(fs.readFileSync(datasetPath, "utf-8"));
if (cases.length === 0) {
  console.error(`dataset is empty or unreadable: ${datasetPath}`);
  process.exit(2);
}

const config = loadConfig();
const referenceName = args.reference ?? config.judgment.backend;
const reference = getBackendByName(referenceName);
if (!reference) {
  console.error(`reference backend "${referenceName}" is not configured`);
  process.exit(2);
}

const candidateNames = args.backends
  ? args.backends.split(",").map((name) => name.trim()).filter(Boolean)
  : Object.keys(config.judgment.backends).filter((name) => name !== referenceName);

const candidates = candidateNames.map((name) => ({ name, backend: getBackendByName(name) }));

console.log(`dataset: ${datasetPath} (${cases.length} cases)`);
console.log(`reference: ${referenceName} (${reference.isAvailable() ? "available" : reference.unavailableReason()})`);
console.log(`candidates: ${candidateNames.join(", ") || "(none)"}\n`);

const timeoutMs = Number(args.timeoutMs ?? 8000);
const summaries = [];

for (const { name, backend } of candidates) {
  const summary = {
    name,
    available: backend?.isAvailable() ?? false,
    reason: backend?.unavailableReason?.() ?? (backend ? null : "not configured"),
    cases: 0,
    failed: 0,
    compared: 0,
    agreed: 0,
    distanceSum: 0,
    latencySum: 0,
    confidenceSum: 0,
  };
  summaries.push(summary);
  if (!summary.available) continue;

  for (const evalCase of cases) {
    const outcome = await backend.judge(
      { state: evalCase.state ?? {}, questions: evalCase.questions },
      { timeoutMs },
    );
    summary.cases += 1;
    if (!outcome.ok) {
      summary.failed += 1;
      continue;
    }
    summary.latencySum += outcome.latencyMs;

    const referenceAnswers = await resolveReference(evalCase, reference, timeoutMs);
    if (!referenceAnswers) continue;

    const comparisons = compareAnswers(evalCase.questions, referenceAnswers, outcome.answers ?? {});
    for (const comparison of comparisons) {
      summary.compared += 1;
      if (comparison.agree) summary.agreed += 1;
      summary.distanceSum += comparison.distance;
      const answer = (outcome.answers ?? {})[comparison.question];
      summary.confidenceSum += answer?.confidence ?? (answer?.type === "noul" ? Math.abs(answer.noul - 0.5) * 2 : 0);
    }
  }
}

// Resolve reference answers per case: explicit expect > recorded answers > live reference run.
// Live reference results are memoized per case index to avoid double calls.
const referenceCache = new Map();
async function resolveReference(evalCase, referenceBackend, timeout) {
  if (evalCase.expect) return expectToAnswers(evalCase.questions, evalCase.expect);
  if (evalCase.answers && Object.keys(evalCase.answers).length > 0) return evalCase.answers;
  if (!referenceBackend.isAvailable()) return null;
  const key = evalCase; // object identity — each case is compared once per candidate
  if (referenceCache.has(key)) return referenceCache.get(key);
  const outcome = await referenceBackend.judge(
    { state: evalCase.state ?? {}, questions: evalCase.questions },
    { timeoutMs: timeout },
  );
  const answers = outcome.ok ? outcome.answers ?? null : null;
  referenceCache.set(key, answers);
  return answers;
}

function expectToAnswers(questions, expect) {
  const answers = {};
  for (const [name, value] of Object.entries(expect)) {
    const question = questions[name];
    if (!question) continue;
    if (question.type === "choice" && typeof value === "string") {
      answers[name] = { type: "choice", choice: value, confidence: 1 };
    } else if (question.type === "noul") {
      const p = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
      if (Number.isFinite(p)) answers[name] = { type: "noul", noul: Math.min(1, Math.max(0, p)) };
    } else if (question.type === "score" && typeof value === "number") {
      answers[name] = { type: "score", score: value, confidence: 1 };
    }
  }
  return answers;
}

// ── Report ──────────────────────────────────────────────────────────────

console.log("backend".padEnd(18), "ok/cases", "agree%", "avgDist", "avgConf", "avgLatency", "note");
console.log("-".repeat(88));
let anySucceeded = false;
for (const summary of summaries) {
  if (!summary.available) {
    console.log(summary.name.padEnd(18), "-".padEnd(8), "-".padEnd(7), "-".padEnd(7), "-".padEnd(7), "-".padEnd(10), summary.reason ?? "unavailable");
    continue;
  }
  const succeeded = summary.cases - summary.failed;
  if (succeeded > 0) anySucceeded = true;
  const agree = summary.compared > 0 ? `${((summary.agreed / summary.compared) * 100).toFixed(1)}%` : "-";
  const distance = summary.compared > 0 ? (summary.distanceSum / summary.compared).toFixed(3) : "-";
  const confidence = summary.compared > 0 ? (summary.confidenceSum / summary.compared).toFixed(3) : "-";
  const latency = succeeded > 0 ? `${Math.round(summary.latencySum / succeeded)}ms` : "-";
  console.log(
    summary.name.padEnd(18),
    `${succeeded}/${summary.cases}`.padEnd(8),
    agree.padEnd(7),
    distance.padEnd(7),
    confidence.padEnd(7),
    latency.padEnd(10),
    summary.failed > 0 ? `${summary.failed} failed` : "",
  );
}

process.exit(anySucceeded ? 0 : 1);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      parsed[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return parsed;
}
