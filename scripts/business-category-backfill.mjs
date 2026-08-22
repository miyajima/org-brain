#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  parseLocationArgs,
  runD1Queries,
  sqlString
} from "../packages/benchmarks/src/metrics-common.mjs";

const WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);

function help() {
  console.log(`Org Brain business classification backfill

Usage:
  pnpm cf:memory:backfill-classification -- --input <file.json|file.csv> --tenant <tenant>
  pnpm cf:memory:backfill-classification -- --input <file> --tenant <tenant> --export <report.json> --apply

Rows: tenant_id, source_type(memory|decision_memory), source_id,
      business_category_id, work_type

Dry-run is the default. --apply requires --export. Category and source ownership are
validated from D1 before any update. Existing content is never classified by inference.`);
}

function parseArgs(argv) {
  const options = { ...parseLocationArgs(argv), input: null, exportPath: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--apply") options.apply = true;
    if (arg === "--input" || arg.startsWith("--input=")) {
      options.input = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    }
    if (arg === "--export" || arg.startsWith("--export=")) {
      options.exportPath = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    }
  }
  return options;
}

export function parseBackfillCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted && char === '"' && raw[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(field.trim());
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(field.trim());
      field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("unterminated CSV quote");
  const [headers, ...values] = rows;
  if (!headers) return [];
  return values.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

export function buildBusinessClassificationBackfillPlan(rows, context) {
  const activeCategories = new Set(context.activeCategories ?? []);
  const memoryIds = new Set(context.memoryIds ?? []);
  const decisionIds = new Set(context.decisionIds ?? []);
  const seen = new Set();
  const updates = [];
  const errors = [];
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    const tenantId = String(row.tenant_id ?? "").trim();
    const sourceType = String(row.source_type ?? "").trim();
    const sourceId = String(row.source_id ?? "").trim();
    const categoryId = String(row.business_category_id ?? "").trim();
    const workType = String(row.work_type ?? "").trim();
    const key = `${sourceType}:${sourceId}`;
    if (tenantId !== context.tenantId) errors.push({ line, code: "tenant_mismatch", source_id: sourceId });
    if (!["memory", "decision_memory"].includes(sourceType)) errors.push({ line, code: "invalid_source_type", source_id: sourceId });
    if (!sourceId) errors.push({ line, code: "source_id_required", source_id: sourceId });
    if (!activeCategories.has(categoryId)) errors.push({ line, code: "category_missing_or_inactive", source_id: sourceId });
    if (!WORK_TYPES.has(workType)) errors.push({ line, code: "invalid_work_type", source_id: sourceId });
    if (sourceType === "memory" && !memoryIds.has(sourceId)) errors.push({ line, code: "memory_not_found", source_id: sourceId });
    if (sourceType === "decision_memory" && !decisionIds.has(sourceId)) errors.push({ line, code: "decision_memory_not_found", source_id: sourceId });
    if (seen.has(key)) errors.push({ line, code: "duplicate_source", source_id: sourceId });
    seen.add(key);
    updates.push({ tenant_id: tenantId, source_type: sourceType, source_id: sourceId, business_category_id: categoryId, work_type: workType });
  }
  return { valid: errors.length === 0, updates, errors };
}

export function buildBusinessClassificationSql(plan) {
  const statements = [];
  for (const item of plan.updates) {
    const table = item.source_type === "memory" ? "memories" : "decision_memories";
    const versionTable = item.source_type === "memory" ? "memory_versions" : "decision_memory_versions";
    const sourceColumn = item.source_type === "memory" ? "memory_id" : "decision_memory_id";
    statements.push(
      `UPDATE ${table} SET business_category_id=${sqlString(item.business_category_id)}, work_type=${sqlString(item.work_type)} WHERE tenant_id=${sqlString(item.tenant_id)} AND id=${sqlString(item.source_id)}`,
      `UPDATE ${versionTable} SET business_category_id=${sqlString(item.business_category_id)}, work_type=${sqlString(item.work_type)} WHERE tenant_id=${sqlString(item.tenant_id)} AND ${sourceColumn}=${sqlString(item.source_id)}`,
      `UPDATE retrieval_units SET business_category_id=${sqlString(item.business_category_id)}, work_type=${sqlString(item.work_type)} WHERE tenant_id=${sqlString(item.tenant_id)} AND source_type=${sqlString(item.source_type)} AND source_id=${sqlString(item.source_id)}`
    );
    if (item.source_type === "memory") {
      statements.push(
        `UPDATE memory_versions SET snapshot_json=json_set(snapshot_json, '$.business_category_id', ${sqlString(item.business_category_id)}, '$.work_type', ${sqlString(item.work_type)}) WHERE tenant_id=${sqlString(item.tenant_id)} AND memory_id=${sqlString(item.source_id)}`
      );
    }
    if (item.source_type === "decision_memory") {
      statements.push(
        `UPDATE decision_memory_versions SET snapshot_json=json_set(snapshot_json, '$.businessCategoryId', ${sqlString(item.business_category_id)}, '$.workType', ${sqlString(item.work_type)}) WHERE tenant_id=${sqlString(item.tenant_id)} AND decision_memory_id=${sqlString(item.source_id)}`
      );
    }
  }
  return `${statements.join(";\n")};`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  if (!options.input) throw new Error("--input is required");
  if (options.apply && !options.exportPath) throw new Error("--apply requires --export");
  const raw = await readFile(options.input, "utf8");
  const rows = options.input.toLowerCase().endsWith(".csv")
    ? parseBackfillCsv(raw)
    : JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("input must be a JSON array or CSV rows");
  const tenant = sqlString(options.tenant);
  const current = await runD1Queries(options, {
    categories: `SELECT id FROM business_categories WHERE tenant_id=${tenant} AND is_active=1`,
    memories: `SELECT id FROM memories WHERE tenant_id=${tenant}`,
    decisions: `SELECT id FROM decision_memories WHERE tenant_id=${tenant}`
  });
  const plan = buildBusinessClassificationBackfillPlan(rows, {
    tenantId: options.tenant,
    activeCategories: current.categories.map((row) => row.id),
    memoryIds: current.memories.map((row) => row.id),
    decisionIds: current.decisions.map((row) => row.id)
  });
  const report = { mode: options.apply ? "apply" : "dry-run", tenant_id: options.tenant, ...plan };
  if (options.exportPath) await writeFile(options.exportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!plan.valid) throw new Error(`backfill validation failed: ${JSON.stringify(plan.errors)}`);
  if (options.apply) await runD1Queries(options, { apply: buildBusinessClassificationSql(plan) });
  console.log(JSON.stringify(report, null, options.json ? 0 : 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
