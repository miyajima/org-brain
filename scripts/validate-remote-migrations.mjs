#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseLocationArgs, runD1Query } from "../packages/benchmarks/src/metrics-common.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const MIGRATION_DIR = resolve(ROOT, "migrations");

function usage() {
  return `Validate pending D1 migrations against a read-only schema snapshot

Usage:
  pnpm migrations:remote-validate -- --remote --output <private-report.json>

The report contains schema metadata, migration hashes, and contract results;
it never includes table rows or memory content.
`;
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv, { location: "remote", database: "open-brain" }),
    output: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--", "--remote", "--local", "--preview", "--json", "--help", "-h"].includes(arg)) continue;
    if (["--tenant", "--database", "--env"].includes(arg) || /^(?:--tenant|--database|--env)=/u.test(arg)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    const match = /^--output(?:=(.*))?$/u.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[1] ?? argv[++index];
    if (!value) throw new Error("--output requires a value");
    options.output = resolve(value);
  }
  if (!options.output) throw new Error("--output is required");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function objectNames(db, type) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name"
  ).all(type).map((row) => String(row.name));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all()
    .map((row) => String(row.name)).sort();
}

function shouldSkipSchemaObject(row) {
  const name = String(row.name ?? "");
  const sql = String(row.sql ?? "");
  return name.startsWith("sqlite_") || /_fts/u.test(name) || /_fts/u.test(sql) ||
    /CREATE\s+VIRTUAL\s+TABLE/iu.test(sql);
}

async function readPendingMigrations() {
  const files = (await readdir(MIGRATION_DIR))
    .filter((file) => /^(?:0029|0030|0031|0032)_.+\.sql$/u.test(file))
    .sort();
  if (files.length !== 5) throw new Error(`expected five pending migration files, found ${files.length}`);
  return Promise.all(files.map(async (file) => {
    const sql = await readFile(resolve(MIGRATION_DIR, file), "utf8");
    return { file, sha256: sha256(sql), bytes: Buffer.byteLength(sql), sql };
  }));
}

async function fetchSchema(options) {
  return runD1Query(options, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 WHEN 'view' THEN 4 ELSE 5 END, name;
  `);
}

function applySchemaCopy(db, rows) {
  const skipped = [];
  const applicable = [];
  for (const row of rows) {
    if (shouldSkipSchemaObject(row)) {
      skipped.push({ type: row.type, name: row.name, reason_code: "fts_or_virtual_table" });
      continue;
    }
    applicable.push(row);
  }
  const order = { table: 1, index: 2, trigger: 3, view: 4 };
  applicable.sort((left, right) => (order[left.type] ?? 9) - (order[right.type] ?? 9) ||
    String(left.name).localeCompare(String(right.name)));
  const failures = [];
  for (const row of applicable) {
    try {
      db.exec(String(row.sql));
    } catch (error) {
      failures.push({ type: row.type, name: row.name, reason_code: error?.message ?? "schema_copy_failed" });
    }
  }
  if (failures.length) {
    const error = new Error("remote_schema_copy_failed");
    error.failures = failures;
    throw error;
  }
  return { applicable_count: applicable.length, skipped };
}

function runCanonicalGuardContract(db) {
  const tenant = "__migration_validation__";
  const insert = db.prepare(
    `INSERT INTO memories(id, tenant_id, content, created_at, canonical_key, lifecycle_state)
     VALUES(?, ?, ?, 1, ?, ?)`
  );
  let duplicateRejected = false;
  try {
    insert.run("schema-check-a", tenant, "contract", "schema-check-canonical", "active");
    try {
      insert.run("schema-check-b", tenant, "contract", "schema-check-canonical", "active");
    } catch (error) {
      duplicateRejected = /duplicate_canonical_key/u.test(String(error?.message));
    }
  } finally {
    db.prepare("DELETE FROM memories WHERE tenant_id = ?").run(tenant);
  }
  return { duplicate_active_canonical_rejected: duplicateRejected };
}

function migrationContract(db) {
  const requiredColumns = {
    memories: [
      "reuse_rule", "owner_principal", "created_by_principal", "deleted_at",
      "deleted_by_principal", "delete_reason", "capture_origin", "verification_state",
      "verified_at", "learning_json", "quality_dimensions_json"
    ],
    memory_versions: ["reuse_rule"],
    decision_memories: ["origin_memory_id", "origin_source", "origin_external_key", "auto_generated"],
    decision_evidence: ["content_hash", "observed_at", "attestation_ref"],
    task_commitments: [
      "tenant_id", "project_id", "task_key", "decision_key", "question_fingerprint",
      "answer_json", "authority", "confirmation_state", "ask_policy", "evidence_digest",
      "version", "updated_at", "expires_at", "superseded_at"
    ],
    memory_learning_candidates: [
      "tenant_id", "project_id", "task_key", "external_key", "payload_json", "status",
      "reason_codes_json", "prompt_contract_id", "prompt_hash", "verifier_version", "updated_at", "expires_at"
    ],
    memory_learning_judgments: [
      "tenant_id", "candidate_id", "judge_name", "judge_model", "prompt_hash", "verdict",
      "reason_codes_json", "support_json", "model_version", "candidate_hash", "signature", "public_key_fingerprint", "created_at"
    ],
    memory_learning_candidate_evidence: [
      "tenant_id", "candidate_id", "evidence_type", "evidence_ref", "digest", "diff_hash",
      "supports_json", "verification_state", "created_at"
    ],
    task_commitment_semantic_aliases: [
      "tenant_id", "project_id", "task_key", "decision_key", "commitment_id",
      "alias_fingerprint", "alias_question", "certification", "prompt_hash",
      "verifier_version", "created_at", "expires_at"
    ]
  };
  const columnChecks = Object.fromEntries(Object.entries(requiredColumns).map(([table, columns]) => {
    const actual = new Set(tableColumns(db, table));
    return [table, Object.fromEntries(columns.map((column) => [column, actual.has(column)]))];
  }));
  const requiredObjects = [
    "idx_decision_memories_auto_origin",
    "idx_decision_memories_origin_memory",
    "idx_memories_active_canonical_lookup",
    "idx_memories_owner_lifecycle",
    "idx_memories_creator",
    "idx_memories_deleted",
    "idx_principal_owner_mappings_owner",
    "idx_memories_learning_origin_state",
    "idx_memories_learning_scope",
    "idx_decision_evidence_attestation",
    "memories_active_canonical_insert_guard",
    "memories_active_canonical_update_guard",
    "decision_retrieval_projection_backfills",
    "principal_owner_mappings",
    "idx_task_commitments_active",
    "idx_task_commitments_context",
    "idx_task_commitment_aliases_context",
    "idx_memory_learning_candidates_review",
    "idx_memory_learning_candidate_evidence",
    "idx_memory_learning_judgments_candidate",
    "memory_learning_candidate_verified_requires_consensus",
    "idx_memory_quality_measurements_run",
    "task_commitments",
    "task_commitment_semantic_aliases",
    "memory_learning_candidates",
    "memory_learning_candidate_evidence",
    "memory_learning_judgments",
    "memory_quality_runs",
    "memory_quality_measurements"
  ];
  const objects = new Set([
    ...objectNames(db, "table"),
    ...objectNames(db, "index"),
    ...objectNames(db, "trigger")
  ]);
  const objectChecks = Object.fromEntries(requiredObjects.map((name) => [name, objects.has(name)]));
  const generation = db.prepare("SELECT id, status FROM retrieval_generations WHERE id = 'gen_verified_learning'").get() ?? null;
  const guard = runCanonicalGuardContract(db);
  const columnsPass = Object.values(columnChecks).every((checks) => Object.values(checks).every(Boolean));
  const objectsPass = Object.values(objectChecks).every(Boolean);
  const passed = columnsPass && objectsPass && Boolean(generation) && guard.duplicate_active_canonical_rejected;
  return {
    passed,
    required_columns: columnChecks,
    required_objects: objectChecks,
    verified_learning_generation: generation ? { present: true, status: generation.status } : { present: false },
    canonical_guard: guard
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const [schemaRows, migrations] = await Promise.all([
    fetchSchema(options),
    readPendingMigrations()
  ]);
  const db = new DatabaseSync(":memory:");
  let schemaCopy;
  let migrationResults;
  try {
    schemaCopy = applySchemaCopy(db, schemaRows);
    migrationResults = [];
    for (const migration of migrations) {
      const started = Date.now();
      let passed = false;
      let reasonCode = null;
      try {
        db.exec("BEGIN");
        db.exec(migration.sql);
        db.exec("COMMIT");
        passed = true;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        reasonCode = error?.message ?? "migration_apply_failed";
      }
      migrationResults.push({
        file: migration.file,
        sha256: migration.sha256,
        bytes: migration.bytes,
        passed,
        reason_code: reasonCode,
        duration_ms: Date.now() - started
      });
      if (!passed) break;
    }
    const contract = migrationResults.every((migration) => migration.passed)
      ? migrationContract(db)
      : { passed: false, reason_code: "migration_apply_failed" };
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      target: { location: options.location, database: options.database },
      source_schema: {
        object_count: schemaRows.length,
        applied_object_count: schemaCopy.applicable_count,
        skipped_object_count: schemaCopy.skipped.length,
        skipped_reason_counts: Object.fromEntries(
          [...new Set(schemaCopy.skipped.map((item) => item.reason_code))].map((reason) => [
            reason, schemaCopy.skipped.filter((item) => item.reason_code === reason).length
          ])
        )
      },
      migrations: migrationResults,
      contract,
      physical_delete_count: 0,
      raw_content_included: false,
      credential_values_included: false,
      passed: migrationResults.length === migrations.length && migrationResults.every((migration) => migration.passed) && contract.passed
    };
    const serialized = JSON.stringify(report, null, 2);
    await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
    await writeFile(options.output, `${serialized}\n`, { mode: 0o600 });
    await chmod(options.output, 0o600);
    console.log(JSON.stringify({
      output: options.output,
      passed: report.passed,
      migration_count: report.migrations.length,
      schema_object_count: report.source_schema.object_count,
      contract_passed: report.contract.passed
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    reason_code: error?.message ?? "remote_migration_validation_failed",
    failures: error?.failures ?? []
  }));
  process.exitCode = 1;
});
