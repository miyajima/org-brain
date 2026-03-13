#!/usr/bin/env node

import process from "node:process";
import {
  buildFtsQuery,
  fetchR2ObjectText,
  formatJst,
  parseLocationArgs,
  runD1Queries,
  sqlString
} from "./lib/metrics-common.mjs";
import { summarizeReplayComparisons } from "./lib/retrieval-metrics-core.mjs";
import { overlapAtFive, resolveReplayInput } from "./lib/retrieval-replay-core.mjs";

function printHelp() {
  console.log(`Org Brain retrieval metrics replay

Usage:
  pnpm metrics:replay [-- --tenant <tenant_id>] [--limit <n>] [--task-id <id>]
  node ./scripts/retrieval-metrics-replay.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --capability <name>    Optional capability filter
  --task-id <id>         Replay a single task
  --limit <n>            Number of recent tasks to inspect (default: 20)
  --bucket <name>        R2 bucket for r2:// input refs (default: open-brain-bucket)
  --local                Query the local wrangler D1 database
  --preview              Query the preview D1 database
  --remote               Query the remote D1 database (default)
  --env <name>           Wrangler environment name
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    limit: 20,
    taskId: undefined,
    bucket: "open-brain-bucket"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "--help" || arg === "-h" || arg === "--json" || arg === "--local" || arg === "--preview" || arg === "--remote") continue;
    if (
      arg === "--tenant" ||
      arg.startsWith("--tenant=") ||
      arg === "--database" ||
      arg.startsWith("--database=") ||
      arg === "--env" ||
      arg.startsWith("--env=") ||
      arg === "--capability" ||
      arg.startsWith("--capability=")
    ) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      continue;
    }
    if (arg === "--task-id" || arg.startsWith("--task-id=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--task-id requires a value");
      options.taskId = value;
      continue;
    }
    if (arg === "--bucket" || arg.startsWith("--bucket=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--bucket requires a value");
      options.bucket = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function runStrategy(options, queryText, strategy) {
  const ftsQuery = buildFtsQuery(queryText);
  if (!ftsQuery) {
    const fallback = await runD1Queries(options, {
      fallback: `
        SELECT id
        FROM memories
        WHERE tenant_id = ${sqlString(options.tenant)}
        ORDER BY created_at DESC
        LIMIT 5;
      `
    });
    return {
      strategy,
      matched_count: 0,
      fallback_used: true,
      memory_ids: fallback.fallback.map((row) => row.id)
    };
  }

  const orderBy =
    strategy === "bm25_v1"
      ? "ORDER BY bm25(memories_fts) ASC, m.created_at DESC"
      : "ORDER BY m.created_at DESC";
  const result = await runD1Queries(options, {
    matched: `
      SELECT m.id
      FROM memories_fts
      JOIN memories m
        ON m.id = memories_fts.memory_id
       AND m.tenant_id = memories_fts.tenant_id
      WHERE memories_fts.tenant_id = ${sqlString(options.tenant)}
        AND memories_fts.content MATCH ${sqlString(ftsQuery)}
      ${orderBy}
      LIMIT 5;
    `,
    count: `
      SELECT COUNT(*) AS matched_count
      FROM memories_fts
      WHERE tenant_id = ${sqlString(options.tenant)}
        AND content MATCH ${sqlString(ftsQuery)};
    `
  });

  if (result.matched.length > 0) {
    return {
      strategy,
      matched_count: result.count[0]?.matched_count ?? 0,
      fallback_used: false,
      memory_ids: result.matched.map((row) => row.id)
    };
  }

  const fallback = await runD1Queries(options, {
    fallback: `
      SELECT id
      FROM memories
      WHERE tenant_id = ${sqlString(options.tenant)}
      ORDER BY created_at DESC
      LIMIT 5;
    `
  });

  return {
    strategy,
    matched_count: 0,
    fallback_used: true,
    memory_ids: fallback.fallback.map((row) => row.id)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const capabilityFilter = options.capability ? ` AND capability = ${sqlString(options.capability)}` : "";
  const taskFilter = options.taskId ? ` AND id = ${sqlString(options.taskId)}` : "";
  const tasks = await runD1Queries(options, {
    tasks: `
      SELECT id, capability, status, input_ref, updated_at
      FROM tasks
      WHERE tenant_id = ${sqlString(options.tenant)}
        ${capabilityFilter}
        ${taskFilter}
      ORDER BY updated_at DESC
      LIMIT ${options.limit};
    `
  });

  const memoryCache = new Map();
  const comparisons = [];

  for (const task of tasks.tasks) {
    const resolved = await resolveReplayInput(
      task,
      {
        loadMemory: async (memoryId) => {
          const memoryRows = await runD1Queries(options, {
            memory: `
              SELECT content
              FROM memories
              WHERE tenant_id = ${sqlString(options.tenant)}
                AND id = ${sqlString(memoryId)}
              LIMIT 1;
            `
          });
          return memoryRows.memory[0]?.content ?? "";
        },
        loadR2: async (key) => fetchR2ObjectText(options, options.bucket, key)
      },
      memoryCache
    );
    const queryText = String(resolved.input).slice(0, 120);
    const legacy = await runStrategy(options, queryText, "legacy_recent_v1");
    const bm25 = await runStrategy(options, queryText, "bm25_v1");
    const legacyIds = legacy.memory_ids;
    const bm25Ids = bm25.memory_ids;
    const exactMatch = JSON.stringify(legacyIds) === JSON.stringify(bm25Ids);

    comparisons.push({
      task_id: task.id,
      capability: task.capability,
      status: task.status,
      input_source: resolved.input_source,
      query_preview: queryText.slice(0, 80),
      legacy_recent_v1: legacy,
      bm25_v1: bm25,
      overlap_at_5: overlapAtFive(legacyIds, bm25Ids),
      exact_match: exactMatch,
      changed: !exactMatch
    });
  }

  const snapshot = {
    captured_at: Date.now(),
    captured_at_jst: formatJst(Date.now()),
    scope: {
      tenant: options.tenant,
      capability: options.capability ?? null,
      task_id: options.taskId ?? null,
      limit: options.limit,
      database: options.database,
      location: options.location,
      env: options.env ?? null,
      bucket: options.bucket
    },
    summary: summarizeReplayComparisons(comparisons),
    comparisons
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log("Org Brain retrieval metrics replay");
  console.log(`Scope: tenant=${snapshot.scope.tenant} capability=${snapshot.scope.capability ?? "(all)"} limit=${snapshot.scope.limit}`);
  console.log(`Captured: ${snapshot.captured_at_jst}`);
  console.log(
    `Summary: tasks=${snapshot.summary.total_tasks} changed=${snapshot.summary.changed_tasks} exact_match_rate=${(snapshot.summary.exact_match_rate * 100).toFixed(1)}% avg_overlap@5=${snapshot.summary.average_overlap_at_5.toFixed(2)}`
  );
  console.log("");

  for (const record of snapshot.comparisons.slice(0, 10)) {
    console.log(`${record.task_id} (${record.capability}/${record.input_source})`);
    console.log(`  legacy: ${record.legacy_recent_v1.memory_ids.join(", ") || "(none)"}`);
    console.log(`  bm25  : ${record.bm25_v1.memory_ids.join(", ") || "(none)"}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
