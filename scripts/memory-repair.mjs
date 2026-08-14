#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync, backup as backupSqlite } from "node:sqlite";
import process from "node:process";
import {
  planDecisionClassificationRepairRows,
  planMemoryRepairRows
} from "../packages/shared/src/memory-repair-core.mjs";
import {
  DEFAULT_LOCAL_DB,
  LocalMemoryStore
} from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  parseLocationArgs,
  runD1Query,
  sqlString
} from "../packages/benchmarks/src/metrics-common.mjs";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 250;
const API_BATCH_SIZE = 25;
const BACKUP_DATA_TABLES = [
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
  "organizations", "principal_owner_mappings", "principal_role_assignments", "resource_acl",
  "retention_deletion_queue", "retention_policies", "retrieval_daily_metrics",
  "retrieval_evaluation_events", "retrieval_events", "retrieval_generation_assignments",
  "retrieval_generations", "retrieval_projection_backfills", "retrieval_projection_jobs",
  "retrieval_projection_v4_backfills", "retrieval_ranking_profiles", "retrieval_units",
  "retrieval_v3_shadow_events", "retrieval_v4_shadow_events", "scheduled_job_runs",
  "scoped_tokens", "task_events", "tasks", "threads", "user_identities", "user_profiles"
];
const repoRoot = resolve(import.meta.dirname, "..");
const apiGatewayDir = resolve(repoRoot, "apps/api-gateway");

function usage() {
  return `Org Brain safe memory repair

Usage:
  pnpm memories:repair -- --local [--db-path <path>] [--apply --output-dir <dir>]
  pnpm memories:repair -- --remote [--tenant <id>] [--apply --output-dir <dir> --api-url <url> --api-key <key>]

Options:
  --local | --remote | --preview  Target adapter (default: local)
  --db-path <path>                Local SQLite path (default: ~/.org-brain/memory.sqlite)
  --tenant <id>                   Tenant ID (default: default)
  --project <id>                  Limit scan/apply to one project ID
  --project-null                  Limit scan/apply to rows without a project ID
  --database <name>               D1 database name (default: open-brain)
  --workspace-root <path>         Convert workspace paths to repository-relative paths
  --page-size <n>                 Cursor page size, 1-500 (default: ${PAGE_SIZE})
  --dry-run                       Explicit no-op alias for the default plan-only mode
  --report <path>                 Write the sanitized dry-run/apply report to this private path
  --output-dir <path>             Required for apply; receives backup/export, manifest, reports, checkpoint
  --api-url <url>                 Cloud API URL (or ORGBRAIN_API_URL)
  --api-key <key>                 Cloud API key (or ORGBRAIN_API_KEY)
  --resume                        Resume apply from a matching checkpoint
  --apply                         Apply the plan; omitted means dry-run
  --json                          Print the report as JSON
  --help                          Show this help
`;
}

function parseArgs(argv) {
  const location = parseLocationArgs(argv, { location: "local" });
  const options = {
    ...location,
    apply: false,
    resume: false,
    dbPath: DEFAULT_LOCAL_DB,
    outputDir: null,
    reportPath: null,
    project: null,
    projectNull: false,
    workspaceRoot: null,
    pageSize: PAGE_SIZE,
    apiUrl: process.env.ORGBRAIN_API_URL ?? process.env.ORGBRAIN_API_BASE ?? null,
    apiKey: process.env.ORGBRAIN_API_KEY ?? null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--", "--json", "--dry-run", "--help", "-h", "--local", "--remote", "--preview"].includes(arg)) continue;
    if (arg === "--project-null") { options.projectNull = true; continue; }
    if (["--tenant", "--database", "--env"].includes(arg) || /^(?:--tenant|--database|--env)=/u.test(arg)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--resume") { options.resume = true; continue; }
    const match = /^(--db-path|--output-dir|--report|--project|--workspace-root|--page-size|--api-url|--api-key)(?:=(.*))?$/u.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`${match[1]} requires a value`);
    if (match[1] === "--db-path") options.dbPath = resolve(value);
    if (match[1] === "--output-dir") options.outputDir = resolve(value);
    if (match[1] === "--report") options.reportPath = resolve(value);
    if (match[1] === "--project") options.project = value.trim() || null;
    if (match[1] === "--workspace-root") options.workspaceRoot = resolve(value);
    if (match[1] === "--api-url") options.apiUrl = value.replace(/\/$/u, "");
    if (match[1] === "--api-key") options.apiKey = value;
    if (match[1] === "--page-size") {
      options.pageSize = Number.parseInt(value, 10);
      if (!Number.isFinite(options.pageSize) || options.pageSize < 1 || options.pageSize > 500) {
        throw new Error("--page-size must be between 1 and 500");
      }
    }
  }
  if (options.apply && !options.outputDir) throw new Error("--output-dir is required with --apply");
  if (options.project && options.projectNull) throw new Error("use either --project or --project-null");
  if (options.reportPath && options.apply && options.outputDir) {
    throw new Error("use either --report or --output-dir with --apply, not both");
  }
  if (options.resume && !options.apply) throw new Error("--resume requires --apply");
  if (options.apply && options.location !== "local" && (!options.apiUrl || !options.apiKey)) {
    throw new Error("--api-url and --api-key are required for cloud apply");
  }
  return options;
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256Buffer(await readFile(path));
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function ensureOutputDirectory(path) {
  if (!path) return;
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function projectPredicate(projectId, projectNull) {
  if (projectNull) return "AND project_id IS NULL";
  return projectId ? `AND project_id = ${sqlString(projectId)}` : "";
}

function memorySelectSql(tenantId, projectId, projectNull, cursor, limit) {
  return `SELECT id, tenant_id, project_id, business_category_id, work_type, source,
                 external_key, content, summary, tags_json, kind, lifecycle_state,
                 created_at, valid_until, expires_at, confidence_score, utility_score,
                 entities_json, rationale, reuse_rule, evidence_json, source_refs_json,
                 conflicts_json, current_version
          FROM memories
          WHERE tenant_id = ${sqlString(tenantId)}
            ${projectPredicate(projectId, projectNull)}
            AND id > ${sqlString(cursor)}
          ORDER BY id
          LIMIT ${limit};`;
}

function categorySelectSql(tenantId, cursor, limit) {
  return `SELECT id
          FROM business_categories
          WHERE tenant_id = ${sqlString(tenantId)}
            AND is_active = 1
            AND id > ${sqlString(cursor)}
          ORDER BY id
          LIMIT ${limit};`;
}

function decisionSelectSql(tenantId, projectId, projectNull, cursor, limit) {
  return `SELECT id, project_id, business_category_id, work_type, status
          FROM decision_memories
          WHERE tenant_id = ${sqlString(tenantId)}
            ${projectPredicate(projectId, projectNull)}
            AND status = 'active'
            AND id > ${sqlString(cursor)}
          ORDER BY id
          LIMIT ${limit};`;
}

async function scanLocal(options) {
  if (!existsSync(options.dbPath)) {
    const error = new Error("database_not_found");
    error.code = "database_not_found";
    throw error;
  }
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  const rows = [];
  const decisionRows = [];
  const categoryIds = new Set();
  let cursor = "";
  try {
    while (true) {
      const projectSql = options.projectNull ? "AND project_id IS NULL" : options.project ? "AND project_id = ?" : "";
      const projectParams = options.projectNull ? [options.tenant] : options.project ? [options.tenant, options.project] : [options.tenant];
      const page = db.prepare(
        `SELECT id, tenant_id, project_id, business_category_id, work_type, source,
                external_key, content, summary, tags_json, kind, lifecycle_state,
                created_at, valid_until, expires_at, confidence_score, utility_score,
                entities_json, rationale, reuse_rule, evidence_json, source_refs_json,
                conflicts_json, current_version
         FROM memories WHERE tenant_id = ? ${projectSql} AND id > ?
         ORDER BY id LIMIT ?`
      ).all(...projectParams, cursor, options.pageSize);
      rows.push(...page);
      if (page.length < options.pageSize) break;
      cursor = page.at(-1).id;
    }
    for (const row of db.prepare(
      "SELECT id FROM business_categories WHERE tenant_id = ? AND is_active = 1"
    ).all(options.tenant)) {
      categoryIds.add(String(row.id));
    }
    const hasDecisionMemories = Boolean(db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='decision_memories'"
    ).get());
    if (hasDecisionMemories) {
      let decisionCursor = "";
      while (true) {
        const decisionSql = options.projectNull ? "AND project_id IS NULL" : options.project ? "AND project_id = ?" : "";
        const decisionParams = options.projectNull ? [options.tenant] : options.project ? [options.tenant, options.project] : [options.tenant];
        const page = db.prepare(
          `SELECT id, project_id, business_category_id, work_type, status
           FROM decision_memories
           WHERE tenant_id = ? ${decisionSql} AND status = 'active' AND id > ?
           ORDER BY id LIMIT ?`
        ).all(...decisionParams, decisionCursor, options.pageSize);
        decisionRows.push(...page);
        if (page.length < options.pageSize) break;
        decisionCursor = String(page.at(-1).id);
      }
    }
  } finally {
    db.close();
  }
  return { memoryRows: rows, decisionRows, categoryIds };
}

async function scanD1(options) {
  const rows = [];
  let cursor = "";
  while (true) {
    const page = await runD1Query(options, memorySelectSql(options.tenant, options.project, options.projectNull, cursor, options.pageSize));
    rows.push(...page);
    if (page.length < options.pageSize) break;
    cursor = String(page.at(-1).id);
  }
  const categoryIds = new Set();
  cursor = "";
  while (true) {
    const page = await runD1Query(options, categorySelectSql(options.tenant, cursor, options.pageSize));
    for (const row of page) categoryIds.add(String(row.id));
    if (page.length < options.pageSize) break;
    cursor = String(page.at(-1).id);
  }
  const decisionRows = [];
  cursor = "";
  while (true) {
    const page = await runD1Query(options, decisionSelectSql(options.tenant, options.project, options.projectNull, cursor, options.pageSize));
    decisionRows.push(...page);
    if (page.length < options.pageSize) break;
    cursor = String(page.at(-1).id);
  }
  return { memoryRows: rows, decisionRows, categoryIds };
}

async function createBackup(options) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  if (options.location === "local") {
    const backupPath = resolve(options.outputDir, `${basename(options.dbPath)}.${stamp}.backup.sqlite`);
    const source = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      await backupSqlite(source, backupPath);
    } finally {
      source.close();
    }
    await chmod(backupPath, 0o600);
    return backupPath;
  }
  if (options.location !== "remote") throw new Error("cloud apply supports --remote only");
  const exportPath = resolve(options.outputDir, `${options.database}.${stamp}.export.sql`);
  await execFileAsync("pnpm", [
    "--dir", apiGatewayDir, "exec", "wrangler", "d1", "export", options.database,
    "--remote", "--config", "wrangler.remote-d1.toml", "--no-schema",
    ...BACKUP_DATA_TABLES.flatMap((table) => ["--table", table]),
    "--output", exportPath,
    ...(options.env ? ["--env", options.env] : [])
  ], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  await chmod(exportPath, 0o600);
  return exportPath;
}

function sanitizedPlan(plan) {
  return {
    tenant_id: plan.tenant_id,
    project_id: plan.project_id ?? null,
    project_null: plan.project_null ?? false,
    scanned_count: plan.scanned_count,
    decision_scanned_count: plan.decision_scanned_count ?? 0,
    stats: plan.stats,
    categories: plan.categories.map((category) => ({ id: category.id, slug: category.slug, label: category.label })),
    actions: plan.actions.map((action) => ({
      type: action.type,
      memory_id: action.memory_id,
      reason_code: action.reason_code,
      candidate_hash: action.candidate_hash ?? null,
      canonical_key_hash: action.canonical_key ? sha256Buffer(action.canonical_key) : null,
      winner_memory_id: action.winner_memory_id ?? null,
      derived_from: action.derived_from ?? null
    })),
    decision_actions: (plan.decision_actions ?? []).map((action) => ({
      type: action.type,
      decision_memory_id: action.decision_memory_id,
      business_category_id: action.business_category_id,
      work_type: action.work_type,
      reason_code: action.reason_code
    })),
    credential_rotation_required: plan.credential_rotation_required
  };
}

function localCategoryUpsert(db, tenantId, category) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO business_categories(id, tenant_id, slug, label, description, is_active, created_at, updated_at)
     VALUES(?,?,?,?,?,1,?,?)
     ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, label=excluded.label,
       description=excluded.description, is_active=1, updated_at=excluded.updated_at`
  ).run(category.id, tenantId, category.slug, category.label, category.description, now, now);
}

function derivedCaptureInput(action) {
  return {
    id: action.memory_id,
    tenant_id: action.tenant_id,
    source: "memory-repair",
    external_key: action.external_key,
    project_id: action.project_id,
    business_category_id: action.business_category_id,
    work_type: action.work_type,
    content: action.content,
    summary: action.summary,
    tags: action.tags,
    created_at: action.created_at,
    kind: action.kind,
    lifecycle_state: "active",
    scope_type: action.project_id ? "project" : "tenant",
    scope_key: action.project_id ?? action.tenant_id,
    confidence_score: action.confidence_score,
    utility_score: action.utility_score,
    canonical_key: action.canonical_key,
    root_memory_id: action.root_memory_id,
    valid_from: action.valid_from,
    valid_until: action.valid_until,
    expires_at: action.valid_until,
    rationale: action.rationale,
    reuse_rule: action.reuse_rule,
    evidence: action.evidence,
    capture_origin: "repair",
    verification_state: "partial",
    verified_at: null,
    source_references: action.source_references,
    permissions: action.visibility === "restricted"
      ? action.allowed_principals.map((principal) => ({ principal_type: "principal", principal_id: principal, permissions: ["read"] }))
      : [],
    actor_type: "system",
    actor_id: "memory-repair"
  };
}

async function markRepairDerivedRowsRemote(options, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return;
  await runD1Query(options, `
    UPDATE memories
    SET capture_origin = 'repair', verification_state = 'partial', verified_at = NULL
    WHERE tenant_id = ${sqlString(options.tenant)}
      AND id IN (${uniqueIds.map((id) => sqlString(id)).join(",")});
  `);
}

async function applyLocal(options, plan, checkpointPath, checkpoint) {
  if ((plan.decision_actions ?? []).length > 0) {
    throw new Error("local_decision_repair_not_supported");
  }
  const store = await new LocalMemoryStore(options.dbPath).init();
  const categoryDb = store.open();
  try {
    categoryDb.exec("BEGIN IMMEDIATE");
    for (const category of plan.categories) localCategoryUpsert(categoryDb, options.tenant, category);
    categoryDb.exec("COMMIT");
  } catch (error) {
    try { categoryDb.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    categoryDb.close();
  }
  const mutations = [
    ...plan.actions.filter((action) => action.type === "derive"),
    ...plan.actions.filter((action) => action.type === "update"),
    ...plan.actions.filter((action) => action.type === "suppress")
  ];
  for (let index = checkpoint.next_action_index ?? 0; index < mutations.length; index += 1) {
    const action = mutations[index];
    if (action.type === "derive") {
      const existingDb = store.open({ readOnly: true });
      let existing;
      try {
        existing = existingDb.prepare(
          "SELECT id FROM memories WHERE tenant_id=? AND source='memory-repair' AND external_key=?"
        ).get(options.tenant, action.external_key);
      } finally { existingDb.close(); }
      if (!existing) await store.capture(derivedCaptureInput(action));
      const provenanceDb = store.open();
      try {
        provenanceDb.prepare(
          `UPDATE memories
           SET capture_origin = 'repair', verification_state = 'partial', verified_at = NULL
           WHERE tenant_id = ? AND id = ?`
        ).run(options.tenant, action.memory_id);
      } finally { provenanceDb.close(); }
      const db = store.open();
      try {
        db.prepare(
          `INSERT INTO memory_edges(id, tenant_id, from_memory_id, to_memory_id, relation, created_at)
           SELECT ?,?,?,?,?,? WHERE NOT EXISTS(
             SELECT 1 FROM memory_edges WHERE tenant_id=? AND from_memory_id=? AND to_memory_id=? AND relation='derived_from'
           )`
        ).run(
          `repair_edge_${sha256Buffer(`${action.memory_id}\0${action.derived_from}`).slice(0, 24)}`,
          options.tenant, action.memory_id, action.derived_from, "derived_from", Date.now(),
          options.tenant, action.memory_id, action.derived_from
        );
      } finally { db.close(); }
    } else if (action.type === "update") {
      const db = store.open({ readOnly: true });
      let current;
      try { current = db.prepare("SELECT * FROM memories WHERE tenant_id=? AND id=?").get(options.tenant, action.memory_id); }
      finally { db.close(); }
      if (current && (
        current.content !== action.content || current.summary !== action.summary ||
        current.tags_json !== JSON.stringify(action.tags) ||
        current.entities_json !== JSON.stringify(action.entities) ||
        current.rationale !== action.rationale ||
        current.reuse_rule !== action.reuse_rule ||
        current.evidence_json !== JSON.stringify(action.evidence) ||
        current.source_refs_json !== JSON.stringify(action.source_references) ||
        current.conflicts_json !== JSON.stringify(action.conflicts) ||
        current.business_category_id !== action.business_category_id || current.work_type !== action.work_type ||
        current.kind !== action.kind || current.canonical_key !== action.canonical_key ||
        current.expires_at !== action.valid_until || current.valid_until !== action.valid_until
      )) {
        await store.revise(options.tenant, action.memory_id, {
          content: action.content,
          summary: action.summary,
          tags: action.tags,
          entities: action.entities,
          rationale: action.rationale,
          reuse_rule: action.reuse_rule,
          evidence: action.evidence,
          source_references: action.source_references,
          conflicts: action.conflicts,
          business_category_id: action.business_category_id,
          work_type: action.work_type,
          kind: action.kind,
          canonical_key: action.canonical_key,
          valid_until: action.valid_until,
          expires_at: action.valid_until,
          actor_type: "system",
          actor_id: "memory-repair"
        });
      }
    } else {
      const db = store.open({ readOnly: true });
      let current;
      try { current = db.prepare("SELECT lifecycle_state FROM memories WHERE tenant_id=? AND id=?").get(options.tenant, action.memory_id); }
      finally { db.close(); }
      if (current && current.lifecycle_state !== "suppressed") {
        await store.suppress(options.tenant, action.memory_id, action.reason_code, {
          actor_type: "system", actor_id: "memory-repair"
        });
      }
    }
    checkpoint.next_action_index = index + 1;
    await writePrivateJson(checkpointPath, checkpoint);
  }
  return mutations.length;
}

async function apiJson(options, path, body) {
  const response = await fetch(`${options.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      "x-api-key": options.apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`repair API ${path} failed (${response.status}): ${payload?.error?.code ?? "unknown"}`);
  return payload;
}

async function ensureCloudCategories(options, categories) {
  for (const category of categories) {
    const now = Date.now();
    await runD1Query(options, `
      INSERT INTO business_categories(id, tenant_id, slug, label, description, is_active, created_at, updated_at)
      VALUES(${sqlString(category.id)},${sqlString(options.tenant)},${sqlString(category.slug)},${sqlString(category.label)},${sqlString(category.description)},1,${now},${now})
      ON CONFLICT(id) DO UPDATE SET
        slug=excluded.slug,
        label=excluded.label,
        description=excluded.description,
        is_active=1,
        updated_at=excluded.updated_at;
    `);
  }
}

async function applyCloud(options, plan, checkpointPath, checkpoint) {
  await ensureCloudCategories(options, plan.categories);
  const decisionActions = plan.decision_actions ?? [];
  for (let index = checkpoint.next_decision_action_index ?? 0; index < decisionActions.length; index += 1) {
    const action = decisionActions[index];
    const current = (await runD1Query(options, `
      SELECT business_category_id, work_type
      FROM decision_memories
      WHERE tenant_id=${sqlString(options.tenant)} AND id=${sqlString(action.decision_memory_id)}
      LIMIT 1;
    `))[0];
    if (!current || current.business_category_id !== action.business_category_id || current.work_type !== action.work_type) {
      await apiJson(
        options,
        `/v1/decision-memories/${encodeURIComponent(action.decision_memory_id)}/revise?tenant_id=${encodeURIComponent(options.tenant)}`,
        {
          business_category_id: action.business_category_id,
          work_type: action.work_type,
          note: "memory-repair-v2 classification"
        }
      );
    }
    checkpoint.next_decision_action_index = index + 1;
    await writePrivateJson(checkpointPath, checkpoint);
  }
  const derived = plan.actions.filter((action) => action.type === "derive");
  const derivedIds = checkpoint.derived_ids ?? {};
  for (let offset = 0; offset < derived.length; offset += API_BATCH_SIZE) {
    const window = derived.slice(offset, offset + API_BATCH_SIZE);
    for (const action of window) {
      if (derivedIds[action.external_key]) continue;
      const existing = (await runD1Query(options, `
        SELECT id FROM memories
        WHERE tenant_id=${sqlString(options.tenant)}
          AND source='memory-repair'
          AND external_key=${sqlString(action.external_key)}
        LIMIT 1;
      `))[0];
      if (existing?.id) derivedIds[action.external_key] = String(existing.id);
    }
    const batch = window.filter((action) => !derivedIds[action.external_key]);
    if (!batch.length) continue;
    const response = await apiJson(options, "/v1/memories/capture", {
      tenant_id: options.tenant,
      source: "memory-repair",
      items: batch.map(derivedCaptureInput)
    });
    const results = response.items ?? response.data?.items ?? [];
    batch.forEach((action, index) => {
      derivedIds[action.external_key] = results[index]?.memory_id ?? action.memory_id;
    });
    checkpoint.derived_ids = derivedIds;
    await writePrivateJson(checkpointPath, checkpoint);
    await markRepairDerivedRowsRemote(options, window.map((action) => derivedIds[action.external_key]));
  }
  const mutations = [
    ...plan.actions.filter((action) => action.type === "update"),
    ...plan.actions.filter((action) => action.type === "suppress")
  ];
  for (const action of derived) {
    const derivedId = derivedIds[action.external_key];
    if (!derivedId) continue;
    const edgeId = `repair_edge_${sha256Buffer(`${derivedId}\0${action.derived_from}`).slice(0, 24)}`;
    await runD1Query(options, `
      INSERT INTO memory_edges(id, tenant_id, from_memory_id, to_memory_id, relation, created_at)
      SELECT ${sqlString(edgeId)},${sqlString(options.tenant)},${sqlString(derivedId)},${sqlString(action.derived_from)},'derived_from',${Date.now()}
      WHERE NOT EXISTS(
        SELECT 1 FROM memory_edges WHERE tenant_id=${sqlString(options.tenant)}
          AND from_memory_id=${sqlString(derivedId)} AND to_memory_id=${sqlString(action.derived_from)}
          AND relation='derived_from'
      );
    `);
  }
  for (let index = checkpoint.next_action_index ?? 0; index < mutations.length; index += 1) {
    const action = mutations[index];
    if (action.type === "update") {
      const current = (await runD1Query(options, `
        SELECT content, summary, tags_json, entities_json, rationale, reuse_rule, evidence_json,
               source_refs_json, conflicts_json, business_category_id, work_type,
               kind, canonical_key, valid_until, expires_at
        FROM memories
        WHERE tenant_id=${sqlString(options.tenant)} AND id=${sqlString(action.memory_id)}
        LIMIT 1;
      `))[0];
      if (!current || current.content !== action.content || current.summary !== action.summary ||
          current.tags_json !== JSON.stringify(action.tags) ||
          current.entities_json !== JSON.stringify(action.entities) ||
          current.rationale !== action.rationale ||
          current.reuse_rule !== action.reuse_rule ||
          current.evidence_json !== JSON.stringify(action.evidence) ||
          current.source_refs_json !== JSON.stringify(action.source_references) ||
          current.conflicts_json !== JSON.stringify(action.conflicts) ||
          current.business_category_id !== action.business_category_id || current.work_type !== action.work_type ||
          current.kind !== action.kind || current.canonical_key !== action.canonical_key ||
          current.valid_until !== action.valid_until || current.expires_at !== action.valid_until) {
        await apiJson(options, "/v1/memories/revise", {
          tenant_id: options.tenant,
          memory_id: action.memory_id,
          content: action.content,
          summary: action.summary,
          tags: action.tags,
          entities: action.entities,
          rationale: action.rationale,
          reuse_rule: action.reuse_rule,
          evidence: action.evidence,
          source_references: action.source_references,
          conflicts: action.conflicts,
          business_category_id: action.business_category_id,
          work_type: action.work_type,
          kind: action.kind,
          canonical_key: action.canonical_key,
          valid_until: action.valid_until,
          expires_at: action.valid_until
        });
      }
    } else {
      const current = (await runD1Query(options, `
        SELECT lifecycle_state FROM memories
        WHERE tenant_id=${sqlString(options.tenant)} AND id=${sqlString(action.memory_id)}
        LIMIT 1;
      `))[0];
      if (current && current.lifecycle_state !== "suppressed") {
        await apiJson(options, "/v1/memories/suppress", {
          tenant_id: options.tenant,
          memory_id: action.memory_id,
          reason: action.reason_code
        });
      }
    }
    checkpoint.next_action_index = index + 1;
    await writePrivateJson(checkpointPath, checkpoint);
  }
  return decisionActions.length + derived.length + mutations.length;
}

async function buildRepairPlan(options) {
  const state = options.location === "local" ? await scanLocal(options) : await scanD1(options);
  const invalidMemoryCategoryCount = state.memoryRows.filter((row) =>
    row.business_category_id && !state.categoryIds.has(String(row.business_category_id))
  ).length;
  const invalidDecisionCategoryCount = state.decisionRows.filter((row) =>
    row.business_category_id && !state.categoryIds.has(String(row.business_category_id))
  ).length;
  const memoryRows = state.memoryRows.map((row) =>
    row.business_category_id && !state.categoryIds.has(String(row.business_category_id))
      ? { ...row, business_category_id: null }
      : row
  );
  const decisionRows = state.decisionRows.map((row) =>
    row.business_category_id && !state.categoryIds.has(String(row.business_category_id))
      ? { ...row, business_category_id: null }
      : row
  );
  const memoryPlan = await planMemoryRepairRows(memoryRows, {
    tenant_id: options.tenant,
    workspace_root: options.workspaceRoot,
    sensitive_policy: { mode: "deny", allowed_principals: [] }
  });
  const decisionPlan = await planDecisionClassificationRepairRows(decisionRows, {
    tenant_id: options.tenant
  });
  const categoryMap = new Map(
    [...memoryPlan.categories, ...decisionPlan.categories].map((category) => [category.id, category])
  );
  return {
    ...memoryPlan,
    project_id: options.project,
    project_null: options.projectNull,
    decision_scanned_count: decisionPlan.scanned_count,
    decision_actions: decisionPlan.actions,
    categories: [...categoryMap.values()],
    stats: {
      ...memoryPlan.stats,
      decision_update_count: decisionPlan.stats.update_count,
      invalid_existing_category_count: invalidMemoryCategoryCount + invalidDecisionCategoryCount,
      unclassified_active_after_plan: decisionPlan.stats.unclassified_after_plan
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  await ensureOutputDirectory(options.outputDir);
  const checkpointPath = options.outputDir ? resolve(options.outputDir, "memory-repair.checkpoint.json") : null;
  const planPath = options.outputDir ? resolve(options.outputDir, "memory-repair.plan.json") : null;
  const manifestPath = options.outputDir ? resolve(options.outputDir, "memory-repair.manifest.json") : null;
  let plan;
  let checkpoint;
  let backup = null;

  if (options.resume) {
    if (!checkpointPath || !planPath || !manifestPath ||
        !existsSync(checkpointPath) || !existsSync(planPath) || !existsSync(manifestPath)) {
      throw new Error("resume_artifacts_missing");
    }
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    plan = JSON.parse(await readFile(planPath, "utf8"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const resumedHash = sha256Buffer(JSON.stringify(sanitizedPlan(plan)));
    if (checkpoint.plan_hash !== resumedHash || manifest.plan_sha256 !== resumedHash) {
      throw new Error("checkpoint_plan_mismatch");
    }
    if (manifest.target !== options.location || manifest.tenant_id !== options.tenant ||
        manifest.project_id !== options.project || Boolean(manifest.project_null) !== options.projectNull) {
      throw new Error("checkpoint_target_mismatch");
    }
    backup = manifest.backup_path;
    if (!backup || !existsSync(backup) || await sha256File(backup) !== manifest.backup_sha256) {
      throw new Error("backup_manifest_mismatch");
    }
  } else {
    plan = await buildRepairPlan(options);
    const initialHash = sha256Buffer(JSON.stringify(sanitizedPlan(plan)));
    checkpoint = {
      version: 2,
      plan_hash: initialHash,
      next_action_index: 0,
      next_decision_action_index: 0,
      derived_ids: {}
    };
  }

  const report = sanitizedPlan(plan);
  const planHash = sha256Buffer(JSON.stringify(report));
  if (checkpoint.plan_hash !== planHash) throw new Error("checkpoint_plan_mismatch");
  let appliedCount = 0;
  if (options.apply) {
    if (!options.resume) {
      backup = await createBackup(options);
      const backupStats = await stat(backup);
      if ((backupStats.mode & 0o077) !== 0) throw new Error("backup_permissions_not_private");
      const manifest = {
        version: 1,
        created_at: Date.now(),
      target: options.location,
      tenant_id: options.tenant,
      project_id: options.project,
      project_null: options.projectNull,
        backup_path: backup,
        backup_sha256: await sha256File(backup),
        plan_sha256: planHash
      };
      await writePrivateJson(manifestPath, manifest);
      await writePrivateJson(planPath, plan);
      await writePrivateJson(checkpointPath, checkpoint);
    }
    appliedCount = options.location === "local"
      ? await applyLocal(options, plan, checkpointPath, checkpoint)
      : await applyCloud(options, plan, checkpointPath, checkpoint);
  }
  const finalReport = {
    version: 1,
    generated_at: Date.now(),
    mode: options.apply ? "apply" : "dry-run",
    target: options.location,
    tenant_id: options.tenant,
    project_id: options.project,
    project_null: options.projectNull,
    plan_sha256: planHash,
    backup_path: backup,
    applied_action_count: appliedCount,
    ...report,
    physical_delete_count: 0
  };
  if (options.outputDir) {
    await writePrivateJson(resolve(options.outputDir, "memory-repair.report.json"), finalReport);
    await writePrivateJson(resolve(options.outputDir, "memory-repair.credentials.json"), {
      tenant_id: options.tenant,
      items: report.credential_rotation_required
    });
  }
  if (options.reportPath) {
    await mkdir(dirname(options.reportPath), { recursive: true, mode: 0o700 });
    await writePrivateJson(options.reportPath, finalReport);
  }
  if (options.json) console.log(JSON.stringify(finalReport, null, 2));
  else console.log(`mode=${finalReport.mode} target=${finalReport.target} scanned=${report.scanned_count} decisions=${report.decision_scanned_count} derive=${report.stats.derive_count} suppress=${report.stats.suppress_count} delete=0`);
}

main().catch((error) => {
  const code = error?.code ?? error?.message ?? "memory_repair_failed";
  console.error(JSON.stringify({ ok: false, reason_code: code }));
  process.exitCode = code === "database_not_found" ? 2 : 1;
});
