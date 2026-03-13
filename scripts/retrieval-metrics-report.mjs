#!/usr/bin/env node

import process from "node:process";
import {
  formatJst,
  formatUtcDay,
  parseLocationArgs,
  runD1Queries,
  sqlString,
  utcDayBounds
} from "./lib/metrics-common.mjs";
import {
  computeRawRetrievalMetrics,
  computeServiceMetrics,
  countTopMemoryIds,
  mergeRetrievalMetrics,
  RAW_RETENTION_DAYS
} from "./lib/retrieval-metrics-core.mjs";

function printHelp() {
  console.log(`Org Brain retrieval metrics report

Usage:
  pnpm metrics:report [-- --tenant <tenant_id>] [--days <n>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  node ./scripts/retrieval-metrics-report.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --capability <name>    Filter to one capability
  --days <n>             Rolling UTC day window when --from/--to are omitted (default: 7)
  --from <day>           Inclusive UTC day in YYYY-MM-DD
  --to <day>             Inclusive UTC day in YYYY-MM-DD
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
    days: 7,
    from: undefined,
    to: undefined
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
    if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--days requires a positive integer");
      options.days = parsed;
      continue;
    }
    if (arg === "--from" || arg.startsWith("--from=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--from requires a value");
      utcDayBounds(value);
      options.from = value;
      continue;
    }
    if (arg === "--to" || arg.startsWith("--to=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--to requires a value");
      utcDayBounds(value);
      options.to = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function buildRange(options) {
  const now = Date.now();
  const today = formatUtcDay(now);

  if (options.from || options.to) {
    const fromDay = options.from ?? options.to;
    const toDay = options.to ?? options.from;
    if (fromDay > toDay) {
      throw new Error("--from must be <= --to");
    }
    const start = utcDayBounds(fromDay).start;
    const end = utcDayBounds(toDay).end;
    return { now, today, fromDay, toDay, start, end };
  }

  const todayStart = utcDayBounds(today).start;
  const start = todayStart - (options.days - 1) * 24 * 60 * 60 * 1000;
  const fromDay = formatUtcDay(start);
  return {
    now,
    today,
    fromDay,
    toDay: today,
    start,
    end: utcDayBounds(today).end
  };
}

function buildQueries(options, range) {
  const capabilityFilter = options.capability ? ` AND capability = ${sqlString(options.capability)}` : "";
  const retrievalCapabilityFilter = options.capability ? ` AND capability = ${sqlString(options.capability)}` : "";
  const tenant = sqlString(options.tenant);
  const rawCutoff = range.now - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const rawStart = Math.max(range.start, rawCutoff);
  const rawEnabled = rawStart < range.end;
  const dailyEndDay = rawEnabled ? formatUtcDay(rawStart - 1) : range.toDay;
  const useDaily = range.fromDay <= dailyEndDay;

  return {
    tasks: `
      SELECT id, capability, status, created_at, updated_at
      FROM tasks
      WHERE tenant_id = ${tenant}
        AND created_at >= ${range.start}
        AND created_at < ${range.end}
        ${capabilityFilter}
      ORDER BY created_at ASC;
    `,
    rawEvents: rawEnabled
      ? `
        SELECT tenant_id, capability, search_strategy, task_id, matched_count, returned_count, fallback_used, latency_ms, top_memory_ids_json, created_at
        FROM retrieval_events
        WHERE tenant_id = ${tenant}
          AND created_at >= ${rawStart}
          AND created_at < ${range.end}
          ${retrievalCapabilityFilter}
        ORDER BY created_at ASC;
      `
      : "SELECT NULL WHERE 0;",
    rawTasks: rawEnabled
      ? `
        SELECT DISTINCT task_id
        FROM retrieval_events
        WHERE tenant_id = ${tenant}
          AND created_at >= ${rawStart}
          AND created_at < ${range.end}
          ${retrievalCapabilityFilter};
      `
      : "SELECT NULL WHERE 0;",
    dailyMetrics: useDaily
      ? `
        SELECT day, tenant_id, capability, search_strategy, search_count, task_count,
               hit_rate, fallback_rate, avg_matched_count, avg_returned_count,
               avg_latency_ms, p95_latency_ms, success_rate, avg_task_duration_ms,
               failed_task_count
        FROM retrieval_daily_metrics
        WHERE tenant_id = ${tenant}
          AND day >= ${sqlString(range.fromDay)}
          AND day <= ${sqlString(dailyEndDay)}
          ${retrievalCapabilityFilter}
        ORDER BY day ASC, capability ASC, search_strategy ASC;
      `
      : "SELECT NULL WHERE 0;",
    rawStart,
    rawEnabled
  };
}

function printText(snapshot) {
  console.log("Org Brain retrieval metrics");
  console.log(`Scope: tenant=${snapshot.scope.tenant} capability=${snapshot.scope.capability ?? "(all)"} range=${snapshot.scope.from_day}..${snapshot.scope.to_day} source=${snapshot.scope.location}`);
  console.log(`Captured: ${snapshot.captured_at_jst}`);
  console.log("");
  console.log("Retrieval");
  if (snapshot.retrieval.groups.length === 0) {
    console.log("  no data");
  } else {
    for (const row of snapshot.retrieval.groups) {
      const p95 = row.p95_latency_ms === null ? "n/a" : `${row.p95_latency_ms.toFixed(1)}ms`;
      console.log(
        `  ${row.capability}/${row.search_strategy}: searches=${row.search_count} hit_rate=${(row.hit_rate * 100).toFixed(1)}% fallback_rate=${(row.fallback_rate * 100).toFixed(1)}% avg_latency=${row.avg_latency_ms.toFixed(1)}ms p95=${p95} success_rate=${(row.success_rate * 100).toFixed(1)}%`
      );
    }
  }
  console.log("");
  console.log("Service");
  console.log(
    `  tasks=${snapshot.service.overall.task_count} success_rate=${(snapshot.service.overall.success_rate * 100).toFixed(1)}% failed=${snapshot.service.overall.failed_count} avg_duration=${snapshot.service.overall.avg_task_duration_ms.toFixed(1)}ms p95=${snapshot.service.overall.p95_task_duration_ms ?? "n/a"}`
  );
  console.log("");
  console.log("Top Referenced Memory IDs");
  if (snapshot.retrieval.top_memory_ids.length === 0) {
    console.log("  no raw telemetry in range");
  } else {
    for (const row of snapshot.retrieval.top_memory_ids) {
      console.log(`  ${row.memory_id}: ${row.count}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const range = buildRange(options);
  const queries = buildQueries(options, range);
  const data = await runD1Queries(options, {
    tasks: queries.tasks,
    rawEvents: queries.rawEvents,
    rawTaskIds: queries.rawTasks,
    dailyMetrics: queries.dailyMetrics
  });

  const rawTaskIds = data.rawTaskIds
    .map((row) => row.task_id)
    .filter((value) => typeof value === "string");
  const rawTasks = rawTaskIds.length > 0
    ? await runD1Queries(options, {
        rawTasks: `
          SELECT id, status, created_at, updated_at
          FROM tasks
          WHERE id IN (${rawTaskIds.map(sqlString).join(",")});
        `
      })
    : { rawTasks: [] };
  const rawTaskMap = new Map(rawTasks.rawTasks.map((task) => [task.id, task]));

  const rawMetrics = computeRawRetrievalMetrics(data.rawEvents.filter((row) => row.tenant_id), rawTaskMap);
  const mergedMetrics = mergeRetrievalMetrics(rawMetrics, data.dailyMetrics.filter((row) => row.tenant_id));
  const serviceMetrics = computeServiceMetrics(data.tasks.filter((task) => task.id));

  const snapshot = {
    captured_at: range.now,
    captured_at_jst: formatJst(range.now),
    scope: {
      tenant: options.tenant,
      capability: options.capability ?? null,
      database: options.database,
      location: options.location,
      env: options.env ?? null,
      from_day: range.fromDay,
      to_day: range.toDay,
      raw_retention_days: RAW_RETENTION_DAYS
    },
    retrieval: {
      groups: mergedMetrics,
      top_memory_ids: countTopMemoryIds(data.rawEvents.filter((row) => row.tenant_id)),
      raw_event_count: data.rawEvents.filter((row) => row.tenant_id).length,
      daily_group_count: data.dailyMetrics.filter((row) => row.tenant_id).length
    },
    service: serviceMetrics
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  printText(snapshot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
