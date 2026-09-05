import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EVALUATION_CONTRACT,
  buildEvaluationBundle,
  deduplicateEvaluationBundle,
  selectEvaluationCases,
  writePrivateJson
} from "./memory-extraction-evaluation-bundle.mjs";

function candidate(id, session, cohorts, retention = "standard") {
  const turns = [{ id: "s1", role: "user", content: `Frozen source ${id}` }];
  return {
    id,
    session_hash: session,
    project_hash: `project-${session}`,
    source_hash: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    retention_class: retention,
    occurred_at: Date.parse("2026-09-03T00:00:00.000Z"),
    turns,
    eligible_cohorts: cohorts,
    model_prediction: { outcome: cohorts.includes("non_durable") ? "no_candidate" : "candidate", lesson_types: cohorts.filter((item) => item !== "non_durable") }
  };
}

test("selects calibration and locked quotas without session overlap", () => {
  const pool = [];
  for (const cohort of ["decision", "failure", "success", "non_durable"]) {
    for (let index = 0; index < 8; index += 1) pool.push(candidate(`${cohort}-${index}`, `${cohort}-session-${index}`, [cohort]));
  }
  const selection = selectEvaluationCases(pool, {
    seed: "fixed-seed",
    calibrationQuotas: { decision: 1, failure: 1, success: 1, non_durable: 1 },
    lockedQuotas: { decision: 2, failure: 2, success: 2, non_durable: 2 }
  });
  assert.equal(selection.cases.length, 12);
  const calibrationSessions = new Set(selection.cases.filter((item) => item.phase === "calibration").map((item) => item.session_hash));
  assert.equal(selection.cases.filter((item) => item.phase === "locked").some((item) => calibrationSessions.has(item.session_hash)), false);
});

test("fails closed when a requested cohort quota cannot be met", () => {
  assert.throws(() => selectEvaluationCases([candidate("only", "session", ["failure"])], {
    calibrationQuotas: { decision: 1, failure: 0, success: 0, non_durable: 0 },
    lockedQuotas: { decision: 0, failure: 0, success: 0, non_durable: 0 }
  }), /evaluation_quota_insufficient:calibration:decision/);
});

test("keeps a dense session out of calibration when locked quota depends on it", () => {
  const pool = [
    candidate("calibration-non-durable", "small-non-durable", ["non_durable"]),
    candidate("locked-non-durable-1", "dense-non-durable", ["non_durable"]),
    candidate("locked-non-durable-2", "dense-non-durable", ["non_durable"]),
    candidate("locked-non-durable-3", "dense-non-durable", ["non_durable"]),
    candidate("calibration-decision", "calibration-decision", ["decision"]),
    candidate("locked-decision", "locked-decision", ["decision"])
  ];
  const selection = selectEvaluationCases(pool, {
    seed: "fixed-seed",
    calibrationQuotas: { decision: 1, failure: 0, success: 0, non_durable: 1 },
    lockedQuotas: { decision: 1, failure: 0, success: 0, non_durable: 3 }
  });
  const calibrationSessions = new Set(selection.cases
    .filter((item) => item.phase === "calibration")
    .map((item) => item.session_hash));
  assert.equal(calibrationSessions.has("dense-non-durable"), false);
  assert.equal(selection.sampling.inclusion_probability_state, "unverified_grouped_deterministic_sampling");
});

test("builds expiring private bundles and writes mode 0600", () => {
  const selection = {
    cases: [
      { ...candidate("standard", "s1", ["decision"]), phase: "calibration", cohort: "decision" },
      { ...candidate("sensitive", "s2", ["non_durable"], "sensitive"), phase: "locked", cohort: "non_durable" }
    ],
    sampling: { seed_hash: "sha256:test", session_overlap: 0 }
  };
  const bundle = buildEvaluationBundle(selection, { frozenAt: "2026-09-03T00:00:00.000Z", setId: "test-set" });
  assert.equal(bundle.contract, EVALUATION_CONTRACT);
  assert.equal(bundle.cases[0].expires_at, "2027-03-02T00:00:00.000Z");
  assert.equal(bundle.cases[1].expires_at, "2026-09-10T00:00:00.000Z");
  assert.equal(Object.hasOwn(bundle.cases[0], "eligible_cohorts"), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orgbrain-evaluation-"));
  const output = writePrivateJson(path.join(directory, "bundle.json"), bundle);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).set_id, "test-set");
});

test("deduplicates citation variants while preserving case identity and span aliases", () => {
  const selection = {
    cases: [{
      ...candidate("duplicate", "s1", ["decision"]),
      phase: "calibration",
      cohort: "decision",
      turns: [
        { id: "s1", role: "assistant", content: "SQLiteを採用しました。" },
        { id: "s2", role: "assistant", content: "SQLiteを採用しました。\n<oai-mem-citation><citation_entries>MEMORY.md:1-2</citation_entries></oai-mem-citation>" },
        { id: "s3", role: "assistant", content: "検証しました。" }
      ]
    }],
    sampling: { seed_hash: "sha256:test", session_overlap: 0 }
  };
  const original = buildEvaluationBundle(selection, { frozenAt: "2026-09-03T00:00:00.000Z", setId: "dedupe-set" });
  const deduplicated = deduplicateEvaluationBundle(original, { generatedAt: "2026-09-04T00:00:00.000Z" });
  assert.equal(deduplicated.set_id, original.set_id);
  assert.equal(deduplicated.frozen_at, original.frozen_at);
  assert.deepEqual(deduplicated.cases[0].turns.map((turn) => turn.id), ["s1", "s3"]);
  assert.deepEqual(deduplicated.cases[0].turn_aliases, { s2: "s1" });
  assert.notEqual(deduplicated.cases[0].source_hash, original.cases[0].source_hash);
  assert.equal(deduplicated.deduplication.removed_turns, 1);
});
