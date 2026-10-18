import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  localDenseEmbeddingProviderFromEnvironment
} from "../packages/orgbrain-cli/src/lib/local-dense-embedding.mjs";

test("persistent dense settings apply only to their database and explicit environment overrides them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-gemma-settings-"));
  const dbPath = join(directory, "memory.sqlite");
  try {
    await writeFile(`${dbPath}.embedding.json`, JSON.stringify({
      version: 1, provider: "embeddinggemma2-ollama", dimensions: 768,
      model: "embeddinggemma-2:270m-bf16-text"
    }), {mode: 0o600});
    const store = new LocalMemoryStore(dbPath, {env: {}});
    assert.equal(store.denseEmbeddingProvider?.dimensions, 768);
    assert.match(store.denseEmbeddingProvider?.provider ?? "", /embeddinggemma-2/);
    const other = new LocalMemoryStore(join(directory, "other.sqlite"), {env: {}});
    assert.equal(other.denseEmbeddingProvider, null);
    const disabled = new LocalMemoryStore(dbPath, {env: {ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "off"}});
    assert.equal(disabled.denseEmbeddingProvider, null);
    await writeFile(`${dbPath}.embedding.json`, "{invalid json");
    assert.throws(() => new LocalMemoryStore(dbPath, {env: {}}), /local_embedding_settings_invalid/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("EmbeddingGemma 2 uses retrieval-specific inputs and 768-dimensional vectors", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ embeddings: body.input.map(() => Array(768).fill(0.25)) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = localDenseEmbeddingProviderFromEnvironment({
      ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "embeddinggemma2-ollama",
      ORGBRAIN_LOCAL_EMBEDDING_URL: `http://127.0.0.1:${server.address().port}`
    });
    assert.equal(provider.model, "embeddinggemma-2:270m-bf16-text");
    assert.equal(provider.dimensions, 768);
    assert.equal((await provider.embedQuery("以前の解決策は？")).length, 768);
    assert.equal((await provider.embedDocuments(["検証済みの解決策"]))[0].length, 768);
    assert.deepEqual(requests.map((request) => request.input), [
      ["task: search result | query: 以前の解決策は？"],
      ["title: none | text: 検証済みの解決策"]
    ]);
    assert.ok(requests.every((request) => request.dimensions === 768));
    assert.match(provider.provider, /embeddinggemma-2.*retrieval-v1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("EmbeddingGemma configuration preserves explicit sparse/off and Qwen defaults", () => {
  assert.equal(localDenseEmbeddingProviderFromEnvironment({}), null);
  assert.equal(localDenseEmbeddingProviderFromEnvironment({ ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "off" }), null);
  assert.equal(localDenseEmbeddingProviderFromEnvironment({ ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "sparse" }), null);
  const qwen = localDenseEmbeddingProviderFromEnvironment({ ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "qwen-ollama" });
  assert.equal(qwen.model, "qwen3-embedding:0.6b");
  assert.equal(qwen.dimensions, 1024);
  assert.equal(qwen.provider, "ollama:qwen3-embedding:0.6b");
  assert.throws(() => localDenseEmbeddingProviderFromEnvironment({
    ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "embeddinggemma2-ollama",
    ORGBRAIN_LOCAL_EMBEDDING_URL: "https://example.com"
  }), /must_be_loopback/);
  assert.throws(() => localDenseEmbeddingProviderFromEnvironment({
    ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "embeddinggemma2-ollama",
    ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS: "1024"
  }), /invalid_dimensions/);
});

test("EmbeddingGemma rejects a wrong-width response instead of claiming a valid embedding", async () => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* drain the bounded test request */ }
    response.end(JSON.stringify({ embeddings: [Array(1024).fill(0)] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = localDenseEmbeddingProviderFromEnvironment({
      ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "embeddinggemma2-ollama",
      ORGBRAIN_LOCAL_EMBEDDING_URL: `http://127.0.0.1:${server.address().port}`
    });
    await assert.rejects(provider.embedQuery("question"), /invalid_vector/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("compact context reports the dense query and scored index rows, with an accurate sparse fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-gemma-context-"));
  const dbPath = join(directory, "memory.sqlite");
  let queryCalls = 0;
  const provider = {
    provider: "ollama:embeddinggemma-2:test:retrieval-v1", dimensions: 768,
    async embedDocuments(texts) { return texts.map(() => Array(768).fill(0.1)); },
    async embedQuery() { queryCalls++; return Array(768).fill(0.1); }
  };
  try {
    const store = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: provider, relevanceSelector: null});
    await store.capture({
      tenant_id: "default", project_id: "test", kind: "fact", lifecycle_state: "active",
      scope_type: "project", scope_key: "test", content: "A database backup preserves the original records.",
      summary: "Database backup", tags: [], entities: [], source: "test", source_references: [],
      actor_type: "principal", actor_id: "tester", evidence: [], conflicts: [], permissions: []
    });
    const dense = await store.retrieveContext({tenant_id: "default", query: "database backup", context_format: "compact", token_budget: 3000});
    assert.equal(queryCalls, 1);
    assert.equal(dense.meta.retrieval.dense_provider, provider.provider);
    assert.equal(dense.meta.retrieval.query_embedding_completed, true);
    assert.ok(dense.meta.retrieval.dense_scored_unit_count > 0);
    assert.ok(!dense.evidence_bundle.degraded_reasons.includes("local_sparse_retrieval"));
    const sparse = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: null, relevanceSelector: null});
    const fallback = await sparse.retrieveContext({tenant_id: "default", query: "database backup", context_format: "compact", token_budget: 3000});
    assert.equal(fallback.meta.retrieval.query_embedding_completed, false);
    assert.ok(fallback.evidence_bundle.degraded_reasons.includes("local_sparse_retrieval"));
    const mismatched = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: {...provider, provider: "ollama:other-model"}, relevanceSelector: null});
    const missingIndex = await mismatched.retrieveContext({tenant_id: "default", query: "database backup", context_format: "compact", token_budget: 3000});
    assert.equal(missingIndex.meta.retrieval.query_embedding_completed, true);
    assert.equal(missingIndex.meta.retrieval.dense_scored_unit_count, 0);
    assert.ok(missingIndex.evidence_bundle.degraded_reasons.includes("local_sparse_retrieval"));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("dense counters exclude unreadable records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-gemma-eligibility-"));
  const dbPath = join(directory, "memory.sqlite");
  const provider = {
    provider: "ollama:embeddinggemma-2:test:retrieval-v1", dimensions: 768,
    async embedDocuments(texts) { return texts.map(() => Array(768).fill(0.1)); },
    async embedQuery() { return Array(this.dimensions).fill(0.1); }
  };
  try {
    const store = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: provider});
    await store.capture({tenant_id: "default", project_id: "test", kind: "fact",
      lifecycle_state: "active", scope_type: "project", scope_key: "test", content: "Private alpha backup",
      summary: "Private alpha backup", permissions: [{principal_id: "alice", permissions: ["read"]}], tags: [], entities: [], source: "test",
      source_references: [], actor_type: "principal", actor_id: "alice", conflicts: [], evidence: []});
    const denied = {};
    const deniedResults = await store.search({tenant_id: "default", query: "private alpha backup", principal_id: "bob", retrieval_metadata: denied});
    assert.equal(deniedResults.length, 0);
    assert.equal(denied.dense_scored_unit_count, 0);
    assert.equal(denied.dense_candidate_count, 0);
    const allowed = {};
    await store.search({tenant_id: "default", query: "private alpha backup", principal_id: "alice", retrieval_metadata: allowed});
    assert.ok(allowed.dense_scored_unit_count > 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("changing vector width requires a matching rebuilt index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-gemma-width-"));
  const dbPath = join(directory, "memory.sqlite");
  const provider = {
    provider: "ollama:embeddinggemma-2:test:retrieval-v1", dimensions: 768,
    async embedDocuments(texts) { return texts.map(() => Array(768).fill(0.1)); },
    async embedQuery() { return Array(this.dimensions).fill(0.1); }
  };
  try {
    const store = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: provider});
    await store.capture({tenant_id: "default", project_id: "test", kind: "fact",
      lifecycle_state: "active", scope_type: "project", scope_key: "test", content: "Private alpha backup",
      summary: "Private alpha backup", permissions: [], tags: [], entities: [], source: "test",
      source_references: [], actor_type: "principal", actor_id: "alice", conflicts: [], evidence: []});
    const smaller = new LocalMemoryStore(dbPath, {denseEmbeddingProvider: {...provider, dimensions: 128}});
    const wrongWidth = {};
    await smaller.search({tenant_id: "default", query: "unrelated nebula", principal_id: "alice", retrieval_metadata: wrongWidth});
    assert.equal(wrongWidth.query_embedding_completed, true);
    assert.equal(wrongWidth.dense_scored_unit_count, 0);
    assert.equal(wrongWidth.dense_candidate_count, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
