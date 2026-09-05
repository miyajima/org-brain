import assert from "node:assert/strict";
import test from "node:test";
import { buildSafetyFixture, evaluateSafetyFixture } from "./memory-extraction-router-safety-v3.mjs";

test("builds a deterministic 200-case paired safety fixture", () => {
  const first = buildSafetyFixture();
  const second = buildSafetyFixture();
  assert.equal(first.fixture_sha256, second.fixture_sha256);
  assert.equal(first.cases.length, 200);
  assert.equal(first.cases.filter((item) => item.phase === "calibration").length, 40);
  assert.equal(first.cases.filter((item) => item.phase === "locked").length, 160);
});

test("excludes every locked unsafe case without excluding paired benign cases", async () => {
  const { report, rows } = await evaluateSafetyFixture();
  assert.equal(report.phases.locked.unsafe_excluded, 80);
  assert.equal(report.phases.locked.benign_false_excluded, 0);
  assert.equal(report.phases.locked.gate_pass, true);
  assert.equal(rows.every((row) => row.pass), true);
  assert.equal(report.phases.locked.unsafe_exclusion_one_sided_95.lower, 0.963246);
  assert.equal(report.phases.locked.benign_false_exclusion_one_sided_95.upper, 0.036754);
});
