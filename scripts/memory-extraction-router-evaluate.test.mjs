import assert from "node:assert/strict";
import test from "node:test";
import { attachSafetyGate, evaluateRouterShadow } from "./memory-extraction-router-evaluate.mjs";
import { SAFETY_FIXTURE_SHA256 } from "./memory-extraction-router-safety-v3.mjs";

const model = (durableProbability, operationalProbability) => ({
  schema: "memory-extraction-router-model/v3",
  training_set: "test-calibration-only",
  feature_names: ["durable_scope"],
  durable_candidate: { intercept: Math.log(durableProbability / (1 - durableProbability)), weights: [0], threshold: 0.5 },
  operational_history: { intercept: Math.log(operationalProbability / (1 - operationalProbability)), weights: [0], threshold: 0.5 }
});

test("attaches the fixed safety fixture to the aggregate local gate", () => {
  const report = { inputs: {}, local_gates: { semantic: { pass: true }, pass: true } };
  attachSafetyGate(report, {
    fixture_sha256: SAFETY_FIXTURE_SHA256,
    phases: { locked: { unsafe_total: 80, unsafe_excluded: 80, benign_total: 80, benign_false_excluded: 0, gate_pass: true } }
  });
  assert.equal(report.local_gates.safety_locked.pass, false); // Old repetitive fixture is regression-only.
  assert.equal(report.local_gates.pass, false);
  assert.equal(report.local_gates.llm_output_exact_grounding.status, "not_run_router_gate_failed");
  assert.equal(report.inputs.safety_fixture_sha256, SAFETY_FIXTURE_SHA256);
});

test("reports semantic metrics separately and keeps v3 routes exclusive", async () => {
  const bundle = {
    cases: [
      { id: "durable", phase: "calibration", session_hash: "a", source_hash: "sa", project_hash: "pa", turns: [{ id: "s1", role: "user", content: "APIの方針としてRESTを採用する。", observed_at: "2026-01-01T00:00:00Z" }] },
      { id: "operational", phase: "locked", session_hash: "b", source_hash: "sb", project_hash: "pb", turns: [{ id: "s1", role: "assistant", content: "テストを実行して成功しました。", observed_at: "2026-01-01T00:00:00Z" }] },
      { id: "excluded", phase: "locked", session_hash: "c", source_hash: "sc", project_hash: "pc", turns: [{ id: "s1", role: "user", content: "通常の文章です。", observed_at: "2026-01-01T00:00:00Z" }] }
    ]
  };
  const goldRows = [
    { case_id: "durable", gold: { usefulness: "durable_memory", evidence_spans: [] } },
    { case_id: "operational", gold: { usefulness: "operational_history_only", evidence_spans: [] } },
    { case_id: "excluded", gold: { usefulness: "excluded", evidence_spans: [] } }
  ];
  for (const row of goldRows) {
    const item = bundle.cases.find((item) => item.id === row.case_id);
    Object.assign(row, { source_hash: item.source_hash, phase: item.phase, cohort: item.cohort });
  }
  const result = await evaluateRouterShadow(bundle, goldRows, {
    v2_model: model(0.9, 0.9),
    v3_model: model(0.1, 0.9),
    generated_at: "2026-01-01T00:00:00Z"
  });
  assert.equal(result.report.v3.semantic.locked.cases, 1);
  assert.equal(result.report.v3.semantic.locked.operational_history.recall, 1);
  assert.equal(result.report.v3.semantic.locked.joint_route_rate, 0);
  assert.equal(result.report.policy.persistence_performed, false);
});
