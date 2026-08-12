#!/usr/bin/env node

import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "apps/api-gateway");
const WRANGLER_BIN = process.env.WRANGLER_BIN?.trim() || join(API_DIR, "node_modules/.bin/wrangler");
const DUMP_DIR = resolve(process.env.ORGBRAIN_LOCAL_DUMP_DIR || join(ROOT, ".local/production-dump"));
const LOCAL_STATE_DIR = resolve(process.env.ORGBRAIN_LOCAL_STATE_DIR || join(DUMP_DIR, "local-state"));
const LOG_DIR = join(DUMP_DIR, "wrangler-logs");
const LOCAL_CONFIG = "wrangler.local.toml";
const REMOTE_CONFIG = "wrangler.remote-d1.toml";
const LOCAL_SNAPSHOT_OWNER = process.env.ORGBRAIN_LOCAL_SNAPSHOT_OWNER?.trim() || "user:local-dev";

// D1 export cannot include SQLite FTS5 virtual tables. These are the
// authoritative application tables; all FTS projections are rebuilt below.
const DATA_TABLES = [
  "agent_messages", "audit_events", "auth_sessions", "business_categories", "capabilities",
  "decision_evidence", "decision_memories", "decision_memory_versions", "decision_rationales",
  "email_auth_challenges", "entities", "group_members", "groups",
  "knowledge_assertion_evidence", "knowledge_assertions", "knowledge_docs", "knowledge_links",
  "knowledge_resource_locations", "knowledge_resource_versions", "knowledge_resources",
  "measurement_comparisons", "measurement_runs", "measurement_variants",
  "memories", "memory_confirmations", "memory_deletions", "memory_edges",
  "memory_effect_attributions", "memory_effect_daily_metrics", "memory_effect_events",
  "memory_entities", "memory_failure_patterns", "memory_impact_daily_metrics",
  "memory_impact_events", "memory_retrieval_units", "memory_retrieval_units_v4",
  "memory_usage_events", "memory_usage_items", "memory_versions", "ops_alert_state",
  "organizations", "principal_owner_mappings", "principal_role_assignments", "resource_acl", "retention_deletion_queue",
  "retention_policies", "retrieval_daily_metrics", "retrieval_evaluation_events",
  "retrieval_events", "retrieval_generation_assignments", "retrieval_generations",
  "retrieval_projection_backfills", "retrieval_projection_jobs",
  "retrieval_projection_v4_backfills", "retrieval_ranking_profiles", "retrieval_units",
  "retrieval_v3_shadow_events", "retrieval_v4_shadow_events", "scheduled_job_runs",
  "scoped_tokens", "task_events", "tasks", "threads", "user_identities", "user_profiles"
];

const FTS_REBUILD_SQL = [
  "DELETE FROM memories_fts",
  "INSERT INTO memories_fts(memory_id, tenant_id, content) SELECT id, tenant_id, COALESCE(summary, '') || char(10) || content FROM memories WHERE (lifecycle_state IS NULL OR lifecycle_state != 'suppressed') AND deleted_at IS NULL",
  "DELETE FROM knowledge_docs_fts",
  "INSERT INTO knowledge_docs_fts(doc_id, tenant_id, title, summary, tags, body_text) SELECT id, tenant_id, title, COALESCE(summary, ''), COALESCE(tags, ''), COALESCE(body_text, '') FROM knowledge_docs WHERE deleted_at IS NULL",
  "DELETE FROM memory_retrieval_units_fts",
  "INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text) SELECT id, memory_id, tenant_id, text FROM memory_retrieval_units",
  "DELETE FROM memory_retrieval_units_v4_fts",
  "INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text) SELECT id, memory_id, tenant_id, text FROM memory_retrieval_units_v4",
  "DELETE FROM retrieval_units_fts",
  "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) SELECT id, generation_id, tenant_id, text FROM retrieval_units",
  "DELETE FROM knowledge_resource_versions_fts",
  "INSERT INTO knowledge_resource_versions_fts(version_id, tenant_id, resource_id, title, text) SELECT v.id, v.tenant_id, v.resource_id, r.title, v.extracted_text FROM knowledge_resource_versions v JOIN knowledge_resources r ON r.tenant_id = v.tenant_id AND r.id = v.resource_id"
].join("; ");

const CLEAR_DATA_SQL = [
  "PRAGMA foreign_keys=OFF",
  ...DATA_TABLES.map((table) => `DELETE FROM "${table}"`),
  "DELETE FROM principal_owner_mappings",
  "PRAGMA foreign_keys=ON"
].join("; ");

function runWrangler(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const capture = Boolean(options.capture);
    const child = spawn(WRANGLER_BIN, args, {
      cwd: API_DIR,
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_LOG_PATH: LOG_DIR
      },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${WRANGLER_BIN} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

async function ensureDirectories() {
  await mkdir(DUMP_DIR, { recursive: true, mode: 0o700 });
  await mkdir(LOCAL_STATE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await chmod(DUMP_DIR, 0o700);
  await chmod(LOCAL_STATE_DIR, 0o700);
  await chmod(LOG_DIR, 0o700);
}

function localArgs(...args) {
  return [
    "d1", "execute", "open-brain", "--local",
    "--persist-to", LOCAL_STATE_DIR,
    "--config", LOCAL_CONFIG,
    ...args
  ];
}

function parseWranglerJson(stdout) {
  const trimmed = stdout.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[" && trimmed[index] !== "{") continue;
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Wrangler may print a status line before its JSON response.
    }
  }
  throw new Error(`Wrangler did not return JSON: ${trimmed.slice(0, 500)}`);
}

async function localStatus() {
  const countSql = `SELECT ${DATA_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(", ")}, (SELECT COUNT(*) FROM memories_fts) AS memories_fts, (SELECT COUNT(*) FROM knowledge_docs_fts) AS knowledge_docs_fts, (SELECT COUNT(*) FROM memory_retrieval_units_fts) AS memory_retrieval_units_fts, (SELECT COUNT(*) FROM memory_retrieval_units_v4_fts) AS memory_retrieval_units_v4_fts, (SELECT COUNT(*) FROM retrieval_units_fts) AS retrieval_units_fts, (SELECT COUNT(*) FROM knowledge_resource_versions_fts) AS knowledge_resource_versions_fts`;
  const result = await runWrangler(localArgs("--json", "--command", countSql), { capture: true });
  const payload = parseWranglerJson(result.stdout);
  const row = payload?.[0]?.results?.[0] || {};
  const tableCounts = Object.fromEntries(DATA_TABLES.map((table) => [table, Number(row[table] ?? 0)]));
  const ftsCounts = Object.fromEntries([
    "memories_fts", "knowledge_docs_fts", "memory_retrieval_units_fts",
    "memory_retrieval_units_v4_fts", "retrieval_units_fts", "knowledge_resource_versions_fts"
  ].map((table) => [table, Number(row[table] ?? 0)]));
  return {
    state_dir: LOCAL_STATE_DIR,
    data_tables: DATA_TABLES.length,
    total_rows: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
    table_counts: tableCounts,
    fts_counts: ftsCounts
  };
}

async function rebuildFts() {
  await runWrangler(localArgs("--json", "--command", FTS_REBUILD_SQL), { capture: true });
}

async function backfillLocalOwnership() {
  const escapedOwner = LOCAL_SNAPSHOT_OWNER.replaceAll("'", "''");
  await runWrangler(localArgs(
    "--json",
    "--command",
    `UPDATE memories
     SET owner_principal = COALESCE(owner_principal, '${escapedOwner}'),
         created_by_principal = COALESCE(created_by_principal, '${escapedOwner}')
     WHERE owner_principal IS NULL OR created_by_principal IS NULL`
  ), { capture: true });
}

async function applyMigrations() {
  await runWrangler([
    "d1", "migrations", "apply", "open-brain", "--local",
    "--persist-to", LOCAL_STATE_DIR,
    "--config", LOCAL_CONFIG
  ]);
}

async function clearData() {
  await runWrangler(localArgs("--json", "--command", CLEAR_DATA_SQL), { capture: true });
}

async function restoreDump(dumpPath) {
  await ensureDirectories();
  await stat(dumpPath);
  await applyMigrations();
  await clearData();
  await runWrangler(localArgs("--file", dumpPath, "--yes"), { capture: true });
  await backfillLocalOwnership();
  await rebuildFts();
  return localStatus();
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function exportProductionDump() {
  if (!process.argv.includes("--from-production")) {
    throw new Error("Production export is explicit: rerun with --from-production");
  }
  await ensureDirectories();
  const output = join(DUMP_DIR, `production-${timestamp()}.data.sql`);
  const args = ["d1", "export", "open-brain", "--remote", "--config", REMOTE_CONFIG, "--no-schema"];
  for (const table of DATA_TABLES) args.push("--table", table);
  args.push("--output", output);
  await runWrangler(args);
  await chmod(output, 0o600);
  const file = await stat(output);
  const digest = await new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(output);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolvePromise(hash.digest("hex")));
  });
  return { output, bytes: file.size, sha256: digest };
}

async function latestDump() {
  const files = (await readdir(DUMP_DIR).catch(() => [])).filter((name) => /^production-.*\.data\.sql$/u.test(name)).sort();
  if (files.length === 0) throw new Error(`No production dump found under ${DUMP_DIR}`);
  return join(DUMP_DIR, files.at(-1));
}

async function main() {
  const [action = "status", ...args] = process.argv.slice(2);
  if (action === "refresh") {
    console.log(JSON.stringify(await exportProductionDump(), null, 2));
    return;
  }
  if (action === "restore") {
    const dumpIndex = args.indexOf("--dump");
    const dumpPath = dumpIndex >= 0 ? resolve(args[dumpIndex + 1]) : await latestDump();
    console.log(JSON.stringify(await restoreDump(dumpPath), null, 2));
    return;
  }
  if (action === "sync") {
    const exported = await exportProductionDump();
    const status = await restoreDump(exported.output);
    console.log(JSON.stringify({ ...exported, restore: status }, null, 2));
    return;
  }
  if (action === "fts") {
    await ensureDirectories();
    await rebuildFts();
    console.log(JSON.stringify(await localStatus(), null, 2));
    return;
  }
  if (action === "status") {
    await ensureDirectories();
    console.log(JSON.stringify(await localStatus(), null, 2));
    return;
  }
  throw new Error(`Unknown action: ${action}. Use status, refresh --from-production, restore, sync --from-production, or fts.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
