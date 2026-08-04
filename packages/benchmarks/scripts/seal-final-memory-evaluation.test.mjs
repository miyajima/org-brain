import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_EVALUATION_QUOTAS,
  buildFinalEvaluationSeal
} from "./seal-final-memory-evaluation.mjs";

function dataset() {
  return Object.entries(FINAL_EVALUATION_QUOTAS).flatMap(([category, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${category}-${index}`,
      category,
      question: `Question ${category} ${index}`,
      answer: `Answer ${category} ${index}`,
      evidence_session_ids: [`session-${category}-${index}`],
      audit: {
        question_verified: true,
        answer_verified: true,
        evidence_verified: true,
        reviewer: "independent-reviewer",
        reviewed_at: "2026-07-31T00:00:00Z"
      }
    }))
  );
}

test("final 200 seal enforces quotas, audit, and development isolation", () => {
  const rows = dataset();
  const seal = buildFinalEvaluationSeal(rows, new Set(["development-only"]), {
    sealedAt: "2026-07-31T00:00:00Z"
  });
  assert.equal(seal.question_count, 200);
  assert.equal(seal.development_overlap, 0);
  assert.match(seal.dataset_sha256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => buildFinalEvaluationSeal(rows, new Set([rows[0].id])),
    /development overlap/u
  );
  const unaudited = structuredClone(rows);
  unaudited[0].audit.evidence_verified = false;
  assert.throws(
    () => buildFinalEvaluationSeal(unaudited, new Set()),
    /independent audit is incomplete/u
  );
});
