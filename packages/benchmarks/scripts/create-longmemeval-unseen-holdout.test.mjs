import assert from "node:assert/strict";
import test from "node:test";
import { selectUnseenQuestions } from "./create-longmemeval-unseen-holdout.mjs";

test("unseen holdout selection excludes public questions and is deterministic", () => {
  const questions = [
    { question_id: "public", question_type: "single_hop" },
    { question_id: "candidate-a", question_type: "single_hop" },
    { question_id: "candidate-b", question_type: "single_hop" }
  ];
  const quotas = { "single-session-user": 1 };
  const first = selectUnseenQuestions(questions, new Set(["public"]), () => true, "seed", quotas);
  const second = selectUnseenQuestions(questions, new Set(["public"]), () => true, "seed", quotas);
  assert.deepEqual(first, second);
  assert.notEqual(first[0].question_id, "public");
});
