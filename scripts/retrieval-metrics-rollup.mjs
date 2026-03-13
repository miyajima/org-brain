#!/usr/bin/env node

import process from "node:process";
import { formatJst, formatUtcDay, parseLocationArgs, runD1Queries, sqlNullable, sqlString, utcDayBounds } from "./lib/metrics-common.mjs";
import { computeRawRetrievalMetrics } from "./lib/retrieval-metrics-core.mjs";

function printHelp() {
  console.log(`Org Brain retrieval metrics rollup

Usage:
  pnpm metrics:rollup [-- --day YYYY-MM-DD]
  node ./scripts/retrieval-metrics-rollup.mjs [options]

Options:
  --day <day>           UTC day to aggregate (default: previous UTC day)
  --tenant <tenant_id>  Optional tenant filter
  --database <name>     D1 database binding/name (default: open-brain)
  --capability <name>   Optional capability filter
  --local               Query the local wrangler D1 database
  --preview             Query the preview D1 database
  --remote              Query the remote D1 database (default)
  --env <name>          Wrangler environment name
  --json                Emit machine-readable JSON
  --help                Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    day: formatUtcDay(Date.now() - 24 * 60 * 60 * 1000)
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
    if (arg === "--day" || arg.startsWith("--day=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--day requires a value");
      utcDayBounds(value);
      options.day = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { start, end } = utcDayBounds(options.day);
  const tenantFilter = options.tenant ? ` AND tenant_id = ${sqlString(options.tenant)}` : "";
  const capabilityFilter = options.capability ? ` AND capability = ${sqlString(options.capability)}` : "";

  const data = await runD1Queries(options, {
    events: `
      SELECT tenant_id, capability, search_strategy, task_id, matched_count, returned_count, fallback_used, latency_ms
      FROM retrieval_events
      WHERE created_at >= ${start}
        AND created_at < ${end}
        ${tenantFilter}
        ${capabilityFilter}
      ORDER BY created_at ASC;
    `,
    taskIds: `
      SELECT DISTINCT task_id
      FROM retrieval_events
      WHERE created_at >= ${start}
        AND created_at < ${end}
        ${tenantFilter}
        ${capabilityFilter};
    `
  });

  const taskIds = data.taskIds.map((row) => row.task_id).filter((value) => typeof value === "string");
  const taskRows = taskIds.length > 0
    ? await runD1Queries(options, {
        tasks: `
          SELECT id, status, created_at, updated_at
          FROM tasks
          WHERE id IN (${taskIds.map(sqlString).join(",")});
        `
      })
    : { tasks: [] };
  const metrics = computeRawRetrievalMetrics(data.events, new Map(taskRows.tasks.map((task) => [task.id, task])));
  const now = Date.now();

  let command = `DELETE FROM retrieval_daily_metrics WHERE day = ${sqlString(options.day)}`;
  for (const row of metrics) {
    command += `;
      INSERT INTO retrieval_daily_metrics(
        day, tenant_id, capability, search_strategy, search_count, task_count,
        hit_rate, fallback_rate, avg_matched_count, avg_returned_count, avg_latency_ms,
        p95_latency_ms, success_rate, avg_task_duration_ms, failed_task_count, created_at
      ) VALUES(
        ${sqlString(options.day)},
        ${sqlString(row.tenant_id)},
        ${sqlString(row.capability)},
        ${sqlString(row.search_strategy)},
        ${row.search_count},
        ${row.task_count},
        ${row.hit_rate},
        ${row.fallback_rate},
        ${row.avg_matched_count},
        ${row.avg_returned_count},
        ${row.avg_latency_ms},
        ${sqlNullable(row.p95_latency_ms)},
        ${row.success_rate},
        ${sqlNullable(row.avg_task_duration_ms)},
        ${row.failed_task_count},
        ${now}
      )`;
  }

  await runD1Queries(options, { write: command });

  const summary = {
    day: options.day,
    group_count: metrics.length,
    raw_event_count: data.events.length,
    captured_at_jst: formatJst(now)
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Org Brain retrieval metrics rollup");
  console.log(`Day: ${summary.day}`);
  console.log(`Groups: ${summary.group_count}`);
  console.log(`Raw events: ${summary.raw_event_count}`);
  console.log(`Captured: ${summary.captured_at_jst}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
