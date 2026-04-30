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
  pnpm usage:status [-- --tenant <tenant_id>] [--json] [--local|--preview]
  node ./skills/org-brain-usage-status/scripts/report-usage-status.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
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
    json: false
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
      if (!arg.includes("=")) i += 1;
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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    `
  };
}

function buildSnapshot(options, data) {
  const memorySummaryRow = data.memorySummary[0] ?? {};
  const threadSummaryRow = data.threadSummary[0] ?? {};

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
      last_memory_at_jst: formatJst(normalizeTimestamp(memorySummaryRow.last_memory_at))
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
