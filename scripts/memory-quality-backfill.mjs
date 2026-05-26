#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { assessMemoryUsefulness } from "./lib/memory-quality.mjs";
import { parseLocationArgs, runD1Queries, sqlNullable, sqlString } from "./lib/metrics-common.mjs";

const DEFAULT_LIMIT = 5000;
const PROJECT_ROOT_OVERRIDES = new Map([
  [".agents", "/Users/miya/.agents"],
  [".codex", "/Users/miya/.codex"],
  ["org-brain", "/Users/miya/projects/org-brain"]
]);

function configuredProjectRootOverrides() {
  const raw = process.env.ORGBRAIN_PROJECT_ROOTS;
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed)
        .filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[0].trim() && entry[1].trim())
        .map(([key, value]) => [key.trim(), value.trim()])
    );
  } catch {
    return new Map();
  }
}

function printHelp() {
  console.log(`Org Brain memory quality backfill

Usage:
  pnpm memories:quality-backfill [-- --tenant <tenant_id>] [--export <path>]
  pnpm memories:quality-backfill [-- --apply --export <path>]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --local                Query the local wrangler D1 database
  --preview              Query the preview D1 database
  --remote               Query the remote D1 database (default)
  --env <name>           Wrangler environment name
  --limit <n>            Maximum memories to inspect (default: 5000)
  --export <path>        Export dry-run report and pre-apply backup
  --apply                Persist updates. Requires --export.
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    apply: false,
    exportPath: null,
    limit: DEFAULT_LIMIT
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--" ||
      arg === "--json" ||
      arg === "--help" ||
      arg === "-h" ||
      arg === "--local" ||
      arg === "--preview" ||
      arg === "--remote"
    ) continue;
    if (
      arg === "--tenant" ||
      arg.startsWith("--tenant=") ||
      arg === "--database" ||
      arg.startsWith("--database=") ||
      arg === "--env" ||
      arg.startsWith("--env=")
    ) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--export" || arg.startsWith("--export=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--export requires a path");
      options.exportPath = value;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50_000) throw new Error("--limit must be between 1 and 50000");
      options.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.apply && !options.exportPath) {
    throw new Error("--apply requires --export <path> so updated rows are backed up first");
  }

  return options;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeNullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function numbersEqual(left, right) {
  const normalizedLeft = normalizeNullableNumber(left);
  const normalizedRight = normalizeNullableNumber(right);
  return normalizedLeft === normalizedRight;
}

function shouldUpdate(row, assessed) {
  return (
    normalizeText(row.summary) !== normalizeText(assessed.summary) ||
    !numbersEqual(row.utility_score, assessed.utility_score) ||
    !numbersEqual(row.confidence_score, assessed.confidence_score) ||
    !numbersEqual(row.expires_at, assessed.expires_at)
  );
}

function resolveProjectRoot(projectId) {
  if (!projectId) return null;
  const configured = configuredProjectRootOverrides();
  if (configured.has(projectId)) return configured.get(projectId);
  if (PROJECT_ROOT_OVERRIDES.has(projectId)) return PROJECT_ROOT_OVERRIDES.get(projectId);
  return `/Users/miya/projects/${projectId}`;
}

function projectMappingWarning(row) {
  const projectId = row.project_id ?? null;
  if (!projectId) return { type: "missing_project_id", root: null };
  const root = resolveProjectRoot(projectId);
  if (!root || !existsSync(root)) return { type: "missing_repo_root", root };
  if (!existsSync(path.join(root, ".git"))) return { type: "non_git_repo_root", root };
  return null;
}

export function buildQualityBackfillPlan(rows, options = {}) {
  const updates = [];
  const unchanged = [];
  const riskyLowSignal = [];
  const shortSummaryCandidates = [];
  const suppressionCandidates = [];
  const artifactExpiryCandidates = [];
  const projectMappingWarnings = [];

  for (const row of rows) {
    const assessed = assessMemoryUsefulness(row, { keepProjectFacts: true });
    const mappingWarning = projectMappingWarning(row);
    const item = {
      row,
      assessment: assessed,
      update_summary: normalizeText(row.summary) !== normalizeText(assessed.summary),
      set_scores: !numbersEqual(row.utility_score, assessed.utility_score) || !numbersEqual(row.confidence_score, assessed.confidence_score),
      set_expiry: !numbersEqual(row.expires_at, assessed.expires_at),
      project_mapping_warning: mappingWarning
    };

    if (assessed.risky_low_signal) riskyLowSignal.push(item);
    if (assessed.short_summary_candidate) shortSummaryCandidates.push(item);
    if (assessed.suppression_candidate) suppressionCandidates.push(item);
    if (assessed.artifact_expiry_candidate) artifactExpiryCandidates.push(item);
    if (mappingWarning) projectMappingWarnings.push(item);
    if (shouldUpdate(row, assessed)) {
      updates.push(item);
    } else {
      unchanged.push(item);
    }
  }

  return {
    updates,
    unchanged,
    riskyLowSignal,
    shortSummaryCandidates,
    suppressionCandidates,
    artifactExpiryCandidates,
    projectMappingWarnings,
    stats: summarizeQualityBackfill(
      {
        updates,
        unchanged,
        riskyLowSignal,
        shortSummaryCandidates,
        suppressionCandidates,
        artifactExpiryCandidates,
        projectMappingWarnings,
        inspectedCount: rows.length
      },
      options.sampleLimit
    )
  };
}

function summarizeQualityBackfill(plan, sampleLimit = 12) {
  const countWhere = (items, key) => items.filter((item) => item[key]).length;
  const sample = (items) =>
    items.slice(0, sampleLimit).map((item) => ({
      id: item.row.id,
      project_id: item.row.project_id ?? null,
      source: item.row.source,
      reason: item.assessment.reason,
      category: item.assessment.category,
      old_summary: item.row.summary ?? null,
      new_summary: item.assessment.summary,
      utility_score: item.assessment.utility_score,
      confidence_score: item.assessment.confidence_score,
      expires_at: item.assessment.expires_at,
      expires_reason: item.assessment.expires_reason,
      project_mapping_warning: item.project_mapping_warning
    }));

  return {
    inspected_count: plan.inspectedCount,
    update_count: plan.updates.length,
    no_change_count: plan.unchanged.length,
    update_summary_count: countWhere(plan.updates, "update_summary"),
    set_scores_count: countWhere(plan.updates, "set_scores"),
    set_expiry_count: countWhere(plan.updates, "set_expiry"),
    risky_low_signal_count: plan.riskyLowSignal.length,
    short_summary_candidate_count: plan.shortSummaryCandidates.length,
    suppression_candidate_count: plan.suppressionCandidates.length,
    artifact_expiry_candidate_count: plan.artifactExpiryCandidates.length,
    project_mapping_warning_count: plan.projectMappingWarnings.length,
    update_samples: sample(plan.updates),
    risky_low_signal_samples: sample(plan.riskyLowSignal),
    short_summary_candidate_samples: sample(plan.shortSummaryCandidates),
    suppression_candidate_samples: sample(plan.suppressionCandidates),
    artifact_expiry_candidate_samples: sample(plan.artifactExpiryCandidates),
    project_mapping_warning_samples: sample(plan.projectMappingWarnings)
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function exportReport(options, plan) {
  if (!options.exportPath) return null;
  const absolutePath = path.resolve(process.cwd(), options.exportPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const payload = {
    metadata: {
      captured_at: Date.now(),
      tenant_id: options.tenant,
      database: options.database,
      location: options.location,
      apply: options.apply,
      update_count: plan.updates.length
    },
    summary: plan.stats,
    backup: {
      memories: plan.updates.map((item) => item.row)
    },
    updates: plan.updates.map((item) => ({
      id: item.row.id,
      before: {
        summary: item.row.summary ?? null,
        utility_score: item.row.utility_score ?? null,
        confidence_score: item.row.confidence_score ?? null,
        expires_at: item.row.expires_at ?? null
      },
      after: {
        summary: item.assessment.summary,
        utility_score: item.assessment.utility_score,
        confidence_score: item.assessment.confidence_score,
        expires_at: item.assessment.expires_at
      },
      reason: item.assessment.reason,
      category: item.assessment.category,
      expires_reason: item.assessment.expires_reason
    }))
  };
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { path: absolutePath, rows: plan.updates.length };
}

function buildUpdateStatements(tenantId, item, now) {
  const row = item.row;
  const nextVersion = Number(row.current_version ?? 1) + 1;
  const tagsJson = row.tags_json ?? null;
  const content = row.content ?? "";
  const summary = item.assessment.summary;

  return [
    `UPDATE memories
     SET summary = ${sqlString(summary)},
         confidence_score = ${item.assessment.confidence_score},
         utility_score = ${item.assessment.utility_score},
         expires_at = ${sqlNullable(item.assessment.expires_at)},
         current_version = ${nextVersion},
         revised_at = ${now}
     WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(row.id)};`,
    `INSERT INTO memory_versions(
       id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind, lifecycle_state,
       scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score, canonical_key, created_at
     )
     VALUES(
       ${sqlString(`quality_backfill_${row.id}_${nextVersion}`)},
       ${sqlString(row.id)},
       ${sqlString(tenantId)},
       ${nextVersion},
       'quality-backfill',
       ${sqlString(content)},
       ${sqlString(summary)},
       ${sqlNullable(tagsJson)},
       ${sqlString(row.kind ?? "episodic")},
       ${sqlString(row.lifecycle_state ?? "active")},
       ${sqlString(row.scope_type ?? "project")},
       ${sqlNullable(row.scope_key)},
       'system',
       'memory-quality-backfill',
       ${item.assessment.confidence_score},
       ${item.assessment.utility_score},
       ${sqlNullable(row.canonical_key)},
       ${now}
     );`,
    `DELETE FROM memories_fts WHERE tenant_id = ${sqlString(tenantId)} AND memory_id = ${sqlString(row.id)};`,
    `INSERT INTO memories_fts(memory_id, tenant_id, content)
     VALUES(${sqlString(row.id)}, ${sqlString(tenantId)}, ${sqlString(`${summary}\n${content}`)});`
  ];
}

async function applyBackfill(options, plan) {
  const now = Date.now();
  for (const chunk of chunkArray(plan.updates, 20)) {
    const statements = chunk.flatMap((item) => buildUpdateStatements(options.tenant, item, now));
    await runD1Queries(options, { apply: statements.join("\n") });
  }
}

function printSummary(result) {
  const stats = result.summary;
  console.log("Org Brain memory quality backfill");
  console.log(`scope: tenant=${result.scope.tenant} database=${result.scope.database} location=${result.scope.location}${result.scope.env ? ` env=${result.scope.env}` : ""}`);
  console.log(`mode: ${result.applied ? "apply" : "dry-run"}`);
  console.log(`inspected: ${stats.inspected_count}`);
  console.log(`updates: ${stats.update_count}`);
  console.log(`no_change: ${stats.no_change_count}`);
  console.log(`update_summary: ${stats.update_summary_count}`);
  console.log(`set_scores: ${stats.set_scores_count}`);
  console.log(`set_expiry: ${stats.set_expiry_count}`);
  console.log(`risky_low_signal: ${stats.risky_low_signal_count}`);
  console.log(`short_summary_candidates: ${stats.short_summary_candidate_count}`);
  console.log(`suppression_candidates: ${stats.suppression_candidate_count}`);
  console.log(`artifact_expiry_candidates: ${stats.artifact_expiry_candidate_count}`);
  console.log(`project_mapping_warnings: ${stats.project_mapping_warning_count}`);
  if (result.export) console.log(`export: ${result.export.path}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const data = await runD1Queries(options, {
    memories: `
      SELECT *
      FROM memories
      WHERE tenant_id = ${sqlString(options.tenant)}
      ORDER BY created_at DESC
      LIMIT ${Number(options.limit)};
    `
  });
  const plan = buildQualityBackfillPlan(data.memories);
  const exported = await exportReport(options, plan);
  if (options.apply && plan.updates.length > 0) await applyBackfill(options, plan);

  const result = {
    captured_at: Date.now(),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    applied: options.apply,
    export: exported,
    summary: plan.stats
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printSummary(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
