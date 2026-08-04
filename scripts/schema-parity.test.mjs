import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  "memory_retrieval_units_v4"
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
    for (let version = 1; version <= MEMORY_SCHEMA_VERSION; version += 1) {
      const prefix = String(version).padStart(4, "0");
      const files = [
        "orgbus", "seed_capabilities", "memory_bridge", "retrieval_metrics",
        "knowledge_docs", "memory_lifecycle_v2", "rationale_confirmation",
        "measurement_mode", "remove_demo_capabilities", "context_engine_mvp",
        "decision_memory_editor", "login_groups_acl", "agent_messages",
        "memory_record_v2", "rbac_audit", "retrieval_units_v3", "retrieval_units_v4"
      ];
      const sql = await readFile(new URL(`../migrations/${prefix}_${files[version - 1]}.sql`, import.meta.url), "utf8");
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
