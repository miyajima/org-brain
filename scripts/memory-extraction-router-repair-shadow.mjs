#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { freezeRouterRun } from "./memory-extraction-router-freeze.mjs";
import { evaluateRouterShadow } from "./memory-extraction-router-evaluate.mjs";
import { evaluateDiverseSafety } from "./memory-extraction-router-safety-v31.mjs";
import { routerHash, validateRouterGoldRows } from "./memory-extraction-router-input.mjs";

export async function runRepairShadow({ bundlePath, goldPath, modelPath, outputDir }) {
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const gold = fs.readFileSync(goldPath, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const document = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  const expectedBundle = "sha256:85cd57e0b5b47703d40b69777a8e06377f9c2fdcd77bfb3cade222bd5fa8fa00";
  if (routerHash(bundle) !== expectedBundle) throw new Error("frozen_bundle_hash_mismatch");
  if (routerHash(document.model) !== document.model_sha256) throw new Error("model_artifact_hash_mismatch");
  if (document.policy.training_cases !== 71 || document.policy.excluded_cases !== 4 || document.policy.locked_used_for_selection !== false) throw new Error("calibration_population_mismatch");
  const labels = validateRouterGoldRows(bundle, gold);
  const eligible = bundle.cases.filter((item) => item.phase === "calibration" && labels.get(item.id) !== "excluded");
  const trainingHash = routerHash(eligible.map((item) => ({ ...item, label: labels.get(item.id) })));
  if (document.model.training_sha256 !== trainingHash) throw new Error("model_training_input_hash_mismatch");
  // mkdir is exclusive, before predictions. A failed run cannot be overwritten.
  freezeRouterRun(outputDir);
  const write = (name, value) => fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  write("model.json", document);
  write("evaluation-manifest.json", { bundle_sha256: routerHash(bundle), labels_sha256: routerHash(gold.map((row) => ({ case_id: row.case_id, gold: row.gold }))),
    model_sha256: document.model_sha256, calibration: 75, semantic_calibration: 71, regression: 425, semantic_regression: 398,
    regression_only: true, external_network: false, external_persistence: false, default_router: "v2", context_experiment: "not_run_optional" });
  const safety = evaluateDiverseSafety();
  write("safety.json", safety);
  const result = await evaluateRouterShadow(bundle, gold, { v3_model: document.model, safety_report: safety });
  result.report.policy.packing_budget_evidence = "offline o200k estimate only; Sol encoding/envelope unverified";
  write("report.json", result.report);
  for (const version of ["v2", "v3"]) fs.writeFileSync(path.join(outputDir, `${version}-cases.jsonl`), `${result.rows[version].map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { output_dir: outputDir, v3: result.report.v3.semantic.locked, v2: result.report.v2.semantic.locked,
    safety: safety.report.phases.locked, local_gates: result.report.local_gates };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  if (!["--bundle", "--runtime-cases", "--model", "--output-dir"].every((name) => process.argv.includes(name))) throw new Error("bundle_gold_model_output_required");
  console.log(JSON.stringify(await runRepairShadow({ bundlePath: option("--bundle"), goldPath: option("--runtime-cases"), modelPath: option("--model"), outputDir: option("--output-dir") })));
}
