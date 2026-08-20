import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDomainPacks } from "./validate-domain-packs.mjs";

async function readStory(pack) {
  const root = fileURLToPath(new URL(`../domain-packs/first-party/${pack}/examples/story-v1.json`, import.meta.url));
  return JSON.parse(await readFile(root, "utf8"));
}

test("all first-party Domain Packs and stories validate", async () => {
  const results = await validateDomainPacks();
  assert.deepEqual(results.map((item) => item.pack_id).sort(), [
    "function.build-engineering", "function.pdm-b2c-marketplace", "function.sales", "function.sre"
  ]);
});

test("PdM story preserves the custom quality-adjusted metric outside its manifest", async () => {
  const root = fileURLToPath(new URL("../domain-packs/first-party/pdm-b2c", import.meta.url));
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  const story = JSON.parse(await readFile(`${root}/examples/story-v1.json`, "utf8"));
  assert.equal(manifest.metrics.some((metric) => metric.key === "quality_adjusted_activation_rate"), false);
  assert.equal(story.custom_metric_test.origin_type, "custom");
  assert.equal(story.custom_metric_test.coupon_case.expected_signal, "warning");
  assert.ok(story.after_four_weeks.ltv_cac < 3);
  assert.ok(story.after_four_weeks.contribution_margin_change_percent > 0);
});

test("the four fixed stories reproduce their metric change and Decision trace", async () => {
  const build = await readStory("build-engineering");
  assert.deepEqual(
    [build.baseline.build_duration_p95, build.after.build_duration_p95, build.after.build_success_rate],
    [18.4, 9.7, 98.6]
  );
  assert.equal(build.decision.workflow, "ci-bottleneck-diagnosis");
  assert.equal(build.decision.evidence.length, 3);

  const sre = await readStory("sre");
  assert.deepEqual(
    [sre.baseline.error_budget_burn_rate, sre.after.error_budget_burn_rate, sre.after.mttr],
    [3.4, 0.6, 29]
  );
  assert.equal(sre.decision.workflow, "service-degradation-response");
  assert.ok(sre.decision.constraints.includes("決済受付自体は停止しない"));

  const sales = await readStory("sales");
  assert.deepEqual(
    [sales.baseline.appointment_rate, sales.after.appointment_rate, sales.after.revenue],
    [27, 36, 8_900_000]
  );
  assert.equal(sales.decision.playbook, "webinar-followup-playbook");
  assert.equal(sales.decision.rejected_alternatives.length, 1);

  const pdm = await readStory("pdm-b2c");
  assert.equal(pdm.baseline.favorite_user_d30_retention / pdm.baseline.non_favorite_user_d30_retention, 2.625);
  assert.equal(pdm.baseline.contribution_ltv_90d / pdm.baseline.cac, pdm.baseline.ltv_cac);
  assert.ok(Math.abs(pdm.after_four_weeks.contribution_ltv_90d / pdm.after_four_weeks.cac - pdm.after_four_weeks.ltv_cac) < 0.01);
  assert.equal(pdm.after_four_weeks.purchase_conversion >= 2.8, true);
  assert.equal(pdm.after_four_weeks.d7_retention >= 26, true);
  assert.equal(pdm.after_four_weeks.contribution_margin_change_percent >= 0, true);
  assert.equal(pdm.decision.workflow, "consumer-funnel-diagnosis-to-experiment");
  assert.equal(pdm.decision.playbook, "b2c-product-experiment-review");
  assert.equal(pdm.decision.evidence.length, 5);
  assert.equal(pdm.custom_metric_test.coupon_case.activation_rate > pdm.custom_metric_test.coupon_case.quality_adjusted_activation_rate, true);

  for (const story of [build, sre, sales, pdm]) {
    assert.equal(story.install_fixture, false);
    assert.match(story.story_id, /^story-/);
    assert.match(story.fixture_date, /^2026-/);
    assert.ok(story.decision.id);
    assert.ok(story.decision.rationale);
    assert.ok(story.decision.evidence.length > 0);
    assert.equal(story.recall_fixture.expected_decision_id, story.decision.id);
  }
});

test("Recall profiles enforce the four domain gates", async () => {
  const root = fileURLToPath(new URL("../domain-packs/first-party", import.meta.url));
  const manifests = await Promise.all(["build-engineering", "sre", "sales", "pdm-b2c"].map(async (pack) =>
    JSON.parse(await readFile(`${root}/${pack}/manifest.json`, "utf8"))
  ));
  assert.deepEqual(manifests.map((manifest) => manifest.recall_profile.auto_recall_threshold), [0.6, 0.72, 0.6, 0.6]);
  assert.equal(manifests[1].recall_profile.risk_mode, "high_assurance");
  assert.deepEqual(manifests[1].recall_profile.required_scope_keys, ["service", "dependency"]);
  assert.ok(manifests.every((manifest) => !("prompt" in manifest) && !("sql" in manifest) && !("code" in manifest)));
});
