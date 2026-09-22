import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompactMemoryContext, countContextTokens } from "../packages/orgbrain-cli/src/lib/compact-memory-context.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest, sanitizeAnswerUxToolResult } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { extractDurableMemoryDrafts } from "../packages/shared/src/memory-capture-v2-runtime.mjs";
import { MEMORY_CAPTURE_HOOK_PROFILE } from "../packages/shared/src/memory-capture-profile.generated.mjs";
import { collectCoverageReviewSignals } from "../packages/orgbrain-cli/src/lib/coverage-review-signals.mjs";

const lesson = {
  id: "memory-one", project_id: "org-brain", kind: "pitfall", work_type: "implementation", current_version: 1,
  content: "Run local SQLite diagnostics sequentially to avoid database lock errors.",
  summary: "Serialize SQLite diagnostics", rationale: "Concurrent writers contend on the same SQLite database.",
  reuse_rule: "Only serialize diagnostics sharing one local database; independent databases can run concurrently.",
  source_references: [{ type: "file", ref: "scripts/local-memory.test.mjs" }],
  conflicts: [], verification_state: "unverified", valid_until: null, expires_at: null
};
const pack = (memories, overrides = {}) => buildCompactMemoryContext({
  results: memories.map((memory) => ({ memory, score: { total: 0.8 } })), query: "SQLite lock diagnostics",
  topK: 3, tokenBudget: 1500, at: 1790000000000, usageId: "test-usage", ...overrides
});

test("complete JSON budget includes receipts and Japanese text without losing a late condition", () => {
  const japanese = { ...lesson, content: "同じSQLiteデータベースへの診断は逐次実行する。".repeat(10),
    reuse_rule: "別のデータベースへの診断は並列実行してよい。書き込みの競合が起きる場合だけ逐次実行する。" };
  for (const tokenBudget of [512, 800, 1500]) {
    const packed = pack([japanese], { tokenBudget });
    assert.equal(packed.response.evidence_bundle.estimated_tokens, countContextTokens(packed.response));
    assert.ok(countContextTokens(packed.response) <= tokenBudget);
    for (const item of packed.response.evidence_bundle.evidence) {
      assert.equal(item.text, japanese.content);
      assert.equal(item.reuse_rule, japanese.reuse_rule);
    }
    assert.equal(packed.items.length, packed.response.evidence_bundle.evidence.length);
  }
});

test("an oversized result does not starve a smaller useful result or produce false use receipts", () => {
  const huge = { ...lesson, id: "huge", content: "oversized unrelated background ".repeat(2000) };
  const { response, items } = pack([huge, lesson], { tokenBudget: 1000 });
  assert.deepEqual(items.map((item) => item.source_id), [lesson.id]);
  assert.equal(response.evidence_bundle.evidence[0].reuse_rule, lesson.reuse_rule);
  assert.equal(response.evidence_bundle.budget_limited, true);
});

test("deduplicate complete lessons but preserve different applicability and independent comparisons", () => {
  const copy = { ...lesson, id: "copy", source_references: [{ type: "file", ref: "docs/OTHER.md" }] };
  const otherScope = { ...lesson, id: "condition", reuse_rule: "Only run on an isolated backup." };
  assert.deepEqual(pack([lesson, copy, otherScope]).items.map((item) => item.source_id), ["memory-one", "condition"]);
  assert.equal(pack([lesson, copy], { query: "compare both SQLite recommendations" }).items.length, 2);
});

test("conflicts and missing independent sources abstain without recording injected memories", () => {
  const conflict = pack([{ ...lesson, conflicts: ["The procedure was revoked."] }]);
  assert.equal(conflict.response.evidence_bundle.evidence_status, "conflicted");
  assert.equal(conflict.items.length, 0);
  const comparison = pack([lesson], { query: "compare both SQLite recommendations" });
  assert.deepEqual(comparison.response.evidence_bundle.missing_evidence, ["insufficient_independent_sessions"]);
  assert.equal(comparison.items.length, 0);
});

test("a conflict after an oversized top result cannot enter through budget backfill", () => {
  const output = pack([{ ...lesson, id: "huge", content: "SQLite ".repeat(8000) },
    { ...lesson, conflicts: ["This procedure is revoked."] }], { topK: 1, tokenBudget: 1000 });
  assert.equal(output.response.evidence_bundle.evidence_status, "conflicted");
  assert.equal(output.items.length, 0);
  const safe = sanitizeAnswerUxToolResult("orgbrain_context_enrich", output.response);
  assert.equal(safe.evidence_bundle.conflicts_count, 1);
  assert.equal(safe.evidence_bundle.answer_guidance.response_mode, "abstain");
});

test("shadow and fallback judgments never remove evidence, and protected duplicates remain available", () => {
  for (const mode of ["shadow", "active"]) {
    const output = pack([lesson], { judgment: { mode, applied: false, decisions: [{ id: lesson.id, reason_codes: ["conflicting_evidence"] }] } });
    assert.equal(output.items.length, 1);
  }
  const copy = { ...lesson, id: "protected-copy" };
  assert.equal(pack([lesson, copy], { protectedIds: [lesson.id, copy.id], tokenBudget: 3000 }).items.length, 2);
  assert.equal(pack([{ ...lesson, content: "SQLite ".repeat(8000) }], { protectedIds: [lesson.id] }).items.length, 0);
});

test("technical memories can contain literal tokenizer markers", () => {
  const item = { ...lesson, content: "Treat <|endoftext|> and <|endofprompt|> as literal data in this fixture." };
  assert.equal(pack([item]).response.evidence_bundle.evidence[0].text, item.content);
});

test("code-mode wrappers report an evidence gap without fabricating native nested calls", () => {
  const diagnostics = collectCoverageReviewSignals([
    { payload: { type: "custom_tool_call", name: "exec", call_id: "wrapper", input: 'text(await tools.orgbrain_context_enrich({project_id:"p"}));' } },
    { payload: { type: "custom_tool_call_output", call_id: "wrapper", output: '{"evidence_bundle":{"evidence_status":"insufficient"}}' } }
  ], "p");
  assert.equal(diagnostics.opaque_tool_wrappers, 1);
  assert.equal(diagnostics.recall_misses, 0);
  assert.deepEqual(diagnostics.successful_actions_after_miss, []);
});

test("a later complete extraction survives early incomplete candidates and retains provenance", () => {
  const strong = "We decided to serialize SQLite diagnostics because concurrent writers contend on the same local database; when diagnosing SQLite lock errors, run the checks sequentially using scripts/local-memory.test.mjs and docs/MEMORY_USE_HISTORY.md.";
  const result = extractDurableMemoryDrafts({ source: "test", project_id: "org-brain", event_id: "ordered-turn",
    text: ["We decided to use the shared adapter for the application.",
      "Never print credentials in the application debug logs.",
      "Always keep the runtime configuration in the repository.", strong].join("\n\n") }, { capture_profile: MEMORY_CAPTURE_HOOK_PROFILE });
  assert.equal(result.drafts.length + result.review_drafts.length, 3);
  assert.ok(result.drafts.some((draft) => draft.content.includes("serialize SQLite")), JSON.stringify(result));
  assert.ok(result.drafts[0].evidence.some((item) => item.ref === "scripts/local-memory.test.mjs"));
  assert.ok(result.excluded.some((item) => item.reason === "candidate_limit"));
});

test("conflict, source shortage and token shortage clear earlier capture gaps", () => {
  const call = (id) => ({ payload: { type: "function_call", call_id: id, name: "orgbrain_context_enrich", arguments: '{"project_id":"p"}' } });
  const result = (id, bundle) => ({ payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ evidence_bundle: bundle }) } });
  for (const block of [{ evidence_status: "conflicted" }, { budget_limited: true }, { missing_evidence: ["insufficient_independent_sessions"] }]) {
    const signals = collectCoverageReviewSignals([call("miss"), result("miss", { evidence_status: "insufficient" }),
      call("blocked"), result("blocked", { ...block, abstention_recommended: true })], "p");
    assert.equal(signals.recall_misses, 1);
    assert.equal(signals.latest_retrieval, "blocked");
    assert.deepEqual(signals.successful_actions_after_miss, []);
  }
  assert.doesNotThrow(() => collectCoverageReviewSignals([call("legacy"), result("legacy", { missing_evidence: "unknown", evidence: [] })], "p"));
});

test("MCP defaults to bounded context with correct persisted receipts and retains full opt-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-efficiency-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {} });
    await store.capture({ ...lesson, id: undefined, tenant_id: "default", source: "test", external_key: "sqlite-lesson", confidence_score: 0.9 });
    const call = async (extra = {}) => {
      const response = await handleLocalMcpRequest(store, { method: "tools/call", params: {
        name: "orgbrain_context_enrich", arguments: { project_id: "org-brain", work_type: "implementation", query: "SQLite lock diagnostics", minimum_total_score: 0, ...extra }
      } });
      assert.equal(response.isError, false, response.content[0].text);
      return { payload: JSON.parse(response.content[0].text), text: response.content[0].text };
    };
    const { payload, text } = await call();
    assert.equal(payload.evidence_bundle.context_format, "compact");
    assert.ok(countContextTokens(text) <= 1500);
    assert.equal(payload.evidence_bundle.estimated_tokens, countContextTokens(text));
    assert.equal(payload.evidence_bundle.evidence[0].reuse_rule, lesson.reuse_rule);
    const db = store.open({ readOnly: true });
    try {
      const rows = db.prepare("SELECT id, source_id, used_state FROM memory_usage_items WHERE usage_event_id=?").all(payload.meta.usage_id);
      assert.deepEqual(rows.map((row) => row.id), payload.meta.usage_item_ids);
      assert.ok(rows.every((row) => row.used_state === "unknown"));
    } finally { db.close(); }
    assert.equal((await call({ context_format: "full" })).payload.evidence_bundle.context_format, undefined);
    const readonly = await handleLocalMcpRequest(store, { method: "tools/call", params: { name: "orgbrain_context_enrich",
      arguments: { project_id: "org-brain", work_type: "implementation", query: "SQLite diagnostics", context_format: "compact" } } }, { toolProfile: "answer-ux-readonly" });
    assert.equal(readonly.isError, true);
    assert.match(readonly.content[0].text, /compact_context_requires_default_profile/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Japanese terms across FTS token boundaries recover only fully matching scoped memories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-cjk-context-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {}, denseEmbeddingProvider: null });
    for (const [key, project, content] of [["match", "org-brain", "Cloudflareのデプロイ後は、稼働中APIの応答を確認する。"],
      ["partial", "org-brain", "Cloudflareの課金設定を確認する。"], ["foreign", "other", "Cloudflareのデプロイ後は、稼働中APIの応答を確認する。"]]) {
      await store.capture({ ...lesson, id: undefined, tenant_id: "default", project_id: project, content, summary: content,
        source: "fixture", external_key: key });
    }
    const results = await store.search({ tenant_id: "default", project_id: "org-brain", query: "Cloudflare デプロイ API 応答", minimum_total_score: 0.065 });
    assert.equal(results.length, 1);
    assert.equal(results[0].memory.external_key, "match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
