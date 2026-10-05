import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

async function fixture(fn, denseEmbeddingProvider = null) {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-fusion-"));
  const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {}, denseEmbeddingProvider });
  try { await store.init(); await fn(store); } finally { await rm(directory, { recursive: true, force: true }); }
}
const capture = (store, key, overrides = {}) => store.capture({ tenant_id: "t", project_id: "p", kind: "fact",
  lifecycle_state: "active", scope_type: "project", scope_key: "p", content: `Cache repair staging ${key} guidance.`,
  summary: key, tags: [], entities: [], source: "synthetic", external_key: key,
  source_references: [{ type: "file", ref: `fixture/${key}` }], rationale: "fixture", reuse_rule: "staging only",
  evidence: [], conflicts: [], permissions: [], ...overrides });

test("repeated segment units cannot inflate one parent's fusion score", async () => fixture(async (store) => {
  const verbose = await capture(store, "verbose"), quiet = await capture(store, "quiet");
  const request = { tenant_id: "t", project_id: "p", query: "cache repair", search_mode: "hybrid_v4", limit: 5 };
  const before = await store.search(request);
  const db = store.open();
  try {
    const columns = db.prepare("PRAGMA table_info(memory_retrieval_units_v4)").all().map((row) => row.name);
    const unit = db.prepare("SELECT * FROM memory_retrieval_units_v4 WHERE memory_id=? AND unit_type='segment' LIMIT 1").get(verbose.memory_id);
    assert.ok(unit);
    const insert = db.prepare(`INSERT INTO memory_retrieval_units_v4 (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const fts = db.prepare("INSERT INTO memory_retrieval_units_v4_fts(unit_id,memory_id,tenant_id,text) VALUES(?,?,?,?)");
    for (let i = 0; i < 200; i++) {
      const duplicate = { ...unit, id: `duplicate-${i}`, content_hash: `duplicate-${i}` };
      insert.run(...columns.map((name) => duplicate[name]));
      fts.run(duplicate.id, duplicate.memory_id, duplicate.tenant_id, duplicate.text);
    }
  } finally { db.close(); }
  const after = await store.search(request);
  assert.ok(after.some((entry) => entry.memory.id === quiet.memory_id));
  const score = (rows, id) => rows.find((entry) => entry.memory.id === id).score.total;
  assert.ok(score(after, verbose.memory_id) <= score(before, verbose.memory_id) + .01);
}));

test("strong dense discovery survives a crowded pool with current version and scope checks", async () => {
  const provider = { provider: "synthetic-dense", dimensions: 2,
    embedDocuments: async (texts) => texts.map((text) => text.includes("Semantic resolution") ? [1, 0] : [0, 1]),
    embedQuery: async () => [1, 0] };
  await fixture(async (store) => {
    for (let i = 0; i < 60; i++) await capture(store, `lexical-${i}`);
    const answer = await capture(store, "answer", { content: "Semantic resolution for a stalled staging system." });
    const denied = await capture(store, "denied", { content: "Semantic resolution hidden from alice.", permissions: [{ principal_id: "bob", permissions: ["read"] }] });
    const other = await capture(store, "other", { content: "Semantic resolution in a different project.", project_id: "other", scope_key: "other" });
    const response = await store.search({ tenant_id: "t", project_id: "p", principal_id: "alice", query: "cache repair", search_mode: "hybrid_v4", limit: 50 });
    assert.ok(response.length <= 50);
    const found = response.find((entry) => entry.memory.id === answer.memory_id);
    assert.ok(found); assert.equal(found.memory.current_version, 1);
    await store.revise("t", answer.memory_id, { content: "Semantic resolution updated for a stalled staging system." });
    const revised = await store.search({ tenant_id: "t", project_id: "p", principal_id: "alice", query: "cache repair", search_mode: "hybrid_v4", limit: 50 });
    assert.ok(!revised.some((entry) => entry.memory.id === answer.memory_id), "a removed old embedding cannot stand in for a revised source");
    await store.rebuildDenseEmbeddings({ tenant_id: "t", project_id: "p", memory_ids: [answer.memory_id] });
    const reindexed = await store.search({ tenant_id: "t", project_id: "p", principal_id: "alice", query: "cache repair", search_mode: "hybrid_v4", limit: 50 });
    assert.equal(reindexed.find((entry) => entry.memory.id === answer.memory_id).memory.current_version, 2);
    assert.ok(!response.some((entry) => [denied.memory_id, other.memory_id].includes(entry.memory.id)));
    await store.suppress("t", answer.memory_id, "retracted fixture");
    const fresh = await store.search({ tenant_id: "t", project_id: "p", principal_id: "alice", query: "cache repair", search_mode: "hybrid_v4", limit: 50 });
    assert.ok(!fresh.some((entry) => entry.memory.id === answer.memory_id));
  }, provider);
});
