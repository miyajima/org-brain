import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLongMemEvalAnswerPrompt,
  buildLongMemEvalJudgePrompt,
  summarizeLongMemEvalAnswers
} from "./product-longmemeval-answer-judge.mjs";

test("LongMemEval answer prompt excludes gold answer and source labels", () => {
  const prompt = buildLongMemEvalAnswerPrompt({
    contexts: ["Session Date: 2023-01-01\nuser: I moved to Oslo."],
    questionDate: "2023-02-01",
    question: "Where did I move?",
    answer: "Oslo",
    answer_session_ids: ["answer-secret"]
  });
  assert.match(prompt, /Where did I move/u);
  assert.doesNotMatch(prompt, /answer-secret/u);
});

test("LongMemEval judge applies temporal tolerance", () => {
  const prompt = buildLongMemEvalJudgePrompt({
    category: "temporal-reasoning",
    questionId: "q1",
    question: "How many days?",
    answer: "18",
    response: "19 days"
  });
  assert.match(prompt, /off-by-one/u);
});

test("LongMemEval answer summary counts errors as incorrect", () => {
  const summary = summarizeLongMemEvalAnswers([
    { category: "multi-session", label: true, error: null },
    { category: "multi-session", label: false, error: "API" }
  ], { answer: "gemini-3.6-flash", judge: "gemini-3.6-flash" });
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.errors, 1);
});
