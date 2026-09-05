#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractMemoryRouterFeatures,
  routeTurnEvidence
} from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V2 } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v2.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v3.mjs";
import { sanitizeMemoryExtractionReviewCase } from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";
import { annotationUsefulness, validateAnnotationExport } from "./memory-extraction-runtime-evaluate.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function stableFold(value, count) {
  const digest = crypto.createHash("sha256").update(String(value)).digest();
  return digest.readUInt32BE(0) % count;
}

function metrics(rows, threshold) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  for (const row of rows) {
    const predicted = row.forced === true || row.probability >= threshold;
    if (row.label && predicted) tp += 1;
    else if (!row.label && predicted) fp += 1;
    else if (!row.label) tn += 1;
    else fn += 1;
  }
  const ratio = (left, right) => right === 0 ? 0 : left / right;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    tp, fp, tn, fn, precision, recall,
    f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    positive_rate: ratio(tp + fp, rows.length)
  };
}

export function fitWeightedLogistic(rows, featureNames, options = {}) {
  const iterations = options.iterations ?? 4_000;
  const learningRate = options.learning_rate ?? 0.12;
  const l2 = options.l2 ?? 0.08;
  const positives = rows.filter((row) => row.label).length;
  const negatives = rows.length - positives;
  if (positives === 0 || negatives === 0) throw new Error("router_calibration_requires_both_classes");
  const positiveWeight = rows.length / (2 * positives);
  const negativeWeight = rows.length / (2 * negatives);
  const weights = featureNames.map(() => 0);
  let intercept = Math.log(positives / negatives);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let interceptGradient = 0;
    const gradients = featureNames.map(() => 0);
    for (const row of rows) {
      const linear = weights.reduce((total, weight, index) =>
        total + weight * (row.features[featureNames[index]] ?? 0), intercept);
      const sampleWeight = row.label ? positiveWeight : negativeWeight;
      const error = (sigmoid(linear) - Number(row.label)) * sampleWeight;
      interceptGradient += error;
      for (let index = 0; index < weights.length; index += 1) {
        gradients[index] += error * (row.features[featureNames[index]] ?? 0);
      }
    }
    intercept -= learningRate * interceptGradient / rows.length;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradients[index] / rows.length + l2 * weights[index]);
    }
  }
  return { intercept, weights };
}

export function scoreRows(rows, featureNames, model) {
  return rows.map((row) => ({
    ...row,
    probability: sigmoid(featureNames.reduce((total, name, index) =>
      total + (model.weights[index] ?? 0) * (row.features[name] ?? 0), model.intercept))
  }));
}

export function selectThreshold(scoredRows, options = {}) {
  const maxPositiveRate = options.max_positive_rate ?? 1;
  const objective = options.objective ?? "f1";
  const candidates = [...new Set([0, 1, ...scoredRows.map((row) => row.probability)])].sort((a, b) => a - b);
  const feasible = candidates.map((threshold) => ({ threshold, ...metrics(scoredRows, threshold) }))
    .filter((item) => item.positive_rate <= maxPositiveRate + Number.EPSILON);
  if (feasible.length === 0) return { threshold: 1, ...metrics(scoredRows, 1) };
  return feasible.sort((left, right) => {
    if (objective === "recall") {
      return right.recall - left.recall || right.f1 - left.f1 || right.precision - left.precision || right.threshold - left.threshold;
    }
    return right.f1 - left.f1 || right.recall - left.recall || right.precision - left.precision || right.threshold - left.threshold;
  })[0];
}

function logLoss(rows) {
  if (rows.length === 0) return Number.POSITIVE_INFINITY;
  return rows.reduce((sum, row) => {
    const probability = Math.min(1 - 1e-9, Math.max(1e-9, row.probability));
    return sum - (row.label ? Math.log(probability) : Math.log(1 - probability));
  }, 0) / rows.length;
}

export function groupedOof(rows, featureNames, options = {}) {
  const foldCount = options.folds ?? 5;
  const l2Candidates = options.l2_candidates ?? [0.04, 0.08, 0.16, 0.32];
  const scoredCandidates = [];
  for (const l2 of l2Candidates) {
    const scored = [];
    for (let fold = 0; fold < foldCount; fold += 1) {
      const validation = rows.filter((row) => stableFold(row.session_hash, foldCount) === fold);
      const training = rows.filter((row) => stableFold(row.session_hash, foldCount) !== fold && row.training_eligible !== false);
      if (validation.length === 0) continue;
      const model = fitWeightedLogistic(training, featureNames, { l2, iterations: 4_000, learning_rate: 0.12 });
      scored.push(...scoreRows(validation, featureNames, model));
    }
    scoredCandidates.push({ l2, rows: scored, log_loss: logLoss(scored.filter((row) => row.loss_eligible !== false)) });
  }
  return scoredCandidates.sort((left, right) => left.log_loss - right.log_loss || right.l2 - left.l2)[0];
}

export function selectOperationalThreshold(scoredRows) {
  const candidates = [...new Set([0, 1, ...scoredRows.map((row) => row.probability)])].sort((a, b) => a - b);
  return candidates.map((threshold) => ({ threshold, ...metrics(scoredRows, threshold) }))
    .sort((left, right) => right.f1 - left.f1
      || right.recall - left.recall
      || right.precision - left.precision
      || left.positive_rate - right.positive_rate
      || right.threshold - left.threshold)[0];
}

function calibrationRows(bundle, annotations, label) {
  return bundle.cases.filter((item) => item.phase === "calibration").map((caseItem) => {
    const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
    const evidence = {
      snippets: reviewCase.turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content })),
      events: [],
      hard_exclusion_reason: null
    };
    const features = extractMemoryRouterFeatures(evidence);
    return {
      case_id: caseItem.id,
      features,
      forced: false,
      label: label(annotationUsefulness(annotations.annotations[caseItem.id], caseItem)),
      evidence
    };
  });
}

export function calibrateRouter(bundle, annotations) {
  validateAnnotationExport(bundle, annotations);
  const featureNames = MEMORY_EXTRACTION_ROUTER_MODEL_V2.feature_names;
  const durableRows = calibrationRows(bundle, annotations, (usefulness) => usefulness === "durable_memory");
  const operationalRows = calibrationRows(bundle, annotations, (usefulness) => usefulness === "operational_history_only");
  for (const row of operationalRows) row.forced = false;
  const durableModel = fitWeightedLogistic(durableRows, featureNames);
  const operationalModel = fitWeightedLogistic(operationalRows, featureNames);
  const durableThreshold = selectThreshold(scoreRows(durableRows, featureNames, durableModel), {
    objective: "recall",
    max_positive_rate: 0.5
  });
  const operationalThreshold = selectThreshold(scoreRows(operationalRows, featureNames, operationalModel), { objective: "f1" });
  const model = {
    schema: "memory-extraction-router-model/v2",
    model_type: "weighted_logistic_regression",
    training_set: `${bundle.set_id}:calibration`,
    feature_names: featureNames,
    durable_candidate: { ...durableModel, threshold: durableThreshold.threshold },
    operational_history: { ...operationalModel, threshold: operationalThreshold.threshold }
  };
  const routed = durableRows.map((row) => routeTurnEvidence(row.evidence, { model }));
  const durableFeatureStats = Object.fromEntries(featureNames.map((name) => {
    const selected = durableRows.filter((row) => (row.features[name] ?? 0) > 0);
    const truePositives = selected.filter((row) => row.label).length;
    return [name, {
      support: selected.length,
      precision: selected.length === 0 ? 0 : truePositives / selected.length,
      recall: durableRows.filter((row) => row.label).length === 0 ? 0 : truePositives / durableRows.filter((row) => row.label).length
    }];
  }));
  const combinations = {
    adopted_scoped: (features) => features.user_adoption === 1 && features.durable_scope === 1,
    decision_scoped: (features) => features.durable_decision === 1 && features.durable_scope === 1,
    constraint_scoped: (features) => features.constraint === 1 && features.durable_scope === 1,
    reusable_failure: (features) => features.failure_correction === 1 && features.reusable_or_causal === 1,
    reusable_failure_scoped: (features) => features.failure_correction === 1 && features.reusable_or_causal === 1 && features.durable_scope === 1
  };
  const durableRuleStats = Object.fromEntries(Object.entries(combinations).map(([name, predicate]) => {
    const selected = durableRows.filter((row) => predicate(row.features));
    const truePositives = selected.filter((row) => row.label).length;
    return [name, {
      support: selected.length,
      precision: selected.length === 0 ? 0 : truePositives / selected.length,
      recall: truePositives / durableRows.filter((row) => row.label).length
    }];
  }));
  return {
    model,
    calibration: {
      cases: durableRows.length,
      durable_candidate: durableThreshold,
      operational_history: operationalThreshold,
      joint_decisions: routed.filter((item) => item.decisions.durable_candidate && item.decisions.operational_history).length,
      durable_feature_stats: durableFeatureStats,
      durable_rule_stats: durableRuleStats
    }
  };
}

function v3Rows(bundle, usefulnessByCase) {
  return bundle.cases.filter((item) => item.phase === "calibration").flatMap((caseItem) => {
    const usefulness = usefulnessByCase.get(caseItem.id);
    if (!usefulness || usefulness === "excluded") return [];
    const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
    const evidence = {
      snippets: reviewCase.turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content })),
      events: [],
      hard_exclusion_reason: null
    };
    return [{
      case_id: caseItem.id,
      session_hash: caseItem.session_hash,
      usefulness,
      durable_label: usefulness === "durable_memory",
      operational_label: usefulness === "operational_history_only",
      features: extractMemoryRouterFeatures(evidence),
      evidence,
      forced: false
    }];
  });
}

export function calibrateRouterV3(bundle, usefulnessByCase) {
  const rows = v3Rows(bundle, usefulnessByCase);
  const featureNames = MEMORY_EXTRACTION_ROUTER_MODEL_V3.feature_names;
  const durableRows = rows.map((row) => ({ ...row, label: row.durable_label }));
  const durableOof = groupedOof(durableRows, featureNames);
  const durableThreshold = selectThreshold(durableOof.rows, { objective: "recall", max_positive_rate: 0.47 });

  const operationalTrainingRows = rows.map((row) => ({
    ...row,
    label: row.operational_label,
    training_eligible: !row.durable_label,
    loss_eligible: !row.durable_label
  }));
  const operationalOof = groupedOof(operationalTrainingRows, featureNames);
  const durableProbability = new Map(durableOof.rows.map((row) => [row.case_id, row.probability]));
  const operationalCascadeRows = operationalOof.rows
    .filter((row) => (durableProbability.get(row.case_id) ?? 1) < durableThreshold.threshold)
    .map((row) => ({ ...row, label: row.operational_label }));
  const operationalThreshold = selectOperationalThreshold(operationalCascadeRows);

  const durableModel = fitWeightedLogistic(durableRows, featureNames, { l2: durableOof.l2 });
  const operationalModel = fitWeightedLogistic(
    operationalTrainingRows.filter((row) => row.training_eligible),
    featureNames,
    { l2: operationalOof.l2 }
  );
  const model = {
    schema: "memory-extraction-router-model/v3",
    model_type: "hierarchical_weighted_logistic_regression",
    training_set: `${bundle.set_id}:calibration`,
    feature_names: featureNames,
    durable_candidate: { ...durableModel, threshold: durableThreshold.threshold },
    operational_history: { ...operationalModel, threshold: operationalThreshold.threshold },
    calibration: {
      cases: rows.length,
      folds: 5,
      call_rate_cap: 0.47,
      durable_l2: durableOof.l2,
      durable_oof_log_loss: durableOof.log_loss,
      durable_threshold: durableThreshold,
      operational_l2: operationalOof.l2,
      operational_oof_log_loss: operationalOof.log_loss,
      operational_threshold: operationalThreshold
    }
  };
  const routed = rows.map((row) => routeTurnEvidence(row.evidence, { model }));
  return {
    model,
    calibration: {
      cases: rows.length,
      durable_candidate: durableThreshold,
      operational_history: operationalThreshold,
      disposition_counts: Object.fromEntries(["llm_candidate", "operational_history", "discard"]
        .map((route) => [route, routed.filter((item) => item.primary_route === route).length])),
      joint_decisions: routed.filter((item) => item.decisions.durable_candidate && item.decisions.operational_history).length
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const bundlePath = option(argv, "--bundle");
  const annotationsPath = option(argv, "--annotations");
  const outputPath = option(argv, "--output");
  const runtimeCasesPath = option(argv, "--runtime-cases");
  const version = option(argv, "--version") ?? (runtimeCasesPath ? "v3" : "v2");
  if (!bundlePath || (!annotationsPath && !runtimeCasesPath)) throw new Error("bundle_and_labels_required");
  const bundle = await fs.readFile(path.resolve(bundlePath), "utf8").then(JSON.parse);
  let result;
  if (version === "v3") {
    let usefulnessByCase;
    if (runtimeCasesPath) {
      const rows = (await fs.readFile(path.resolve(runtimeCasesPath), "utf8"))
        .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
      usefulnessByCase = new Map(rows.map((row) => [row.case_id, row.gold?.usefulness]));
    } else {
      const annotations = await fs.readFile(path.resolve(annotationsPath), "utf8").then(JSON.parse);
      validateAnnotationExport(bundle, annotations);
      usefulnessByCase = new Map(bundle.cases.map((caseItem) => [
        caseItem.id,
        annotationUsefulness(annotations.annotations[caseItem.id], caseItem)
      ]));
    }
    result = calibrateRouterV3(bundle, usefulnessByCase);
  } else {
    const annotations = await fs.readFile(path.resolve(annotationsPath), "utf8").then(JSON.parse);
    result = calibrateRouter(bundle, annotations);
  }
  if (outputPath) await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`router_calibration_failed:${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
