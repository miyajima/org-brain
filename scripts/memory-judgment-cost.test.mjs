import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJudge, memoryJudgmentPolicyHash } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { qualifyMemoryJudgment } from "../packages/shared/src/memory-judgment-evaluation.mjs";
import { memoryCostConfigurationHash } from "../packages/shared/src/memory-judgment-cost-evaluation.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalMemoryJudge, readJudgmentQualification } from "../packages/orgbrain-cli/src/lib/local-memory-judge.mjs";
import { localJudgmentImplementationHash } from "../packages/orgbrain-cli/src/lib/local-memory-judgment-binding.mjs";

const candidate = (id, text = `Use the verified staging rule ${id}.`) => ({ id, text, source_text: text, reuse_rule: "staging only", version: 1 });
const input = (candidates, extra = {}) => ({ stage: "use", context: { project_id: "p", query: "staging" }, candidates,
  policy: { mode: "shadow", objective: "cost" }, ...extra });
function response(request, conflict = false) {
  return { model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 10, cost: .001 },
    answers: Object.fromEntries(Object.keys(request.questions).map((key) => {
      const axis = key.replace(/^c\d+_/u, "");
      return [key, { type: "noul", noul: axis === "contradiction" && conflict ? .99
        : ["contradiction", "instruction_attack", "needs_verification"].includes(axis) ? .01 : .99 }];
    })) };
}

test("cost judgments reuse unchanged source questions after order and comparison-set changes", async () => {
  const requests = [];
  const judge = createMemoryJudge({ transport: async (request) => { requests.push(request); return response(request); } });
  const a = candidate("a"), b = candidate("b");
  await judge(input([a]));
  await judge(input([a, b]));
  assert.equal(Object.keys(requests.at(-1).questions).length, 8);
  const reversed = await judge(input([b, a]));
  assert.equal(reversed.request_count, 0);
  assert.deepEqual(reversed.decisions.map((d) => d.id), ["b", "a"]);
  const changed = await judge(input([{ ...a, version: 2 }, b]));
  assert.ok(changed.request_count > 0);
  assert.equal(Object.keys(requests.at(-1).questions).length, 8);
});

test("cost judgments split requests and preserve conflicts across batches", async () => {
  let calls = 0;
  const source = Array.from({ length: 35 }, (_, i) => candidate(`item-${i}`));
  const result = await createMemoryJudge({ transport: async (request) => {
    calls++;
    assert.ok(new TextEncoder().encode(JSON.stringify(request)).length <= 28_000);
    assert.ok(Object.keys(request.questions).length <= 50);
    return response(request, calls === 1);
  } })(input(source));
  assert.ok(calls > 1);
  assert.equal(result.decisions.length, source.length);
  assert.ok(result.decisions.every((d) => d.action === "review"));
});

test("cost judgments share concurrent calls and preserve original candidates on timeout", async () => {
  let calls = 0;
  const judge = createMemoryJudge({ transport: async (request) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return response(request);
  } });
  const request = input([candidate("shared")]);
  const results = await Promise.all([judge(request), judge(request)]);
  assert.equal(calls, 1);
  assert.equal(results.reduce((n, r) => n + r.request_count, 0), 1);
  const before = structuredClone(request.candidates);
  const timed = await createMemoryJudge({ transport: async (_request, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  }) })(input(before, { policy: { mode: "shadow", objective: "cost", timeout_ms: 30 } }));
  assert.ok(timed.elapsed_ms < 500);
  assert.ok(timed.decisions.every((d) => d.action === "review"));
  assert.deepEqual(before, request.candidates);
});
test("failed cost requests keep charges unknown and never retry a provider failure", async () => {
  let calls=0;
  const result=await createMemoryJudge({transport:async()=>{calls++;throw new Error("provider_unavailable");}})(input([candidate("failure")]));
  assert.equal(calls,1);assert.equal(result.provider_cost,null);
  assert.equal(result.usage.input_tokens,null);assert.equal(result.decisions[0].action,"review");
});
test("empty cost requests still identify the configured objective", async () => {
  const result = await createMemoryJudge({ transport: async () => { throw new Error("unexpected"); } })(input([]));
  assert.equal(result.objective, "cost");
  assert.equal(result.request_count, 0);
});

async function paired() {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `case-${i}`, conversation_id: `source-${i}` }));
  const manifest = { schema: "memory-judgment-experiment/v2", objective: "cost", policy_version: "memory-judgment/v1",
    model: "typesafe/jev-1.13", resolved_model: "typesafe/jev-1.13", threshold: .95,
    policy_hash: await memoryJudgmentPolicyHash(.95, { objective: "cost" }), dataset_hash: "a".repeat(64), runtime_hash: "b".repeat(64),
    implementation_hash: "c".repeat(64), configuration_hash: await memoryCostConfigurationHash(["capture", "use"]), stages: ["capture", "use"],
    dev_conversations: ["development"], holdout_conversations: cases.map((c) => c.conversation_id), holdout_cases: cases };
  const outcomes = cases.flatMap((c) => ["baseline", "jev"].map((arm) => ({ case_id: c.id, conversation_id: c.conversation_id, arm, split: "holdout",
    task_success: true, false_application: 0, required_memory_missing: 0, critical_regressions: 0,
    verification: { artifact_hash: "a".repeat(64), test_hash: "b".repeat(64), verified: true },
    parent_model: "fixed-parent", settings_hash: "settings", start_state_hash: "start", budget_hash: "budget",
    configuration_hash: manifest.configuration_hash,
    parent_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 2 }, task_elapsed_ms: arm === "baseline" ? 100 : 5100,
    cost: { source: "provider", parent_usd: arm === "baseline" ? 1 : .5, fallback_usd: 0, review_usd: .1, rework_usd: 0, other_usd: 0, jev_actual_usd: .001, jev_assumed_usd: 0 }
  })));
  return { manifest, outcomes };
}

test("cost qualification accepts equal quality and lower whole-task cost, with five seconds extra", async () => {
  const { manifest, outcomes } = await paired();
  const result = await qualifyMemoryJudgment(manifest, outcomes);
  assert.equal(result.status, "passed");
  assert.equal(result.task_success_improvement, 0);
  assert.ok(result.cost_savings_usd > 0);
  assert.equal(result.added_latency_p95_ms, 5000);
});

test("cost qualification refuses missing fees, per-case regressions, and extra review costs", async () => {
  for (const change of [
    (o) => { o.cost.parent_usd = null; },
    (o) => { o.task_success = false; },
    (o) => { o.required_memory_missing = 1; },
    (o) => { o.cost.review_usd = 20; },
    (o) => { o.task_elapsed_ms = 6000; }
  ]) {
    const { manifest, outcomes } = await paired();
    // Latency p95 requires at least two delayed cases in twenty observations.
    for (const item of outcomes.filter((o) => o.arm === "jev").slice(0, 2)) change(item);
    assert.equal((await qualifyMemoryJudgment(manifest, outcomes)).status, "inconclusive");
  }
});

test("cost disk cache survives process adapters and telemetry contains no candidate text or IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-cache-"));
  try {
    let calls = 0;
    const dbPath = join(root, "memory.sqlite");
    const options = { dbPath, env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_USE_MODE: "shadow", ORGBRAIN_JEV_OBJECTIVE: "cost" },
      transport: async (r) => { calls++; return response(r); } };
    const request = input([candidate("private-fixture-id", "PRIVATE ORIGINAL STAGING PROCEDURE")]);
    await createLocalMemoryJudge(options)(request);
    assert.equal((await createLocalMemoryJudge(options)(request)).cache_hit, true);
    assert.equal(calls, 1);
    assert.doesNotMatch((await readFile(`${dbPath}.jev.sqlite`)).toString(), /PRIVATE ORIGINAL|private-fixture-id/u);
    const trace = await readFile(`${dbPath}.jev-metrics.jsonl`, "utf8");
    assert.doesNotMatch(trace, /PRIVATE ORIGINAL|private-fixture-id/u);
    assert.equal(JSON.parse(trace.split("\n")[0]).objective, "cost");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cost activation verifies artifacts and binds the exact combined configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cost-qualification-contract-"));
  try {
    // Synthetic receipts verify the activation contract, never production qualification.
    const { manifest, outcomes } = await paired();
    manifest.implementation_hash = await localJudgmentImplementationHash();
    const digest = (v) => createHash("sha256").update(v).digest("hex");
    for (const [index, outcome] of outcomes.entries()) {
      const artifact = `contract-fixture-${index}`;
      const testReceipt = JSON.stringify({ case_id: outcome.case_id, arm: outcome.arm, passed: true, artifact_hash: digest(artifact) });
      await writeFile(join(root, `${index}.artifact`), artifact);
      await writeFile(join(root, `${index}.test`), testReceipt);
      outcome.verification = { verified: true, artifact_path: `${index}.artifact`, artifact_hash: digest(artifact), test_path: `${index}.test`, test_hash: digest(testReceipt) };
    }
    const file = join(root, "qualification.json");
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(root, "outcomes.json"), JSON.stringify(outcomes));
    await writeFile(file, JSON.stringify(await qualifyMemoryJudgment(manifest, outcomes)));
    const policy = { objective: "cost", threshold: .95, resolved_model: "typesafe/jev-1.13" };
    assert.equal(await readJudgmentQualification(file, "use", policy, { activeStages: ["capture", "use"] }), true);
    assert.equal(await readJudgmentQualification(file, "use", policy, { activeStages: ["use"] }), false);
    assert.equal(await readJudgmentQualification(file, "use", { ...policy, resolved_model: "changed-model" }, { activeStages: ["capture", "use"] }), false);
    await writeFile(join(root, "0.artifact"), "tampered");
    assert.equal(await readJudgmentQualification(file, "use", policy, { activeStages: ["capture", "use"] }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
