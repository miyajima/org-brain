import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectHistoricalRetrievals, evaluateHistoricalSessions, historicalReplayReport, readEmbeddedObjects } from "./memory-judgment-history-evaluate.mjs";

const memory = { id: "memory-1", content: "Keep the original evidence when a judgment is uncertain.", project_id: "org-brain", current_version: 2 };
const response = (id = "usage-1", results = [{ memory }]) => ({ results, meta: { usage_id: id }, evidence_bundle: {} });
const rows = (payload = response()) => [
  { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "How should uncertain judgments be handled?" }] } },
  { type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "mcp__orgbrain__orgbrain_context_enrich",
    arguments: JSON.stringify({ query: "How should uncertain judgments be handled?", project_id: "org-brain" }) } },
  { type: "response_item", timestamp: "2026-09-21T00:00:00Z", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [
    { type: "input_text", text: "Script completed\nOutput:\n" },
    { type: "input_text", text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }) }
  ] } }
];

test("recovers nested MCP text inside a code-mode result without evaluating code", () => {
  const values = readEmbeddedObjects('Output:\n{"content":[{"text":"{\\"results\\":[],\\"meta\\":{\\"usage_id\\":\\"u\\"}}"}]}');
  assert.equal(values.filter(v => v.meta?.usage_id === "u").length, 1);
});
test("preserves the historical query, candidate body and version", () => {
  const result = collectHistoricalRetrievals(rows(), { projectId: "org-brain" });
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].context.query, "How should uncertain judgments be handled?");
  assert.equal(result.cases[0].candidates[0].text, memory.content);
  assert.equal(result.cases[0].candidates[0].version, 2);
});
test("uses the actual CLI search literal instead of the surrounding user task", () => {
  const input = rows();
  input.splice(1, 1, { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec",
    input: 'const r = await tools.exec_command({ cmd: "orgbrain memory search \\"Zephyr bridge\\" --project-id org-brain" });' } });
  const result = collectHistoricalRetrievals(input, { projectId: "org-brain" });
  assert.equal(result.cases[0].context.query, "Zephyr bridge");
  assert.equal(result.cases[0].query_source, "original_cli_search_literal");
});
test("isolated UX fixtures do not count as ordinary-use evaluation cases", () => {
  const input = rows();
  input.splice(1, 1, { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec",
    input: 'const r = await tools.exec_command({ cmd: "ORGBRAIN_LOCAL_DB=/repo/artifacts/product-ux-evaluation/baseline/test.sqlite orgbrain memory search \\"Decision Evidence\\" --project-id org-brain" });' } });
  const result = collectHistoricalRetrievals(input, { projectId: "org-brain" });
  assert.equal(result.cases.length, 0);
  assert.equal(result.diagnostic_retrieval_count, 1);
});
test("MCP fixture generation is excluded even when its caller has no CLI search literal", () => {
  const input = rows();
  input.splice(1, 1, { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec",
    input: 'await tools.exec_command({cmd:"node -e \\"const fixtures = []; const db = \\\\\\\"/tmp/mcp-fixtures.sqlite\\\\\\\";\\""})' } });
  const result = collectHistoricalRetrievals(input, { projectId: "org-brain" });
  assert.equal(result.cases.length, 0);
  assert.equal(result.diagnostic_retrieval_count, 1);
});
test("does not treat user text, reasoning, or a final answer as a retrieval", () => {
  const fake = JSON.stringify(response());
  const result = collectHistoricalRetrievals([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: fake }] } },
    { type: "response_item", payload: { type: "reasoning", output: fake } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: fake }] } }
  ], { projectId: "org-brain" });
  assert.equal(result.retrieval_count, 0);
});
test("keeps empty retrievals separate from recoverable nonempty cases", () => {
  const result = collectHistoricalRetrievals(rows(response("u", [])), { projectId: "org-brain" });
  assert.equal(result.retrieval_count, 1);
  assert.equal(result.empty_retrieval_count, 1);
  assert.equal(result.cases.length, 0);
});
test("never drops an unsupported result and evaluates only the remaining subset", () => {
  const result = collectHistoricalRetrievals(rows(response("u", [{ memory }, { source_id: "missing-body" }])), { projectId: "org-brain" });
  assert.equal(result.cases.length, 0);
  assert.equal(result.incomplete_result_count, 1);
});
test("deduplicates repeated usage receipts within a session", () => {
  const input = rows(); input.push(input[2]);
  const result = collectHistoricalRetrievals(input, { projectId: "org-brain" });
  assert.equal(result.retrieval_count, 1);
  assert.equal(result.duplicate_receipts, 1);
});
test("missing or oversized search arguments are not reconstructed from the surrounding task", () => {
  assert.equal(collectHistoricalRetrievals([rows()[0], rows()[2]], { projectId: "org-brain" }).cases.length, 0);
  const input = rows(); input[1].payload.arguments = JSON.stringify({ query: "x".repeat(60001) });
  assert.equal(collectHistoricalRetrievals(input, { projectId: "org-brain" }).cases.length, 0);
});
test("an option before an unsupported search query is not mistaken for the query", () => {
  const input = rows();
  input[1] = { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec",
    input: 'await tools.exec_command({cmd:"orgbrain memory search --db /tmp/fixture.sqlite --project-id org-brain \\"query\\""})' } };
  const result = collectHistoricalRetrievals(input, { projectId: "org-brain" });
  assert.equal(result.cases.length, 0);
  assert.equal(result.missing_context_count, 1);
});
test("historical selection predictions do not manufacture task quality or activation proof", () => {
  const report = historicalReplayReport([{ conversation_hash: "a", candidates: [memory] }], [
    { status: "judged", decisions: [{ id: memory.id, action: "omit" }], request_count: 1, cache_hits: 0, provider_cost: .001, elapsed_ms: 10 }
  ]);
  assert.equal(report.proposed_omissions, 1);
  assert.equal(report.independent_conversations, 1);
  assert.equal(report.task_success, null);
  assert.equal(report.required_memory_missing, null);
  assert.equal(report.total_task_cost_usd, null);
  assert.equal(report.activation_qualified, false);
});
test("failed requests retain unknown provider cost instead of substituting zero", () => {
  const report = historicalReplayReport([], [{ request_count: 1, provider_cost: null, decisions: [], elapsed_ms: 10 }]);
  assert.equal(report.known_provider_cost_usd, 0);
  assert.equal(report.provider_cost_usd, null);
  assert.equal(report.unpriced_requests, 1);
});

test("runs a private replay of original tool snapshots and excludes subagents and unrelated projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-replay-"));
  try {
    const source = join(root, "sessions"), { mkdir } = await import("node:fs/promises"); await mkdir(source);
    const meta = { type: "session_meta", timestamp: "2026-09-21T00:00:00Z", payload: { id: "user-session", cwd: "/repo/org-brain", source: "vscode" } };
    await writeFile(join(source, "user.jsonl"), [meta, ...rows()].map(r => JSON.stringify(r)).join("\n"));
    await writeFile(join(source, "child.jsonl"), JSON.stringify({ ...meta, payload: { ...meta.payload, id: "child", parent_thread_id: "user-session" } }));
    await writeFile(join(source, "other.jsonl"), JSON.stringify({ ...meta, payload: { ...meta.payload, id: "other", cwd: "/repo/other-project" } }));
    await writeFile(join(source, "batch.jsonl"), [
      { ...meta, payload: { ...meta.payload, id: "batch", source: "exec", originator: "Codex Desktop", git: { commit_hash: "a".repeat(40) } } },
      ...rows(response("batch-usage"))
    ].map(r => JSON.stringify(r)).join("\n"));
    let calls = 0;
    const result = await evaluateHistoricalSessions({ roots: [source], projectId: "org-brain", out: join(root, "out"),
      transport: async request => { calls++; return { model: "typesafe/jev-1.13-20260917", usage: { cost: .001, input_tokens: 100, output_tokens: 10 },
        answers: Object.fromEntries(Object.entries(request.questions).map(([id]) => [id, { type: "noul", noul: .5 }])) }; } });
    assert.equal(calls, 1);
    assert.equal(result.inspected_sessions, 1);
    assert.equal(result.independent_conversations, 1);
    assert.equal(result.reviews, 1);
    assert.equal(result.activation_qualified, false);
    const manifest = JSON.parse(await readFile(join(root, "out", "manifest.json"), "utf8"));
    assert.match(manifest.sessions[0].source_hash, /^[a-f0-9]{64}$/u);
    await assert.rejects(evaluateHistoricalSessions({ roots: [source], projectId: "org-brain", out: join(root, "out") }), /EEXIST/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
