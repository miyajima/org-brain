import test from "node:test";
import assert from "node:assert/strict";
import { calibrateRouterV31 } from "./memory-extraction-router-calibrate-v31.mjs";
import { stableFold } from "./memory-extraction-router-calibrate.mjs";

test("nested cascade is deterministic and neither excluded nor regression rows participate in fitting/selection", () => {
  const cases = []; const labels = new Map();
  const sessions = new Map();
  for (let seed = 0; sessions.size < 20; seed++) {
    const session = `fixture-${seed}`;
    sessions.set(`${stableFold(session, 5)}:${stableFold(session, 4)}`, session);
  }
  for (const session of sessions.values()) {
    for (const [kind, label, content] of [
      ["durable", "durable_memory", "今後のAPI方針としてRESTを採用する。理由は互換性。"],
      ["operational", "operational_history_only", "テストを実行して成功しました。"],
      ["discard", "not_useful", "確認しました。"]
    ]) {
      const id = `${session}-${kind}`;
      cases.push({ id, phase: "calibration", session_hash: session, turns: [{ id: "s1", role: kind === "durable" ? "user" : "assistant", content }] });
      labels.set(id, label);
    }
  }
  for (const [id, phase, label] of [["excluded", "calibration", "excluded"], ["regression", "locked", "durable_memory"]]) {
    cases.push({ id, phase, session_hash: id, turns: [{ id: "s1", role: "user", content: "API方針としてRESTを採用する。" }] }); labels.set(id, label);
  }
  const bundle = { set_id: "test", cases };
  const first = calibrateRouterV31(bundle, labels);
  cases.at(-1).turns[0].content = "無関係な回帰本文";
  labels.set("regression", "not_useful");
  cases.at(-2).turns[0].content = "除外本文も変更";
  const second = calibrateRouterV31(bundle, labels);
  assert.deepEqual(first, second);
  assert.equal(first.policy.training_cases, 60);
  assert.equal(first.policy.excluded_cases, 1);
  for (const config of first.configurations) for (const fold of config.folds) {
    assert.ok(fold.training_ids.every((id) => !fold.validation_ids.includes(id)));
    assert.ok(fold.residual_ids.every((id) => fold.training_ids.includes(id)));
    assert.ok(!fold.training_ids.includes("excluded") && !fold.training_ids.includes("regression"));
  }
});
