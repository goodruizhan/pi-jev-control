/**
 * Neutral judgment IR — the "System One interface" decoupled from any vendor SDK.
 *
 * A judgment backend receives { state, questions } and returns typed answers
 * with confidence/probability information. The IR is structurally compatible
 * with the TypeSafe System One wire format so the TypeSafe backend is a thin
 * pass-through, while other backends (small local models, Jev-compatible
 * clones) translate the IR into their own request format.
 */

/** Free-form entry: text, JSON object, array, or null. */
export type EntryValue = string | { [key: string]: unknown } | unknown[] | null;

/** Yes/no question — answer is a probability of "yes". */
export interface NoulQuestionIR {
  type: "noul";
  instructions?: EntryValue;
  criteria?: { true?: EntryValue; false?: EntryValue } | null;
}

/** Multiple-choice question — criteria maps option label → description. */
export interface ChoiceQuestionIR {
  type: "choice";
  instructions?: EntryValue;
  criteria: Record<string, EntryValue>;
}

/** Score question — criteria is an ordered rubric (index 0 = lowest). */
export interface ScoreQuestionIR {
  type: "score";
  instructions?: EntryValue;
  criteria: readonly EntryValue[];
}

export type JudgeQuestionIR = NoulQuestionIR | ChoiceQuestionIR | ScoreQuestionIR;

/** Questions keyed by the names used to identify their answers. */
export interface JudgeQuestions {
  [name: string]: JudgeQuestionIR;
}

/** Back-compat alias for code written against the SDK's Questions type. */
export type Questions = JudgeQuestions;

// ── Builders (same call shape as the TypeSafe SDK builders) ─────────────

export function noul(instructions?: EntryValue, criteria?: NoulQuestionIR["criteria"]): NoulQuestionIR {
  return { type: "noul", instructions, criteria };
}

export function choice(instructions: EntryValue, criteria: Record<string, EntryValue>): ChoiceQuestionIR {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: EntryValue, criteria: readonly EntryValue[]): ScoreQuestionIR {
  return { type: "score", instructions, criteria };
}

// ── Answers ─────────────────────────────────────────────────────────────
// Field names intentionally match the TypeSafe SDK response fields
// (noul / choice / confidence / probabilities / score) so consuming code
// reads the same regardless of which backend produced the answer.

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability of a yes answer, from zero to one. */
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities?: Record<string, number>;
}

export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/**
 * Read a JudgeAnswer as a choice, falling back to a safe unknown when the
 * backend returned another shape (e.g. a non-conformant small model).
 */
export function choiceOf(answer: JudgeAnswer | undefined): { choice: string; confidence: number } {
  return answer?.type === "choice" ? answer : { choice: "unknown", confidence: 0 };
}

export interface JudgeAnswers {
  [name: string]: JudgeAnswer;
}

/** Token usage for a request, when the backend reports it. */
export interface JudgeUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}
