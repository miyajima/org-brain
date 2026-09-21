import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateJudgmentDataset, calibrateMemoryJudgment, qualifyMemoryJudgment, MEMORY_JUDGMENT_ARMS } from "../packages/shared/src/memory-judgment-evaluation.mjs";
import { memoryJudgmentPolicyHash } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { runJudgmentEvaluation } from "./memory-judgment-evaluate.mjs";

test("conversation grouping prevents development/holdout leakage", async () => {
  const data = JSON.parse(await readFile(new URL("./fixtures/memory-judgment-v1.json", import.meta.url)));
  assert.equal(validateJudgmentDataset(data), data);
  data.cases.at(-1).conversation_id = data.cases[0].conversation_id;
  assert.throws(() => validateJudgmentDataset(data), /conversation_split_leak/u);
  assert.throws(() => calibrateMemoryJudgment([{ split: "holdout" }]), /development_data/u);
});
test("threshold calibration is conservative and cannot disguise required-memory loss", () => {
  const scores = { grounded: .85, applicable: .85, incremental: .85, contradiction: .01, instruction_attack: .01, needs_verification: .01 };
  const result = calibrateMemoryJudgment([{ split: "dev", stage: "use", candidate: { id: "a" }, scores, required: true, forbidden: true }]);
  assert.equal(result.threshold, .98);
  assert.equal(result.rows.find((r) => r.threshold === .8).predicted_false_application, 1);
});
test("five-arm fixture replay freezes inputs, leaves real outcomes unknown, and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-evaluation-"));
  try {
    const args = { dataset: new URL("./fixtures/memory-judgment-v1.json", import.meta.url).pathname, out: join(root, "new-run") };
    const result = await runJudgmentEvaluation(args);
    assert.deepEqual(Object.keys(result.arms), MEMORY_JUDGMENT_ARMS);
    assert.equal(result.activation_qualified, false); assert.equal(result.task_success, null);
    assert.equal(result.arms.both.required_memory_missing, 0);
    assert.equal(result.arms.both.irrelevant_memory_included, 0);
    await assert.rejects(runJudgmentEvaluation(args), /EEXIST/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("qualification requires complete matched verified task observations, not a replay score", async () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `case-${i}`, conversation_id: `conversation-${i}` }));
  const manifest = { schema: "memory-judgment-experiment/v1", policy_version: "memory-judgment/v1", model: "typesafe/jev-1.13", threshold: .95,
    policy_hash: await memoryJudgmentPolicyHash(.95), dataset_hash: "a".repeat(64), runtime_hash: "b".repeat(64), implementation_hash: "c".repeat(64),
    dev_conversations: ["dev"], holdout_conversations: cases.map((c) => c.conversation_id), holdout_cases: cases };
  const observations = cases.flatMap((c) => MEMORY_JUDGMENT_ARMS.map((arm) => ({ case_id: c.id, conversation_id: c.conversation_id, arm, split: "holdout",
    task_success: arm !== "baseline" && arm !== "no_memory", false_application: 0, required_memory_missing: 0, critical_regressions: 0,
    verification: { artifact_hash: "a".repeat(64), test_hash: "b".repeat(64), verified: true }, parent_model: "fixed-parent",
    settings_hash: "settings", start_state_hash: "start", budget_hash: "budget", parent_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 }, task_elapsed_ms: 100 })));
  assert.equal((await qualifyMemoryJudgment(manifest, observations)).status, "passed");
  assert.equal((await qualifyMemoryJudgment({ ...manifest, dev_conversations: [cases[0].conversation_id] }, observations)).reason, "invalid_conversation_split");
  assert.equal((await qualifyMemoryJudgment(manifest, observations.slice(5))).status, "inconclusive");
  observations[0].parent_model = "different";
  assert.equal((await qualifyMemoryJudgment(manifest, observations)).reason, "unmatched_conditions");
  observations[0].parent_model = "fixed-parent"; observations[0].verification.verified = false;
  assert.equal((await qualifyMemoryJudgment(manifest, observations)).reason, "unverified_or_incomplete_outcome");
});
