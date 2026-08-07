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

test("local SQLite shared tables stay in parity with D1 migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-schema-parity-"));
  const localPath = join(directory, "local.sqlite");
  const migratedPath = join(directory, "migrated.sqlite");
  try {
    const store = new LocalMemoryStore(localPath);
    await store.init();
    const migrated = new DatabaseSync(migratedPath);
    const migrationDirectory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const sql = await readFile(new URL(file, migrationDirectory), "utf8");
      migrated.exec(sql);
    }
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
