#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { fitWeightedLogistic, groupedOof, scoreRows, selectThreshold, selectOperationalThreshold, stableFold } from "./memory-extraction-router-calibrate.mjs";
import { extractMemoryRouterFeatures } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 as previous } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v3.mjs";
import { sanitizeMemoryExtractionReviewCase } from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";
import { validateRouterDataset, validateRouterGoldRows, routerHash } from "./memory-extraction-router-input.mjs";

function fitCascade(rows, names, folds) {
  const durableRows = rows.map((row) => ({ ...row, label: row.usefulness === "durable_memory" }));
  const durableOof = groupedOof(durableRows, names, { folds });
  if (durableOof.rows.length !== rows.length) throw new Error("incomplete_durable_oof");
  const durable = selectThreshold(durableOof.rows, { objective: "recall", max_positive_rate: 0.47 });
  const residual = durableOof.rows.filter((row) => row.probability < durable.threshold)
    .map((row) => ({ ...row, label: row.usefulness === "operational_history_only" }));
  const operationalOof = groupedOof(residual, names, { folds });
  if (!residual.length || operationalOof.rows.length !== residual.length) throw new Error("incomplete_operational_oof");
  const operational = selectOperationalThreshold(operationalOof.rows);
  return {
    durable_candidate: { ...fitWeightedLogistic(durableRows, names, { l2: durableOof.l2 }), threshold: durable.threshold },
    operational_history: { ...fitWeightedLogistic(residual, names, { l2: operationalOof.l2 }), threshold: operational.threshold },
    calibration: { durable, operational, durable_l2: durableOof.l2, operational_l2: operationalOof.l2,
      residual_case_ids: residual.map((row) => row.case_id), folds }
  };
}
function predictions(rows, names, model) {
  const durable = scoreRows(rows, names, model.durable_candidate);
  return durable.map((row) => {
    const llm = row.probability >= model.durable_candidate.threshold;
    const op = !llm && scoreRows([row], names, model.operational_history)[0].probability >= model.operational_history.threshold;
    return { ...row, llm, op };
  });
}
function metric(rows, label, predicted) {
  let tp = 0; let fp = 0; let fn = 0;
  for (const row of rows) { if (predicted(row)) { if (label(row)) tp++; else fp++; } else if (label(row)) fn++; }
  return { recall: tp + fn ? tp / (tp + fn) : 0, precision: tp + fp ? tp / (tp + fp) : 0,
    f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0, tp, fp, fn };
}
function summarize(rows) {
  return { durable: metric(rows, (row) => row.usefulness === "durable_memory", (row) => row.llm),
    operational: metric(rows, (row) => row.usefulness === "operational_history_only", (row) => row.op),
    call_rate: rows.filter((row) => row.llm).length / rows.length };
}
export function calibrateRouterV31(bundle, labels) {
  validateRouterDataset(bundle, labels);
  const eligible = bundle.cases.filter((item) => item.phase === "calibration" && labels.get(item.id) !== "excluded");
  const excluded = bundle.cases.filter((item) => item.phase === "calibration" && labels.get(item.id) === "excluded").map((item) => item.id);
  if (!eligible.length) throw new Error("semantic_calibration_empty");
  const configurations = [];
  for (const id of ["correctness-only", "features-v31"]) {
    const rows = eligible.map((item) => ({ case_id: item.id, session_hash: item.session_hash, usefulness: labels.get(item.id),
      features: extractMemoryRouterFeatures({ snippets: sanitizeMemoryExtractionReviewCase(item).turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content })), events: [] },
        id === "features-v31" ? { version: "v3" } : {}) }));
    const names = id === "features-v31" ? Object.keys(rows[0].features).sort() : previous.feature_names;
    const outer = [];
    const foldEvidence = [];
    for (let fold = 0; fold < 5; fold++) {
      const training = rows.filter((row) => stableFold(row.session_hash, 5) !== fold);
      const validation = rows.filter((row) => stableFold(row.session_hash, 5) === fold);
      if (!training.length || !validation.length) throw new Error("router_outer_fold_empty");
      const model = fitCascade(training, names, 4);
      outer.push(...predictions(validation, names, model));
      foldEvidence.push({ fold, training_ids: training.map((row) => row.case_id), validation_ids: validation.map((row) => row.case_id), residual_ids: model.calibration.residual_case_ids });
    }
    const final = fitCascade(rows, names, 5);
    configurations.push({ id, feature_names: names, feature_revision: id === "features-v31" ? "v3.1" : "v3",
      ...final, outer_oof: summarize(outer), folds: foldEvidence });
  }
  const feasible = configurations.filter((item) => item.outer_oof.call_rate <= 0.47);
  if (!feasible.length) throw new Error("router_no_feasible_configuration");
  feasible.sort((a, b) => b.outer_oof.durable.recall - a.outer_oof.durable.recall
    || b.outer_oof.operational.f1 - a.outer_oof.operational.f1 || b.outer_oof.durable.precision - a.outer_oof.durable.precision
    || b.outer_oof.operational.precision - a.outer_oof.operational.precision || a.outer_oof.call_rate - b.outer_oof.call_rate
    || a.feature_names.length - b.feature_names.length || b.durable_candidate.threshold - a.durable_candidate.threshold
    || b.operational_history.threshold - a.operational_history.threshold || a.id.localeCompare(b.id));
  const selected = feasible[0];
  const model = { schema: "memory-extraction-router-model/v3", revision: "v3.1", feature_revision: selected.feature_revision,
    model_type: "hierarchical_weighted_logistic_regression", training_set: `${bundle.set_id}:semantic-calibration`,
    feature_names: selected.feature_names, durable_candidate: selected.durable_candidate, operational_history: selected.operational_history,
    training_sha256: routerHash(eligible.map((item) => ({ ...item, label: labels.get(item.id) }))),
    calibration: { ...selected.calibration, cases: eligible.length, excluded_case_ids: excluded, call_rate_cap: 0.47 } };
  return { model, model_sha256: routerHash(model), selected: selected.id, configurations,
    policy: { locked_used_for_selection: false, training_cases: eligible.length, excluded_cases: excluded.length, external_network: false } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  if (!["--bundle", "--runtime-cases", "--output"].every((name) => process.argv.includes(name))) throw new Error("bundle_labels_output_required");
  const bundle = JSON.parse(fs.readFileSync(option("--bundle"), "utf8"));
  const rows = fs.readFileSync(option("--runtime-cases"), "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const labels = validateRouterGoldRows(bundle, rows);
  const result = calibrateRouterV31(bundle, labels);
  fs.writeFileSync(option("--output"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ selected: result.selected, model_sha256: result.model_sha256, policy: result.policy }));
}
