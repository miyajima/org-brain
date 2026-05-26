#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { assessMemoryUsefulness } from "../../../scripts/lib/memory-quality.mjs";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const apiGatewayDir = resolve(repoRoot, "apps/api-gateway");
const projectRootOverrides = new Map([
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

function resolveProjectRoot(projectId) {
  if (!projectId) return null;
  const configured = configuredProjectRootOverrides();
  if (configured.has(projectId)) return configured.get(projectId);
  if (projectRootOverrides.has(projectId)) return projectRootOverrides.get(projectId);
  return `/Users/miya/projects/${projectId}`;
}

async function inspectProjectRepo(projectId) {
  const root = resolveProjectRoot(projectId);
  if (!root || !existsSync(root)) {
    return { root, repo_state: "missing", branch: null, dirty_count: null, docs_count: null };
  }
  const docs = ["README.md", "AGENTS.md", "CLAUDE.md", "docs/SPEC.md", "docs/SYSTEM_DESIGN.md", "docs/DESIGN.md"].filter((file) =>
    existsSync(resolve(root, file))
  );
  try {
    const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", root, "status", "--short"], { encoding: "utf8", maxBuffer: 1024 * 1024 })
    ]);
    return {
      root,
      repo_state: "git",
      branch: branchOut.trim(),
      dirty_count: statusOut.split(/\r?\n/).filter(Boolean).length,
      docs_count: docs.length
    };
  } catch {
    return { root, repo_state: "non-git", branch: null, dirty_count: null, docs_count: docs.length };
  }
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
    memoryQuality: `
      SELECT
        id,
        project_id,
        source,
        summary,
        content,
        tags_json,
        kind,
        lifecycle_state,
        created_at,
        utility_score,
        confidence_score,
        last_accessed_at,
        expires_at
      FROM memories
      WHERE tenant_id = ${tenant};
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

async function buildProjectHealth(qualityRows, qualityAssessments) {
  const byProject = new Map();
  for (let index = 0; index < qualityRows.length; index += 1) {
    const row = qualityRows[index];
    const assessment = qualityAssessments[index];
    const projectId = row.project_id ?? "(none)";
    const entry = byProject.get(projectId) ?? {
      project_id: row.project_id ?? null,
      total_memories: 0,
      missing_utility_score: 0,
      missing_confidence_score: 0,
      has_expiry: 0,
      risky_low_signal: 0,
      short_summary: 0,
      suppression_candidate: 0,
      artifact_expiry_candidate: 0,
      latest_snapshot_at: null,
      latest_snapshot_at_jst: null,
      latest_memory_at: null,
      latest_memory_at_jst: null
    };
    entry.total_memories += 1;
    if (row.utility_score === null || row.utility_score === undefined) entry.missing_utility_score += 1;
    if (row.confidence_score === null || row.confidence_score === undefined) entry.missing_confidence_score += 1;
    if (row.expires_at !== null && row.expires_at !== undefined) entry.has_expiry += 1;
    if (assessment?.risky_low_signal) entry.risky_low_signal += 1;
    if (String(row.summary ?? "").length < 80) entry.short_summary += 1;
    if (assessment?.suppression_candidate) entry.suppression_candidate += 1;
    if (assessment?.artifact_expiry_candidate) entry.artifact_expiry_candidate += 1;
    const createdAt = normalizeTimestamp(row.created_at);
    if (createdAt !== null && (entry.latest_memory_at === null || createdAt > entry.latest_memory_at)) {
      entry.latest_memory_at = createdAt;
      entry.latest_memory_at_jst = formatJst(createdAt);
    }
    const tags = String(row.tags_json ?? "");
    if (createdAt !== null && tags.includes('"project-current-state"') && (entry.latest_snapshot_at === null || createdAt > entry.latest_snapshot_at)) {
      entry.latest_snapshot_at = createdAt;
      entry.latest_snapshot_at_jst = formatJst(createdAt);
    }
    byProject.set(projectId, entry);
  }

  const entries = [...byProject.values()].sort(
    (left, right) =>
      right.missing_utility_score + right.missing_confidence_score - (left.missing_utility_score + left.missing_confidence_score) ||
      right.risky_low_signal - left.risky_low_signal ||
      right.total_memories - left.total_memories ||
      String(left.project_id ?? "").localeCompare(String(right.project_id ?? ""))
  );
  const repoStates = await Promise.all(entries.map((entry) => inspectProjectRepo(entry.project_id)));
  const now = Date.now();
  return entries.map((entry, index) => {
    const repo = repoStates[index];
    const mappingWarning =
      repo.repo_state === "missing" || repo.repo_state === "non-git" || (repo.repo_state === "git" && (repo.dirty_count ?? 0) > 0);
    return {
      ...entry,
      snapshot_age_days: entry.latest_snapshot_at ? Number(((now - entry.latest_snapshot_at) / (24 * 60 * 60 * 1000)).toFixed(1)) : null,
      mapping_warning: mappingWarning,
      repo
    };
  });
}

async function buildSnapshot(options, data) {
  const memorySummaryRow = data.memorySummary[0] ?? {};
  const threadSummaryRow = data.threadSummary[0] ?? {};
  const stageRows = data.memoryStages ?? [];
  const qualityRows = data.memoryQuality ?? [];
  const latestRows = data.memoryStageLatest ?? [];
  const qualityAssessments = qualityRows.map((row) => assessMemoryUsefulness(row));
  const projectHealth = await buildProjectHealth(qualityRows, qualityAssessments);
  const quality = {
    short_summary_lt80: qualityRows.filter((row) => String(row.summary ?? "").length < 80).length,
    very_short_summary_lt60: qualityRows.filter((row) => String(row.summary ?? "").length < 60).length,
    missing_utility_score: qualityRows.filter((row) => row.utility_score === null || row.utility_score === undefined).length,
    missing_confidence_score: qualityRows.filter((row) => row.confidence_score === null || row.confidence_score === undefined).length,
    has_utility: qualityRows.filter((row) => row.utility_score !== null && row.utility_score !== undefined).length,
    has_confidence: qualityRows.filter((row) => row.confidence_score !== null && row.confidence_score !== undefined).length,
    has_expiry: qualityRows.filter((row) => row.expires_at !== null && row.expires_at !== undefined).length,
    has_last_accessed: qualityRows.filter((row) => row.last_accessed_at !== null && row.last_accessed_at !== undefined).length,
    risky_low_signal: qualityAssessments.filter((item) => item.risky_low_signal).length,
    suppression_candidate: qualityAssessments.filter((item) => item.suppression_candidate).length,
    artifact_expiry_candidate: qualityAssessments.filter((item) => item.artifact_expiry_candidate).length,
    avg_utility_score:
      qualityRows.filter((row) => typeof row.utility_score === "number").length > 0
        ? Number(
            (
              qualityRows
                .filter((row) => typeof row.utility_score === "number")
                .reduce((sum, row) => sum + Number(row.utility_score), 0) /
              qualityRows.filter((row) => typeof row.utility_score === "number").length
            ).toFixed(3)
          )
        : null,
    avg_confidence_score:
      qualityRows.filter((row) => typeof row.confidence_score === "number").length > 0
        ? Number(
            (
              qualityRows
                .filter((row) => typeof row.confidence_score === "number")
                .reduce((sum, row) => sum + Number(row.confidence_score), 0) /
              qualityRows.filter((row) => typeof row.confidence_score === "number").length
            ).toFixed(3)
          )
        : null
  };
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
      quality,
      project_health: projectHealth,
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
  console.log("- quality:");
  console.log(`  - short_summary_lt80: ${memories.quality.short_summary_lt80}`);
  console.log(`  - very_short_summary_lt60: ${memories.quality.very_short_summary_lt60}`);
  console.log(`  - has_utility: ${memories.quality.has_utility} missing=${memories.quality.missing_utility_score}`);
  console.log(`  - has_confidence: ${memories.quality.has_confidence} missing=${memories.quality.missing_confidence_score}`);
  console.log(`  - has_expiry: ${memories.quality.has_expiry}`);
  console.log(`  - has_last_accessed: ${memories.quality.has_last_accessed}`);
  console.log(`  - risky_low_signal: ${memories.quality.risky_low_signal}`);
  console.log(`  - suppression_candidate: ${memories.quality.suppression_candidate}`);
  console.log(`  - artifact_expiry_candidate: ${memories.quality.artifact_expiry_candidate}`);
  console.log("");
  console.log("Project health");
  for (const project of memories.project_health.slice(0, 20)) {
    const projectLabel = project.project_id ?? "(none)";
    const repo = project.repo ?? {};
    const repoBits =
      repo.repo_state === "git"
        ? `repo=git branch=${repo.branch ?? "n/a"} dirty=${repo.dirty_count ?? "n/a"} docs=${repo.docs_count ?? 0}`
        : `repo=${repo.repo_state ?? "unknown"} docs=${repo.docs_count ?? 0}`;
    console.log(
      `- ${projectLabel}: total=${project.total_memories} missing_score=${project.missing_utility_score}/${project.missing_confidence_score} expiry=${project.has_expiry} short_summary=${project.short_summary} low_signal=${project.risky_low_signal} suppress=${project.suppression_candidate} artifact_expiry=${project.artifact_expiry_candidate} snapshot_age_days=${project.snapshot_age_days ?? "n/a"} mapping_warning=${project.mapping_warning ? "yes" : "no"} latest=${project.latest_memory_at_jst ?? "n/a"} ${repoBits}`
    );
  }
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

  const snapshot = await buildSnapshot(options, data);
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
