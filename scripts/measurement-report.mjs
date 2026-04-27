#!/usr/bin/env node

import process from "node:process";
import { formatJst, parseLocationArgs, runD1Queries, sqlString } from "./lib/metrics-common.mjs";

function printHelp() {
  console.log(`Org Brain measurement report

Usage:
  pnpm measurement:report [-- --tenant <tenant_id>] [--run-id <id>] [--session-id <id>] [--limit <n>]
  node ./scripts/measurement-report.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --run-id <id>          Show a single measurement run
  --session-id <id>      Show runs grouped under one measurement session
  --limit <n>            Number of recent runs to inspect (default: 20)
  --database <name>      D1 database binding/name (default: open-brain)
  --local                Query local D1
  --preview              Query preview D1
  --remote               Query remote D1 (default)
  --env <name>           Wrangler environment name
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    runId: undefined,
    sessionId: undefined,
    limit: 20
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--" ||
      arg === "--help" ||
      arg === "-h" ||
      arg === "--json" ||
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
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--run-id requires a value");
      options.runId = value;
      continue;
    }
    if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--session-id requires a value");
      options.sessionId = value;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function buildQueries(options) {
  const tenant = sqlString(options.tenant);
  const runFilter = options.runId ? ` AND r.id = ${sqlString(options.runId)}` : "";
  const sessionFilter = options.sessionId ? ` AND r.measurement_session_id = ${sqlString(options.sessionId)}` : "";
  const limit = Number(options.limit);

  return {
    runs: `
      SELECT r.id, r.tenant_id, r.project_id, r.capability, r.input_ref, r.reference_model,
             r.measurement_session_id, r.measurement_unit, r.created_at,
             c.input_tokens_saved, c.input_savings_rate, c.input_cost_saved_usd,
             c.total_cost_delta_usd, c.duration_delta_ms, c.quality_verdict, c.quality_passed
      FROM measurement_runs r
      LEFT JOIN measurement_comparisons c
        ON c.tenant_id = r.tenant_id
       AND c.run_id = r.id
      WHERE r.tenant_id = ${tenant}
        ${runFilter}
        ${sessionFilter}
      ORDER BY r.created_at DESC
      LIMIT ${limit};
    `,
    variants: `
      SELECT v.run_id, v.variant, v.task_id, v.status, v.memory_enabled, v.memory_write_enabled,
             v.output_ref, v.input_tokens, v.output_tokens, v.total_tokens,
             v.input_cost_usd, v.total_cost_usd, v.duration_ms, v.retrieval_count,
             v.retrieved_ids_json, v.error_json, v.created_at, v.completed_at
      FROM measurement_variants v
      JOIN measurement_runs r
        ON r.tenant_id = v.tenant_id
       AND r.id = v.run_id
      WHERE v.tenant_id = ${tenant}
        ${runFilter}
        ${sessionFilter}
      ORDER BY v.run_id DESC, v.variant ASC
      LIMIT ${limit * 2};
    `
  };
}

function summarize(runs, variants) {
  const completed = runs.filter((run) => run.input_tokens_saved !== null && run.input_tokens_saved !== undefined);
  const qualityPassed = completed.filter((run) => Number(run.quality_passed) > 0);
  const tokensSavedTotal = completed.reduce((sum, run) => sum + Number(run.input_tokens_saved ?? 0), 0);
  const costSavedTotal = completed.reduce((sum, run) => sum + Number(run.input_cost_saved_usd ?? 0), 0);
  const sessionGroups = completed.reduce((acc, run) => {
    const key = run.measurement_session_id ?? "(none)";
    acc[key] ??= { run_count: 0, tokens_saved: 0, input_cost_saved_usd: 0 };
    acc[key].run_count += 1;
    acc[key].tokens_saved += Number(run.input_tokens_saved ?? 0);
    acc[key].input_cost_saved_usd += Number(run.input_cost_saved_usd ?? 0);
    return acc;
  }, {});

  return {
    run_count: runs.length,
    completed_count: completed.length,
    quality_passed_count: qualityPassed.length,
    degraded_count: completed.length - qualityPassed.length,
    avg_tokens_saved:
      completed.length > 0 ? tokensSavedTotal / completed.length : 0,
    avg_quality_passed_tokens_saved:
      qualityPassed.length > 0
        ? qualityPassed.reduce((sum, run) => sum + Number(run.input_tokens_saved ?? 0), 0) / qualityPassed.length
        : 0,
    input_cost_saved_usd: costSavedTotal,
    sessions: sessionGroups,
    variants_by_run: variants.reduce((acc, variant) => {
      const key = variant.run_id;
      acc[key] ??= [];
      acc[key].push(variant);
      return acc;
    }, {})
  };
}

function printText(snapshot) {
  console.log("Org Brain measurement report");
  console.log(`Scope: tenant=${snapshot.scope.tenant} run=${snapshot.scope.run_id ?? "(recent)"} session=${snapshot.scope.session_id ?? "(all)"} source=${snapshot.scope.location}`);
  console.log(`Captured: ${snapshot.captured_at_jst}`);
  console.log("");
  console.log("Summary");
  console.log(`  runs=${snapshot.summary.run_count} completed=${snapshot.summary.completed_count} quality_passed=${snapshot.summary.quality_passed_count} degraded=${snapshot.summary.degraded_count}`);
  console.log(`  avg_tokens_saved=${snapshot.summary.avg_tokens_saved.toFixed(1)} quality_passed_avg=${snapshot.summary.avg_quality_passed_tokens_saved.toFixed(1)} input_cost_saved=$${snapshot.summary.input_cost_saved_usd.toFixed(6)}`);
  const sessionEntries = Object.entries(snapshot.summary.sessions).filter(([id]) => id !== "(none)");
  for (const [sessionId, session] of sessionEntries) {
    console.log(`  session ${sessionId}: runs=${session.run_count} tokens_saved=${session.tokens_saved} input_cost_saved=$${session.input_cost_saved_usd.toFixed(6)}`);
  }
  console.log("");
  console.log("Runs");
  if (snapshot.runs.length === 0) {
    console.log("  no data");
    return;
  }

  for (const run of snapshot.runs) {
    const variants = snapshot.summary.variants_by_run[run.id] ?? [];
    const saved = run.input_tokens_saved === null || run.input_tokens_saved === undefined
      ? "pending"
      : `${Number(run.input_tokens_saved).toFixed(0)} tokens (${(Number(run.input_savings_rate) * 100).toFixed(1)}%)`;
    const session = run.measurement_session_id ? ` session=${run.measurement_session_id}` : "";
    console.log(`  ${run.id} ${run.capability}${session}: saved=${saved} quality=${run.quality_verdict ?? "pending"}`);
    for (const variant of variants) {
      console.log(`    ${variant.variant}: status=${variant.status} task=${variant.task_id} input_tokens=${variant.input_tokens ?? "n/a"} retrievals=${variant.retrieval_count ?? "n/a"}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const data = await runD1Queries(options, buildQueries(options));
  const now = Date.now();
  const snapshot = {
    captured_at: now,
    captured_at_jst: formatJst(now),
    scope: {
      tenant: options.tenant,
      run_id: options.runId ?? null,
      session_id: options.sessionId ?? null,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    summary: summarize(data.runs, data.variants),
    runs: data.runs.map((run) => ({
      ...run,
      created_at_jst: formatJst(Number(run.created_at))
    })),
    variants: data.variants
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
