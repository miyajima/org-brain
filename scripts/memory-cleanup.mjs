#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { addTags, classifyMemoryQuality, parseTagsJson } from "./lib/memory-quality.mjs";
import { parseLocationArgs, runD1Queries, sqlString } from "./lib/metrics-common.mjs";

const DEFAULT_LIMIT = 5000;

function printHelp() {
  console.log(`Org Brain memory cleanup

Usage:
  pnpm memories:cleanup [-- --json] [--export <path>] [--apply --export <path>]
  node ./scripts/memory-cleanup.mjs [options]

Options:
  --tenant <tenant_id>        Tenant to inspect (default: default)
  --database <name>           D1 database binding/name (default: open-brain)
  --local                     Query the local wrangler D1 database
  --preview                   Query the preview D1 database
  --remote                    Query the remote D1 database (default)
  --env <name>                Wrangler environment name
  --limit <n>                 Maximum memories to inspect (default: 5000)
  --export <path>             Export cleanup backup as JSONL
  --apply                     Persist cleanup. Requires --export.
  --keep-project-facts        Keep and promote project-fact rows (default)
  --delete-project-facts      Allow project-fact deletion by classifier
  --json                      Emit machine-readable JSON
  --help                      Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    apply: false,
    exportPath: null,
    keepProjectFacts: true,
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
    if (arg === "--keep-project-facts") {
      options.keepProjectFacts = true;
      continue;
    }
    if (arg === "--delete-project-facts") {
      options.keepProjectFacts = false;
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
    throw new Error("--apply requires --export <path> so deleted rows are backed up first");
  }

  return options;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function classifyMemoryCleanupRows(rows, options = {}) {
  const deleteRows = [];
  const promoteRows = [];
  const keepRows = [];

  for (const row of rows) {
    const tags = parseTagsJson(row.tags_json);
    const decision = classifyMemoryQuality({ ...row, tags }, { keepProjectFacts: options.keepProjectFacts });
    const item = { row, tags, decision };
    if (decision.action === "delete") {
      deleteRows.push(item);
    } else if (decision.action === "promote") {
      promoteRows.push(item);
    } else {
      keepRows.push(item);
    }
  }

  return { deleteRows, promoteRows, keepRows };
}

export function summarizeCleanupPlan(plan) {
  const countByReason = (items) =>
    items.reduce((acc, item) => {
      acc[item.decision.reason] = (acc[item.decision.reason] ?? 0) + 1;
      return acc;
    }, {});

  return {
    inspected_count: plan.inspectedCount,
    delete_count: plan.deleteRows.length,
    promote_count: plan.promoteRows.length,
    keep_count: plan.keepRows.length,
    delete_reasons: countByReason(plan.deleteRows),
    promote_reasons: countByReason(plan.promoteRows),
    delete_samples: plan.deleteRows.slice(0, 12).map((item) => ({
      id: item.row.id,
      project_id: item.row.project_id ?? null,
      source: item.row.source,
      reason: item.decision.reason,
      summary: item.row.summary
    })),
    promote_samples: plan.promoteRows.slice(0, 12).map((item) => ({
      id: item.row.id,
      project_id: item.row.project_id ?? null,
      source: item.row.source,
      reason: item.decision.reason,
      summary: item.row.summary
    }))
  };
}

export async function loadCleanupBackup(options, tenantId, memoryIds) {
  const backup = {
    memories: [],
    memory_versions: [],
    memory_edges: [],
    memory_entities: [],
    decision_rationales: [],
    decision_evidence: []
  };
  if (memoryIds.length === 0) return backup;

  for (const chunk of chunkArray(memoryIds, 80)) {
    const idList = chunk.map(sqlString).join(", ");
    const data = await runD1Queries(options, {
      memories: `
        SELECT *
        FROM memories
        WHERE tenant_id = ${sqlString(tenantId)}
          AND id IN (${idList});
      `,
      memory_versions: `
        SELECT *
        FROM memory_versions
        WHERE tenant_id = ${sqlString(tenantId)}
          AND memory_id IN (${idList});
      `,
      memory_edges: `
        SELECT *
        FROM memory_edges
        WHERE tenant_id = ${sqlString(tenantId)}
          AND (from_memory_id IN (${idList}) OR to_memory_id IN (${idList}));
      `,
      memory_entities: `
        SELECT *
        FROM memory_entities
        WHERE tenant_id = ${sqlString(tenantId)}
          AND memory_id IN (${idList});
      `,
      decision_rationales: `
        SELECT *
        FROM decision_rationales
        WHERE tenant_id = ${sqlString(tenantId)}
          AND memory_id IN (${idList});
      `
    });
    backup.memories.push(...data.memories);
    backup.memory_versions.push(...data.memory_versions);
    backup.memory_edges.push(...data.memory_edges);
    backup.memory_entities.push(...data.memory_entities);
    backup.decision_rationales.push(...data.decision_rationales);

    const rationaleIds = data.decision_rationales.map((row) => row.id).filter(Boolean);
    for (const rationaleChunk of chunkArray(rationaleIds, 80)) {
      const rationaleList = rationaleChunk.map(sqlString).join(", ");
      const evidence = await runD1Queries(options, {
        decision_evidence: `
          SELECT *
          FROM decision_evidence
          WHERE tenant_id = ${sqlString(tenantId)}
            AND rationale_id IN (${rationaleList});
        `
      });
      backup.decision_evidence.push(...evidence.decision_evidence);
    }
  }

  return backup;
}

async function exportBackup(options, plan) {
  if (!options.exportPath) return null;
  const absolutePath = path.resolve(process.cwd(), options.exportPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const memoryIds = plan.deleteRows.map((item) => item.row.id);
  const backup = await loadCleanupBackup(options, options.tenant, memoryIds);
  const lines = [
    {
      type: "metadata",
      captured_at: Date.now(),
      tenant_id: options.tenant,
      database: options.database,
      location: options.location,
      delete_count: plan.deleteRows.length
    },
    ...backup.memories.map((row) => ({ type: "memories", row })),
    ...backup.memory_versions.map((row) => ({ type: "memory_versions", row })),
    ...backup.memory_edges.map((row) => ({ type: "memory_edges", row })),
    ...backup.memory_entities.map((row) => ({ type: "memory_entities", row })),
    ...backup.decision_rationales.map((row) => ({ type: "decision_rationales", row })),
    ...backup.decision_evidence.map((row) => ({ type: "decision_evidence", row }))
  ];
  await writeFile(absolutePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return { path: absolutePath, rows: lines.length };
}

export function buildPromotionStatements(tenantId, item, now) {
  const row = item.row;
  const tags = addTags(item.tags, ["curated-memory"]);
  const currentVersion = Number(row.current_version ?? 1);
  return [
    `UPDATE memories
       SET tags_json = ${sqlString(JSON.stringify(tags))},
           kind = 'semantic',
           lifecycle_state = 'active',
           promoted_at = COALESCE(promoted_at, ${now}),
           revised_at = ${now},
           current_version = ${currentVersion + 1}
     WHERE tenant_id = ${sqlString(tenantId)}
       AND id = ${sqlString(row.id)};`,
    `DELETE FROM memories_fts
     WHERE tenant_id = ${sqlString(tenantId)}
       AND memory_id = ${sqlString(row.id)};`,
    `INSERT INTO memories_fts(memory_id, tenant_id, content)
     VALUES(${sqlString(row.id)}, ${sqlString(tenantId)}, ${sqlString(row.content)});`,
    `INSERT INTO memory_versions(
       id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind, lifecycle_state,
       scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score, canonical_key, created_at
     )
     VALUES(
       ${sqlString(`memver_cleanup_promote_${row.id}_${currentVersion + 1}`)},
       ${sqlString(row.id)},
       ${sqlString(tenantId)},
       ${currentVersion + 1},
       'promote',
       ${sqlString(row.content)},
       ${row.summary === null || row.summary === undefined ? "NULL" : sqlString(row.summary)},
       ${sqlString(JSON.stringify(tags))},
       'semantic',
       'active',
       ${sqlString(row.scope_type ?? "project")},
       ${row.scope_key === null || row.scope_key === undefined ? (row.project_id ? sqlString(row.project_id) : sqlString(tenantId)) : sqlString(row.scope_key)},
       'system',
       'memory-cleanup',
       ${row.confidence_score ?? "NULL"},
       ${row.utility_score ?? "NULL"},
       ${row.canonical_key === null || row.canonical_key === undefined ? "NULL" : sqlString(row.canonical_key)},
       ${now}
     );`
  ];
}

export function buildDeleteStatements(tenantId, deleteRows) {
  const ids = deleteRows.map((item) => item.row.id);
  const statements = [];
  for (const chunk of chunkArray(ids, 80)) {
    const idList = chunk.map(sqlString).join(", ");
    statements.push(
      `DELETE FROM decision_evidence
       WHERE tenant_id = ${sqlString(tenantId)}
         AND rationale_id IN (
           SELECT id FROM decision_rationales
           WHERE tenant_id = ${sqlString(tenantId)}
             AND memory_id IN (${idList})
         );`,
      `DELETE FROM decision_rationales
       WHERE tenant_id = ${sqlString(tenantId)}
         AND memory_id IN (${idList});`,
      `DELETE FROM memory_entities
       WHERE tenant_id = ${sqlString(tenantId)}
         AND memory_id IN (${idList});`,
      `DELETE FROM memory_edges
       WHERE tenant_id = ${sqlString(tenantId)}
         AND (from_memory_id IN (${idList}) OR to_memory_id IN (${idList}));`,
      `DELETE FROM memory_versions
       WHERE tenant_id = ${sqlString(tenantId)}
         AND memory_id IN (${idList});`,
      `DELETE FROM memories_fts
       WHERE tenant_id = ${sqlString(tenantId)}
         AND memory_id IN (${idList});`,
      `DELETE FROM memories
       WHERE tenant_id = ${sqlString(tenantId)}
         AND id IN (${idList});`
    );
  }
  return statements;
}

export async function applyCleanupPlan(options, plan) {
  const now = Date.now();
  const promotionStatements = plan.promoteRows.flatMap((item) => buildPromotionStatements(options.tenant, item, now));
  const deleteStatements = buildDeleteStatements(options.tenant, plan.deleteRows);
  const allStatements = [...promotionStatements, ...deleteStatements];
  for (const chunk of chunkArray(allStatements, 40)) {
    await runD1Queries(options, { apply: chunk.join("\n") });
  }
  return { statement_count: allStatements.length };
}

function printText(snapshot) {
  console.log("Org Brain memory cleanup");
  console.log(`scope: tenant=${snapshot.scope.tenant} database=${snapshot.scope.database} location=${snapshot.scope.location}`);
  console.log(`apply_requested: ${snapshot.apply_requested}`);
  console.log(`applied: ${snapshot.applied}`);
  if (snapshot.export) console.log(`export: ${snapshot.export.path} rows=${snapshot.export.rows}`);
  console.log("");
  console.log("Summary");
  console.log(`  inspected=${snapshot.summary.inspected_count}`);
  console.log(`  delete=${snapshot.summary.delete_count}`);
  console.log(`  promote=${snapshot.summary.promote_count}`);
  console.log(`  keep=${snapshot.summary.keep_count}`);
  console.log("");
  console.log("Delete reasons");
  for (const [reason, count] of Object.entries(snapshot.summary.delete_reasons)) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log("");
  console.log("Delete samples");
  for (const sample of snapshot.summary.delete_samples) {
    console.log(`  ${sample.id} project=${sample.project_id ?? "(none)"} reason=${sample.reason}: ${sample.summary ?? "(no summary)"}`);
  }
  console.log("");
  console.log("Promote samples");
  for (const sample of snapshot.summary.promote_samples) {
    console.log(`  ${sample.id} project=${sample.project_id ?? "(none)"} reason=${sample.reason}: ${sample.summary ?? "(no summary)"}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const tenant = sqlString(options.tenant);
  const data = await runD1Queries(options, {
    memories: `
      SELECT *
      FROM memories
      WHERE tenant_id = ${tenant}
      ORDER BY created_at DESC
      LIMIT ${Number(options.limit)};
    `
  });

  const classified = classifyMemoryCleanupRows(data.memories, options);
  const plan = {
    inspectedCount: data.memories.length,
    ...classified
  };

  const exported = await exportBackup(options, plan);
  const applied = options.apply ? await applyCleanupPlan(options, plan) : null;
  const snapshot = {
    captured_at: Date.now(),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    apply_requested: options.apply,
    applied: Boolean(applied),
    export: exported,
    apply_result: applied,
    summary: summarizeCleanupPlan(plan)
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printText(snapshot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
