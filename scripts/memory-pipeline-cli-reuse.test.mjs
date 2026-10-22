import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { runSelectedPipeline } from "../packages/orgbrain-cli/src/lib/memory-pipeline-cli.mjs";
import { reviewPipelineCandidate } from "../packages/orgbrain-cli/src/lib/memory-pipeline-review.mjs";
import { pipelineStatus, runMemoryPipeline } from "../packages/orgbrain-cli/src/lib/memory-pipeline.mjs";
import { loadSessionPipelinePacket } from "../packages/orgbrain-cli/src/lib/memory-pipeline-sources.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const projectId = "org-brain";
const tenantId = "default";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-pipeline-cli-reuse-"));
  const queueDir = path.join(root, "queue");
  await mkdir(queueDir);
  const queueDb = new DatabaseSync(path.join(queueDir, "queue.sqlite"));
  queueDb.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, client TEXT,
    packet_json TEXT, packet_hash TEXT, status TEXT, policy_hash TEXT,
    created_at INTEGER, month TEXT, charged INTEGER, error TEXT
  )`);
  const store = new LocalMemoryStore(path.join(root, "memory.sqlite"), {
    memoryJudge: null,
    denseEmbeddingProvider: null,
    relevanceSelector: null,
  });
  await store.init();
  return {
    root,
    queueDir,
    queueDb,
    store,
    close: async () => {
      queueDb.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function addPacket(f, jobId) {
  const packet = {
    policy: "session-extraction/v1",
    tenant_id: tenantId,
    project_id: projectId,
    snippets: [{
      span_id: `tool-${jobId[0]}`,
      role: "tool",
      source: "tool_result",
      text: "The local verification completed successfully.",
    }],
    events: [{ event_id: `event-${jobId[0]}`, call_id: `call-${jobId[0]}`, type: "tool_execution", name: "test", status: "completed" }],
  };
  f.queueDb.prepare(`INSERT INTO jobs
    (id,tenant_id,project_id,client,packet_json,packet_hash,status,policy_hash,created_at,month,charged,error)
    VALUES(?,?,?,?,?,?,?, ?,0,'2026-10',0,NULL)`).run(
    jobId,
    tenantId,
    projectId,
    "codex",
    JSON.stringify(packet),
    sha256(JSON.stringify(packet)),
    "completed",
    "fixture-policy",
  );
}

const candidate = (spanId) => ({
  content: "The local verification completed successfully.",
  rationale: "The retained tool result records the completed check.",
  reuse_rule: "Use this result only for the same verified source.",
  kind: "fact",
  support_refs: [spanId],
});

function acceptedReview(args) {
  return reviewPipelineCandidate({
    ...args,
    runJudge: async ({ profile }) => ({
      model: profile === "durability_atomicity" ? "google/gemini-3.8-flash" : "anthropic/claude-sonnet-5.5",
      provider: "fixture",
      verdict: "pass",
      confidence: 0.99,
      reasons: ["Grounded in the retained fixture."],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  });
}

function inferenceOptions({ abstain = false, verdict = "pass", calls = {} } = {}) {
  return {
    env: {},
    extractorFactory: () => {
      calls.extractorFactory = (calls.extractorFactory ?? 0) + 1;
      return async ({ snapshot }) => ({
        candidate: abstain ? null : candidate(snapshot.snippets[0].span_id),
        model: "fixture/extractor",
        provider: "fixture",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
    judgeFactory: () => {
      calls.judgeFactory = (calls.judgeFactory ?? 0) + 1;
      return async ({ profile }) => ({
        model: profile === "durability_atomicity" ? "google/gemini-3.8-flash" : "anthropic/claude-sonnet-5.5",
        provider: "fixture",
        verdict,
        confidence: 0.99,
        reasons: ["Grounded in the retained fixture."],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  };
}

function denseFixtureProvider({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: "fixture:local-dense-v1",
    dimensions: 32,
    async embedDocuments(texts) {
      calls.push(texts.length);
      if (fail) throw new Error("fixture provider failure");
      return texts.map(() => Array(32).fill(0.125));
    },
  };
}

function denseRowsForMemory(db, memoryId, provider) {
  return db.prepare(`SELECT COUNT(*) AS n
    FROM memory_retrieval_unit_embeddings_v4 e
    JOIN memory_retrieval_units_v4 u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id
    WHERE u.memory_id=? AND e.provider=? AND e.vector_format='dense-f32' AND e.vector_blob IS NOT NULL`).get(memoryId, provider).n;
}

function pipelineBudgetRows(f) {
  return f.queueDb.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(charged),0) AS charged FROM jobs WHERE id LIKE 'pipeline:%'").get();
}

test("cached active session replay needs no OpenRouter key and creates no inference budget row", async () => {
  const f = await fixture();
  try {
    const jobId = "a".repeat(64);
    addPacket(f, jobId);
    const input = { source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId };
    const load = () => loadSessionPipelinePacket({
      queueDir: f.queueDir,
      tenantId,
      projectId,
      jobId,
    });
    const snapshot = await load();
    const extracted = candidate(snapshot.snippets[0].span_id);
    const seed = await runMemoryPipeline({
      store: f.store,
      snapshot,
      extract: async () => ({ candidate: extracted }),
      review: acceptedReview,
      reload: load,
    });
    assert.equal(seed.status, "active");
    const denseProvider = denseFixtureProvider();
    f.store.denseEmbeddingProvider = denseProvider;

    const replay = await runSelectedPipeline(f.store, input, { env: {} });
    assert.equal(replay.status, "active");
    assert.equal(replay.replayed, true);
    assert.equal(replay.memory_id, seed.memory_id);
    const budget = pipelineBudgetRows(f);
    assert.equal(budget.n, 0);
    assert.equal(budget.charged, 0);
    assert.equal(denseProvider.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("new active admission indexes only its own memory units through the configured local provider", async () => {
  const f = await fixture();
  try {
    const prior = await f.store.capture({
      tenant_id: tenantId,
      project_id: projectId,
      kind: "fact",
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: projectId,
      content: "Previously captured fixture memory.",
      summary: "Previously captured fixture memory.",
      tags: [],
      entities: [],
      source: "test",
      source_references: [],
      actor_type: "principal",
      actor_id: "tester",
      evidence: [],
      conflicts: [],
      permissions: [],
    });
    const denseProvider = denseFixtureProvider();
    f.store.denseEmbeddingProvider = denseProvider;
    const jobId = "c".repeat(64);
    addPacket(f, jobId);
    const input = { source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId };

    const result = await runSelectedPipeline(f.store, input, inferenceOptions());

    assert.equal(result.status, "active");
    assert.equal(result.replayed, undefined);
    assert.equal(result.dense_projection.state, "indexed");
    assert.equal(result.dense_projection.provider, denseProvider.provider);
    assert.equal(result.dense_projection.dimensions, denseProvider.dimensions);
    assert.ok(result.dense_projection.indexed > 0);
    assert.equal(denseProvider.calls.length, 1);
    const db = f.store.open({ readOnly: true });
    try {
      assert.equal(denseRowsForMemory(db, result.memory_id, denseProvider.provider), result.dense_projection.indexed);
      assert.equal(denseRowsForMemory(db, prior.memory_id, denseProvider.provider), 0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("abstained and rejected sources never invoke dense projection", async () => {
  const f = await fixture();
  try {
    const denseProvider = denseFixtureProvider();
    f.store.denseEmbeddingProvider = denseProvider;
    const abstainJobId = "d".repeat(64);
    addPacket(f, abstainJobId);
    const abstained = await runSelectedPipeline(f.store, {
      source: "session", job_id: abstainJobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId,
    }, inferenceOptions({ abstain: true }));
    assert.equal(abstained.status, "abstained");
    assert.equal(abstained.dense_projection, undefined);

    const rejectJobId = "e".repeat(64);
    addPacket(f, rejectJobId);
    const rejected = await runSelectedPipeline(f.store, {
      source: "session", job_id: rejectJobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId,
    }, inferenceOptions({ verdict: "fail" }));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.dense_projection, undefined);
    assert.equal(denseProvider.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("active admission remains intact and reports pending when dense projection fails", async () => {
  const f = await fixture();
  try {
    const denseProvider = denseFixtureProvider({ fail: true });
    f.store.denseEmbeddingProvider = denseProvider;
    const jobId = "f".repeat(64);
    addPacket(f, jobId);
    const input = { source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId };

    const result = await runSelectedPipeline(f.store, input, inferenceOptions());

    assert.equal(result.status, "active");
    assert.equal(result.dense_projection.state, "pending");
    assert.equal(result.dense_projection.reason, "projection_failed");
    assert.equal(result.dense_projection.provider, denseProvider.provider);
    assert.equal(denseProvider.calls.length, 1);
    const status = await pipelineStatus(f.store, { tenantId, projectId });
    assert.equal(status.runs[0].status, "active");
    assert.equal(status.runs[0].memory_id, result.memory_id);
  } finally {
    await f.close();
  }
});

test("active admission without a dense provider reports not configured", async () => {
  const f = await fixture();
  try {
    const jobId = "1".repeat(64);
    addPacket(f, jobId);
    const input = { source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId };

    const result = await runSelectedPipeline(f.store, input, inferenceOptions());

    assert.equal(result.status, "active");
    assert.equal(result.dense_projection.state, "pending");
    assert.equal(result.dense_projection.reason, "not_configured");
    const status = await pipelineStatus(f.store, { tenantId, projectId });
    assert.equal(status.runs[0].status, "active");
    assert.equal(status.runs[0].memory_id, result.memory_id);
  } finally {
    await f.close();
  }
});

test("zero indexed units stay pending instead of being reported as indexed", async () => {
  const f = await fixture();
  try {
    const denseProvider = denseFixtureProvider();
    f.store.denseEmbeddingProvider = denseProvider;
    f.store.rebuildDenseEmbeddings = async () => ({
      provider: denseProvider.provider,
      dimensions: denseProvider.dimensions,
      indexed: 0,
    });
    const jobId = "2".repeat(64);
    addPacket(f, jobId);

    const result = await runSelectedPipeline(f.store, {
      source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId,
    }, inferenceOptions());

    assert.equal(result.status, "active");
    assert.equal(result.dense_projection.state, "pending");
    assert.equal(result.dense_projection.reason, "no_units_indexed");
    assert.equal(result.dense_projection.indexed, undefined);
    assert.equal(denseProvider.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("fresh session inference without an OpenRouter key fails before reserving tokens", async () => {
  const f = await fixture();
  try {
    const jobId = "b".repeat(64);
    addPacket(f, jobId);
    const input = { source: "session", job_id: jobId, queue_dir: f.queueDir, tenant_id: tenantId, project_id: projectId };

    await assert.rejects(runSelectedPipeline(f.store, input, { env: {} }), /pipeline_review_api_key_required/);

    const budget = pipelineBudgetRows(f);
    assert.equal(budget.n, 0);
    assert.equal(budget.charged, 0);
    const status = await pipelineStatus(f.store, { tenantId, projectId });
    assert.equal(status.runs.length, 1);
    assert.equal(status.runs[0].status, "held");
    assert.equal(status.runs[0].memory_id, null);
    const db = f.store.open();
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE lifecycle_state='active'").get().n, 0); }
    finally { db.close(); }
  } finally {
    await f.close();
  }
});
