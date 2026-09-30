import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { enqueueJudgmentCapture, drainJudgmentCapture } from "../packages/orgbrain-cli/src/lib/local-memory-judge-queue.mjs";

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), "jev-paths-"));
  const dbPath = join(directory, "memory.sqlite");
  const store = new LocalMemoryStore(dbPath, { env: {}, denseEmbeddingProvider: null });
  try { await store.init(); await fn(store, dbPath); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function seed(store, key, kind = "fact") {
  return store.capture({ tenant_id: "default", project_id: "p", kind, lifecycle_state: "active", scope_type: "project", scope_key: "p",
    content: `timeout staging ${key}`, summary: `timeout staging ${key}`, tags: [], entities: [], source: "test", source_references: [],
    external_key: key, rationale: "observed", reuse_rule: "staging only", evidence: [], conflicts: [], permissions: [] });
}

test("search filters before usage recording, preserves protected rules, and keeps audits complete", async () => {
  await fixture(async (store) => {
    await seed(store, "keep"); await seed(store, "omit"); await seed(store, "protected", "constraint");
    store.memoryJudge = async ({ candidates }) => ({ mode: "active", applied: true,
      decisions: candidates.map((c) => ({ id: c.id, action: c.text.endsWith("keep") ? "retain" : "omit", requires_review: false })) });
    const call = async (purpose) => {
      const result = await handleLocalMcpRequest(store, { method: "tools/call", params: { name: "orgbrain_memory_search",
        arguments: { tenant_id: "default", project_id: "p", query: "timeout staging", usage_purpose: purpose } } });
      assert.equal(result.isError, false);
      return JSON.parse(result.content[0].text);
    };
    const task = await call("task");
    assert.equal(task.results.length, 2);
    assert.equal(task.meta.usage_items.length, 2);
    assert.ok(task.results.some((r) => r.memory.kind === "constraint"));
    const audit = await call("audit");
    assert.equal(audit.results.length, 3);
    assert.equal(audit.meta.usage_items.length, 3);
  });
});

test("maintenance sends eligible uncertain candidates to one batch evaluator without granting promotion", async () => {
  await fixture(async (_store, dbPath) => {
    const commitments = new TaskCommitmentStore(dbPath);
    await commitments.saveLearningCandidates({ tenantId: "default", projectId: "p", candidates: [1, 2, 3].map((i) => ({
      external_key: `batch:${i}`, item: { content: `rule ${i}` }, reason_codes: ["review_required"]
    })) });
    let calls = 0, promotions = 0;
    const result = await commitments.maintainLearningCandidates({ tenantId: "default", now: Date.now() + 1,
      evaluateBatch: async (items) => { calls++; return items.map((item) => ({ id: item.id, route: "active", verified: false, consensus_pass: false })); },
      promote: async () => { promotions++; return { ok: true }; } });
    assert.equal(calls, 1); assert.equal(promotions, 0); assert.equal(result.promoted, 0);
  });
});

test("cost capture queue judges a project batch once and restores each admitted job on abstention", async () => {
  await fixture(async (_store, dbPath) => {
    const env = { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: "active", ORGBRAIN_JEV_OBJECTIVE: "cost" };
    for (const key of ["first", "second"]) await enqueueJudgmentCapture({ dbPath, tenantId: "default", projectId: "p", source: "test", env,
      records: [{ projectId: "p", content: key, externalKey: key }] });
    let calls = 0, saves = 0;
    const result = await drainJudgmentCapture({ dbPath, projectId: "p", env,
      judge: async ({ candidates }) => { calls++; return { mode: "active", applied: false, status: "fallback", decisions: candidates.map((c) => ({ id: c.id, action: "review" })) }; },
      capture: async (_source, _tenant, records) => { saves += records.length; return records; } });
    assert.equal(calls, 1); assert.equal(saves, 2); assert.equal(result.processed, 2);
  });
});
