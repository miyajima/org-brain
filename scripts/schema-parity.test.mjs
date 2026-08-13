import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalMemoryStore, MEMORY_SCHEMA_VERSION } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const SHARED_TABLES = [
  "memories",
  "memory_versions",
  "memory_edges",
  "memory_deletions",
  "principal_role_assignments",
  "scoped_tokens",
  "audit_events",
  "retention_policies",
  "memory_retrieval_units",
  "memory_retrieval_units_v4",
  "business_categories",
  "organizations",
  "user_profiles",
  "user_identities",
  "groups",
  "group_members",
  "memory_impact_events",
  "memory_impact_daily_metrics",
  "memory_failure_patterns",
  "memory_usage_events",
  "memory_usage_items",
  "memory_effect_events",
  "memory_effect_attributions",
  "memory_effect_daily_metrics",
  "retrieval_ranking_profiles",
  "retrieval_generations",
  "retrieval_generation_assignments",
  "retrieval_projection_jobs",
  "retrieval_evaluation_events",
  "retrieval_units"
];

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)).sort();
}

async function applyD1Migrations(db) {
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, migrationDirectory), "utf8");
    db.exec(sql);
  }
}

test("local SQLite shared tables stay in parity with D1 migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-schema-parity-"));
  const localPath = join(directory, "local.sqlite");
  const migratedPath = join(directory, "migrated.sqlite");
  try {
    const store = new LocalMemoryStore(localPath);
    await store.init();
    const migrated = new DatabaseSync(migratedPath);
    await applyD1Migrations(migrated);
    const local = new DatabaseSync(localPath, { readOnly: true });
    try {
      const differences = {};
      for (const table of SHARED_TABLES) {
        const localColumns = columns(local, table);
        const migratedColumns = columns(migrated, table);
        if (JSON.stringify(localColumns) !== JSON.stringify(migratedColumns)) {
          differences[table] = { local: localColumns, migrated: migratedColumns };
        }
      }
      assert.deepEqual(differences, {}, `shared table columns differ:\n${JSON.stringify(differences, null, 2)}`);
    } finally {
      local.close();
      migrated.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("D1 migration atomically rejects new active canonical duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-canonical-guard-"));
  const migratedPath = join(directory, "migrated.sqlite");
  const database = new DatabaseSync(migratedPath);
  try {
    await applyD1Migrations(database);
    const insert = database.prepare(
      `INSERT INTO memories(id, tenant_id, content, created_at, canonical_key, lifecycle_state)
       VALUES(?, 'default', ?, 1, ?, ?)`
    );
    insert.run("memory-a", "first", "canonical-a", "active");
    assert.throws(
      () => insert.run("memory-b", "second", "canonical-a", "active"),
      /duplicate_canonical_key/
    );

    insert.run("memory-suppressed", "historical", "canonical-a", "suppressed");
    database.prepare("UPDATE memories SET content = ? WHERE id = ?").run("updated", "memory-a");
    database.prepare("UPDATE memories SET lifecycle_state = 'suppressed' WHERE id = ?").run("memory-a");
    insert.run("memory-b", "replacement", "canonical-a", "active");
    assert.throws(
      () => database.prepare(
        "UPDATE memories SET lifecycle_state = 'active' WHERE id = ?"
      ).run("memory-a"),
      /duplicate_canonical_key/
    );

    const active = database.prepare(
      `SELECT id FROM memories
       WHERE tenant_id = 'default' AND canonical_key = 'canonical-a'
         AND lifecycle_state != 'suppressed'`
    ).all();
    assert.deepEqual(active.map((row) => row.id), ["memory-b"]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
