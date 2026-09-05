import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEpisodeText,
  evaluateMemoryExtraction,
  renderMarkdown,
  validateAnnotationExport
} from "./memory-extraction-runtime-evaluate.mjs";

function fixture() {
  const candidateText = "方針として必ず固定セットを使う。";
  const noCandidateText = "テストを実行しました。";
  const bundle = {
    contract: "orgbrain-memory-extraction-evaluation/v1",
    set_id: "set-1",
    frozen_at: "2026-09-04T00:00:00.000Z",
    cases: [
      {
        id: "case-1",
        phase: "calibration",
        cohort: "decision",
        project_hash: "a".repeat(64),
        source_hash: "sha256:source-1",
        turns: [{ id: "s1", role: "assistant", content: candidateText, observed_at: "2026-09-03T00:00:00.000Z" }]
      },
      {
        id: "case-2",
        phase: "locked",
        cohort: "non_durable",
        project_hash: "b".repeat(64),
        source_hash: "sha256:source-2",
        turns: [{ id: "s1", role: "assistant", content: noCandidateText, observed_at: "2026-09-03T00:00:00.000Z" }],
        ai_draft: { usefulness: "operational_history_only" }
      }
    ]
  };
  const annotations = {
    contract: "orgbrain-memory-extraction-annotations/v1",
    set_id: "set-1",
    annotations: {
      "case-1": {
        case_id: "case-1",
        outcome: "candidate",
        usefulness: "durable_memory",
        lesson_types: ["decision"],
        evidence_spans: [{ turn_id: "s1", quote: candidateText, start: 0, end: candidateText.length }],
        exclusion_reason: "",
        confidence: "high",
        completed_at: "2026-09-04T00:10:00.000Z"
      },
      "case-2": {
        case_id: "case-2",
        outcome: "no_candidate",
        usefulness: "operational_history_only",
        lesson_types: [],
        evidence_spans: [],
        exclusion_reason: "",
        confidence: "medium",
        completed_at: "2026-09-04T00:10:00.000Z",
        ai_assistance: { source_hash: "sha256:source-2" }
      }
    }
  };
  return { bundle, annotations, candidateText, noCandidateText };
}

test("evaluates calibration and locked cases separately without tuning locked predictions", async () => {
  const { bundle, annotations, candidateText } = fixture();
  const result = await evaluateMemoryExtraction(bundle, annotations, {
    generatedAt: "2026-09-04T01:00:00.000Z",
    extractor: async (_event, caseItem) => caseItem.id === "case-1"
      ? {
          drafts: [{ kind: "decision", content: candidateText, summary: "Decision", confidence_score: 0.9 }],
          review_drafts: [],
          excluded: [],
          sensitivity: { hard_reject: false }
        }
      : { drafts: [], review_drafts: [], excluded: [], sensitivity: { hard_reject: false } }
  });
  assert.equal(result.report.phases.calibration.candidate_detection.f1, 1);
  assert.equal(result.report.phases.locked.candidate_detection.accuracy, 1);
  assert.equal(result.report.phases.locked.ai_assisted_operational_history_false_positive_rate, 0);
  assert.equal(result.report.phases.calibration.grounding.gold_evidence_case_coverage, 1);
  assert.equal(result.report.phases.calibration.router.durable_gate.recall, 1);
  assert.equal(result.report.phases.locked.router.operational_history.recall, 1);
  assert.equal(result.report.phases.locked.router.llm_call_rate, 0);
  assert.equal(result.report.evaluation_policy.threshold_tuning_performed, true);
  assert.equal(result.report.evaluation_policy.threshold_tuning_split, "calibration_only");
  assert.equal(result.report.evaluation_policy.locked_predictions_used_for_tuning, false);
  assert.match(renderMarkdown(result.report), /calibration/u);
});

test("fails closed on missing annotations and invalid exact spans", () => {
  const { bundle, annotations } = fixture();
  delete annotations.annotations["case-2"];
  assert.throws(() => validateAnnotationExport(bundle, annotations), /annotation_count/u);
  const next = fixture();
  next.annotations.annotations["case-1"].evidence_spans[0].quote = "invented";
  assert.throws(() => validateAnnotationExport(next.bundle, next.annotations), /annotation_quote/u);
});

test("rebases a unique legacy human span onto the shared sanitized review text", () => {
  const { bundle, annotations } = fixture();
  bundle.cases[0].turns[0].content = "方針として必ず `rules.ts` を使う。";
  annotations.annotations["case-1"].evidence_spans = [{
    turn_id: "s1",
    quote: "方針として必ず `rules.ts` を使う。",
    start: 0,
    end: 24
  }];
  assert.doesNotThrow(() => validateAnnotationExport(bundle, annotations));
});

test("rejects stale sanitized AI offsets and incomplete confidence metadata", () => {
  const { bundle, annotations } = fixture();
  bundle.cases[0].turns[0].content = "方針として必ず `rules.ts` を使う。";
  annotations.annotations["case-1"].ai_assistance = { source_hash: "sha256:source-1" };
  annotations.annotations["case-1"].evidence_spans = [{
    turn_id: "s1",
    quote: "方針として必ず `rules.ts` を使う。",
    start: 0,
    end: 24,
    basis: "sanitized_review_text_v1"
  }];
  assert.throws(() => validateAnnotationExport(bundle, annotations), /annotation_sanitized_offset/u);
  const next = fixture();
  next.annotations.annotations["case-1"].confidence = null;
  assert.throws(() => validateAnnotationExport(next.bundle, next.annotations), /annotation_confidence/u);
});

test("joins deduplicated sanitized turns in chronological bundle order", () => {
  const { bundle } = fixture();
  bundle.cases[0].turns.push({ id: "s2", role: "user", content: "次へ。詳細は `rules.ts`。" });
  assert.equal(buildEpisodeText(bundle.cases[0]), "方針として必ず固定セットを使う。\n\n次へ。詳細は 対象ファイル。");
});
