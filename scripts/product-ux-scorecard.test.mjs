import assert from "node:assert/strict";
import test from "node:test";
import { buildScorecard, DEFAULT_RUBRIC_PATH, loadJson } from "./product-ux-scorecard.mjs";

const rubric = await loadJson(DEFAULT_RUBRIC_PATH);

function inputFor({ mode = "interactive-local", rawScore = 100, overrides = {}, consecutivePasses = 2, aiRepeatConsistent = true } = {}) {
  const evidence = [{ id: "E-01", mode, description: "current-run evidence", source: "test" }];
  const measurements = rubric.axes.flatMap((axis) => axis.items.map((item) => ({
    id: item.id,
    raw_score: rawScore,
    evidence: ["E-01"],
    findings: [],
    notes: "test measurement",
    ...(overrides[item.id] ?? {})
  })));
  return {
    audit: {
      id: "test-run",
      date: "2026-08-24",
      commit: "de5f9afa",
      state: "final",
      basis: "test",
      consecutive_passes: consecutivePasses,
      ai_repeat_consistent: aiRepeatConsistent,
      cloud_live_verified: true,
      voiceover_manually_verified: true
    },
    evidence,
    measurements
  };
}

test("accepts a fully evidenced 100-point run", () => {
  const scorecard = buildScorecard(rubric, inputFor());
  assert.equal(scorecard.overall.score, 100);
  assert.equal(scorecard.overall.coverage, 1);
  assert.equal(scorecard.overall.completion_accepted, true);
});

test("caps static-only claims at 80", () => {
  const scorecard = buildScorecard(rubric, inputFor({ mode: "static" }));
  assert.equal(scorecard.overall.score, 80);
  assert.equal(scorecard.overall.completion_accepted, false);
});

test("does not renormalize an unverified required item", () => {
  const itemId = rubric.axes[0].items[0].id;
  const scorecard = buildScorecard(rubric, inputFor({ overrides: { [itemId]: { raw_score: null, evidence: [] } } }));
  assert.equal(scorecard.axes[0].score, 75);
  assert.equal(scorecard.axes[0].coverage, 0.75);
  assert.equal(scorecard.overall.coverage < 1, true);
  assert.equal(scorecard.overall.completion_accepted, false);
});

test("applies finding severity caps and blocks high findings", () => {
  const lowItem = rubric.axes[0].items[0].id;
  const mediumItem = rubric.axes[1].items[0].id;
  const highItem = rubric.axes[2].items[0].id;
  const overrides = {
    [lowItem]: { findings: [{ id: "F-low", severity: "low", summary: "minor", acceptance: "fixed", affected_axes: ["clarity"] }] },
    [mediumItem]: { findings: [{ id: "F-medium", severity: "medium", summary: "friction", acceptance: "fixed", affected_axes: ["simplicity"] }] },
    [highItem]: { findings: [{ id: "F-high", severity: "high", summary: "blocked", acceptance: "fixed", affected_axes: ["operability"] }] }
  };
  const scorecard = buildScorecard(rubric, inputFor({ overrides }));
  assert.equal(scorecard.axes[0].items[0].score, 96);
  assert.equal(scorecard.axes[1].items[0].score, 89);
  assert.equal(scorecard.axes[2].items[0].score, 79);
  assert.equal(scorecard.overall.blocking_findings, 1);
  assert.equal(scorecard.overall.completion_accepted, false);
});

test("requires every fixed rubric measurement", () => {
  const input = inputFor();
  input.measurements.pop();
  assert.throws(() => buildScorecard(rubric, input), /missing measurements/u);
});

test("requires two passes and repeat-consistent AI", () => {
  const scorecard = buildScorecard(rubric, inputFor({ consecutivePasses: 1, aiRepeatConsistent: false }));
  assert.equal(scorecard.overall.score, 100);
  assert.equal(scorecard.overall.completion_accepted, false);
  assert.match(scorecard.overall.reasons.join("\n"), /consecutive passes/u);
  assert.match(scorecard.overall.reasons.join("\n"), /AI repeat consistency/u);
});

test("requires Cloud live and manual VoiceOver verification", () => {
  const input = inputFor();
  input.audit.cloud_live_verified = false;
  input.audit.voiceover_manually_verified = false;
  const scorecard = buildScorecard(rubric, input);
  assert.equal(scorecard.overall.score, 100);
  assert.equal(scorecard.overall.completion_accepted, false);
  assert.match(scorecard.overall.reasons.join("\n"), /Cloud live verification/u);
  assert.match(scorecard.overall.reasons.join("\n"), /VoiceOver manual verification/u);
});

test("validates inputs against the published JSON Schema", () => {
  const invalidState = inputFor();
  invalidState.audit.state = "improved-provisional";
  assert.throws(() => buildScorecard(rubric, invalidState), /must be equal to one of the allowed values/u);

  const extraProperty = inputFor();
  extraProperty.audit.unpublished_gate = true;
  assert.throws(() => buildScorecard(rubric, extraProperty), /must NOT have additional properties/u);
});
