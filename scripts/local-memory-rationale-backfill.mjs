#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  DEFAULT_LOCAL_DB,
  LocalMemoryStore,
  MEMORY_SCHEMA_VERSION
} from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

export const LOCAL_RATIONALE_BACKFILL_VERSION = "orgbrain-local-rationale-backfill/v1";
export const DEFAULT_BACKFILL_LIMIT = 5_000;
const AIMA_EXTERNAL_KEY_PREFIX = "aima:improvement-rationale:";
const BACKFILL_GAP = "既存の根拠メモから構造化した推定であり、元の改善実行をこの適用では再検証していない";
const APPLICABILITY_COMPONENTS = ["aima-chunked-improvement", "sales-coaching"];
const REQUIRED_MEMORY_COLUMNS = [
  "id", "tenant_id", "project_id", "kind", "lifecycle_state", "content", "summary",
  "external_key", "rationale", "reuse_rule", "evidence_json", "source_refs_json",
  "current_version", "capture_origin", "capture_route", "verification_state", "verified_at",
  "learning_json"
];

function printHelp() {
  console.log(`Org Brain local rationale backfill (dry-run by default)

Usage:
  node ./scripts/local-memory-rationale-backfill.mjs [options]

Options:
  --db <path>             Local SQLite path (default: ORGBRAIN_LOCAL_DB or ~/.org-brain/memory.sqlite)
  --tenant <id>           Tenant to inspect (default: default)
  --project <id>          Project to inspect (default: aima)
  --limit <n>             Maximum rows to inspect (default: ${DEFAULT_BACKFILL_LIMIT})
  --dry-run               Plan only; never initializes or writes the database (default)
  --apply                 Create a verified backup, revise candidates, rebuild indexes, and doctor
  --backup <path>         Backup destination for --apply (otherwise a private backups/ path is generated)
  --plan-output <path>    Write the plan/report JSON with mode 0600
  --json                  Emit machine-readable JSON
  --help                  Show this message

Safety:
  --apply is the only mutation path. The planner reads memories through a read-only
  SQLite connection, keeps id/external_key, and skips missing evidence. Inferred rows
  are partial/unverified; this command never promotes a row to verified and never
  stores raw transcripts or sends data to Cloud.`);
}

function parseArgs(argv) {
  const options = {
    dbPath: process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB,
    tenantId: "default",
    projectId: "aima",
    limit: DEFAULT_BACKFILL_LIMIT,
    apply: false,
    dryRun: true,
    json: false,
    backupPath: null,
    planOutput: null,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (options.apply) throw new Error("--dry-run cannot be combined with --apply");
      options.dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      if (options.dryRun && argv.includes("--dry-run")) throw new Error("--dry-run cannot be combined with --apply");
      options.apply = true;
      options.dryRun = false;
      continue;
    }
    const [name, inline] = arg.split("=", 2);
    const takesValue = new Set(["--db", "--tenant", "--tenant-id", "--project", "--project-id", "--limit", "--backup", "--plan-output"]);
    if (takesValue.has(name)) {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      if (name === "--db") options.dbPath = value;
      if (name === "--tenant" || name === "--tenant-id") options.tenantId = value;
      if (name === "--project" || name === "--project-id") options.projectId = value;
      if (name === "--backup") options.backupPath = value;
      if (name === "--plan-output") options.planOutput = value;
      if (name === "--limit") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50_000) {
          throw new Error("--limit must be between 1 and 50000");
        }
        options.limit = parsed;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.tenantId.trim() || !options.projectId.trim()) throw new Error("tenant and project must not be empty");
  return options;
}

function parseJson(raw, fallback) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseArray(raw) {
  const value = parseJson(raw, []);
  return Array.isArray(value) ? value : [];
}

function parseObject(raw) {
  const value = parseJson(raw, null);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function clip(value, limit) {
  const text = collapseWhitespace(value);
  return text.length <= limit ? text : text.slice(0, limit);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sectionValue(content, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const match = String(content ?? "").match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[：:]\\s*([^\\n]*)`, "iu"));
  return clip(match?.[1] ?? "", 2_000);
}

function normalizeRow(row) {
  return {
    ...row,
    tags: parseArray(row.tags_json),
    entities: parseArray(row.entities_json),
    source_references: parseArray(row.source_refs_json),
    evidence: parseArray(row.evidence_json),
    conflicts: parseArray(row.conflicts_json),
    permissions: parseArray(row.permissions_json),
    learning: parseObject(row.learning_json)
  };
}

function requiredColumns(db) {
  return new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
}

/**
 * Read the local source table without invoking LocalMemoryStore.init(). This is
 * intentionally used by both dry-run and the apply preflight so a dry-run cannot
 * migrate, chmod, rebuild, or otherwise mutate the user's database.
 */
export function readLocalMemories({ dbPath, tenantId = "default", projectId = "aima", limit = DEFAULT_BACKFILL_LIMIT }) {
  const path = resolve(dbPath);
  if (!existsSync(path)) throw new Error(`local database not found: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (schemaVersion !== MEMORY_SCHEMA_VERSION) {
      throw new Error(`schema version ${schemaVersion} != ${MEMORY_SCHEMA_VERSION}; refuse local backfill`);
    }
    const columns = requiredColumns(db);
    const missing = REQUIRED_MEMORY_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) throw new Error(`memories table missing columns: ${missing.join(", ")}`);
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE tenant_id = ? AND project_id = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`
    ).all(tenantId, projectId, limit);
    return { db_path: path, schema_version: schemaVersion, rows: rows.map(normalizeRow) };
  } finally {
    db.close();
  }
}

function aimaEvidence(row) {
  const candidates = [
    ...(Array.isArray(row.evidence) ? row.evidence : []).map((item) => ({
      ref: item?.evidence_ref,
      digest: item?.content_hash
    })),
    ...(Array.isArray(row.source_references) ? row.source_references : []).map((item) => ({
      ref: item?.ref,
      digest: item?.content_hash
    }))
  ];
  return candidates.find((item) =>
    typeof item.ref === "string" && item.ref.startsWith("aima/") &&
    typeof item.digest === "string" && /^sha256:[a-f0-9]{64}$/iu.test(item.digest)
  ) ?? null;
}

function inferStructuredFields(row) {
  const conclusion = sectionValue(row.content, ["結論", "Conclusion"]);
  const rationale = sectionValue(row.content, ["理由", "Reason"]) || clip(row.rationale, 2_000);
  const reuseRule = sectionValue(row.content, ["再利用条件", "Reuse condition", "Reuse rule"]) || clip(row.reuse_rule, 1_000);
  return {
    conclusion,
    rationale,
    reuse_rule: reuseRule,
    evidence: aimaEvidence(row)
  };
}

function buildLearning(row, fields) {
  return {
    record_type: "learning_observation",
    schema_version: 2,
    lesson_type: "decision",
    capture_intent: "review",
    trigger: null,
    applicability: {
      target_files: [],
      components: [...APPLICABILITY_COMPONENTS]
    },
    evidence_selectors: [{
      type: "doc",
      ref: fields.evidence.ref,
      digest: fields.evidence.digest,
      supports: ["decision", "rationale", "reuse_rule"]
    }],
    gaps: [BACKFILL_GAP],
    decision_type: "implementation",
    decision_key: clip(row.external_key, 160),
    decision: clip(fields.conclusion, 1_000),
    selected_value: clip(fields.conclusion, 1_000),
    rationale: clip(fields.rationale, 2_000),
    alternatives: [],
    constraints: [],
    reuse_when: clip(fields.reuse_rule, 1_000)
  };
}

function skip(reason) {
  return { target: false, reason };
}

function candidateFor(row) {
  if (row.lifecycle_state !== "active") return skip("inactive");
  if (row.kind !== "decision") return skip("not_decision");
  if (typeof row.external_key !== "string" || !row.external_key.startsWith(AIMA_EXTERNAL_KEY_PREFIX)) {
    return skip("not_aima_rationale");
  }
  if (row.verification_state === "verified") return skip("verified_requires_manual_review");
  if (row.verification_state === "rejected") return skip("rejected");
  if (row.verification_state && !["unverified", "partial"].includes(row.verification_state)) {
    return skip("invalid_verification_state");
  }
  if (row.learning) return skip("learning_already_present");
  const fields = inferStructuredFields(row);
  if (!fields.conclusion) return skip("missing_conclusion");
  if (!fields.rationale) return skip("missing_rationale");
  if (!fields.reuse_rule) return skip("missing_reuse_rule");
  if (!fields.evidence) return skip("missing_stable_evidence");
  const patch = {
    reuse_rule: fields.reuse_rule,
    learning: buildLearning(row, fields),
    ...(row.verification_state !== "partial" ? { verification_state: "partial" } : {}),
    ...(!row.capture_origin || row.capture_origin === "legacy" ? { capture_origin: "repair" } : {}),
    ...(!row.capture_route || row.capture_route === "legacy" ? { capture_route: "repair" } : {})
  };
  return {
    target: true,
    change: {
      memory_id: row.id,
      external_key: row.external_key,
      current_version: Number(row.current_version || 1),
      summary: row.summary ?? null,
      evidence_ref: fields.evidence.ref,
      evidence_digest: fields.evidence.digest,
      fields: Object.keys(patch),
      patch
    }
  };
}

export function buildLocalBackfillPlan(rows, { tenantId = "default", projectId = "aima", now = Date.now() } = {}) {
  const changes = [];
  const skippedByReason = {};
  for (const row of rows) {
    const result = candidateFor(row);
    if (result.target) {
      changes.push(result.change);
      continue;
    }
    skippedByReason[result.reason] = (skippedByReason[result.reason] ?? 0) + 1;
  }
  const digestInput = changes.map((change) => ({
    memory_id: change.memory_id,
    external_key: change.external_key,
    current_version: change.current_version,
    patch: change.patch
  }));
  return {
    contract_version: LOCAL_RATIONALE_BACKFILL_VERSION,
    generated_at: now,
    scope: { tenant_id: tenantId, project_id: projectId },
    schema_version: MEMORY_SCHEMA_VERSION,
    inspected_count: rows.length,
    target_count: changes.length,
    skipped_count: rows.length - changes.length,
    skipped_by_reason: skippedByReason,
    changes,
    plan_digest: `sha256:${sha256(stableJson(digestInput))}`
  };
}

function patchMatches(record, patch) {
  return Object.entries(patch).every(([key, value]) => stableJson(record[key] ?? null) === stableJson(value ?? null));
}

function defaultBackupPath(dbPath) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(dirname(resolve(dbPath)), "backups", `memory-rationale-backfill-${stamp}.sqlite`);
}

export async function applyLocalBackfillPlan(store, plan, { backupPath = null } = {}) {
  if (plan.target_count === 0) {
    return { status: "noop", applied_count: 0, skipped_idempotent_count: 0, backup: null, doctor: null };
  }
  const destination = resolve(backupPath || defaultBackupPath(store.dbPath));
  const backup = await store.createBackup(destination);
  const applied = [];
  const skippedIdempotent = [];
  try {
    for (const change of plan.changes) {
      const current = await store.get(plan.scope.tenant_id, change.memory_id);
      if (!current) throw new Error(`memory not found during apply: ${change.memory_id}`);
      if (current.external_key !== change.external_key) {
        throw new Error(`external_key changed during apply: ${change.memory_id}`);
      }
      if (patchMatches(current, change.patch)) {
        skippedIdempotent.push(change.memory_id);
        continue;
      }
      if (Number(current.current_version || 1) !== change.current_version) {
        throw new Error(`stale plan for ${change.memory_id}: expected version ${change.current_version}, got ${current.current_version}`);
      }
      const result = await store.revise(plan.scope.tenant_id, change.memory_id, change.patch);
      applied.push({ ...result, external_key: change.external_key });
    }
    await store.rebuildIndex();
    const doctor = await store.doctor();
    if (!doctor.ok) throw new Error(`post-apply doctor failed: ${doctor.errors.join("; ")}`);
    return {
      status: "applied",
      backup,
      applied_count: applied.length,
      skipped_idempotent_count: skippedIdempotent.length,
      applied,
      skipped_idempotent: skippedIdempotent,
      doctor,
      rollback: { backup_path: backup.path, command: "orgbrain backup restore --from <backup_path>" }
    };
  } catch (error) {
    return {
      status: "failed",
      backup,
      applied_count: applied.length,
      skipped_idempotent_count: skippedIdempotent.length,
      applied,
      skipped_idempotent: skippedIdempotent,
      error: error instanceof Error ? error.message : String(error),
      rollback: { backup_path: backup.path, command: "orgbrain backup restore --from <backup_path>" }
    };
  }
}

async function writePlan(path, payload) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}

function printText(report) {
  console.log("Org Brain local rationale backfill");
  console.log(`scope: tenant=${report.plan.scope.tenant_id} project=${report.plan.scope.project_id}`);
  console.log(`db: ${report.db_path}`);
  console.log(`mode: ${report.apply_requested ? "apply" : "dry-run"}`);
  console.log("");
  console.log("Plan");
  console.log(`  inspected=${report.plan.inspected_count}`);
  console.log(`  target=${report.plan.target_count}`);
  console.log(`  skipped=${report.plan.skipped_count}`);
  console.log(`  plan_digest=${report.plan.plan_digest}`);
  for (const [reason, count] of Object.entries(report.plan.skipped_by_reason)) console.log(`  skip.${reason}=${count}`);
  if (report.apply) {
    console.log("");
    console.log("Apply");
    console.log(`  status=${report.apply.status}`);
    console.log(`  applied=${report.apply.applied_count}`);
    console.log(`  skipped_idempotent=${report.apply.skipped_idempotent_count}`);
    if (report.apply.backup?.path) console.log(`  backup=${report.apply.backup.path}`);
    if (report.apply.error) console.log(`  error=${report.apply.error}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const source = readLocalMemories({
    dbPath: options.dbPath,
    tenantId: options.tenantId,
    projectId: options.projectId,
    limit: options.limit
  });
  const plan = buildLocalBackfillPlan(source.rows, {
    tenantId: options.tenantId,
    projectId: options.projectId
  });
  const report = {
    report_version: LOCAL_RATIONALE_BACKFILL_VERSION,
    captured_at: Date.now(),
    db_path: source.db_path,
    schema_version: source.schema_version,
    apply_requested: options.apply,
    plan
  };
  if (options.apply) {
    const store = new LocalMemoryStore(source.db_path);
    report.apply = await applyLocalBackfillPlan(store, plan, { backupPath: options.backupPath });
    if (report.apply.status === "failed") process.exitCode = 1;
  }
  if (options.planOutput) report.plan_output = await writePlan(options.planOutput, report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
}

export {
  aimaEvidence,
  candidateFor,
  inferStructuredFields,
  parseArgs,
  sectionValue
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
