import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localTaskQueryPlan, matchesLocalTaskQuery } from "../packages/orgbrain-cli/src/lib/local-task-query.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { memories, positiveCases, negativeCases, seedRecallFixture } from "./fixtures/natural-query-recall.mjs";

async function fixture(run, isolated = null) {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-task-query-test-"));
  try {
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {}, denseEmbeddingProvider: null,
      memoryJudge: async () => ({ mode: "off", applied: false, status: "disabled", decisions: [] }), contextSearchJudge: null });
    const ids = await seedRecallFixture(store, isolated);
    await run(store, ids);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const search = (store, query, overrides = {}) => store.search({ tenant_id: "recall", project_id: "fixture",
  principal_id: "reader", work_type: "implementation", query, minimum_total_score: 0.065, limit: 3, ...overrides });
async function enrich(store, query, overrides = {}) {
  const result = await handleLocalMcpRequest(store, { method: "tools/call", params: {
    name: "orgbrain_context_enrich", arguments: { tenant_id: "recall", project_id: "fixture", principal_id: "reader",
      work_type: "implementation", query, top_k: 3, token_budget: 1500, usage_purpose: "test", ...overrides }
  } });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test("task query planning removes request scaffolding, preserves all subjects and groups inflections", () => {
  const plan = localTaskQueryPlan("Please investigate SQLite diagnostics and database lock errors in this repository.");
  assert.deepEqual(plan.groups, [["sqlite"], ["diagnostics", "diagnostic"], ["database"], ["lock"], ["errors", "error"]]);
  assert.match(plan.fts, /\("errors" OR "error"\)/u);
  assert.equal(matchesLocalTaskQuery(memories.find((m) => m.key === "sqlite"), plan), true);
  const unknown = localTaskQueryPlan("Please investigate SQLite diagnostics database lock ErrorXYZ732.");
  assert.equal(matchesLocalTaskQuery(memories.find((m) => m.key === "sqlite"), unknown), false);
  assert.equal(localTaskQueryPlan("please explain"), null);
  assert.equal(localTaskQueryPlan("SQLite"), null);
  assert.equal(localTaskQueryPlan(Array.from({ length: 17 }, (_, i) => `subject${i}`).join(" ")), null);
  assert.equal(localTaskQueryPlan("x".repeat(8193)), null);
});

test("Japanese mixed script and NFKC use word boundaries; substring decoys do not qualify", () => {
  const plan = localTaskQueryPlan("ＣｌｏｕｄｆｌａｒｅのデプロイとＡＰＩの応答について調査してください。");
  assert.deepEqual(plan.groups, [["cloudflare"], ["デプロイ"], ["api"], ["応答"]]);
  assert.equal(matchesLocalTaskQuery(memories.find((m) => m.key === "cloudflare"), plan), true);
  assert.equal(matchesLocalTaskQuery({ content: "scar postgresql" }, localTaskQueryPlan("car postgres")), false);
  assert.equal(matchesLocalTaskQuery({ content: "Git worktree workspace mapping" },
    localTaskQueryPlan("Git worktree workspace mapping plus payroll")), false);
});

test("all bounded natural subjects qualify at the unchanged final score floor, with precise top three", async () => {
  await fixture(async (store, ids) => {
    for (const item of positiveCases.filter((c) => c.category !== "original-full")) {
      const results = await search(store, item.query);
      assert.deepEqual(results.map((r) => ids.get(r.memory.id)).sort(), [...item.expected].sort(), item.id);
      assert.ok(results.every((r) => r.score.total >= 0.065), item.id);
      assert.ok(results.every((r) => r.memory.verification_state === "unverified"), "retrieval must not promote verification");
    }
    assert.equal((await search(store, positiveCases[9].query, { limit: 1 })).length, 1);
    assert.equal((await search(store, positiveCases[9].query, { minimum_total_score: 1 })).length, 0);
  });
});

test("context keeps source-independence, complete conditions, conflict and permission gates", async () => {
  await fixture(async (store) => {
    for (const id of ["workspace-en", "sqlite-en"]) {
      const response = await enrich(store, positiveCases.find((c) => c.id === id).query);
      assert.equal(response.results.length, 0);
      assert.ok(response.evidence_bundle.missing_evidence.includes("insufficient_independent_sessions"));
    }
    const response = await enrich(store, positiveCases.find((c) => c.id === "cloudflare-ja").query);
    assert.equal(response.results.length, 1);
    const evidence = response.evidence_bundle.evidence[0];
    assert.equal(evidence.rationale, memories.find((m) => m.key === "cloudflare").rationale);
    assert.equal(evidence.reuse_rule, memories.find((m) => m.key === "cloudflare").reuse_rule);
    assert.equal(evidence.verification_state, "unverified");
    assert.ok(response.evidence_bundle.estimated_tokens <= 1500);
  });
  for (const isolated of ["conflict", "permissions"]) await fixture(async (store) => {
    const item = negativeCases.find((c) => c.isolated === isolated);
    const response = await enrich(store, item.query);
    assert.equal(response.results.length, 0, isolated);
    assert.equal(response.evidence_bundle.abstention_recommended, true);
  }, isolated);
});

test("unknown and multiple topics, tenant and project boundaries do not gain relevance", async () => {
  await fixture(async (store) => {
    for (const item of negativeCases.filter((c) => !c.isolated)) {
      const result = await search(store, item.query, {
        tenant_id: item.tenant_id ?? "recall", project_id: item.project_id ?? "fixture"
      });
      assert.equal(result.length, 0, item.id);
    }
  });
});

test("rescue cannot surface suppressed, future, expired, or unauthorized memories", async () => {
  await fixture(async (store) => {
    for (const [index, extra] of [
      { lifecycle_state: "suppressed" }, { valid_from: Date.now() + 86_400_000 },
      { valid_until: Date.now() - 86_400_000 }, { expires_at: Date.now() - 86_400_000 },
      { permissions: [{ principal_type: "principal", principal_id: "owner", permissions: ["read"] }] }
    ].entries()) {
      await store.capture({ tenant_id: "recall", project_id: `boundary-${index}`, source: "fixture",
        external_key: "hidden", kind: "pitfall", work_type: "implementation", ...memories[0], ...extra });
      const response = await enrich(store, positiveCases.find((c) => c.id === "workspace-ja").query,
        { project_id: `boundary-${index}` });
      assert.equal(response.results.length, 0, JSON.stringify(extra));
    }
  });
});

test("many partial-word decoys cannot displace the all-subject candidate", async () => {
  await fixture(async (store, ids) => {
    for (let i = 0; i < 55; i++) {
      await store.capture({ tenant_id: "recall", project_id: "fixture", source: "fixture", external_key: `decoy-${i}`,
        kind: "pitfall", work_type: "implementation", content: `SQLite diagnostics database-locksmith payroll decoy ${i}.`,
        summary: "SQLite diagnostics decoy", rationale: "A different subject.", reuse_rule: "Only for payroll.",
        source_references: [{ type: "file", ref: `fixtures/decoy-${i}.md` }] });
    }
    const results = await search(store, positiveCases.find((c) => c.id === "sqlite-en").query);
    assert.deepEqual(results.map((r) => ids.get(r.memory.id)), ["sqlite"]);
  });
});

test("low-floor automatic hooks still reject weather and unrelated installation requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-query-hook-"));
  try {
    const workspace = join(directory, "project"), workspacesFile = join(directory, "workspaces.json");
    await writeFile(workspacesFile, JSON.stringify({ version: 1,
      workspaces: { [workspace]: { tenant_id: null, project_id: "org-brain" } } }));
    const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {}, denseEmbeddingProvider: null });
    await store.capture({ tenant_id: "default", project_id: "org-brain", work_type: "other", kind: "decision",
      content: "Use the Codex notify and prompt hooks with a short-lived Node CLI. Avoid a resident MCP server and do not call an LLM from either hook.",
      summary: "Use short-lived Codex hooks instead of resident MCP or extra LLM calls.",
      tags: ["codex", "hooks"], source: "test", external_key: "codex-hook-design", confidence_score: 0.9, utility_score: 0.8 });
    for (const prompt of ["What is the weather forecast for the mountain tomorrow?", "Install TypeSafe AI and configure OpenRouter"]) {
      const response = await buildCodexMemoryContext({ hook_event_name: "UserPromptSubmit", cwd: workspace, prompt },
        { store, workspace, workspacesFile, env: { ORGBRAIN_WORKSPACES_FILE: workspacesFile,
          ORGBRAIN_ENABLE_CLOUD_MEMORY: "false", ORGBRAIN_ENABLE_ORG_SHARING: "false" } });
      assert.equal(response, null, prompt);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
