import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildEvaluationBundle, selectEvaluationCases } from "./memory-extraction-evaluation-bundle.mjs";
import { validateEvaluationBundle } from "./memory-extraction-evaluation-bundle-validate.mjs";

function candidate(id, session, cohorts, content = `Frozen source ${id}`) {
  return {
    id,
    session_hash: session.padEnd(64, "0").slice(0, 64),
    project_hash: `project-${session}`,
    source_hash: "replaced-by-bundle-fixture",
    retention_class: "standard",
    turns: [{ id: `turn-${id}`, role: "user", content }],
    eligible_cohorts: cohorts,
    model_prediction: { outcome: "candidate" }
  };
}

function validBundle() {
  const pool = [
    candidate("cal-d", "1", ["decision"]),
    candidate("cal-n", "2", ["non_durable"]),
    candidate("lock-d", "3", ["decision"]),
    candidate("lock-n", "4", ["non_durable"])
  ];
  const selection = selectEvaluationCases(pool, {
    calibrationQuotas: { decision: 1, success: 0, failure: 0, non_durable: 1 },
    lockedQuotas: { decision: 1, success: 0, failure: 0, non_durable: 1 }
  });
  const bundle = buildEvaluationBundle(selection, { frozenAt: "2026-09-03T00:00:00.000Z", setId: "validator-test" });
  const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  for (const item of bundle.cases) item.source_hash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(item.turns))).digest("hex")}`;
  return bundle;
}

test("validates a private bundle without exposing source content", () => {
  const bundle = validBundle();
  const result = validateEvaluationBundle(bundle, {
    expectedTotal: 4,
    expectedPhaseQuotas: {
      calibration: { decision: 1, success: 0, failure: 0, non_durable: 1 },
      locked: { decision: 1, success: 0, failure: 0, non_durable: 1 }
    }
  });
  assert.equal(result.total, 4);
  assert.equal(result.session_overlap, 0);
});

test("fails closed on a raw absolute path", () => {
  const bundle = validBundle();
  bundle.cases[0].turns[0].content = "Read /Users/private/secret.txt";
  const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  bundle.cases[0].source_hash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(bundle.cases[0].turns))).digest("hex")}`;
  assert.throws(() => validateEvaluationBundle(bundle), /evaluation_bundle_invalid:absolute_path/);
});

test("fails closed on duplicate citation variants", () => {
  const bundle = validBundle();
  const item = bundle.cases[0];
  item.turns.push({
    id: "duplicate-turn",
    role: item.turns[0].role,
    content: `${item.turns[0].content}\n<oai-mem-citation><citation_entries>MEMORY.md:1-2</citation_entries></oai-mem-citation>`
  });
  const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  item.source_hash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(item.turns))).digest("hex")}`;
  assert.throws(() => validateEvaluationBundle(bundle), /evaluation_bundle_invalid:duplicate_turn/);
});
