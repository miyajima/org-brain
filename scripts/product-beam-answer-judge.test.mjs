import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnswerPrompt,
  buildJudgePrompt,
  summarizeBeamAnswers
} from "./product-beam-answer-judge.mjs";

test("BEAM answer prompt receives context and question but no scorer labels", () => {
  const prompt = buildAnswerPrompt({
    context: "user: The launch is Tuesday.",
    question: "When is the launch?",
    rubric: ["Must say Tuesday"],
    ideal_response: "Tuesday",
    expected_message_ids: ["gold-1"]
  });
  assert.match(prompt, /The launch is Tuesday/u);
  assert.match(prompt, /When is the launch/u);
  assert.doesNotMatch(prompt, /Must say Tuesday|ideal_response|gold-1/u);
});

test("BEAM judge prompt evaluates exactly one rubric item", () => {
  const prompt = buildJudgePrompt({
    question: "When is the launch?",
    rubricItem: "The response states Tuesday.",
    response: "Tuesday."
  });
  assert.match(prompt, /The response states Tuesday/u);
  assert.match(prompt, /Tuesday\./u);
  assert.match(prompt, /0\.5/u);
});

test("BEAM answer summary retains errors and averages rubric items", () => {
  const summary = summarizeBeamAnswers([
    {
      category: "factual",
      error: null,
      judgments: [{ score: 1 }, { score: 0.5 }]
    },
    {
      category: "factual",
      error: "API failure",
      judgments: []
    }
  ], {
    chatSize: "500K",
    models: { answer: "gemini-3.6-flash", judge: "gemini-3.6-flash" }
  });
  assert.equal(summary.question_count, 2);
  assert.equal(summary.completed_questions, 1);
  assert.equal(summary.rubric_score, 0.75);
  assert.equal(summary.errors, 1);
});
