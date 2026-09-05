#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractDurableMemoryDrafts } from "../packages/shared/src/memory-capture-v2-runtime.mjs";
import { routeTurnEvidence } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import {
  sanitizeMemoryExtractionReviewCase,
  sanitizeMemoryExtractionReviewText
} from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";
import {
  DEFAULT_CALIBRATION_QUOTAS,
  DEFAULT_LOCKED_QUOTAS
} from "./memory-extraction-evaluation-bundle.mjs";
import { validateEvaluationBundle } from "./memory-extraction-evaluation-bundle-validate.mjs";

export const RUNTIME_EVALUATION_CONTRACT = "orgbrain-memory-extraction-runtime-evaluation/v2";
export const ANNOTATION_CONTRACT = "orgbrain-memory-extraction-annotations/v1";
const PHASES = ["calibration", "locked"];
const OUTCOMES = new Set(["candidate", "no_candidate", "episode_fragment", "hard_excluded"]);
const LESSON_TYPES = new Set(["decision", "failure", "success"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const USEFULNESS = new Set(["durable_memory", "operational_history_only", "not_useful", "excluded"]);

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function assert(condition, reason) {
  if (!condition) throw new Error(`runtime_evaluation_invalid:${reason}`);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
}

function binaryMetrics(rows, gold, predicted) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const actual = Boolean(gold(row));
    const guess = Boolean(predicted(row));
    if (actual && guess) tp += 1;
    else if (!actual && guess) fp += 1;
    else if (actual && !guess) fn += 1;
    else tn += 1;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1: f1(precision, recall),
    accuracy: ratio(tp + tn, rows.length),
    support_positive: tp + fn,
    support_negative: tn + fp
  };
}

function observedAt(caseItem, fallback) {
  const values = caseItem.turns
    .map((turn) => Date.parse(turn.observed_at ?? ""))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : Date.parse(fallback);
}

export function buildEpisodeText(caseItem) {
  return sanitizeMemoryExtractionReviewCase(caseItem).turns.map((turn) => turn.content).join("\n\n");
}

function exactDraftSpans(content, turns) {
  const needle = String(content ?? "").trim();
  if (!needle) return [];
  const matches = [];
  for (const turn of turns) {
    let start = turn.content.indexOf(needle);
    while (start >= 0) {
      matches.push({ turn_id: turn.id, start, end: start + needle.length });
      start = turn.content.indexOf(needle, start + 1);
    }
  }
  return matches;
}

function spansOverlap(left, right) {
  return left.turn_id === right.turn_id && Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function normalizedAnnotationSpans(caseItem, annotation) {
  const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
  const turns = new Map(reviewCase.turns.map((turn) => [turn.id, turn]));
  return annotation.evidence_spans.map((span) => {
    const turn = turns.get(span.turn_id);
    assert(turn, `annotation_turn:${caseItem.id}:${span.turn_id}`);
    assert(Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start, `annotation_offsets:${caseItem.id}`);
    if (turn.content.slice(span.start, span.end) === span.quote) {
      return { turn_id: span.turn_id, quote: span.quote, start: span.start, end: span.end, rebased: false };
    }
    const legacyHumanSpan = !annotation.ai_assistance && (span.basis === undefined || span.basis === "frozen_source");
    assert(legacyHumanSpan, `annotation_sanitized_offset:${caseItem.id}:${span.turn_id}`);
    const sanitizedQuote = sanitizeMemoryExtractionReviewText(span.quote);
    const start = turn.content.indexOf(sanitizedQuote);
    assert(start >= 0 && start === turn.content.lastIndexOf(sanitizedQuote), `annotation_quote:${caseItem.id}:${span.turn_id}`);
    return { turn_id: span.turn_id, quote: sanitizedQuote, start, end: start + sanitizedQuote.length, rebased: true };
  });
}

export function annotationUsefulness(annotation, caseItem) {
  if (USEFULNESS.has(annotation.usefulness)) return annotation.usefulness;
  const note = String(annotation.note ?? "");
  if (annotation.outcome === "episode_fragment") return "operational_history_only";
  if (annotation.outcome === "hard_excluded") return "excluded";
  if (/有用性:\s*時系列・再発防止には有用だが永続化対象外/u.test(note)
    || /永続化対象ではない|永続すべき[^。\n]*ない/u.test(note)) return "operational_history_only";
  if (annotation.ai_assistance && caseItem.ai_draft
    && annotation.ai_assistance.source_hash === caseItem.source_hash
    && USEFULNESS.has(caseItem.ai_draft.usefulness)) return caseItem.ai_draft.usefulness;
  if (annotation.outcome === "candidate") return "durable_memory";
  if (annotation.outcome === "no_candidate") return "not_useful";
  return null;
}

export function annotationUsefulnessSource(annotation, caseItem) {
  if (USEFULNESS.has(annotation.usefulness)) return "reviewer_annotation";
  if (/有用性:|永続化対象ではない|永続すべき[^。\n]*ない/u.test(String(annotation.note ?? ""))) {
    return "legacy_reviewer_note";
  }
  if (annotation.ai_assistance && caseItem.ai_draft
    && annotation.ai_assistance.source_hash === caseItem.source_hash
    && USEFULNESS.has(caseItem.ai_draft.usefulness)) return "confirmed_ai_draft";
  return "legacy_outcome_default";
}

function predictedDecision(row) {
  return row.prediction.kinds.some((kind) => ["decision", "constraint", "preference"].includes(kind));
}

function predictedFailure(row) {
  return row.prediction.kinds.includes("pitfall");
}

function phaseSummary(rows) {
  const candidateDetection = binaryMetrics(
    rows,
    (row) => row.gold.usefulness === "durable_memory",
    (row) => row.prediction.candidate
  );
  const hardExclusion = binaryMetrics(
    rows,
    (row) => row.gold.outcome === "hard_excluded",
    (row) => row.prediction.hard_excluded
  );
  const decisionDetection = binaryMetrics(
    rows,
    (row) => row.gold.lesson_types.includes("decision"),
    predictedDecision
  );
  const failureDetection = binaryMetrics(
    rows,
    (row) => row.gold.lesson_types.includes("failure"),
    predictedFailure
  );
  const goldSuccess = rows.filter((row) => row.gold.lesson_types.includes("success"));
  const operationalHistory = rows.filter((row) => row.gold.usefulness === "operational_history_only");
  const fragments = rows.filter((row) => row.gold.outcome === "episode_fragment");
  const noCandidates = rows.filter((row) => row.gold.outcome === "no_candidate");
  const predictedDrafts = rows.flatMap((row) => row.prediction.drafts);
  const exactDrafts = predictedDrafts.filter((draft) => draft.source_spans.length > 0);
  const goldEvidenceCases = rows.filter((row) => row.gold.evidence_spans.length > 0);
  const overlappingEvidenceCases = goldEvidenceCases.filter((row) =>
    row.prediction.drafts.some((draft) =>
      draft.source_spans.some((sourceSpan) => row.gold.evidence_spans.some((goldSpan) => spansOverlap(sourceSpan, goldSpan)))
    )
  );
  const routerDurableGate = binaryMetrics(
    rows,
    (row) => row.gold.usefulness === "durable_memory",
    (row) => row.prediction.router.decisions?.durable_candidate === true
  );
  const routerOperationalHistory = binaryMetrics(
    rows,
    (row) => row.gold.usefulness === "operational_history_only",
    (row) => row.prediction.router.decisions?.operational_history === true
  );
  const routerHardExclusion = binaryMetrics(
    rows,
    (row) => row.gold.usefulness === "excluded",
    (row) => row.prediction.router.decisions?.hard_excluded === true
  );
  return {
    cases: rows.length,
    gold_outcomes: Object.fromEntries([...OUTCOMES].map((outcome) => [outcome, rows.filter((row) => row.gold.outcome === outcome).length])),
    predicted_candidate_cases: rows.filter((row) => row.prediction.candidate).length,
    predicted_drafts: predictedDrafts.length,
    candidate_detection: candidateDetection,
    hard_exclusion_detection: hardExclusion,
    ai_assisted_operational_history_false_positive_rate: ratio(
      operationalHistory.filter((row) => row.prediction.candidate).length,
      operationalHistory.length
    ),
    ai_assisted_operational_history_support: operationalHistory.length,
    no_candidate_false_positive_rate: ratio(
      noCandidates.filter((row) => row.prediction.candidate).length,
      noCandidates.length
    ),
    fragment_false_positive_rate: ratio(
      fragments.filter((row) => row.prediction.candidate).length,
      fragments.length
    ),
    lesson_type_proxy: {
      decision_family: decisionDetection,
      failure_pitfall: failureDetection,
      success_extraction_recall: ratio(
        goldSuccess.filter((row) => row.prediction.candidate).length,
        goldSuccess.length
      ),
      success_support: goldSuccess.length,
      note: "The runtime taxonomy has no success kind. Success is measured only as candidate extraction; decision maps to decision/constraint/preference and failure maps to pitfall."
    },
    grounding: {
      exact_source_drafts: exactDrafts.length,
      total_drafts: predictedDrafts.length,
      exact_source_rate: ratio(exactDrafts.length, predictedDrafts.length),
      gold_evidence_cases: goldEvidenceCases.length,
      overlapping_evidence_cases: overlappingEvidenceCases.length,
      gold_evidence_case_coverage: ratio(overlappingEvidenceCases.length, goldEvidenceCases.length)
    },
    router: {
      disposition_counts: Object.fromEntries(["hard_excluded", "discard", "operational_history", "llm_candidate"]
        .map((disposition) => [disposition, rows.filter((row) => row.prediction.router.disposition === disposition).length])),
      durable_gate: routerDurableGate,
      operational_history: routerOperationalHistory,
      hard_exclusion: routerHardExclusion,
      llm_call_rate: ratio(rows.filter((row) => row.prediction.router.llm_recommended === true).length, rows.length),
      operational_history_rate: ratio(rows.filter((row) => row.prediction.router.operational_history_recommended === true).length, rows.length),
      joint_durable_operational_rate: ratio(rows.filter((row) =>
        row.prediction.router.decisions?.durable_candidate === true
        && row.prediction.router.decisions?.operational_history === true).length, rows.length),
      short_circuit_rate: ratio(rows.filter((row) => row.prediction.router.llm_recommended !== true).length, rows.length)
    },
    errors: rows.filter((row) => row.error).length
  };
}

function errorAnalysis(rows) {
  const falseNegatives = rows.filter((row) => row.gold.usefulness === "durable_memory" && !row.prediction.candidate);
  const falsePositives = rows.filter((row) => row.gold.usefulness !== "durable_memory" && row.prediction.candidate);
  const hardExclusionMisses = rows.filter((row) => row.gold.outcome === "hard_excluded" && !row.prediction.hard_excluded);
  const kinds = rows.flatMap((row) => row.prediction.kinds);
  return {
    candidate_false_negatives: falseNegatives.length,
    candidate_false_positives: falsePositives.length,
    hard_exclusion_misses: hardExclusionMisses.length,
    false_negatives_by_cohort: Object.fromEntries([...new Set(rows.map((row) => row.cohort))].sort().map((cohort) => [cohort, falseNegatives.filter((row) => row.cohort === cohort).length])),
    false_positives_by_gold_outcome: Object.fromEntries([...OUTCOMES].filter((outcome) => outcome !== "candidate").map((outcome) => [outcome, falsePositives.filter((row) => row.gold.outcome === outcome).length])),
    predicted_kind_counts: Object.fromEntries([...new Set(kinds)].sort().map((kind) => [kind, kinds.filter((item) => item === kind).length])),
    case_lists_file: "runtime-evaluation-cases.jsonl"
  };
}

export function validateAnnotationExport(bundle, annotationExport) {
  assert(annotationExport && typeof annotationExport === "object" && !Array.isArray(annotationExport), "annotations_root");
  assert(annotationExport.contract === ANNOTATION_CONTRACT, "annotations_contract");
  assert(annotationExport.set_id === bundle.set_id, "set_id_mismatch");
  assert(annotationExport.annotations && typeof annotationExport.annotations === "object" && !Array.isArray(annotationExport.annotations), "annotations_object");
  const expected = new Set(bundle.cases.map((item) => item.id));
  const actual = Object.keys(annotationExport.annotations);
  assert(actual.length === expected.size, `annotation_count:${actual.length}/${expected.size}`);
  for (const caseItem of bundle.cases) {
    const annotation = annotationExport.annotations[caseItem.id];
    assert(annotation && typeof annotation === "object", `annotation_missing:${caseItem.id}`);
    assert(annotation.case_id === caseItem.id, `annotation_case_id:${caseItem.id}`);
    assert(OUTCOMES.has(annotation.outcome), `annotation_outcome:${caseItem.id}`);
    assert(Array.isArray(annotation.lesson_types), `annotation_lesson_types:${caseItem.id}`);
    assert(annotation.lesson_types.every((item) => LESSON_TYPES.has(item)), `annotation_lesson_type:${caseItem.id}`);
    assert(Array.isArray(annotation.evidence_spans), `annotation_evidence:${caseItem.id}`);
    assert(CONFIDENCE_LEVELS.has(annotation.confidence), `annotation_confidence:${caseItem.id}`);
    const usefulness = annotationUsefulness(annotation, caseItem);
    assert(USEFULNESS.has(usefulness), `annotation_usefulness:${caseItem.id}`);
    if (annotation.usefulness !== undefined) {
      if (annotation.outcome === "candidate") assert(usefulness === "durable_memory", `candidate_usefulness:${caseItem.id}`);
      if (annotation.outcome === "hard_excluded") assert(usefulness === "excluded", `excluded_usefulness:${caseItem.id}`);
      if (["no_candidate", "episode_fragment"].includes(annotation.outcome)) {
        assert(["operational_history_only", "not_useful"].includes(usefulness), `non_durable_usefulness:${caseItem.id}`);
      }
    }
    assert(typeof annotation.completed_at === "string" && Number.isFinite(Date.parse(annotation.completed_at)), `annotation_completed_at:${caseItem.id}`);
    normalizedAnnotationSpans(caseItem, annotation);
    if (annotation.outcome === "candidate") {
      assert(annotation.lesson_types.length > 0, `candidate_without_type:${caseItem.id}`);
      assert(annotation.evidence_spans.length > 0, `candidate_without_evidence:${caseItem.id}`);
    }
    if (annotation.outcome === "hard_excluded") assert(String(annotation.exclusion_reason ?? "").trim(), `exclusion_reason:${caseItem.id}`);
  }
  for (const caseId of actual) assert(expected.has(caseId), `unknown_annotation:${caseId}`);
  return { ok: true, annotations: actual.length };
}

export async function evaluateMemoryExtraction(bundle, annotationExport, options = {}) {
  validateAnnotationExport(bundle, annotationExport);
  const extractor = options.extractor ?? ((event) => extractDurableMemoryDrafts(event, {
    workspace_root: null,
    sensitive_policy: { mode: "deny", allowed_principals: [] },
    max_candidates: 3
  }));
  const rows = [];
  for (const caseItem of bundle.cases) {
    const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
    const annotation = annotationExport.annotations[caseItem.id];
    const normalizedGoldSpans = normalizedAnnotationSpans(caseItem, annotation);
    const event = {
      event_id: caseItem.id,
      tenant_id: "evaluation-local",
      project_id: caseItem.project_hash ? `hash:${caseItem.project_hash}` : null,
      source: "codex",
      occurred_at: observedAt(caseItem, bundle.frozen_at),
      text: buildEpisodeText(caseItem)
    };
    try {
      const result = await extractor(event, caseItem);
      const drafts = (result.drafts ?? []).map((draft) => ({
        kind: draft.kind,
        content: draft.content,
        summary: draft.summary,
        confidence_score: draft.confidence_score,
        source_spans: exactDraftSpans(draft.content, reviewCase.turns)
      }));
      const hardExcluded = Boolean(result.sensitivity?.hard_reject)
        || (result.excluded ?? []).some((item) => item.disposition === "hard_excluded");
      const router = routeTurnEvidence({
        snippets: reviewCase.turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content })),
        events: [],
        hard_exclusion_reason: hardExcluded
          ? (result.excluded ?? []).find((item) => item.disposition === "hard_excluded")?.reason ?? "sensitive_content"
          : null
      }, options.router_model ? { model: options.router_model } : {});
      rows.push({
        case_id: caseItem.id,
        phase: caseItem.phase,
        cohort: caseItem.cohort,
        source_hash: caseItem.source_hash,
        gold: {
          outcome: annotation.outcome,
          usefulness: annotationUsefulness(annotation, caseItem),
          usefulness_source: annotationUsefulnessSource(annotation, caseItem),
          lesson_types: [...annotation.lesson_types],
          evidence_spans: normalizedGoldSpans.map(({ turn_id, start, end, rebased }) => ({ turn_id, start, end, rebased })),
          confidence: annotation.confidence,
          ai_assisted: Boolean(annotation.ai_assistance)
        },
        prediction: {
          candidate: drafts.length > 0,
          hard_excluded: hardExcluded,
          router,
          kinds: [...new Set(drafts.map((draft) => draft.kind))].sort(),
          drafts,
          excluded_reasons: [...new Set((result.excluded ?? []).map((item) => item.reason))].sort(),
          review_draft_count: result.review_drafts?.length ?? 0
        },
        error: null
      });
    } catch (error) {
      rows.push({
        case_id: caseItem.id,
        phase: caseItem.phase,
        cohort: caseItem.cohort,
        source_hash: caseItem.source_hash,
        gold: {
          outcome: annotation.outcome,
          usefulness: annotationUsefulness(annotation, caseItem),
          usefulness_source: annotationUsefulnessSource(annotation, caseItem),
          lesson_types: [...annotation.lesson_types],
          evidence_spans: normalizedGoldSpans.map(({ turn_id, start, end, rebased }) => ({ turn_id, start, end, rebased })),
          confidence: annotation.confidence,
          ai_assisted: Boolean(annotation.ai_assistance)
        },
        prediction: {
          candidate: false,
          hard_excluded: false,
          router: {
            disposition: "discard",
            reason_codes: ["evaluation_error"],
            support_span_ids: [],
            score: 0,
            llm_recommended: false,
            operational_history_recommended: false,
            decisions: { hard_excluded: false, durable_candidate: false, operational_history: false },
            probabilities: { durable_candidate: 0, operational_history: 0 }
          },
          kinds: [], drafts: [], excluded_reasons: [], review_draft_count: 0
        },
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const semanticRows = rows.filter((row) => row.gold.usefulness !== "excluded");
  const summaries = Object.fromEntries(PHASES.map((phase) => [phase, phaseSummary(rows.filter((row) => row.phase === phase))]));
  const semanticSummaries = Object.fromEntries(PHASES.map((phase) => [phase, phaseSummary(semanticRows.filter((row) => row.phase === phase))]));
  return {
    report: {
      contract: RUNTIME_EVALUATION_CONTRACT,
      set_id: bundle.set_id,
      generated_at: options.generatedAt ?? new Date().toISOString(),
      extractor: {
        id: options.router_model?.schema === "memory-extraction-router-model/v3"
          ? "hierarchical-router-v3-plus-durable-rules-v2"
          : "multilabel-calibrated-router-v2-plus-durable-rules-v2",
        implementation: "packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs + packages/shared/src/memory-capture-v2-runtime.mjs",
        input_projection: "deduplicated sanitized turn contents joined in chronological order",
        max_candidates: 3,
        persistence_performed: false,
        external_network: false
      },
      inputs: {
        bundle_sha256: sha256(stableJson(bundle)),
        annotations_sha256: sha256(stableJson(annotationExport)),
        cases: rows.length,
        human_only: rows.filter((row) => !row.gold.ai_assisted).length,
        ai_assisted_confirmed: rows.filter((row) => row.gold.ai_assisted).length
      },
      overall: phaseSummary(rows),
      phases: summaries,
      semantic_overall: phaseSummary(semanticRows),
      semantic_phases: semanticSummaries,
      segments: {
        human_only: phaseSummary(rows.filter((row) => !row.gold.ai_assisted)),
        ai_assisted_confirmed: phaseSummary(rows.filter((row) => row.gold.ai_assisted))
      },
      error_analysis: errorAnalysis(rows),
      evaluation_policy: {
        calibration_cases: rows.filter((row) => row.phase === "calibration").length,
        locked_cases: rows.filter((row) => row.phase === "locked").length,
        threshold_tuning_performed: true,
        threshold_tuning_split: "calibration_only",
        locked_predictions_used_for_tuning: false,
        formal_certification: false,
        local_acceptance_targets: {
          router_durable_recall_min: 0.95,
          router_llm_call_rate_max: 0.5,
          router_operational_history_f1_min: 0.75
        },
        sanitized_hard_exclusion_evaluable: false,
        development_shadow_only: true,
        production_readiness_claimed: false,
        metric_provenance: {
          candidate_detection: "exported reviewer annotation",
          ai_assisted_operational_history_false_positive_rate: "explicit reviewer usefulness label, with confirmed AI draft fallback for legacy exports"
        },
        limitations: [
          "Single-reviewer labels include AI-assisted confirmations and are provisional, not certified gold.",
          "Sanitized cases cannot measure hard-exclusion recall; safety is evaluated on a separately hash-fixed synthetic fixture.",
          "The human success label has no one-to-one runtime kind and is reported as extraction recall only.",
          "Exact ideal memory text is not annotated, so semantic rewrite quality and canonical-key quality are not scored."
        ]
      }
    },
    rows
  };
}

export function renderMarkdown(report) {
  const locked = report.phases.locked;
  const semanticLocked = report.semantic_phases.locked;
  const show = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Memory extraction runtime evaluation",
    "",
    `- Set: \`${report.set_id}\``,
    `- Cases: ${report.inputs.cases} (${report.inputs.human_only} human-only, ${report.inputs.ai_assisted_confirmed} AI-assisted confirmed)`,
    `- Extractor: \`${report.extractor.id}\``,
    "- Persistence: none (local read-only evaluation)",
    "",
    "| Phase | Cases | Precision | Recall | F1 | Accuracy | AI-assisted operational-history FP | Exact source grounding |",
    "|---|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const phase of PHASES) {
    const item = report.phases[phase];
    lines.push(`| ${phase} | ${item.cases} | ${show(item.candidate_detection.precision)} | ${show(item.candidate_detection.recall)} | ${show(item.candidate_detection.f1)} | ${show(item.candidate_detection.accuracy)} | ${show(item.ai_assisted_operational_history_false_positive_rate)} | ${show(item.grounding.exact_source_rate)} |`);
  }
  lines.push(
    "",
    "## Router stage",
    "",
    "The semantic rows below exclude `excluded`; sanitized data does not measure safety recall.",
    "",
    "| Phase | Durable recall | Durable precision | Operational F1 | LLM call rate | Joint route rate |",
    "|---|---:|---:|---:|---:|---:|"
  );
  for (const phase of PHASES) {
    const item = report.semantic_phases[phase].router;
    lines.push(`| ${phase} | ${show(item.durable_gate.recall)} | ${show(item.durable_gate.precision)} | ${show(item.operational_history.f1)} | ${show(item.llm_call_rate)} | ${show(item.joint_durable_operational_rate)} |`);
  }
  lines.push(
    "",
    "## Locked findings",
    "",
    `- Candidate false negatives: ${locked.candidate_detection.fn} / ${locked.candidate_detection.support_positive}`,
    `- Candidate false positives: ${locked.candidate_detection.fp} / ${locked.candidate_detection.support_negative}`,
    "- Hard-exclusion recall: not evaluated on sanitized cases (see synthetic safety fixture)",
    `- Semantic router durable recall: ${show(semanticLocked.router.durable_gate.recall)}`,
    `- Semantic router operational-history F1: ${show(semanticLocked.router.operational_history.f1)}`,
    `- AI-assisted operational-history false-positive rate: ${show(locked.ai_assisted_operational_history_false_positive_rate)} (${locked.ai_assisted_operational_history_support} confirmed-AI usefulness labels; human-only cases excluded)`,
    `- Exact source grounding: ${show(locked.grounding.exact_source_rate)} (${locked.grounding.exact_source_drafts} / ${locked.grounding.total_drafts} drafts)`,
    `- Human evidence overlap coverage: ${show(locked.grounding.gold_evidence_case_coverage)} (${locked.grounding.overlapping_evidence_cases} / ${locked.grounding.gold_evidence_cases} cases)`,
    "",
    "## Interpretation boundary",
    "",
    "Calibration and locked metrics are reported separately. Logistic weights and thresholds are fit only on calibration; locked predictions are not used for tuning. These labels are provisional single-reviewer labels; this report is not formal certification.",
    "",
    "The runtime has no `success` kind. Success is therefore measured as candidate extraction recall only. Ideal rewritten memory text is not annotated, so semantic rewrite and canonical-key quality remain unscored. Safety results come only from the separately fixed synthetic fixture.",
    ""
  );
  return lines.join("\n");
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export async function main(argv = process.argv.slice(2)) {
  const bundlePath = path.resolve(option(argv, "--bundle") ?? "");
  const annotationsPath = path.resolve(option(argv, "--annotations") ?? "");
  const outputDir = path.resolve(option(argv, "--output-dir") ?? "");
  const routerModelPath = option(argv, "--router-model");
  assert(option(argv, "--bundle"), "bundle_required");
  assert(option(argv, "--annotations"), "annotations_required");
  assert(option(argv, "--output-dir"), "output_dir_required");
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const annotations = JSON.parse(fs.readFileSync(annotationsPath, "utf8"));
  const routerModelDocument = routerModelPath ? JSON.parse(fs.readFileSync(path.resolve(routerModelPath), "utf8")) : null;
  const routerModel = routerModelDocument?.model ?? routerModelDocument;
  validateEvaluationBundle(bundle, {
    expectedTotal: 500,
    expectedPhaseQuotas: { calibration: DEFAULT_CALIBRATION_QUOTAS, locked: DEFAULT_LOCKED_QUOTAS }
  });
  const result = await evaluateMemoryExtraction(bundle, annotations, routerModel ? { router_model: routerModel } : {});
  const reportPath = path.join(outputDir, "runtime-evaluation-report.json");
  const casesPath = path.join(outputDir, "runtime-evaluation-cases.jsonl");
  const summaryPath = path.join(outputDir, "runtime-evaluation-summary.md");
  writePrivate(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  writePrivate(casesPath, `${result.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writePrivate(summaryPath, renderMarkdown(result.report));
  process.stdout.write(`${JSON.stringify({ ok: true, report: reportPath, cases: casesPath, summary: summaryPath, phases: result.report.phases })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
