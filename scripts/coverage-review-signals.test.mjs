import test from "node:test";
import assert from "node:assert/strict";
import { collectCoverageReviewSignals, annotateCoverageReviewSignals } from "../packages/orgbrain-cli/src/lib/coverage-review-signals.mjs";
import { buildCoverageEvidenceGroups, selectCoverageEvidence } from "../packages/shared/src/memory-extraction-coverage-runtime.mjs";
import { buildTurnEvidenceV1 } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";

const call = (id, name, args = {}) => ({ payload: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } });
const result = (id, value) => ({ payload: { type: "function_call_output", call_id: id, output: JSON.stringify(value) } });

test("links an explicit scoped miss to subsequent repeated failures without storing query text", () => {
  const rows = [call("search", "orgbrain_memories_search", { project_id: "p", q: "private query" }), result("search", { results: [] }), call("a", "exec_command"), result("a", { exit_code: 1 }), call("b", "exec_command"), result("b", { exit_code: 1 })];
  const diagnostics = collectCoverageReviewSignals(rows, "p");
  assert.equal(diagnostics.recall_misses, 1);
  assert.equal(diagnostics.signals[1].reason, "repeated_tool_failure");
  assert.equal(diagnostics.signals[1].recall_miss_id, "search");
  assert.ok(!JSON.stringify(diagnostics).includes("private query"));
  const snippets = annotateCoverageReviewSignals([{ span_id: "s", call_id: "b", source_order: 6, role: "assistant", text: "失敗の原因を修正した。" }], diagnostics);
  assert.ok(snippets[0].review_signal_score > 0);
  assert.ok(snippets[0].review_signal_reasons.includes("recall_gap_and_friction"));
});

test("foreign scope, failed search and unstructured output are not knowledge gaps", () => {
  for (const [project, output] of [["other", { results: [] }], ["p", { isError: true, results: [] }], ["p", "no results"]]) {
    const d = collectCoverageReviewSignals([call("s", "orgbrain_memories_search", { project_id: project }), result("s", output)], "p");
    assert.equal(d.recall_misses, 0);
  }
});

test("friction breaks ties without displacing higher-priority corrections", () => {
  const groups = buildCoverageEvidenceGroups([
    { span_id: "a", role: "user", text: "APIを採用する。", review_signal_score: 3 },
    { span_id: "b", role: "user", text: "CLIを採用する。" },
    { span_id: "c", role: "user", text: "旧仕様を撤回する。" }
  ]);
  const selected = selectCoverageEvidence(groups);
  assert.deepEqual(selected.groups.map((g) => g.parent_span_ids[0]), ["c", "a", "b"]);
  assert.equal(selected.groups.length, 3);
});

test("turn adapter annotates a human correction after a miss in every capture mode", async () => {
  const input = { project_id: "p", rows: [
    call("s", "orgbrain_memories_search", { project_id: "p" }), result("s", { results: [] }),
    { payload: { type: "user_message", message: "違います。APIの設定を訂正してください。" } }
  ] };
  const coverage = await buildTurnEvidenceV1(input, { preserve_snippet_text: true });
  assert.ok(coverage.snippets.find((s) => s.role === "user").review_signal_reasons.includes("recall_gap_and_friction"));
  const legacy = await buildTurnEvidenceV1(input);
  assert.ok(legacy.snippets.find((s) => s.role === "user").review_signal_reasons.includes("recall_gap_and_friction"));
  assert.equal(legacy.review_diagnostics.recall_misses, 1);
  assert.ok(!JSON.stringify(legacy.review_diagnostics).includes("private query"));
});

test("a later search hit clears the pending gap and duplicate result rows do not add failures", () => {
  const rows = [call("s", "orgbrain_memories_search", { project_id: "p" }), result("s", { results: [] }),
    call("h", "orgbrain_memories_search", { project_id: "p" }), result("h", { results: [{ id: "m" }] }),
    call("f", "exec_command"), result("f", { exit_code: 1 }), result("f", { exit_code: 1 })];
  const d = collectCoverageReviewSignals(rows, "p");
  assert.equal(d.signals.length, 1);
  assert.equal(d.signals[0].recall_miss_id, undefined);
});


test("distinct operations and successful recovery do not accumulate repeated failures", () => {
  const rows = [call("a", "exec_command", { cmd: "a" }), result("a", { exit_code: 1 }),
    call("b", "exec_command", { cmd: "b" }), result("b", { exit_code: 1 }),
    call("c", "exec_command", { cmd: "a" }), result("c", { exit_code: 0 }),
    call("d", "exec_command", { cmd: "a" }), result("d", { exit_code: 1 })];
  const diagnostics = collectCoverageReviewSignals(rows, "p");
  assert.deepEqual(diagnostics.signals.map((s) => s.reason), ["tool_failure", "tool_failure", "tool_failure"]);
  const [unrelated] = annotateCoverageReviewSignals([{ role: "assistant", source_order: 9, text: "別の作業を完了した。" }], diagnostics);
  assert.equal(unrelated.review_signal_score, 0);
});

test("MCP error envelope cannot establish a recall miss", () => {
  const diagnostics = collectCoverageReviewSignals([call("s", "orgbrain_memories_search", { project_id: "p" }),
    result("s", { isError: true, content: [{ type: "text", text: '{"results":[]}' }] })], "p");
  assert.equal(diagnostics.recall_misses, 0);
});

test("context enrichment abstention becomes an eager gap only after later successful work", () => {
  const rows = [
    call("ctx", "mcp__orgbrain__orgbrain_context_enrich", { project_id: "p", query: "OpenRouter setup" }),
    result("ctx", { evidence_bundle: { evidence_status: "insufficient", evidence: [], abstention_recommended: true } }),
    call("patch", "apply_patch", { patch: "*** Update File: config/runtime.env" }),
    result("patch", { ok: true }),
    call("verify", "exec_command", { cmd: "typesafe-ai doctor" }),
    result("verify", { exit_code: 0 })
  ];
  const diagnostics = collectCoverageReviewSignals(rows, "p");
  assert.equal(diagnostics.recall_misses, 1);
  assert.equal(diagnostics.latest_retrieval, "miss");
  assert.deepEqual(diagnostics.successful_actions_after_miss.map((item) => item.tool), ["apply_patch", "exec_command"]);
  assert.ok(diagnostics.successful_actions_after_miss.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.result_hash)));
  assert.ok(!JSON.stringify(diagnostics).includes("OpenRouter setup"));
});

test("a later context hit clears eager gap actions", () => {
  const rows = [
    call("miss", "orgbrain_context_enrich", { project_id: "p" }),
    result("miss", { evidence_bundle: { evidence_status: "insufficient", abstention_recommended: true } }),
    call("work", "exec_command"), result("work", { exit_code: 0 }),
    call("hit", "orgbrain_context_enrich", { project_id: "p" }),
    result("hit", { evidence_bundle: { evidence_status: "sufficient", evidence: [{ memory_id: "m" }], abstention_recommended: false } })
  ];
  const diagnostics = collectCoverageReviewSignals(rows, "p");
  assert.equal(diagnostics.latest_retrieval, "hit");
  assert.deepEqual(diagnostics.successful_actions_after_miss, []);
});

test("read-only discovery after a miss is not verified eager work", () => {
  const diagnostics = collectCoverageReviewSignals([
    call("miss", "orgbrain_context_enrich", { project_id: "p" }),
    result("miss", { evidence_bundle: { evidence_status: "insufficient", abstention_recommended: true } }),
    call("read", "exec_command", { cmd: "rg -n OpenRouter packages" }),
    result("read", { exit_code: 0 })
  ], "p");
  assert.equal(diagnostics.latest_retrieval, "miss");
  assert.deepEqual(diagnostics.successful_actions_after_miss, []);
});
