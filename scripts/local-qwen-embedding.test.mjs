import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cosineSimilarity,
  decodeFloat32Vector,
  encodeFloat32Vector,
  OllamaEmbeddingProvider
} from "../packages/orgbrain-cli/src/lib/local-dense-embedding.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const fixtureUrl = new URL(
  "../packages/shared/test/fixtures/local-qwen-session-regression-v1.json",
  import.meta.url
);

function learningText(session) {
  return [
    `Trigger: ${session.trigger}`,
    `Conclusion: ${session.conclusion}`,
    `Rationale: ${session.rationale}`,
    `Reuse rule: ${session.reuse_rule}`,
    `Outcome: ${session.outcome}`
  ].join("\n");
}

function score(rows, returnedByQuery, k = 5) {
  let hits = 0;
  let reciprocalRank = 0;
  const items = [];
  for (const row of rows) {
    const returned = (returnedByQuery.get(row.query) ?? []).slice(0, k);
    const rank = returned.indexOf(row.expected_id);
    if (rank >= 0) {
      hits += 1;
      reciprocalRank += 1 / (rank + 1);
    }
    items.push({ query: row.query, expected_id: row.expected_id, rank: rank + 1, returned_ids: returned });
  }
  return {
    count: rows.length,
    recall_at_5: Number((hits / rows.length).toFixed(4)),
    mrr: Number((reciprocalRank / rows.length).toFixed(4)),
    items
  };
}

test("Float32 persistence preserves cosine ranking", () => {
  const vector = [0.25, -0.5, 0.75, 1];
  const decoded = decodeFloat32Vector(encodeFloat32Vector(vector), vector.length);
  assert.deepEqual(decoded, vector);
  assert.ok(cosineSimilarity(vector, decoded) > 0.999999);
});

test("Qwen dense embeddings retrieve paraphrased lessons better than sparse fallback", async (context) => {
  if (process.env.ORGBRAIN_LOCAL_EMBEDDING_PROVIDER !== "qwen-ollama") {
    context.skip("run through `pnpm test:local-qwen` so the test owns the Ollama lifecycle");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-qwen-regression-"));
  await chmod(directory, 0o700);
  const dbPath = join(directory, "memory.sqlite");
  try {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const provider = new OllamaEmbeddingProvider({
      endpoint: process.env.ORGBRAIN_LOCAL_EMBEDDING_URL,
      model: process.env.ORGBRAIN_LOCAL_EMBEDDING_MODEL,
      dimensions: 1024,
      timeoutMs: 60_000
    });
    const denseStore = new LocalMemoryStore(dbPath, { denseEmbeddingProvider: provider });
    const now = Date.now();
    const captures = await denseStore.captureBatch(fixture.sessions.map((session, index) => ({
      id: session.session_id,
      tenant_id: "regression",
      project_id: "local-qwen",
      kind: session.kind,
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: "local-qwen",
      content: learningText(session),
      summary: session.conclusion,
      tags: ["verified-learning", session.lesson_type],
      entities: [],
      source: "synthetic-session-fixture",
      source_references: [{ type: "session", ref: session.session_id }],
      external_key: `fixture:${fixture.fixture_id}:${session.session_id}`,
      actor_type: "hook",
      actor_id: "local-qwen-regression",
      confidence_score: 0.95,
      utility_score: 0.95,
      rationale: session.rationale,
      reuse_rule: session.reuse_rule,
      evidence: [{ type: "synthetic_fixture", ref: `${fixture.fixture_id}:${index}` }],
      conflicts: [],
      permissions: [],
      capture_origin: "observed",
      verification_state: "verified",
      verified_at: now,
      learning: {
        schema_version: 1,
        lesson_type: session.lesson_type,
        kind: session.kind,
        trigger: session.trigger,
        conclusion: session.conclusion,
        rationale: session.rationale,
        reuse_rule: session.reuse_rule,
        outcome: session.outcome,
        applicability: { target_files: [], components: ["org-brain"] },
        evidence_selectors: [{ type: "synthetic_fixture", ref: session.session_id }],
        gaps: []
      },
      quality_dimensions: {
        atomicity: 100,
        evidence_support: 100,
        reuse_specificity: 100,
        privacy: 100
      }
    })));

    assert.ok(captures.every((capture) => capture.embedding_projection?.state === "indexed"));
    const { state: projectionState, ...projection } = captures[0].embedding_projection;
    assert.equal(projectionState, "indexed");
    assert.equal(projection.provider, "ollama:qwen3-embedding:0.6b");
    assert.equal(projection.dimensions, 1024);
    assert.ok(projection.indexed >= fixture.sessions.length);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const embeddingAudit = db.prepare(
      `SELECT COUNT(*) AS count,
              MIN(feature_count) AS min_dimensions,
              MAX(feature_count) AS max_dimensions,
              MIN(length(vector_blob)) AS min_bytes,
              MAX(length(vector_blob)) AS max_bytes
       FROM memory_retrieval_unit_embeddings_v4
       WHERE tenant_id = 'regression'
         AND provider = 'ollama:qwen3-embedding:0.6b'
         AND vector_format = 'dense-f32'`
    ).get();
    db.close();
    assert.equal(Number(embeddingAudit.count), projection.indexed);
    assert.equal(Number(embeddingAudit.min_dimensions), 1024);
    assert.equal(Number(embeddingAudit.max_dimensions), 1024);
    assert.equal(Number(embeddingAudit.min_bytes), 4096);
    assert.equal(Number(embeddingAudit.max_bytes), 4096);

    const sparseStore = new LocalMemoryStore(dbPath, { denseEmbeddingProvider: null });
    const queries = fixture.sessions.flatMap((session) =>
      session.queries.map((query) => ({ query, expected_id: session.session_id }))
    );
    const sparseReturned = new Map();
    const denseReturned = new Map();
    for (const row of queries) {
      const sparse = await sparseStore.search({
        tenant_id: "regression",
        project_id: "local-qwen",
        query: row.query,
        search_mode: "hybrid_v4",
        limit: 5
      });
      sparseReturned.set(row.query, sparse.map((entry) => entry.memory.id));
      const dense = await denseStore.search({
        tenant_id: "regression",
        project_id: "local-qwen",
        query: row.query,
        search_mode: "hybrid_v4",
        limit: 5
      });
      denseReturned.set(row.query, dense.map((entry) => entry.memory.id));
    }

    const sparseScore = score(queries, sparseReturned);
    const qwenScore = score(queries, denseReturned);
    process.stdout.write(`${JSON.stringify({
      fixture_id: fixture.fixture_id,
      projection,
      sparse: { count: sparseScore.count, recall_at_5: sparseScore.recall_at_5, mrr: sparseScore.mrr },
      qwen: { count: qwenScore.count, recall_at_5: qwenScore.recall_at_5, mrr: qwenScore.mrr },
      qwen_non_top1: qwenScore.items.filter((item) => item.rank !== 1)
    })}\n`);
    assert.ok(qwenScore.recall_at_5 >= 0.95, `Qwen Recall@5 was ${qwenScore.recall_at_5}`);
    assert.ok(qwenScore.mrr >= 0.95, `Qwen MRR was ${qwenScore.mrr}`);
    assert.ok(
      qwenScore.mrr >= sparseScore.mrr + 0.2,
      `expected Qwen MRR to improve by at least 0.2; sparse=${sparseScore.mrr}, qwen=${qwenScore.mrr}`
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
