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
import { LocalMemoryStore } from "../../orgbrain-cli/src/lib/local-memory-store.mjs";
import { OrgBrainLocalAdapter } from "./competitive-memory-benchmark.mjs";

test("real local adapter rejects pending host selection instead of scoring it as a miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitive-pending-"));
  const keys = ["ORGBRAIN_LOCAL_RELEVANCE_PROVIDER", "ORGBRAIN_LOCAL_EMBEDDING_PROVIDER", "ORGBRAIN_JEV_PROJECTS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ORGBRAIN_LOCAL_RELEVANCE_PROVIDER = "working-llm";
    process.env.ORGBRAIN_LOCAL_EMBEDDING_PROVIDER = "off";
    process.env.ORGBRAIN_JEV_PROJECTS = "";
    const adapter = new OrgBrainLocalAdapter(join(directory, "memory.sqlite"));
    await assert.rejects(runCompetitiveBenchmark(adapter, [buildCompetitiveTasks()[0]], { repeat: 1 }), /incomplete_retrieval.*pending_host_selection/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("real local adapter scores completed selector-off retrieval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitive-off-"));
  const keys = ["ORGBRAIN_LOCAL_RELEVANCE_PROVIDER", "ORGBRAIN_LOCAL_EMBEDDING_PROVIDER", "ORGBRAIN_JEV_PROJECTS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ORGBRAIN_LOCAL_RELEVANCE_PROVIDER = "off";
    process.env.ORGBRAIN_LOCAL_EMBEDDING_PROVIDER = "off";
    process.env.ORGBRAIN_JEV_PROJECTS = "";
    const task = buildCompetitiveTasks()[0];
    const adapter = new OrgBrainLocalAdapter(join(directory, "memory.sqlite"));
    const report = await runCompetitiveBenchmark(adapter, [task], { repeat: 1 });
    assert.equal(report.metrics.accuracy, 100);
    assert.equal(report.task_results[0].attempts[0].ids[0], task.expected_ids[0]);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable selection fails, while completed empty responses remain misses", async () => {
  const task = buildCompetitiveTasks()[0];
  const adapter = { name: "orgbrain-local-test", reset: async () => {}, capture: async () => ({}) };
  adapter.search = async () => ({ results: [], meta: { local_relevance: { status: "unavailable" } } });
  await assert.rejects(runCompetitiveBenchmark(adapter, [task], { repeat: 1 }), /incomplete_retrieval.*unavailable/);
  for (const response of [{ results: [] }, {}]) {
    adapter.search = async () => response;
    const report = await runCompetitiveBenchmark(adapter, [task], { repeat: 1 });
    assert.equal(report.metrics.accuracy, 0);
  }
});

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

test("context efficiency measures the injected evidence bundle instead of the full storage record", async () => {
  const task = buildCompetitiveTasks()[0];
  const expected = task.memories.find((memory) => task.expected_ids.includes(memory.id));
  const adapter = {
    name: "orgbrain-local-context-metric",
    reset: async () => undefined,
    capture: async () => ({}),
    search: async () => ({
      results: [{ memory: { ...expected, content: "x".repeat(8_000) } }],
      evidence_bundle: { estimated_tokens: 17 }
    })
  };
  const report = await runCompetitiveBenchmark(adapter, [task], { repeat: 1 });
  assert.equal(report.metrics.average_context_tokens, 17);
});

test("ranking requires every configured complete same-harness report and a strict OrgBrain lead", () => {
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
    makeResult("mem0", 90),
    makeResult("hindsight", 89),
    makeResult("mnemosyne", 88)
  ];
  const ranking = evaluateCompetitiveRanking(results, [], harness);
  assert.equal(ranking.first_place_claim_allowed, true);
  assert.deepEqual(ranking.blockers, []);
  assert.deepEqual(ranking.required_adapters, [
    "orgbrain-local",
    "mem0",
    "hindsight",
    "mnemosyne"
  ]);

  const incomplete = evaluateCompetitiveRanking(
    results.filter((result) => result.adapter !== "mem0"),
    [],
    harness
  );
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
