#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { readFileSync } from "node:fs";
import { verifiedCandidates } from "../packages/shared/src/memory-extraction-verifier-runtime.mjs";
import {
  coverageCandidateFingerprint,
  mergeCoverageCandidates,
  validateCoverageCandidate
} from "../packages/shared/src/memory-extraction-coverage-runtime.mjs";

const EXPECTED = Object.freeze({
  tune: { decision: 15, failure: 15, success: 15, non_persistent: 30, total: 75 },
  fixed: { decision: 75, failure: 75, success: 75, non_persistent: 200, total: 425 }
});
const TAGS = ["negation", "retraction", "condition", "failure"];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stableValue(value))).digest("hex");
}

async function variantCandidates(testCase, variant) {
  const passes = testCase.variants?.[variant]?.passes ?? [];
  const successful = [];
  for (const pass of passes) {
    if (pass.status !== "succeeded" || !Array.isArray(pass.candidates)) { successful.push([]); continue; }
    const packet = pass.packet ?? testCase.packet;
    const verified = await verifiedCandidates({ packet: { ...packet, schema: packet.schema ?? "learning-extraction-proposal/v2" },
      extraction_profile: variant === "A" ? null : "coverage/v1", project_id: testCase.project_id ?? packet.project_id,
      run_id: testCase.id }, pass.candidates);
    successful.push(verified.accepted_indices.map((index) => pass.candidates[index]));
  }
  const merged = variant === "C" ? mergeCoverageCandidates(successful, {
    priority_by_span: Object.fromEntries((testCase.packet.coverage?.groups ?? []).flatMap((g) => g.span_ids.map((id) => [id, g.priority]))),
    signal_by_span: Object.fromEntries((testCase.packet.coverage?.groups ?? []).flatMap((g) => g.span_ids.map((id) => [id, g.review_signal_score ?? 0]))),
    order_by_span: Object.fromEntries((testCase.packet.snippets ?? []).map((s) => [s.span_id, s.order ?? 0]))
  }).candidates : successful.flat().slice(0, 3);
  const finalPacket = variant === "A" ? (passes[0]?.packet ?? testCase.packet) : testCase.packet;
  const final = await verifiedCandidates({ packet: { ...finalPacket, schema: finalPacket.schema ?? "learning-extraction-proposal/v2" },
    extraction_profile: variant === "A" ? null : "coverage/v1", project_id: testCase.project_id ?? testCase.packet.project_id, run_id: testCase.id }, merged);
  return final.accepted_indices.map((index) => merged[index]);
}

export function coverageFreezeManifest(dataset) {
  const digestFiles = (files) => `sha256:${sha256(files.map((file) => [file, readFileSync(new URL(file, import.meta.url), "utf8")]))}`;
  return {
    code: digestFiles(["../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs", "../packages/orgbrain-cli/src/lib/coverage-review-signals.mjs", "../apps/cap-runner/src/capabilities/memory-extraction.ts", "./memory-extraction-coverage-evaluate.mjs"]),
    prompt: digestFiles(["../packages/shared/src/memory-extraction-provider-contract-runtime.mjs"]),
    verifier: digestFiles(["../packages/shared/src/memory-extraction-verifier-runtime.mjs", "../packages/shared/src/memory-contract-v2-runtime.mjs"]),
    execution_policy: digestFiles(["../packages/shared/src/memory-extraction-coverage-runtime.mjs"]),
    model_configuration: `sha256:${sha256((dataset.cases ?? []).map((c) => [c.id, c.provider, c.model, c.reasoning_effort]))}`,
    data: `sha256:${sha256((dataset.cases ?? []).map(({ variants, gold, ...input }) => input))}`,
    labels: `sha256:${sha256((dataset.cases ?? []).map((c) => [c.id, c.gold]))}`
  };
}

function usageFor(testCase, variant) {
  const passes = Array.isArray(testCase.variants?.[variant]?.passes) ? testCase.variants[variant].passes : [];
  if (passes.some((pass) => pass.status !== "skipped" && (!Number.isFinite(pass.usage?.input_tokens) || !Number.isFinite(pass.usage?.output_tokens) || pass.usage.input_tokens < 0 || pass.usage.output_tokens < 0))) return null;
  return passes.reduce((sum, pass) => sum + (pass.status === "skipped" ? 0 : pass.usage.input_tokens + pass.usage.output_tokens), 0);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function delta(left, right) {
  return left === null || right === null ? null : right - left;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function scoreVariant(cases, variant) {
  let candidates = 0;
  let correct = 0;
  let gold = 0;
  const matched = new Set();
  const tagTotals = Object.fromEntries(TAGS.map((tag) => [tag, 0]));
  const tagMatched = Object.fromEntries(TAGS.map((tag) => [tag, new Set()]));
  let safetyViolations = 0;
  const usages = [];
  let usageUnknown = 0;
  const durations = [];
  let secondPassCases = 0;
  let failedPasses = 0;
  const diagnostics = { input_omissions: 0, verification_rejections: 0, candidate_limit: 0, duplicates: 0 };
  for (const testCase of cases) {
    const labels = Array.isArray(testCase.gold) ? testCase.gold : [];
    gold += labels.length;
    for (const label of labels) for (const tag of TAGS) if (label.tags?.includes(tag)) tagTotals[tag] += 1;
    const judgments = new Map((testCase.variants?.[variant]?.judgments ?? []).map((judgment) => [judgment.fingerprint, judgment]));
    const variantData = testCase.variants?.[variant] ?? {};
    const passes = Array.isArray(variantData.passes) ? variantData.passes : [];
    if (passes.length > 1 && passes[1]?.status !== "skipped") secondPassCases += 1;
    failedPasses += passes.filter((pass) => ["failed", "outcome_unknown"].includes(pass.status)).length;
    const duration = passes.reduce((sum, pass) => sum + (Number.isFinite(pass.duration_ms) ? pass.duration_ms : 0), 0);
    if (passes.length > 0 && passes.every((pass) => Number.isFinite(pass.duration_ms))) durations.push(duration);
    for (const key of Object.keys(diagnostics)) diagnostics[key] += Number(variantData.diagnostics?.[key] ?? 0) || 0;
    for (const candidate of await variantCandidates(testCase, variant)) {
      candidates += 1;
      const fingerprint = coverageCandidateFingerprint(candidate);
      const structural = variant === "A" ? { valid: true } : validateCoverageCandidate(candidate, testCase.packet);
      const judgment = judgments.get(fingerprint);
      if (structural.valid && judgment?.correct === true) {
        correct += 1;
        for (const labelId of judgment.gold_ids ?? []) {
          const matchKey = `${testCase.id}:${labelId}`;
          const label = labels.find((item) => item.id === labelId);
          if (!label) continue;
          matched.add(matchKey);
          for (const tag of TAGS) if (label?.tags?.includes(tag)) tagMatched[tag].add(matchKey);
        }
      }
      safetyViolations += ["wrong_human_attribution", "fabricated_evidence", "sensitive_leak"].filter((key) => judgment?.safety?.[key] === true).length;
    }
    const usage = usageFor(testCase, variant);
    if (usage === null) usageUnknown += 1;
    else usages.push(usage);
  }
  return {
    candidate_count: candidates,
    correct_candidate_count: correct,
    gold_count: gold,
    matched_gold_count: matched.size,
    precision: ratio(correct, candidates),
    recall: ratio(matched.size, gold),
    category_recall: Object.fromEntries(TAGS.map((tag) => [tag, ratio(tagMatched[tag].size, tagTotals[tag])])),
    average_measured_tokens: usageUnknown === 0 && usages.length === cases.length ? usages.reduce((sum, value) => sum + value, 0) / Math.max(1, usages.length) : null,
    usage_unknown_cases: usageUnknown,
    safety_violations: safetyViolations,
    diagnostics: {
      ...diagnostics,
      second_pass_rate: ratio(secondPassCases, cases.length),
      failed_passes: failedPasses,
      latency_p50_ms: percentile(durations, 0.5),
      latency_p95_ms: percentile(durations, 0.95)
    }
  };
}

function expectedCounts(cases, split) {
  const counts = { decision: 0, failure: 0, success: 0, non_persistent: 0, total: cases.length };
  for (const testCase of cases) if (testCase.category in counts) counts[testCase.category] += 1;
  return { actual: counts, expected: EXPECTED[split], valid: Object.keys(EXPECTED[split]).every((key) => counts[key] === EXPECTED[split][key]) };
}

export async function evaluateCoverageDataset(dataset, options = {}) {
  if (dataset?.schema !== "memory-extraction-coverage-evaluation/v1") throw new Error("coverage_evaluation_schema_invalid");
  const sessions = new Map();
  for (const item of Array.isArray(dataset.cases) ? dataset.cases : []) {
    if (!item.session_id) continue;
    const prior = sessions.get(item.session_id);
    if (prior && prior !== item.split) throw new Error("coverage_evaluation_session_split_leak");
    sessions.set(item.session_id, item.split);
  }
  const split = options.split ?? "fixed";
  if (!(split in EXPECTED)) throw new Error("coverage_evaluation_split_invalid");
  const cases = (Array.isArray(dataset.cases) ? dataset.cases : []).filter((item) => item.split === split);
  const counts = expectedCounts(cases, split);
  const metrics = Object.fromEntries(await Promise.all(["A", "B", "C"].map(async (variant) => [variant, await scoreVariant(cases, variant)])));
  const modelGroups = new Map();
  for (const testCase of cases) {
    const key = `${testCase.provider ?? "unknown"}/${testCase.model ?? "unknown"}`;
    modelGroups.set(key, [...(modelGroups.get(key) ?? []), testCase]);
  }
  const modelMetrics = {};
  for (const [key, modelCases] of modelGroups) modelMetrics[key] = Object.fromEntries(await Promise.all(["A", "B", "C"].map(async (v) => [v, await scoreVariant(modelCases, v)])));

  const a = metrics.A;
  const c = metrics.C;
  const categoryGate = TAGS.every((tag) => a.category_recall[tag] !== null && c.category_recall[tag] !== null && c.category_recall[tag] >= a.category_recall[tag]);
  const gates = {
    recall_gain_5_points: a.recall !== null && c.recall !== null && c.recall - a.recall >= 0.05,
    precision_98_and_not_lower: a.precision !== null && c.precision !== null && c.precision >= 0.98 && c.precision >= a.precision,
    qualifier_and_failure_recall_not_lower: categoryGate,
    average_tokens_within_1_5x: a.average_measured_tokens !== null && c.average_measured_tokens !== null && c.average_measured_tokens <= a.average_measured_tokens * 1.5,
    safety_counterexamples_zero: c.safety_violations === 0,
    fixed_dataset_complete: counts.valid
  };
  let humanLabelsComplete = cases.length > 0;
  for (const item of cases) {
    const goldIds = new Set((item.gold ?? []).map((g) => g.id));
    if (item.labels_source !== "human" || goldIds.size !== (item.gold ?? []).length) humanLabelsComplete = false;
    for (const variant of ["A", "B", "C"]) {
      const judgments = item.variants?.[variant]?.judgments;
      if (!Array.isArray(judgments)) { humanLabelsComplete = false; continue; }
      const fingerprints = new Set(judgments.map((j) => j.fingerprint));
      if (fingerprints.size !== judgments.length || judgments.some((j) => typeof j.correct !== "boolean" || !Array.isArray(j.gold_ids)
        || j.gold_ids.some((id) => !goldIds.has(id)) || ["wrong_human_attribution", "fabricated_evidence", "sensitive_leak"].some((key) => typeof j.safety?.[key] !== "boolean"))) humanLabelsComplete = false;
      for (const c of await variantCandidates(item, variant)) if (!fingerprints.has(coverageCandidateFingerprint(c))) humanLabelsComplete = false;
    }
  }
  const shapeComplete = new Set(cases.map((item) => item.id)).size === cases.length && cases.every((item) => item.id && item.session_id && typeof item.provider === "string" && item.provider.length > 0 && typeof item.model === "string" && item.model.length > 0 && ["A", "B", "C"].every((variant) => {
    const passes = item.variants?.[variant]?.passes;
    if (!Array.isArray(passes) || passes.length !== (variant === "C" ? 2 : 1)) return false;
    return passes.every((pass, index) => pass.provider === item.provider && pass.model === item.model
      && pass.reasoning_effort === item.reasoning_effort
      && (pass.status !== "skipped" || (variant === "C" && index === 1))
      && ["succeeded", "failed", "outcome_unknown", "skipped"].includes(pass.status)
      && (pass.status === "skipped" || (pass.packet && Array.isArray(pass.packet.snippets) && Array.isArray(pass.packet.events))));
  }));
  const expectedFreeze = coverageFreezeManifest(dataset);
  const freezeComplete = Object.entries(expectedFreeze).every(([key, value]) => dataset.freeze?.[key] === value);

  const evaluationComplete = counts.valid && humanLabelsComplete && shapeComplete && freezeComplete
    && ["A", "B", "C"].every((variant) => metrics[variant].usage_unknown_cases === 0);
  return {
    schema: "memory-extraction-coverage-report/v1",
    split,
    status: evaluationComplete ? (Object.values(gates).every(Boolean) ? "passed" : "failed") : "evaluation_incomplete",
    counts,
    integrity: { human_labels_complete: humanLabelsComplete, session_split_valid: true, variant_shape_complete: shapeComplete, freeze_complete: freezeComplete },
    metrics,
    model_metrics: modelMetrics,
    comparisons: {
      A_to_B: {
        precision_points: delta(metrics.A.precision, metrics.B.precision),
        recall_points: delta(metrics.A.recall, metrics.B.recall),
        average_measured_tokens: delta(metrics.A.average_measured_tokens, metrics.B.average_measured_tokens)
      },
      B_to_C: {
        precision_points: delta(metrics.B.precision, metrics.C.precision),
        recall_points: delta(metrics.B.recall, metrics.C.recall),
        average_measured_tokens: delta(metrics.B.average_measured_tokens, metrics.C.average_measured_tokens)
      },
      A_to_C: {
        precision_points: delta(metrics.A.precision, metrics.C.precision),
        recall_points: delta(metrics.A.recall, metrics.C.recall),
        average_measured_tokens: delta(metrics.A.average_measured_tokens, metrics.C.average_measured_tokens)
      }
    },
    gates,
    freeze_hashes: {
      dataset: `sha256:${sha256(dataset.cases)}`,
      labels: `sha256:${sha256(dataset.cases?.map((item) => ({ id: item.id, gold: item.gold, judgments: Object.fromEntries(["A", "B", "C"].map((variant) => [variant, item.variants?.[variant]?.judgments])) })))}`,
      configuration: `sha256:${sha256(dataset.freeze ?? {})}`
    }
  };
}

async function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const input = value("--input");
  const output = value("--output");
  const split = value("--split") ?? "fixed";
  if (!input || !output) throw new Error("usage: memory-extraction-coverage-evaluate.mjs --input <private.json> --output <report.json> [--split tune|fixed]");
  const dataset = JSON.parse(await readFile(input, "utf8"));
  const report = argv.includes("--freeze-only") ? coverageFreezeManifest(dataset) : await evaluateCoverageDataset(dataset, { split });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, output, split, dataset_hash: report.freeze_hashes?.dataset }));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
