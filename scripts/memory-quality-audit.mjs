#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  planDecisionClassificationRepairRows,
  planMemoryRepairRows
} from "../packages/shared/src/memory-repair-core.mjs";
import { screenSensitiveMemory } from "../packages/shared/src/memory-capture-v2-runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiGatewayDir = resolve(repoRoot, "apps/api-gateway");
const DEFAULT_PAGE_SIZE = 250;
const VALID_WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
const AUTOMATIC_SOURCES = new Set(["codex", "claude", "cursor", "openclaw", "opencode", "hook"]);
const HOME_PATH_PATTERN = /(?:^|[\s`'"(])(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|[A-Za-z]:\\Users\\)/u;

function usage() {
  return `Read-only memory quality audit

Usage:
  pnpm cf:memory:audit -- --remote --tenant default --report <private-report>
  node ./scripts/memory-quality-audit.mjs --local --db-path <path> --json

Options:
  --local | --remote | --preview  Target adapter (default: remote)
  --db-path <path>                Local SQLite path
  --tenant <id>                   Tenant ID (default: default)
  --database <name>               D1 database name (default: open-brain)
  --env <name>                    Wrangler environment name
  --workspace-root <path>         Repository root for path normalization
  --page-size <n>                 Cursor page size, 1-500 (default: ${DEFAULT_PAGE_SIZE})
  --report <path>                 Private JSON report path (mode 0600)
  --json                          Print the sanitized JSON report
  --help                          Show this help
`;
}

function parseArgs(argv) {
  const options = {
    location: "remote",
    tenant: "default",
    database: "open-brain",
    env: null,
    dbPath: null,
    workspaceRoot: null,
    pageSize: DEFAULT_PAGE_SIZE,
    report: null,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (["--local", "--remote", "--preview"].includes(arg)) {
      options.location = arg.slice(2);
      continue;
    }
    const match = /^(--tenant|--database|--env|--db-path|--workspace-root|--page-size|--report)(?:=(.*))?$/u.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`${match[1]} requires a value`);
    if (match[1] === "--tenant") options.tenant = value;
    if (match[1] === "--database") options.database = value;
    if (match[1] === "--env") options.env = value;
    if (match[1] === "--db-path") options.dbPath = resolve(value);
    if (match[1] === "--workspace-root") options.workspaceRoot = resolve(value);
    if (match[1] === "--report") options.report = resolve(value);
    if (match[1] === "--page-size") {
      options.pageSize = Number.parseInt(value, 10);
      if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 500) {
        throw new Error("--page-size must be between 1 and 500");
      }
    }
  }
  if (options.location === "local" && !options.dbPath) throw new Error("--db-path is required with --local");
  return options;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function isActive(row) {
  return String(row.lifecycle_state ?? "active") !== "suppressed" && Number(row.deleted_at ?? 0) === 0;
}

function isExpired(row, now) {
  const rawExpiry = row.valid_until ?? row.expires_at;
  if (rawExpiry === null || rawExpiry === undefined || String(rawExpiry).trim() === "") return false;
  const expiry = Number(rawExpiry);
  return Number.isFinite(expiry) && expiry <= now;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function containsHomePath(row) {
  return HOME_PATH_PATTERN.test([
    row.content, row.summary, row.rationale, row.reuse_rule,
    row.tags_json, row.entities_json, row.evidence_json,
    row.source_refs_json, row.conflicts_json
  ].map((value) => String(value ?? "")).join("\n"));
}

function likelyRawHook(row) {
  const tags = parseArray(row.tags_json).map((tag) => String(tag));
  return AUTOMATIC_SOURCES.has(String(row.source ?? "").toLowerCase()) &&
    (tags.includes("hook") || tags.includes("promoted") || String(row.content ?? "").length >= 800);
}

function safeRowHash(row) {
  return sha256([
    row.id, row.project_id, row.kind, row.lifecycle_state,
    row.content, row.summary, row.rationale, row.reuse_rule,
    row.tags_json, row.evidence_json, row.source_refs_json
  ].map((value) => String(value ?? "")).join("\0"));
}

function configFor(location) {
  return location === "remote"
    ? "wrangler.remote-d1.toml"
    : location === "local"
      ? "wrangler.local.toml"
      : "wrangler.toml";
}

async function runD1Query(options, sql) {
  const args = [
    "--dir", apiGatewayDir, "exec", "wrangler", "d1", "execute", options.database,
    "--config", configFor(options.location), `--${options.location}`
  ];
  if (options.env) args.push("--env", options.env);
  args.push("--json", "--command", sql);
  try {
    const { stdout } = await execFileAsync("pnpm", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first?.success) throw new Error("d1_query_failed");
    return first.results ?? [];
  } catch (error) {
    const failure = new Error("d1_query_failed");
    failure.cause = error;
    throw failure;
  }
}

async function readSchema(options) {
  if (options.location === "local") {
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      const rows = db.prepare("PRAGMA table_info(memories)").all();
      const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
      return { columns: new Set(rows.map((row) => String(row.name))), userVersion, tables };
    } finally {
      db.close();
    }
  }
  const [columns, tables] = await Promise.all([
    runD1Query(options, "PRAGMA table_info(memories);"),
    runD1Query(options, "SELECT name FROM sqlite_master WHERE type='table';")
  ]);
  return {
    columns: new Set(columns.map((row) => String(row.name))),
    // Cloudflare D1 rejects PRAGMA user_version for remote queries. The
    // migration/table shape is the portable schema signal for this audit.
    userVersion: null,
    tables: tables.map((row) => String(row.name))
  };
}

const BASE_MEMORY_COLUMNS = [
  "id", "tenant_id", "project_id", "business_category_id", "work_type", "source",
  "external_key", "content", "summary", "tags_json", "kind", "lifecycle_state",
  "created_at", "valid_from", "valid_until", "expires_at", "confidence_score", "utility_score",
  "entities_json", "rationale", "reuse_rule", "evidence_json", "source_refs_json",
  "conflicts_json", "current_version"
];
const OPTIONAL_MEMORY_COLUMNS = [
  "deleted_at", "content_hash", "canonical_key", "capture_origin", "verification_state",
  "verified_at", "source_hash", "ttl_days", "origin", "provenance_json"
];

function memorySelectSql(tenantId, cursor, limit, columns) {
  const selected = [
    ...BASE_MEMORY_COLUMNS.filter((column) => columns.has(column)),
    ...OPTIONAL_MEMORY_COLUMNS.filter((column) => columns.has(column))
  ];
  return `SELECT ${selected.join(", ")} FROM memories WHERE tenant_id=${sqlString(tenantId)} AND id>${sqlString(cursor)} ORDER BY id LIMIT ${limit};`;
}

async function scanRemote(options, schema) {
  const memoryRows = [];
  let cursor = "";
  let pages = 0;
  while (true) {
    const page = await runD1Query(options, memorySelectSql(options.tenant, cursor, options.pageSize, schema.columns));
    memoryRows.push(...page);
    pages += 1;
    if (page.length < options.pageSize) break;
    cursor = String(page.at(-1).id);
  }
  const categoryRows = await runD1Query(options, `SELECT id FROM business_categories WHERE tenant_id=${sqlString(options.tenant)} AND is_active=1;`);
  const decisionRows = schema.tables.includes("decision_memories")
    ? await runD1Query(options, `SELECT id, project_id, business_category_id, work_type, status FROM decision_memories WHERE tenant_id=${sqlString(options.tenant)} ORDER BY id;`)
    : [];
  return { memoryRows, decisionRows, categoryRows, pages };
}

function scanLocal(options, schema) {
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    const selected = [
      ...BASE_MEMORY_COLUMNS.filter((column) => schema.columns.has(column)),
      ...OPTIONAL_MEMORY_COLUMNS.filter((column) => schema.columns.has(column))
    ];
    const memoryRows = [];
    let cursor = "";
    let pages = 0;
    while (true) {
      const page = db.prepare(`SELECT ${selected.join(", ")} FROM memories WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?`).all(options.tenant, cursor, options.pageSize);
      memoryRows.push(...page);
      pages += 1;
      if (page.length < options.pageSize) break;
      cursor = String(page.at(-1).id);
    }
    const categoryRows = db.prepare("SELECT id FROM business_categories WHERE tenant_id=? AND is_active=1").all(options.tenant);
    const decisionRows = schema.tables.includes("decision_memories")
      ? db.prepare("SELECT id, project_id, business_category_id, work_type, status FROM decision_memories WHERE tenant_id=? ORDER BY id").all(options.tenant)
      : [];
    return { memoryRows, decisionRows, categoryRows, pages };
  } finally {
    db.close();
  }
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

function idsByReason(plan, memoryRows, now) {
  const ids = {};
  const add = (reason, id) => {
    if (!reason || !id) return;
    ids[reason] ??= [];
    ids[reason].push(String(id));
  };
  for (const action of plan.actions) add(action.reason_code, action.memory_id);
  for (const item of plan.credential_rotation_required) add(item.reason_code, item.memory_id);
  for (const row of memoryRows) {
    if (isActive(row) && isExpired(row, now)) add("expired_active", row.id);
    if (isActive(row) && containsHomePath(row)) add("home_path_candidate", row.id);
    if (isActive(row) && likelyRawHook(row)) add("raw_hook_candidate", row.id);
  }
  for (const key of Object.keys(ids)) ids[key] = [...new Set(ids[key])].sort();
  return ids;
}

function duplicateGroups(rows, keyForRow) {
  const groups = new Map();
  for (const row of rows) {
    if (!isActive(row)) continue;
    const key = keyForRow(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(String(row.id));
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key_hash: sha256(key), memory_ids: ids.sort() }))
    .sort((left, right) => left.key_hash.localeCompare(right.key_hash));
}

function buildAudit(options, schema, scan, plan, decisionPlan, now) {
  const rows = scan.memoryRows;
  const active = rows.filter(isActive);
  const categoryIds = new Set(scan.categoryRows.map((row) => String(row.id)));
  const counts = {
    memories_total: rows.length,
    memories_active: active.length,
    memories_suppressed: rows.length - active.length,
    active_expired: active.filter((row) => isExpired(row, now)).length,
    active_without_category: active.filter((row) => !hasValue(row.business_category_id) || !categoryIds.has(String(row.business_category_id))).length,
    active_without_work_type: active.filter((row) => !VALID_WORK_TYPES.has(String(row.work_type ?? ""))).length,
    active_without_rationale: active.filter((row) => !hasValue(row.rationale)).length,
    active_without_reuse_rule: active.filter((row) => !hasValue(row.reuse_rule)).length,
    active_without_evidence: active.filter((row) => parseArray(row.evidence_json).length === 0).length,
    active_without_source_references: active.filter((row) => parseArray(row.source_refs_json).length === 0).length,
    active_without_content_hash: schema.columns.has("content_hash") ? active.filter((row) => !hasValue(row.content_hash)).length : null,
    active_without_canonical_key: schema.columns.has("canonical_key") ? active.filter((row) => !hasValue(row.canonical_key)).length : null,
    active_without_capture_origin: schema.columns.has("capture_origin") ? active.filter((row) => !hasValue(row.capture_origin)).length : null,
    active_unverified: schema.columns.has("verification_state") ? active.filter((row) => String(row.verification_state ?? "unverified") !== "verified").length : null,
    active_home_path_candidates: active.filter(containsHomePath).length,
    active_raw_hook_candidates: active.filter(likelyRawHook).length,
    active_credential_candidates: active.filter((row) => screenSensitiveMemory(JSON.stringify(row), { mode: "deny", allowed_principals: [] }).hard_reject).length,
    active_decision_kind: active.filter((row) => row.kind === "decision").length,
    active_non_decision_kind: active.filter((row) => row.kind !== "decision").length,
    decisions_total: scan.decisionRows.length,
    decisions_active: scan.decisionRows.filter((row) => String(row.status ?? "active") === "active").length,
    decisions_without_category: scan.decisionRows.filter((row) => String(row.status ?? "active") === "active" && (!hasValue(row.business_category_id) || !categoryIds.has(String(row.business_category_id)))).length,
    decisions_without_work_type: scan.decisionRows.filter((row) => String(row.status ?? "active") === "active" && !VALID_WORK_TYPES.has(String(row.work_type ?? ""))).length
  };
  const activeDenominator = counts.memories_active;
  const rates = Object.fromEntries([
    ["active_not_expired", ratio(activeDenominator - counts.active_expired, activeDenominator)],
    ["active_category_coverage", ratio(activeDenominator - counts.active_without_category, activeDenominator)],
    ["active_work_type_coverage", ratio(activeDenominator - counts.active_without_work_type, activeDenominator)],
    ["active_rationale_coverage", ratio(activeDenominator - counts.active_without_rationale, activeDenominator)],
    ["active_reuse_rule_coverage", ratio(activeDenominator - counts.active_without_reuse_rule, activeDenominator)],
    ["active_evidence_coverage", ratio(activeDenominator - counts.active_without_evidence, activeDenominator)],
    ["active_source_reference_coverage", ratio(activeDenominator - counts.active_without_source_references, activeDenominator)],
    ["active_content_hash_coverage", schema.columns.has("content_hash") ? ratio(activeDenominator - counts.active_without_content_hash, activeDenominator) : null],
    ["active_canonical_key_coverage", schema.columns.has("canonical_key") ? ratio(activeDenominator - counts.active_without_canonical_key, activeDenominator) : null],
    ["active_capture_origin_coverage", schema.columns.has("capture_origin") ? ratio(activeDenominator - counts.active_without_capture_origin, activeDenominator) : null],
    ["active_verified_coverage", schema.columns.has("verification_state") ? ratio(activeDenominator - counts.active_unverified, activeDenominator) : null],
    ["decision_category_coverage", ratio(counts.decisions_active - counts.decisions_without_category, counts.decisions_active)],
    ["decision_work_type_coverage", ratio(counts.decisions_active - counts.decisions_without_work_type, counts.decisions_active)]
  ]);
  const reasonCounts = {};
  for (const action of plan.actions) increment(reasonCounts, action.reason_code ?? action.type);
  for (const item of plan.credential_rotation_required) increment(reasonCounts, item.reason_code);
  const canonicalGroups = duplicateGroups(rows, (row) => hasValue(row.canonical_key) ? String(row.canonical_key) : null);
  const externalGroups = duplicateGroups(rows, (row) => hasValue(row.external_key) ? `${row.project_id ?? "global"}\0${row.external_key}` : null);
  const rowHashes = rows.map((row) => ({
    memory_id: String(row.id),
    row_sha256: safeRowHash(row),
    observed_content_sha256: sha256(row.content),
    stored_content_hash: hasValue(row.content_hash) ? sha256(row.content_hash) : null,
    canonical_key_sha256: hasValue(row.canonical_key) ? sha256(row.canonical_key) : null
  })).sort((left, right) => left.memory_id.localeCompare(right.memory_id));
  return {
    schema_version: 1,
    generated_at: now,
    scope: { tenant_id: options.tenant, database: options.database, location: options.location, env: options.env },
    schema: {
      user_version: schema.userVersion,
      memories_columns: [...schema.columns].sort(),
      optional_columns_present: Object.fromEntries(OPTIONAL_MEMORY_COLUMNS.map((column) => [column, schema.columns.has(column)])),
      decision_memories_present: schema.tables.includes("decision_memories")
    },
    scan: {
      complete: true,
      page_size: options.pageSize,
      pages: scan.pages,
      memory_ids: rows.map((row) => String(row.id)).sort(),
      decision_ids: scan.decisionRows.map((row) => String(row.id)).sort(),
      active_category_ids: [...new Set(active.map((row) => row.business_category_id).filter(hasValue).map(String))].sort()
    },
    counts,
    rates,
    repair_plan: {
      scanned_count: plan.scanned_count,
      decision_scanned_count: decisionPlan.scanned_count,
      stats: plan.stats,
      reason_counts: reasonCounts,
      action_count: plan.actions.length,
      candidate_hashes: plan.actions.filter((action) => action.candidate_hash).map((action) => ({
        memory_id: String(action.memory_id), candidate_sha256: String(action.candidate_hash)
      })).sort((left, right) => left.memory_id.localeCompare(right.memory_id))
    },
    duplicates: {
      active_canonical_groups: canonicalGroups.length,
      active_canonical_duplicate_rows: canonicalGroups.reduce((sum, group) => sum + group.memory_ids.length, 0),
      active_external_key_groups: externalGroups.length,
      active_external_key_duplicate_rows: externalGroups.reduce((sum, group) => sum + group.memory_ids.length, 0),
      canonical_groups: canonicalGroups,
      external_key_groups: externalGroups
    },
    ids_by_reason: idsByReason(plan, rows, now),
    row_hashes: rowHashes,
    credential_rotation_required: plan.credential_rotation_required.map((item) => ({ memory_id: String(item.memory_id), reason_code: item.reason_code })),
    integrity: {
      physical_delete_count: 0,
      raw_content_emitted: false,
      candidate_text_emitted: false,
      credential_values_emitted: false,
      pii_text_emitted: false
    }
  };
}

async function writePrivateJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(path, mode);
}

export async function runAudit(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return { report: { help: usage() }, options };
  const schema = await readSchema(options);
  const scan = options.location === "local" ? scanLocal(options, schema) : await scanRemote(options, schema);
  const now = Date.now();
  const plan = await planMemoryRepairRows(scan.memoryRows, {
    tenant_id: options.tenant,
    workspace_root: options.workspaceRoot,
    now,
    sensitive_policy: { mode: "deny", allowed_principals: [] }
  });
  const decisionPlan = await planDecisionClassificationRepairRows(scan.decisionRows, { tenant_id: options.tenant });
  const report = buildAudit(options, schema, scan, plan, decisionPlan, now);
  report.report_sha256 = sha256(JSON.stringify(report));
  if (options.report) {
    await writePrivateJson(options.report, report);
    const metadata = await stat(options.report);
    if ((metadata.mode & 0o077) !== 0) throw new Error("report_permissions_not_private");
  }
  return { report, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAudit().then(({ report, options }) => {
    if (options.help) {
      process.stdout.write(report.help);
      return;
    }
    if (options.json || !options.report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`audit=complete target=${report.scope.location} tenant=${report.scope.tenant_id} memories=${report.counts.memories_total} active=${report.counts.memories_active} report_sha256=${report.report_sha256}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason_code: error?.message ?? "memory_quality_audit_failed" })}\n`);
    process.exitCode = 1;
  });
}
