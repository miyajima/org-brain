#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const apiGatewayDir = resolve(repoRoot, "apps/api-gateway");

function printHelp() {
  console.log(`Org Brain usage status

Usage:
  pnpm usage:status [-- --tenant <tenant_id>] [--json] [--local|--preview] [--recent <n>]
  node ./skills/org-brain-usage-status/scripts/report-usage-status.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --recent <n>           Latest memories to show per stage (default: 3)
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
    tenant: "default",
    database: "open-brain",
    location: "remote",
    env: undefined,
    json: false,
    recent: 3
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--local") {
      options.location = "local";
      continue;
    }
    if (arg === "--preview") {
      options.location = "preview";
      continue;
    }
    if (arg === "--remote") {
      options.location = "remote";
      continue;
    }
    if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++i];
      if (!value) throw new Error("--tenant requires a value");
      options.tenant = value;
      continue;
    }
    if (arg === "--database" || arg.startsWith("--database=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++i];
      if (!value) throw new Error("--database requires a value");
      options.database = value;
      continue;
    }
    if (arg === "--recent" || arg.startsWith("--recent=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++i];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--recent requires a non-negative integer");
      options.recent = parsed;
      continue;
    }
    if (arg === "--env" || arg.startsWith("--env=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++i];
      if (!value) throw new Error("--env requires a value");
      options.env = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function formatJst(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp));
}

function normalizeTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
}

function clip(value, limit = 140) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function stageLabel(stage) {
  return {
    canonical: "canonical-memory",
    curated_promoted: "curated/promoted-memory",
    digest: "memory-digest",
    recent_raw: "recent-raw",
    compacted: "compacted",
    suppressed: "suppressed"
  }[stage] ?? stage;
}

function stageSort(stage) {
  return {
    canonical: 0,
    curated_promoted: 1,
    digest: 2,
    recent_raw: 3,
    compacted: 4,
    suppressed: 5
  }[stage] ?? 99;
}

async function runQuery(options, sql) {
  const args = ["wrangler", "d1", "execute", options.database];
  args.push(`--${options.location}`);
  if (options.env) args.push("--env", options.env);
  args.push("--json", "--command", sql);

  const attempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout, stderr } = await execFileAsync("pnpm", args, {
        cwd: apiGatewayDir,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        const details = stderr?.trim() ? `\n${stderr.trim()}` : "";
        throw new Error(`Failed to parse wrangler JSON output.${details}\n${stdout}`);
      }

      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!first?.success) {
        throw new Error(`Wrangler query failed: ${JSON.stringify(first)}`);
      }
      return first.results ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = new Error(`Attempt ${attempt}/${attempts} failed for D1 query: ${message}`);
      if (attempt < attempts) {
        await delay(250 * attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("D1 query failed without a captured error");
}

function buildQueries(options) {
  const tenant = sqlString(options.tenant);
  const latestLimit = Number(options.recent);
  const classificationSql = `
      SELECT
        id,
        project_id,
        source,
        summary,
        tags_json,
        lifecycle_state,
        created_at,
        CASE
          WHEN tags_json LIKE '%"compacted"%' THEN 'compacted'
          WHEN COALESCE(lifecycle_state, 'active') = 'suppressed' THEN 'suppressed'
          WHEN tags_json LIKE '%"canonical-memory"%' THEN 'canonical'
          WHEN tags_json LIKE '%"curated-memory"%'
            OR tags_json LIKE '%"promoted-memory"%'
            OR tags_json LIKE '%"promoted"%'
            OR COALESCE(lifecycle_state, 'active') = 'promoted'
            THEN 'curated_promoted'
          WHEN tags_json LIKE '%"memory-digest"%' THEN 'digest'
          ELSE 'recent_raw'
        END AS stage
      FROM memories
      WHERE tenant_id = ${tenant}
    `;

  return {
    memorySummary: `
      SELECT
        COUNT(*) AS total_memories,
        COUNT(DISTINCT project_id) AS distinct_projects,
        MIN(created_at) AS first_memory_at,
        MAX(created_at) AS last_memory_at
      FROM memories
      WHERE tenant_id = ${tenant};
    `,
    threadSummary: `
      SELECT
        COUNT(*) AS total_threads,
        MIN(created_at) AS first_thread_at,
        MAX(created_at) AS last_thread_at
      FROM threads
      WHERE tenant_id = ${tenant};
    `,
    memoryStages: `
      WITH classified AS (
        ${classificationSql}
      )
      SELECT
        stage,
        COUNT(*) AS total,
        COUNT(DISTINCT project_id) AS distinct_projects,
        MIN(created_at) AS first_seen_at,
        MAX(created_at) AS last_seen_at
      FROM classified
      GROUP BY stage;
    `,
    memoryStageLatest: `
      WITH classified AS (
        ${classificationSql}
      ),
      ranked AS (
        SELECT
          stage,
          id,
          project_id,
          source,
          summary,
          tags_json,
          lifecycle_state,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY stage ORDER BY created_at DESC, id DESC) AS rn
        FROM classified
      )
      SELECT stage, id, project_id, source, summary, tags_json, lifecycle_state, created_at
      FROM ranked
      WHERE rn <= ${latestLimit}
      ORDER BY
        CASE stage
          WHEN 'canonical' THEN 0
          WHEN 'curated_promoted' THEN 1
          WHEN 'digest' THEN 2
          WHEN 'recent_raw' THEN 3
          WHEN 'compacted' THEN 4
          WHEN 'suppressed' THEN 5
          ELSE 99
        END,
        created_at DESC,
        id DESC;
    `
  };
}

function buildSnapshot(options, data) {
  const memorySummaryRow = data.memorySummary[0] ?? {};
  const threadSummaryRow = data.threadSummary[0] ?? {};
  const stageRows = data.memoryStages ?? [];
  const latestRows = data.memoryStageLatest ?? [];
  const latestByStage = latestRows.reduce((acc, row) => {
    const stage = String(row.stage);
    acc[stage] ??= [];
    acc[stage].push({
      id: row.id,
      project_id: row.project_id ?? null,
      source: row.source ?? null,
      summary: row.summary ?? null,
      lifecycle_state: row.lifecycle_state ?? null,
      tags_json: row.tags_json ?? null,
      created_at: normalizeTimestamp(row.created_at),
      created_at_jst: formatJst(normalizeTimestamp(row.created_at))
    });
    return acc;
  }, {});

  return {
    captured_at: Date.now(),
    captured_at_jst: formatJst(Date.now()),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    memories: {
      total_memories: Number(memorySummaryRow.total_memories ?? 0),
      distinct_projects: Number(memorySummaryRow.distinct_projects ?? 0),
      first_memory_at: normalizeTimestamp(memorySummaryRow.first_memory_at),
      first_memory_at_jst: formatJst(normalizeTimestamp(memorySummaryRow.first_memory_at)),
      last_memory_at: normalizeTimestamp(memorySummaryRow.last_memory_at),
      last_memory_at_jst: formatJst(normalizeTimestamp(memorySummaryRow.last_memory_at)),
      stages: stageRows
        .map((row) => ({
          stage: row.stage,
          label: stageLabel(row.stage),
          total: Number(row.total ?? 0),
          distinct_projects: Number(row.distinct_projects ?? 0),
          first_seen_at: normalizeTimestamp(row.first_seen_at),
          first_seen_at_jst: formatJst(normalizeTimestamp(row.first_seen_at)),
          last_seen_at: normalizeTimestamp(row.last_seen_at),
          last_seen_at_jst: formatJst(normalizeTimestamp(row.last_seen_at)),
          latest: latestByStage[row.stage] ?? []
        }))
        .sort((a, b) => stageSort(a.stage) - stageSort(b.stage))
    },
    threads: {
      total_threads: Number(threadSummaryRow.total_threads ?? 0),
      first_thread_at: normalizeTimestamp(threadSummaryRow.first_thread_at),
      first_thread_at_jst: formatJst(normalizeTimestamp(threadSummaryRow.first_thread_at)),
      last_thread_at: normalizeTimestamp(threadSummaryRow.last_thread_at),
      last_thread_at_jst: formatJst(normalizeTimestamp(threadSummaryRow.last_thread_at))
    }
  };
}

function printSnapshot(snapshot) {
  const { scope, memories, threads } = snapshot;

  console.log("Org Brain usage snapshot");
  console.log(`captured_at: ${snapshot.captured_at_jst}`);
  console.log(`scope: tenant=${scope.tenant} database=${scope.database} location=${scope.location}${scope.env ? ` env=${scope.env}` : ""}`);
  console.log("");
  console.log("Memories");
  console.log(`- total: ${memories.total_memories}`);
  console.log(`- distinct_projects: ${memories.distinct_projects}`);
  console.log(`- first_seen: ${memories.first_memory_at_jst ?? "n/a"}`);
  console.log(`- last_seen: ${memories.last_memory_at_jst ?? "n/a"}`);
  console.log("");
  console.log("Memory stages");
  for (const stage of memories.stages) {
    console.log(`- ${stage.label}: total=${stage.total} distinct_projects=${stage.distinct_projects} last_seen=${stage.last_seen_at_jst ?? "n/a"}`);
    if (stage.latest.length === 0) {
      console.log("  latest: none");
      continue;
    }
    for (const item of stage.latest) {
      const project = item.project_id ? ` project=${item.project_id}` : "";
      const source = item.source ? ` source=${item.source}` : "";
      console.log(`  - ${item.created_at_jst ?? "n/a"} ${item.id}${project}${source}: ${clip(item.summary ?? "(no summary)")}`);
    }
  }
  console.log("");
  console.log("Threads");
  console.log(`- total: ${threads.total_threads}`);
  console.log(`- first_seen: ${threads.first_thread_at_jst ?? "n/a"}`);
  console.log(`- last_seen: ${threads.last_thread_at_jst ?? "n/a"}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const queries = buildQueries(options);
  const data = {};
  for (const [key, sql] of Object.entries(queries)) {
    data[key] = await runQuery(options, sql);
  }

  const snapshot = buildSnapshot(options, data);
  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printSnapshot(snapshot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
