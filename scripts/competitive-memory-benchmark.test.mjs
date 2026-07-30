import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCompetitiveTasks,
  evaluateCompetitiveRanking,
  runCompetitiveBenchmark
} from "./lib/competitive-memory-benchmark-core.mjs";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";

test("competitive dataset fixes 100 personal and 100 organization tasks across required risks", () => {
  const tasks = buildCompetitiveTasks();
  assert.equal(tasks.length, 200);
  assert.equal(tasks.filter((task) => task.mode === "personal").length, 100);
  assert.equal(tasks.filter((task) => task.mode === "organization").length, 100);
  assert.deepEqual(
    [...new Set(tasks.map((task) => task.category))].sort(),
    [
      "coding",
      "contradiction",
      "cross_tenant",
      "decision",
      "evidence",
      "permission",
      "policy",
      "preference",
      "staleness",
      "temporal"
    ]
  );
  assert.deepEqual(
    [...new Set(tasks.map((task) => task.dataset_family))].sort(),
    ["locomo_style", "longmemeval_style", "state_bench_style"]
  );
});

test("capability scores require evidence and can complete both weighted scorecards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitive-evidence-test-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
    const adapter = {
      name: "orgbrain-local",
      async describe() {
        return {
          personal: {
            setup_and_daily_ux: { score: 90, evidence: ["timed setup artifact"] },
            privacy_and_offline: { score: 100, evidence: ["offline network-denial test"] },
            automatic_extraction: { score: 95, evidence: ["extraction fixture report"] },
            interoperability: { score: 90, evidence: ["connector smoke report"] }
          },
          organization: {
            availability_and_recovery: { score: 90, evidence: ["restore drill artifact"] },
            integration_ease: { score: 90, evidence: ["connector smoke report"] },
            operability: { score: 95, evidence: ["operations API smoke"] }
          }
        };
      },
      async reset() {
        await store.init();
      },
      capture: (record) => store.capture(record),
      search: (query) => store.search(query)
    };
    const allTasks = buildCompetitiveTasks();
    const report = await runCompetitiveBenchmark(adapter, [allTasks[0], allTasks[100], allTasks[120]], {
      repeat: 1,
      harness: { model_id: "model-a", budget_usd: 1, hardware_id: "runner-a" }
    });
    assert.equal(report.scorecards.personal.ranking_eligible, true);
    assert.equal(report.scorecards.organization.ranking_eligible, true);
    assert.equal(report.settings.harness.model_id, "model-a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability scores without evidence remain unmeasured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitive-no-evidence-test-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
    const adapter = {
      name: "orgbrain-local",
      describe: async () => ({
        personal: { setup_and_daily_ux: { score: 100, evidence: [] } }
      }),
      async reset() {
        await store.init();
      },
      capture: (record) => store.capture(record),
      search: (query) => store.search(query)
    };
    const report = await runCompetitiveBenchmark(adapter, buildCompetitiveTasks().slice(0, 1), {
      repeat: 1
    });
    assert.equal(report.scorecards.personal.components.setup_and_daily_ux.score, null);
    assert.equal(report.scorecards.personal.ranking_eligible, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ranking requires five complete same-harness reports and a strict OrgBrain lead", () => {
  const harness = { model_id: "model-a", budget_usd: 2, hardware_id: "runner-a" };
  const component = (score) => ({ score, evidence: ["benchmark artifact"] });
  const makeScorecard = (score) => ({
    ranking_eligible: true,
    weighted_score: score,
    components: {
      search_quality: component(score),
      privacy_and_offline: component(score),
      automatic_extraction: component(score),
      security_and_governance: component(score),
      search_and_update_quality: component(score),
      availability_and_recovery: component(score),
      decision_and_collaboration: component(score)
    }
  });
  const makeResult = (adapter, score) => ({
    adapter,
    settings: { harness },
    scorecards: {
      personal: makeScorecard(score),
      organization: makeScorecard(score)
    }
  });
  const results = [
    makeResult("orgbrain-local", 95),
    makeResult("supermemory", 90),
    makeResult("gbrain", 89),
    makeResult("cognee", 88),
    makeResult("mem0", 87)
  ];
  const ranking = evaluateCompetitiveRanking(results, [], harness);
  assert.equal(ranking.first_place_claim_allowed, true);
  assert.deepEqual(ranking.blockers, []);

  const incomplete = evaluateCompetitiveRanking(results.slice(0, 4), [], harness);
  assert.equal(incomplete.first_place_claim_allowed, false);
  assert.ok(incomplete.blockers.includes("missing adapter result: mem0"));

  const mismatched = structuredClone(results);
  mismatched[1].settings.harness.model_id = "model-b";
  assert.equal(
    evaluateCompetitiveRanking(mismatched, [], harness).first_place_claim_allowed,
    false
  );
});

test("local adapter enforces tenant, permission, validity, and provenance contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitive-test-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
    const adapter = {
      name: "orgbrain-local-test",
      async reset() {
        await store.init();
      },
      capture: (record) => store.capture(record),
      search: (query) => store.search(query)
    };
    const allTasks = buildCompetitiveTasks();
    const selected = ["staleness", "permission", "cross_tenant", "evidence"].flatMap((category) =>
      allTasks.filter((task) => task.category === category).slice(0, 3)
    );
    const report = await runCompetitiveBenchmark(adapter, selected, { repeat: 5 });
    const failed = report.task_results.filter((task) => !task.attempts[0].top1);
    assert.equal(report.metrics.accuracy, 100, JSON.stringify(failed, null, 2));
    assert.equal(report.metrics.recall_at_5, 100);
    assert.equal(report.metrics.pass_5, 100);
    assert.equal(report.metrics.task_completion_rate, 100);
    assert.equal(report.metrics.average_turns, 1);
    assert.equal(report.metrics.total_cost_usd, 0);
    assert.equal(report.personal.task_completion_rate, 100);
    assert.equal(report.organization.average_turns, 1);
    assert.equal(report.metrics.cross_tenant_or_permission_leakage_count, 0);
    assert.equal(report.metrics.decision_grade_provenance_rate, 100);
    assert.equal(report.scorecards.personal.components.search_quality.score, 100);
    assert.equal(report.scorecards.organization.components.security_and_governance.score, 100);
    assert.equal(report.scorecards.organization.components.cost.score, 100);
    assert.equal(report.scorecards.personal.ranking_eligible, false);
    assert.equal(report.ranking.first_place_claim_allowed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
