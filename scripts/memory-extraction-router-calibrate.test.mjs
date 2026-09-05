import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateRouterV3,
  fitWeightedLogistic,
  scoreRows,
  selectThreshold,
  stableFold
} from "./memory-extraction-router-calibrate.mjs";

test("fits a deterministic lightweight classifier and selects a bounded threshold", () => {
  const rows = [
    { features: { signal: 0 }, label: false, forced: false },
    { features: { signal: 0 }, label: false, forced: false },
    { features: { signal: 1 }, label: true, forced: false },
    { features: { signal: 1 }, label: true, forced: false }
  ];
  const model = fitWeightedLogistic(rows, ["signal"], { iterations: 1_000, learning_rate: 0.15 });
  const scored = scoreRows(rows, ["signal"], model);
  assert.ok(scored[2].probability > scored[0].probability);
  const selected = selectThreshold(scored, { objective: "recall", max_positive_rate: 0.5 });
  assert.equal(selected.positive_rate, 0.5);
  assert.equal(selected.recall, 1);
  assert.equal(selected.f1, 1);
});

test("counts forced rule decisions inside the call-rate budget", () => {
  const rows = [
    { probability: 0.9, label: false, forced: true },
    { probability: 0.8, label: true, forced: false },
    { probability: 0.2, label: false, forced: false },
    { probability: 0.1, label: false, forced: false }
  ];
  const selected = selectThreshold(rows, { objective: "recall", max_positive_rate: 0.5 });
  assert.equal(selected.positive_rate, 0.5);
  assert.equal(selected.recall, 1);
});

test("keeps sessions in one fold and never uses locked rows for v3 fitting", () => {
  assert.equal(stableFold("same-session", 5), stableFold("same-session", 5));
  const cases = [];
  const usefulness = new Map();
  for (let session = 0; session < 12; session += 1) {
    for (const [kind, label, text] of [
      ["durable", "durable_memory", "API方針としてRESTを採用する。"],
      ["operational", "operational_history_only", "テストを実行して成功しました。"],
      ["discard", "not_useful", "確認しました。"]
    ]) {
      const id = `cal-${session}-${kind}`;
      cases.push({ id, phase: "calibration", session_hash: `session-${session}`, turns: [{ id: "s1", role: kind === "durable" ? "user" : "assistant", content: text }] });
      usefulness.set(id, label);
    }
  }
  cases.push({ id: "locked", phase: "locked", session_hash: "locked-session", turns: [{ id: "s1", role: "user", content: "API方針としてGraphQLを採用する。" }] });
  usefulness.set("locked", "durable_memory");
  const first = calibrateRouterV3({ set_id: "fixture", cases }, usefulness);
  usefulness.set("locked", "not_useful");
  cases[36].turns[0].content = "全く異なるlocked本文。";
  const second = calibrateRouterV3({ set_id: "fixture", cases }, usefulness);
  assert.deepEqual(first, second);
  assert.equal(first.calibration.cases, 36);
  assert.ok(first.calibration.durable_candidate.positive_rate <= 0.47);
  assert.equal(first.calibration.joint_decisions, 0);
});
