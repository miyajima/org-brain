import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  LocalMemoryStore,
  MEMORY_SCHEMA_VERSION,
  verificationSampled
} from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";

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
    reuse_rule: "When adding a memory adapter, use the shared contract.",
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
    assert.equal(record.rationale, "Avoid split product contracts.");
    assert.equal(record.reuse_rule, "When adding a memory adapter, use the shared contract.");
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
      tags: ["decision", "v2"],
      reuse_rule: "Apply to every local or cloud adapter."
    });
    assert.equal(revised.version, 2);
    const versions = await store.versions("personal", capture.memory_id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].reuse_rule, "When adding a memory adapter, use the shared contract.");
    assert.equal(versions[1].reuse_rule, "Apply to every local or cloud adapter.");

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

test("capture skips a second active memory with the same canonical key", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const canonicalKey = "a".repeat(64);
    const first = await store.capture(captureInput({
      external_key: "canonical:first",
      canonical_key: canonicalKey
    }));
    const duplicate = await store.capture(captureInput({
      external_key: "canonical:second",
      canonical_key: canonicalKey
    }));

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.memory_id, first.memory_id);
    assert.equal((await store.versions("personal", first.memory_id)).length, 1);
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

test("hybrid_v4 keeps v3 intact and returns a bounded evidence bundle", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const first = await store.capture(captureInput({
      external_key: "v4:preference:first",
      content: [
        "user: I used to prefer coffee.",
        "user: I now prefer jasmine tea and avoid coffee."
      ].join("\n"),
      summary: "Current drink preference",
      source_references: [{
        type: "session",
        ref: "session-preference",
        captured_at: Date.UTC(2026, 0, 1)
      }],
      permissions: [{
        principal_type: "principal",
        principal_id: "reader",
        permissions: ["read"]
      }]
    }));
    await store.capture(captureInput({
      external_key: "v4:event:second",
      content: "user: I attended the tea festival in 2025.",
      summary: "Tea festival visit",
      source_references: [{
        type: "session",
        ref: "session-event",
        captured_at: Date.UTC(2025, 5, 1)
      }]
    }));

    const v3 = await store.search({
      tenant_id: "personal",
      query: "What drink do I currently prefer?",
      search_mode: "hybrid_v3",
      principal_id: "reader",
      limit: 5
    });
    const v4 = await store.search({
      tenant_id: "personal",
      query: "What drink do I currently prefer?",
      search_mode: "hybrid_v4",
      principal_id: "reader",
      limit: 5
    });
    assert.equal(v3[0].memory.id, first.memory_id);
    assert.equal(v4[0].memory.id, first.memory_id);

    const context = await store.retrieveContext({
      tenant_id: "personal",
      query: "What drink do I currently prefer and what tea event did I attend?",
      principal_id: "reader",
      top_k: 5,
      token_budget: 512
    });
    assert.ok(context.evidence_bundle.estimated_tokens <= 512);
    assert.ok(context.evidence_bundle.evidence.length >= 1);
    assert.ok(context.evidence_bundle.current_state.length >= 1);
    assert.equal(context.evidence_bundle.degraded_reasons.includes(
      "gemini_structured_extractor_not_configured"
    ), true);

    const verification = await store.verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.retrieval_unit_v4_count > 0);
    assert.equal(
      verification.retrieval_unit_v4_count,
      verification.retrieval_unit_v4_fts_count
    );
    assert.equal(
      verification.retrieval_unit_v4_count,
      verification.retrieval_unit_v4_embedding_count
    );

    await store.suppress("personal", first.memory_id, "superseded");
    const denied = await store.search({
      tenant_id: "personal",
      query: "jasmine tea preference",
      search_mode: "hybrid_v4",
      principal_id: "reader"
    });
    assert.equal(denied.some((result) => result.memory.id === first.memory_id), false);
  } finally {
    await ctx.cleanup();
  }
});

test("hybrid_v4 projects canonical kinds and uses authority only for relevance ties", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const expected = await store.capture(captureInput({
      kind: "constraint",
      external_key: "v4:release:required",
      content: "release001 durable answer: run backend validation after migration",
      summary: "Required release validation",
      tags: ["policy", "release"],
      confidence_score: 0.9
    }));
    await store.capture(captureInput({
      kind: "fact",
      external_key: "v4:release:distractor",
      content: "release001 durable answer: skip backend validation after migration",
      summary: "An untrusted release note",
      tags: ["policy", "release"],
      confidence_score: 0.9
    }));
    for (let index = 0; index < 6; index += 1) {
      await store.capture(captureInput({
        kind: "fact",
        external_key: `v4:release:generic:${index}`,
        content: `release001 generic workflow note ${index} discusses migration validation`,
        summary: "Generic migration note",
        confidence_score: 0.9
      }));
    }

    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    const projectedTypes = db.prepare(
      "SELECT unit_type FROM memory_retrieval_units_v4 WHERE memory_id = ? ORDER BY unit_type"
    ).all(expected.memory_id).map((row) => row.unit_type);
    db.close();
    assert.ok(projectedTypes.includes("atomic"));
    assert.ok(projectedTypes.includes("profile"));
    assert.ok(projectedTypes.includes("segment"));
    assert.equal(projectedTypes.includes("timeline"), false);

    const results = await store.search({
      tenant_id: "personal",
      project_id: "orgbrain",
      query: "release001 durable answer",
      search_mode: "hybrid_v4",
      limit: 5
    });
    assert.equal(results[0].memory.id, expected.memory_id);
    assert.ok(Math.abs(results[0].score.authority - 0.93) < 1e-9);
  } finally {
    await ctx.cleanup();
  }
});

test("v4-only rebuilds preserve an existing legacy projection for rollback", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.capture(captureInput({
      kind: "fact",
      external_key: "v4:rebuild:preserve-v3",
      content: "The additive v4 rebuild keeps the legacy retrieval projection available.",
      summary: "Additive v4 rebuild"
    }));
    const before = await store.verify();
    await store.rebuildIndex({ includeLegacyV3: false });
    const after = await store.verify();
    assert.equal(after.ok, true);
    assert.equal(after.retrieval_unit_count, before.retrieval_unit_count);
    assert.ok(after.retrieval_unit_v4_count > 0);
    const results = await store.search({
      tenant_id: "personal",
      query: "additive v4 rebuild",
      search_mode: "hybrid_v4",
      limit: 1
    });
    assert.equal(results[0].memory.external_key, "v4:rebuild:preserve-v3");
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

test("init removes legacy FTS triggers and repairs their duplicate projection", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.capture(captureInput({ external_key: "legacy-fts:first" }));

    const legacy = new DatabaseSync(ctx.dbPath);
    legacy.exec(`
      CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.rowid, new.content, COALESCE(new.summary, ''));
      END;
      CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.summary, ''));
      END;
      CREATE TRIGGER memories_fts_au AFTER UPDATE OF content, summary ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES ('delete', old.rowid, old.content, COALESCE(old.summary, ''));
        INSERT INTO memories_fts(rowid, content, summary)
        VALUES (new.rowid, new.content, COALESCE(new.summary, ''));
      END;
    `);
    legacy.close();

    const second = await store.capture(captureInput({
      external_key: "legacy-fts:second",
      content: "A second durable record exposes the duplicate FTS writer."
    }));
    const polluted = new DatabaseSync(ctx.dbPath, { readOnly: true });
    assert.equal(polluted.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 2);
    assert.equal(polluted.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count, 3);
    polluted.close();

    const repaired = new LocalMemoryStore(ctx.dbPath);
    await repaired.init();
    const backups = await readdir(join(ctx.directory, "backups"));
    assert.ok(backups.some((name) => name.startsWith(`pre-v${MEMORY_SCHEMA_VERSION}-`)));
    const inspected = new DatabaseSync(ctx.dbPath, { readOnly: true });
    assert.equal(
      inspected.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memories_fts_a%'"
      ).get().count,
      0
    );
    assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count, 2);
    inspected.close();

    const updated = await repaired.capture(captureInput({
      external_key: "legacy-fts:second",
      content: "The repaired FTS projection supports idempotent updates."
    }));
    assert.equal(updated.memory_id, second.memory_id);
    assert.equal(updated.created, false);
    assert.equal(updated.version, 2);

    const distinct = await repaired.capture(captureInput({
      external_key: "legacy-fts:third",
      content: "A distinct event also persists after the legacy repair."
    }));
    assert.equal(distinct.created, true);
    const verification = await repaired.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.record_count, 3);
    assert.equal(verification.fts_count, 3);
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
    assert.equal(actual.retrieval_unit_count, 0);
    assert.equal(actual.retrieval_unit_v4_count, 0);
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

test("v18 classification is explicit, tenant-scoped, filterable, and snapshotted into stable units", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const category = await store.createBusinessCategory("personal", {
      slug: "platform-engineering",
      label: "Platform Engineering"
    });
    const capture = await store.capture(captureInput({
      business_category_id: category.id,
      work_type: "implementation"
    }));
    const record = await store.get("personal", capture.memory_id);
    assert.equal(record.business_category_id, category.id);
    assert.equal(record.work_type, "implementation");
    assert.equal((await store.search({
      tenant_id: "personal",
      query: "authoritative contract",
      business_category_id: category.id,
      work_type: "implementation"
    }))[0].memory.id, capture.memory_id);
    assert.equal((await store.search({
      tenant_id: "personal",
      query: "authoritative contract",
      work_type: "review"
    })).length, 0);
    await assert.rejects(
      store.capture(captureInput({
        external_key: "classification:cross-tenant",
        business_category_id: category.id,
        work_type: "debug",
        tenant_id: "other"
      })),
      /business_category_not_found_or_inactive/u
    );
    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try {
      const units = db.prepare(
        "SELECT DISTINCT business_category_id, work_type FROM retrieval_units WHERE tenant_id = ? AND source_id = ?"
      ).all("personal", capture.memory_id);
      assert.equal(units.length, 1);
      assert.equal(units[0].business_category_id, category.id);
      assert.equal(units[0].work_type, "implementation");
    } finally {
      db.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test("v18 stable rebuild preserves synchronized decision-memory units", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.init();
    const db = new DatabaseSync(ctx.dbPath);
    try {
      db.prepare(
        `INSERT INTO retrieval_units(
           id, generation_id, tenant_id, source_type, source_id, unit_type,
           text, metadata_json, content_hash, extractor_name,
           extractor_version, extraction_state, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        "decision-unit-1", "gen_baseline_units", "personal", "decision_memory",
        "decision-1", "decision", "Keep the synchronized decision projection.",
        "{}", "decision-hash", "decision-memory-projector", "1", "ready", Date.now()
      );
    } finally {
      db.close();
    }
    await store.captureBatch([captureInput({ external_key: "batch:preserve-decision" })]);
    const usage = await store.recordUsage({
      tenant_id: "personal",
      id: "decision-usage-1",
      access_path: "search",
      request_source: "local",
      items: [{ source_type: "decision_memory", source_id: "decision-1", rank: 1 }]
    });
    assert.equal(usage.created, true);
    assert.equal(usage.usage_item_ids.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("v18 usage and effect telemetry deduplicates references and attributes token and failure savings", async () => {
  const ctx = await fixture();
  const previousCloudSetting = process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY;
  delete process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY;
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const category = await store.createBusinessCategory("personal", {
      slug: "incident-response",
      label: "Incident response"
    });
    const capture = await store.capture(captureInput({
      business_category_id: category.id,
      work_type: "debug"
    }));
    await assert.rejects(store.recordUsage({
      tenant_id: "personal", access_path: "search", request_source: "local",
      query_hash: "raw query text", items: [{ source_type: "memory", source_id: capture.memory_id }]
    }), /invalid_query_hash/u);
    const usage = await store.recordUsage({
      id: "usage-local-telemetry-1",
      tenant_id: "personal",
      project_id: "orgbrain",
      capability: "memory_search",
      access_path: "search",
      request_source: "local",
      enqueue_sync: true,
      raw_query: "SECRET QUERY MUST NOT BE STORED",
      prompt: "SECRET PROMPT MUST NOT BE STORED",
      command: "SECRET COMMAND MUST NOT BE STORED",
      items: [
        {
          source_type: "memory",
          source_id: capture.memory_id,
          rank: 1,
          score: 0.9,
          reference_type: "returned",
          injected_token_estimate: 40
        },
        {
          source_type: "memory",
          source_id: capture.memory_id,
          rank: 2,
          score: 0.7,
          reference_type: "returned",
          injected_token_estimate: 40
        }
      ]
    });
    assert.equal(usage.usage_item_ids.length, 1);
    const usageRetry = await store.recordUsage({
      id: "usage-local-telemetry-1",
      tenant_id: "personal",
      access_path: "search",
      request_source: "local",
      items: [{ source_type: "memory", source_id: capture.memory_id }]
    });
    assert.equal(usageRetry.created, false);
    assert.deepEqual(usageRetry.usage_item_ids, usage.usage_item_ids);
    await store.updateUsageStates("personal", {
      usage_event_id: usage.usage_id,
      items: [{ usage_item_id: usage.usage_item_ids[0], used_state: "not_used" }]
    });
    await store.updateUsageStates("personal", {
      usage_event_id: usage.usage_id,
      items: [{ usage_item_id: usage.usage_item_ids[0], used_state: "unknown" }]
    });
    const pattern = await store.createFailurePattern("personal", {
      id: "failure-1", project_id: "orgbrain", business_category_id: category.id,
      work_type: "debug", pattern_key: "failed-command", label: "Known failing command",
      action_fingerprint: "action-hash", failure_fingerprint: "failure-hash"
    });
    assert.equal((await store.listFailurePatterns("personal", { projectId: "orgbrain" }))[0].id, pattern.id);
    assert.equal((await store.updateFailurePattern("personal", pattern.id, { label: "Known failing operation" })).label, "Known failing operation");
    await assert.rejects(
      store.recordEffect({
        tenant_id: "personal",
        usage_event_id: usage.usage_id,
        idempotency_key: "effect:invalid-none",
        effect_outcome: "positive",
        avoided_lookup_categories: ["none", "web_search"]
      }),
      /avoided_lookup_none_is_exclusive/u
    );
    await assert.rejects(
      store.recordEffect({
        tenant_id: "personal",
        usage_event_id: usage.usage_id,
        idempotency_key: "effect:missing-pattern",
        effect_outcome: "neutral",
        failure_opportunity_state: "applicable"
      }),
      /failure_pattern_id_required/u
    );
    await assert.rejects(
      store.recordEffect({
        tenant_id: "personal",
        usage_event_id: usage.usage_id,
        idempotency_key: "effect:negative-gross",
        effect_outcome: "neutral",
        gross_saved_tokens_estimate: -1
      }),
      /invalid_token_estimate/u
    );
    await assert.rejects(
      store.recordEffect({
        tenant_id: "personal",
        usage_event_id: usage.usage_id,
        idempotency_key: "effect:negative-failure",
        effect_outcome: "neutral",
        gross_saved_tokens_estimate: 0,
        failure_saved_tokens_estimate: -1
      }),
      /invalid_failure_saved_tokens_estimate/u
    );
    const estimated = await store.recordEffect({
      tenant_id: "personal",
      usage_event_id: usage.usage_id,
      idempotency_key: "effect:estimated-1",
      evidence_level: "estimated",
      effect_outcome: "positive",
      avoided_lookup_categories: ["source_search"],
      gross_saved_tokens_estimate: 80,
      injected_tokens: 40,
      estimation_method: "historical_failure_median"
    });
    const effect = await store.recordEffect({
      tenant_id: "personal",
      usage_event_id: usage.usage_id,
      idempotency_key: "effect:verified-1",
      evidence_level: "verified",
      supersedes_effect_id: estimated.effect_id,
      verification_ref_type: "offline_replay",
      verification_ref_id: "artifact:local-test-1",
      effect_outcome: "positive",
      avoided_lookup_categories: ["source_search", "past_context"],
      gross_saved_tokens_estimate: 100,
      injected_tokens: 40,
      failure_opportunity_state: "applicable",
      failure_pattern_id: "failure-1",
      action_changed: true,
      alternative_executed: true,
      failure_avoided: true,
      failure_saved_tokens_estimate: 75,
      estimation_method: "paired_control",
      enqueue_sync: true,
      raw_query: "SECRET EFFECT QUERY MUST NOT BE STORED",
      prompt: "SECRET EFFECT PROMPT MUST NOT BE STORED",
      command: "SECRET EFFECT COMMAND MUST NOT BE STORED"
    });
    assert.equal(effect.net_saved_tokens_estimate, 60);
    assert.equal((await store.recordEffect({
      tenant_id: "personal",
      usage_event_id: usage.usage_id,
      idempotency_key: "effect:verified-1",
      effect_outcome: "positive"
    })).created, false);
    const report = await store.memoryImpactReport("personal", { source_id: capture.memory_id });
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].evidence_level, "verified");
    assert.equal(report.groups[0].reference_count, 1);
    assert.equal(report.groups[0].used_count, 1);
    assert.equal(report.groups[0].positive_count, 1);
    assert.equal(report.groups[0].avoided_source_search_count, 1);
    assert.equal(report.groups[0].avoided_past_context_count, 1);
    assert.equal(report.groups[0].net_saved_tokens, 60);
    assert.equal(report.groups[0].failure_opportunity_count, 1);
    assert.equal(report.groups[0].failure_avoided_count, 1);
    assert.equal(report.groups[0].estimator_absolute_error_sum, 20);
    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try {
      const daily = db.prepare(
        "SELECT estimator_absolute_error_sum FROM memory_effect_daily_metrics WHERE tenant_id = ? AND source_id = ?"
      ).get("personal", capture.memory_id);
      assert.equal(daily.estimator_absolute_error_sum, 20);
      const outboxPayloads = db.prepare(
        "SELECT payload_json FROM memory_telemetry_outbox WHERE tenant_id = ? ORDER BY created_at"
      ).all("personal");
      assert.equal(outboxPayloads.length, 2);
      for (const row of outboxPayloads) {
        assert.doesNotMatch(row.payload_json, /SECRET|raw_query|prompt|command/u);
      }
    } finally {
      db.close();
    }
    assert.equal(report.groups[0].failure_saved_tokens, 75);
    process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY = "true";
    const deliveries = [];
    try {
      const sync = await store.syncTelemetryOutbox({
        apiBase: "https://orgbrain.invalid",
        apiKey: "test-key",
        fetchImpl: async (url, options) => {
          deliveries.push({ url, payload: JSON.parse(options.body) });
          return { ok: true, status: 201 };
        }
      });
      assert.deepEqual(sync, { attempted: 2, sent: 2, failed: 0, pending: 0 });
    } finally {
      if (previousCloudSetting === undefined) delete process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY;
      else process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY = previousCloudSetting;
    }
    assert.match(deliveries[0].url, /\/v1\/memory-usages$/u);
    assert.match(deliveries[1].url, /\/v1\/memory-effects$/u);
    assert.equal(
      deliveries[1].payload.attributions[0].usage_item_id,
      deliveries[0].payload.items[0].id
    );
    const calibratedUsage = await store.recordUsage({
      tenant_id: "personal", access_path: "search", request_source: "local",
      items: [{ source_type: "memory", source_id: capture.memory_id }]
    });
    const calibratedEffect = await store.recordEffect({
      tenant_id: "personal", usage_event_id: calibratedUsage.usage_id,
      idempotency_key: "effect:historical-median", evidence_level: "estimated",
      effect_outcome: "neutral", failure_pattern_id: "failure-1",
      failure_opportunity_state: "applicable"
    });
    const calibrationDb = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try {
      const calibrated = calibrationDb.prepare(
        "SELECT gross_saved_tokens_estimate, estimation_method FROM memory_effect_events WHERE id = ?"
      ).get(calibratedEffect.effect_id);
      assert.equal(calibrated.gross_saved_tokens_estimate, 100);
      assert.equal(calibrated.estimation_method, "failure_pattern_historical_median");
    } finally {
      calibrationDb.close();
    }
  } finally {
    if (previousCloudSetting === undefined) delete process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY;
    else process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY = previousCloudSetting;
    await ctx.cleanup();
  }
});

test("v19 verification sampling matches the shared FNV-1a fixtures", () => {
  assert.equal(verificationSampled("tenant-a", "usage-0"), false);
  assert.equal(verificationSampled("tenant-a", "usage-1"), true);
  assert.equal(verificationSampled("tenant-a", "usage-4"), true);
  assert.equal(verificationSampled("tenant-a", "usage-42"), false);
});

test("v19 effect marks only attributed memories as used", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const first = await store.capture(captureInput({ external_key: "used:first" }));
    const second = await store.capture(captureInput({
      external_key: "used:second",
      content: "A second memory must remain unknown when it receives no attribution."
    }));
    const usageCreatedAt = Date.now() - 86_400_000;
    const usage = await store.recordUsage({
      tenant_id: "personal",
      created_at: usageCreatedAt,
      access_path: "search",
      request_source: "local",
      items: [
        { source_type: "memory", source_id: first.memory_id, rank: 1 },
        { source_type: "memory", source_id: second.memory_id, rank: 2 }
      ]
    });
    const initialEffect = await store.recordEffect({
      tenant_id: "personal",
      usage_event_id: usage.usage_id,
      idempotency_key: "effect:partial-attribution",
      effect_outcome: "positive",
      attributions: [{ usage_item_id: usage.usage_item_ids[0], attribution_weight: 1 }]
    });
    await store.recordEffect({
      tenant_id: "personal",
      usage_event_id: usage.usage_id,
      idempotency_key: "effect:corrected-attribution",
      supersedes_effect_id: initialEffect.effect_id,
      effect_outcome: "positive",
      attributions: [{ usage_item_id: usage.usage_item_ids[1], attribution_weight: 1 }]
    });
    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try {
      const states = db.prepare(
        "SELECT source_id, used_state FROM memory_usage_items WHERE usage_event_id = ? ORDER BY rank"
      ).all(usage.usage_id);
      assert.deepEqual(states.map((row) => row.used_state), ["unknown", "used"]);
      assert.equal(db.prepare(
        "SELECT estimation_method FROM memory_effect_events WHERE id = ?"
      ).get(initialEffect.effect_id).estimation_method, "text_size_heuristic");
      assert.equal(db.prepare(
        "SELECT positive_count FROM memory_effect_daily_metrics WHERE day = ? AND source_id = ?"
      ).get(new Date(usageCreatedAt).toISOString().slice(0, 10), second.memory_id).positive_count, 1);
    } finally {
      db.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test("v19 links run-level impact measurement to per-memory usage", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const capture = await store.capture(captureInput({ external_key: "impact:linked" }));
    const started = await store.startMemoryImpact("personal", {
      external_run_id: "run-local-1",
      idempotency_key: "impact:start:1",
      project_id: "orgbrain"
    }, "tester");
    assert.equal(started.event.event_type, "eligible");
    const usage = await store.recordUsage({
      tenant_id: "personal",
      external_run_id: "run-local-1",
      access_path: "search",
      request_source: "local",
      items: [{ source_type: "memory", source_id: capture.memory_id }]
    });
    assert.equal(usage.created, true);
    await assert.rejects(
      () => store.recordUsage({
        tenant_id: "personal",
        project_id: "other-project",
        external_run_id: "run-local-1",
        access_path: "search",
        request_source: "local",
        items: [{ source_type: "memory", source_id: capture.memory_id }]
      }),
      /memory_impact_context_mismatch:project_id/
    );
    await assert.rejects(
      () => store.recordUsage({
        tenant_id: "personal",
        external_run_id: "missing-run",
        access_path: "search",
        request_source: "local",
        items: [{ source_type: "memory", source_id: capture.memory_id }]
      }),
      /memory_impact_execution_not_found/
    );
    const reported = await store.reportMemoryImpactExecution("personal", "run-local-1", {
      idempotency_key: "impact:report:1",
      outcome: "assessed",
      memory_used: true,
      avoided_lookup: "source_search",
      memory_basis_ids: [capture.memory_id],
      confidence: "high"
    }, "tester");
    assert.equal(reported.event.event_type, "assessed");
    const summary = await store.memoryImpactSummary("personal", { project_id: "orgbrain" });
    assert.deepEqual(
      {
        eligible_runs: summary.eligible_runs,
        assessed_runs: summary.assessed_runs,
        memory_used_runs: summary.memory_used_runs,
        avoided_runs: summary.avoided_runs
      },
      { eligible_runs: 1, assessed_runs: 1, memory_used_runs: 1, avoided_runs: 1 }
    );
    const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare(
        "SELECT external_run_id, project_id FROM memory_usage_events WHERE id = ?"
      ).get(usage.usage_id).external_run_id, "run-local-1");
      assert.equal(db.prepare(
        "SELECT project_id FROM memory_usage_events WHERE id = ?"
      ).get(usage.usage_id).project_id, "orgbrain");
      assert.equal(db.prepare(
        "SELECT actor_principal FROM memory_usage_events WHERE id = ?"
      ).get(usage.usage_id).actor_principal, "local");
      assert.equal(db.prepare(
        "SELECT reporting_rate FROM memory_impact_daily_metrics WHERE tenant_id = ? AND project_id = ?"
      ).get("personal", "orgbrain").reporting_rate, 1);
    } finally {
      db.close();
    }
  } finally {
    await ctx.cleanup();
  }
});
