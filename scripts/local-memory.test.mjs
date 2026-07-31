import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalMemoryStore, MEMORY_SCHEMA_VERSION } from "./lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "./local-mcp.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-local-test-"));
  await chmod(directory, 0o700);
  return {
    directory,
    dbPath: join(directory, "memory.sqlite"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function captureInput(overrides = {}) {
  return {
    tenant_id: "personal",
    project_id: "orgbrain",
    kind: "decision",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: "orgbrain",
    content: "Use one authoritative MemoryStore contract for local and cloud.",
    summary: "Unify MemoryStore",
    tags: ["decision", "architecture"],
    entities: ["MemoryStore"],
    source: "test",
    source_references: [{ type: "file", ref: "docs/SPEC.md" }],
    external_key: "decision:memory-store",
    actor_type: "principal",
    actor_id: "tester",
    valid_from: null,
    valid_until: null,
    confidence_score: 0.95,
    utility_score: 0.9,
    rationale: "Avoid split product contracts.",
    evidence: [{ type: "file", ref: "scripts/local-memory.mjs" }],
    conflicts: [],
    permissions: [],
    ...overrides
  };
}

test("capture, revise, search, suppress, verify and delete share one record contract", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const capture = await store.capture(captureInput());
    assert.equal(capture.created, true);
    assert.equal(capture.version, 1);

    const record = await store.get("personal", capture.memory_id);
    assert.equal(record.kind, "decision");
    assert.equal(record.entities[0], "MemoryStore");
    assert.match(record.content_hash, /^[a-f0-9]{64}$/);

    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "authoritative contract"
    });
    assert.equal(results[0].memory.id, capture.memory_id);
    assert.ok(results[0].score.lexical > 0);
    assert.ok(results[0].score.semantic > 0);

    const revised = await store.revise("personal", capture.memory_id, {
      content: "Use the MemoryStore v2 contract everywhere.",
      tags: ["decision", "v2"]
    });
    assert.equal(revised.version, 2);
    assert.equal((await store.versions("personal", capture.memory_id)).length, 2);

    await store.suppress("personal", capture.memory_id, "superseded");
    assert.equal((await store.search({ tenant_id: "personal", query: "MemoryStore" })).length, 0);
    const suppressedVerification = await store.verify();
    assert.equal(suppressedVerification.ok, true);
    assert.equal(suppressedVerification.fts_count, 0);

    await store.delete("personal", capture.memory_id);
    assert.equal(await store.get("personal", capture.memory_id), null);
    const verification = await store.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.record_count, 0);
    assert.equal(verification.version_count, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("captureBatch preserves capture projections and rolls back atomically", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const results = await store.captureBatch([
      captureInput({
        external_key: "batch:first",
        content: "The first batched memory discusses alpine routes."
      }),
      captureInput({
        external_key: "batch:second",
        content: "The second batched memory discusses coastal routes."
      })
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.created && result.version === 1));
    const search = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "coastal route",
      search_mode: "hybrid_v3"
    });
    assert.equal(search[0].memory.id, results[1].memory_id);
    const before = await store.verify();
    assert.equal(before.record_count, 2);
    assert.equal(before.version_count, 2);
    assert.equal(before.ok, true);

    await assert.rejects(
      store.captureBatch([
        captureInput({ external_key: "batch:rollback", content: "This row must roll back." }),
        captureInput({ external_key: "batch:invalid", content: "" })
      ]),
      /content must not be empty/u
    );
    const after = await store.verify();
    assert.equal(after.record_count, 2);
    assert.equal(after.version_count, 2);
    assert.equal(after.ok, true);
  } finally {
    await ctx.cleanup();
  }
});

test("local sparse embeddings retrieve a synonym without external services", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const capture = await store.capture(captureInput({
      kind: "fact",
      content: "The automobile inspection workflow is documented.",
      summary: "Vehicle inspection",
      external_key: "fact:automobile"
    }));
    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "car"
    });
    assert.equal(results[0].memory.id, capture.memory_id);
    assert.equal(results[0].score.lexical, 0);
    assert.ok(results[0].score.semantic > 0);
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 searches derived units, preserves ACLs, and rebuilds projections", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const allowed = await store.capture(captureInput({
      kind: "preference",
      external_key: "preference:drink",
      content: [
        "user: I used to order black coffee every morning.",
        "assistant: You said a compact brewer would fit the kitchen.",
        "user: I now prefer jasmine tea and avoid coffee."
      ].join("\n"),
      summary: "Current drink preference",
      permissions: [{
        principal_type: "principal",
        principal_id: "reader",
        permissions: ["read"]
      }]
    }));
    await store.capture(captureInput({
      tenant_id: "other",
      external_key: "preference:other-tenant",
      content: "user: I now prefer jasmine tea.",
      summary: "Other tenant preference"
    }));

    const denied = await store.search({
      tenant_id: "personal",
      query: "What drink do I currently prefer?",
      search_mode: "hybrid_v3",
      principal_id: "intruder",
      limit: 5
    });
    assert.equal(denied.length, 0);

    const results = await store.search({
      tenant_id: "personal",
      query: "What drink do I currently prefer?",
      search_mode: "hybrid_v3",
      principal_id: "reader",
      limit: 5
    });
    assert.equal(results[0].memory.id, allowed.memory_id);
    assert.equal(results.length, 1);

    let verification = await store.verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.retrieval_unit_count >= 4);
    assert.equal(verification.retrieval_unit_count, verification.retrieval_unit_fts_count);
    assert.equal(verification.retrieval_unit_count, verification.retrieval_unit_embedding_count);

    await store.rebuildIndex();
    verification = await store.verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.retrieval_unit_count >= 4);

    const beforeSuppressionUnitCount = verification.retrieval_unit_count;
    await store.suppress("personal", allowed.memory_id, "obsolete");
    verification = await store.verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.retrieval_unit_count < beforeSuppressionUnitCount);
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 keeps exact lexical evidence above generic intent matches", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const exact = await store.capture(captureInput({
      kind: "fact",
      external_key: "fact:shampoo",
      content: "user: I currently use Trader Joe's lavender shampoo.",
      summary: "Current shampoo brand",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000
    }));
    for (let index = 0; index < 4; index += 1) {
      await store.capture(captureInput({
        kind: "fact",
        external_key: `fact:generic-current-${index}`,
        content: [
          "user: I currently use the updated workflow.",
          "user: My current process is documented.",
          "user: I now use the latest available option."
        ].join("\n"),
        summary: "Current generic workflow",
        created_at: 1_700_100_000_000 + index,
        updated_at: 1_700_100_000_000 + index
      }));
    }
    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "What brand of shampoo do I currently use?",
      search_mode: "hybrid_v3",
      at: 1_700_200_000_000,
      limit: 5
    });
    assert.equal(results[0].memory.id, exact.memory_id);
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 optionally removes results below a caller-selected total score", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.capture(captureInput({
      kind: "fact",
      external_key: "fact:redis",
      content: "Redis is the session store for the web application.",
      summary: "Redis session store"
    }));
    await store.capture(captureInput({
      kind: "fact",
      external_key: "fact:unrelated",
      content: "The design system uses a blue accessibility palette.",
      summary: "Design system colors"
    }));
    const unfiltered = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "Which Redis session store does the web application use?",
      search_mode: "hybrid_v3",
      limit: 5
    });
    assert.ok(unfiltered.length > 0);
    const threshold = unfiltered[0].score.total + 0.000001;
    const filtered = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "Which Redis session store does the web application use?",
      search_mode: "hybrid_v3",
      minimum_total_score: threshold,
      limit: 5
    });
    assert.equal(filtered.length, 0);
    await assert.rejects(
      store.search({
        tenant_id: "personal",
        query: "Redis",
        search_mode: "hybrid_v3",
        minimum_total_score: -1
      }),
      /minimum_total_score/
    );
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 retrieves standing instructions for generic implementation requests", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const instruction = await store.capture(captureInput({
      kind: "constraint",
      external_key: "constraint:code-format",
      content: "user: Always format all code snippets with syntax highlighting.",
      summary: "Code formatting instruction"
    }));
    await store.capture(captureInput({
      kind: "fact",
      external_key: "fact:unrelated-deployment",
      content: "assistant: The deployment completed on Tuesday.",
      summary: "Deployment status"
    }));
    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "Could you show me how to implement a login feature?",
      search_mode: "hybrid_v3",
      limit: 5
    });
    assert.ok(results.some((result) => result.memory.id === instruction.memory_id));
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 ranks explicit relative-time targets without global recency bias", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const now = 1_720_000_000_000;
    const targetEventAt = now - 28 * 24 * 60 * 60 * 1000;
    const target = await store.capture(captureInput({
      kind: "event",
      external_key: "event:milestone-target",
      content: "user: I reached a significant business milestone.",
      summary: "Business milestone",
      source_references: [{
        type: "session",
        ref: "target-session",
        captured_at: targetEventAt
      }]
    }));
    await store.capture(captureInput({
      kind: "event",
      external_key: "event:milestone-recent",
      content: "user: I reached a significant business milestone.",
      summary: "Business milestone",
      source_references: [{
        type: "session",
        ref: "recent-session",
        captured_at: now - 2 * 24 * 60 * 60 * 1000
      }]
    }));
    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "What significant business milestone did I mention four weeks ago?",
      search_mode: "hybrid_v3",
      at: now,
      limit: 2
    });
    assert.equal(results[0].memory.id, target.memory_id);
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v3 keeps subject-related relative-time evidence in top five", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const now = 1_720_000_000_000;
    const targetEventAt = now - 28 * 24 * 60 * 60 * 1000;
    const target = await store.capture(captureInput({
      kind: "event",
      external_key: "event:business-launch",
      content: "user: I launched my website and created a business social account.",
      summary: "Website launch",
      source_references: [{
        type: "session",
        ref: "business-launch-session",
        captured_at: targetEventAt
      }]
    }));
    for (let index = 0; index < 8; index += 1) {
      await store.capture(captureInput({
        kind: "fact",
        external_key: `fact:significant-research-${index}`,
        content: `assistant: Significant research milestone number ${index + 1}.`,
        summary: "Significant research milestone",
        source_references: [{
          type: "session",
          ref: `research-session-${index}`,
          captured_at: now - (index + 1) * 24 * 60 * 60 * 1000
        }]
      }));
    }
    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "What significant business milestone did I mention four weeks ago?",
      search_mode: "hybrid_v3",
      at: now,
      limit: 5
    });
    assert.ok(results.some((result) => result.memory.id === target.memory_id));
  } finally {
    await ctx.cleanup();
  }
});

test("external keys are idempotent and preserve version history", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const first = await store.capture(captureInput());
    const second = await store.capture(captureInput({ content: "Updated authoritative content." }));
    assert.equal(second.memory_id, first.memory_id);
    assert.equal(second.created, false);
    assert.equal(second.version, 2);
    assert.equal((await store.versions("personal", first.memory_id)).length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("init upgrades a legacy local database in place without losing records", async () => {
  const ctx = await fixture();
  try {
    const legacy = new DatabaseSync(ctx.dbPath);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'local',
        external_key TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO memories VALUES(
        'legacy-1', 'legacy-project', 'Legacy durable fact', 'Legacy fact',
        '["fact"]', 'legacy', 'fact:1', 1700000000000
      );
    `);
    legacy.close();

    const store = new LocalMemoryStore(ctx.dbPath);
    await store.init();
    const record = await store.get("default", "legacy-1");
    assert.equal(record.content, "Legacy durable fact");
    assert.equal(record.project_id, "legacy-project");
    assert.equal(record.current_version, 1);
    assert.equal((await store.verify()).schema_version, MEMORY_SCHEMA_VERSION);
  } finally {
    await ctx.cleanup();
  }
});

test("restore verifies backups and reapplies later deletion tombstones", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const capture = await store.capture(captureInput());
    const expected = await store.verify();
    const backupPath = join(ctx.directory, "backups", "memory.sqlite");
    const backup = await store.createBackup(backupPath);
    assert.equal(backup.ok, true);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

    await store.delete("personal", capture.memory_id);
    const restored = await store.restoreBackup(backupPath);
    assert.equal(restored.restored, ctx.dbPath);
    assert.equal(restored.reapplied_deletions, 1);
    const actual = await store.verify();
    assert.equal(actual.record_count, 0);
    assert.notEqual(actual.content_digest, expected.content_digest);

    const doctor = await store.doctor();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.directory_mode, "700");
    assert.equal(doctor.database_mode, "600");
  } finally {
    await ctx.cleanup();
  }
});

test("local MCP exposes capture and search over the same MemoryStore", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const tools = await handleLocalMcpRequest(store, { method: "tools/list" });
    assert.ok(tools.tools.some((tool) => tool.name === "orgbrain_memory_capture"));
    const searchTool = tools.tools.find((tool) => tool.name === "orgbrain_memory_search");
    assert.equal(searchTool.inputSchema.properties.minimum_total_score.minimum, 0);
    const captured = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_memory_capture",
        arguments: {
          tenant_id: "personal",
          project_id: "orgbrain",
          kind: "constraint",
          content: "Local MCP must never send memory to an external service."
        }
      }
    });
    assert.equal(captured.isError, false);
    const searched = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_memory_search",
        arguments: { tenant_id: "personal", query: "external service" }
      }
    });
    assert.equal(searched.isError, false);
    assert.match(searched.content[0].text, /Local MCP/);
  } finally {
    await ctx.cleanup();
  }
});
