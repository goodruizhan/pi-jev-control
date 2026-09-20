/**
 * Backend evaluation support — record live judgments to JSONL and compare
 * two backends' answers offline.
 *
 * Workflow: set judgment.eval.recordPath, collect real traffic with the
 * production backend, then run `npm run eval` to replay the log against
 * candidate backends and get agreement/latency numbers before switching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { JudgeAnswer, JudgeAnswers, JudgeQuestionIR, JudgeQuestions } from "./ir.js";

export interface EvalRecord {
  /** Unix epoch ms when the judgment was made. */
  ts: number;
  /** Calling module: router, toolGate, failureJudge, ... */
  module: string;
  /** Backend name and model that produced `answers`. */
  backend: string;
  model?: string;
  confidenceKind?: string;
  state: Record<string, unknown>;
  questions: JudgeQuestions;
  answers: JudgeAnswers;
  latencyMs: number;
}

/**
 * Append one record to a JSONL file. Synchronous and total-failure-proof:
 * recording must never break the live judgment path, so every error is
 * swallowed (the file is an opt-in side channel, not critical state).
 */
export function appendEvalRecord(recordPath: string, record: EvalRecord): void {
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.appendFileSync(recordPath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Intentionally silent — recording is best-effort.
  }
}

/** Parse a JSONL dataset/recording file. Blank lines are skipped. */
export function parseEvalRecords(text: string): EvalRecord[] {
  const records: EvalRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as EvalRecord;
      // Seed cases carry `expect` instead of recorded `answers`; both are valid.
      if (parsed && typeof parsed === "object" && parsed.questions && (parsed.answers || (parsed as { expect?: unknown }).expect)) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines — a partial write must not break the whole run.
    }
  }
  return records;
}

export interface AnswerComparison {
  question: string;
  type: "choice" | "noul" | "score";
  /** Exact-agreement boolean (see per-type rules in compareAnswer). */
  agree: boolean;
  /**
   * Numeric distance: choice → 0/1, noul → |Δp|, score → |Δscore| / (rubricSize - 1).
   * Useful for averaging how far apart two backends are beyond agree/disagree.
   */
  distance: number;
}

export function compareAnswer(
  name: string,
  question: JudgeQuestionIR,
  reference: JudgeAnswer | undefined,
  candidate: JudgeAnswer | undefined,
): AnswerComparison | null {
  if (!reference || !candidate || reference.type !== candidate.type) return null;

  if (question.type === "choice" && reference.type === "choice" && candidate.type === "choice") {
    const agree = reference.choice === candidate.choice;
    return { question: name, type: "choice", agree, distance: agree ? 0 : 1 };
  }
  if (question.type === "noul" && reference.type === "noul" && candidate.type === "noul") {
    const refYes = reference.noul >= 0.5;
    const candYes = candidate.noul >= 0.5;
    return { question: name, type: "noul", agree: refYes === candYes, distance: Math.abs(reference.noul - candidate.noul) };
  }
  if (question.type === "score" && reference.type === "score" && candidate.type === "score") {
    const span = Math.max(1, (question.criteria?.length ?? 2) - 1);
    const gap = Math.abs(reference.score - candidate.score);
    return { question: name, type: "score", agree: gap === 0, distance: gap / span };
  }
  return null;
}

/** Compare a full answer set against a reference, skipping questions either side lacks. */
export function compareAnswers(
  questions: JudgeQuestions,
  reference: JudgeAnswers,
  candidate: JudgeAnswers,
): AnswerComparison[] {
  const comparisons: AnswerComparison[] = [];
  for (const [name, question] of Object.entries(questions)) {
    const comparison = compareAnswer(name, question, reference[name], candidate[name]);
    if (comparison) comparisons.push(comparison);
  }
  return comparisons;
}
