import assert from "node:assert/strict";
import test from "node:test";
import { buildVerifiedKnowledgeGoldenSet, VERIFIED_GOLDEN_COHORTS } from "./verified-knowledge-golden.mjs";

test("verified golden set is deterministic and has the planned cohorts", () => {
  const first = buildVerifiedKnowledgeGoldenSet();
  const second = buildVerifiedKnowledgeGoldenSet();
  assert.deepEqual(first, second);
  assert.equal(first.case_count, 100);
  assert.deepEqual(first.cohorts, VERIFIED_GOLDEN_COHORTS);
  assert.equal(first.cases.filter((item) => item.expected_state === "active").length, 55);
  assert.equal(first.cases.filter((item) => item.expected_state === "verified_draft").length, 20);
  assert.equal(first.cases.filter((item) => item.expected_state === "extractor_disagreement").length, 15);
  assert.equal(first.cases.filter((item) => item.expected_state === "quarantined").length, 10);
  assert.ok(first.cases.every((item) => item.session.events.every((event) => !event.text.includes("real-user"))));
});
