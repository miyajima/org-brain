import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnswerPrompt,
  buildContext,
  buildJudgePrompt,
  flattenMessages,
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

test("BEAM answer context supports 10M plan-grouped batches", () => {
  const turns = flattenMessages([
    {
      "plan-1": [{
        batch_number: 1,
        turns: [[
          { id: 101, role: "user", content: "The launch is Tuesday." },
          { id: 102, role: "assistant", content: "Noted." }
        ]]
      }]
    },
    {
      "plan-2": [{
        batch_number: 1,
        turns: [[
          { id: 201, role: "user", content: "The venue is Tokyo." }
        ]]
      }]
    }
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].turn_id, "plan-1-batch-1-turn-1");
  assert.equal(turns[1].turn_id, "plan-2-batch-1-turn-1");
  assert.equal(buildContext(turns, ["201"]), "user: The venue is Tokyo.");
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
