#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { assessMemoryUsefulness } from "./lib/memory-quality.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const apiGatewayDir = path.resolve(repoRoot, "apps/api-gateway");

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
  console.log(`Org Brain project current-state snapshot

Usage:
  pnpm memories:project-snapshot -- --tenant default --remote [--apply] [--projects a,b]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --local                Query local D1
  --preview              Query preview D1
  --remote               Query remote D1 (default)
  --projects <csv>       Limit to project ids
  --apply                Upsert snapshot memories; default is dry-run
  --json                 Emit JSON
`);
}

function parseArgs(argv) {
  const options = {
    tenant: "default",
    database: "open-brain",
    location: "remote",
    projects: null,
    apply: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--local" || arg === "--preview" || arg === "--remote") {
      options.location = arg.slice(2);
      continue;
    }
    if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      options.tenant = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      continue;
    }
    if (arg === "--database" || arg.startsWith("--database=")) {
      options.database = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      continue;
    }
    if (arg === "--projects" || arg.startsWith("--projects=")) {
      const raw = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      options.projects = raw.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function sqlNullable(value) {
  return value === null || value === undefined ? "NULL" : sqlString(value);
}

function resolveProjectRoot(projectId) {
  if (!projectId) return null;
  const configured = configuredProjectRootOverrides();
  if (configured.has(projectId)) return configured.get(projectId);
  if (PROJECT_ROOT_OVERRIDES.has(projectId)) return PROJECT_ROOT_OVERRIDES.get(projectId);
  return `/Users/miya/projects/${projectId}`;
}

async function runD1(options, command) {
  const args = ["wrangler", "d1", "execute", options.database, `--${options.location}`, "--json", "--command", command];
  const { stdout, stderr } = await execFileAsync("pnpm", args, {
    cwd: apiGatewayDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) throw new Error(`Wrangler query failed: ${JSON.stringify(first)}\n${stderr}`);
  return first.results ?? [];
}

async function inspectRepo(projectId) {
  const root = resolveProjectRoot(projectId);
  const docs = root
    ? ["README.md", "AGENTS.md", "CLAUDE.md", "docs/SPEC.md", "docs/SYSTEM_DESIGN.md", "docs/DESIGN.md"].filter((file) => existsSync(path.resolve(root, file)))
    : [];
  if (!root || !existsSync(root)) {
    return { root, repo_state: "missing", branch: null, dirty_count: null, dirty_files: [], docs };
  }
  try {
    const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", root, "status", "--short"], { encoding: "utf8", maxBuffer: 1024 * 1024 })
    ]);
    const dirtyFiles = statusOut.split(/\r?\n/).filter(Boolean);
    return {
      root,
      repo_state: "git",
      branch: branchOut.trim(),
      dirty_count: dirtyFiles.length,
      dirty_files: dirtyFiles.slice(0, 12),
      docs
    };
  } catch {
    return { root, repo_state: "non-git", branch: null, dirty_count: null, dirty_files: [], docs };
  }
}

function latestForProject(rows, projectId) {
  return rows
    .filter((row) => row.project_id === projectId)
    .sort((left, right) => Number(right.created_at ?? 0) - Number(left.created_at ?? 0))[0] ?? null;
}

function buildContent(options, projectId, rows, repo) {
  const latest = latestForProject(rows, projectId);
  const projectRows = rows.filter((row) => row.project_id === projectId);
  const missingUtility = projectRows.filter((row) => row.utility_score === null || row.utility_score === undefined).length;
  const missingConfidence = projectRows.filter((row) => row.confidence_score === null || row.confidence_score === undefined).length;
  const unresolved = [];
  if (missingUtility || missingConfidence) unresolved.push(`quality metadata missing utility=${missingUtility} confidence=${missingConfidence}`);
  if (repo.repo_state !== "git") unresolved.push(`repo mapping is ${repo.repo_state}`);
  if (repo.repo_state === "git" && repo.dirty_count > 0) unresolved.push(`local dirty files=${repo.dirty_count}`);
  if (repo.docs.length === 0) unresolved.push("no standard docs detected");

  return [
    "# Project Current-State Snapshot",
    "",
    `- Tenant: ${options.tenant}`,
    `- Project: ${projectId}`,
    `- RepoRoot: ${repo.root ?? "n/a"}`,
    `- RepoState: ${repo.repo_state}`,
    `- Branch: ${repo.branch ?? "n/a"}`,
    `- DirtyCount: ${repo.dirty_count ?? "n/a"}`,
    `- Docs: ${repo.docs.length > 0 ? repo.docs.join(", ") : "none"}`,
    `- MemoryCount: ${projectRows.length}`,
    `- LatestMemoryAt: ${latest?.created_at ? new Date(Number(latest.created_at)).toISOString() : "n/a"}`,
    `- LatestImplementationState: ${latest?.summary ?? "n/a"}`,
    `- LastTestDeployState: ${projectRows.find((row) => /(?:test|deploy|smoke|pnpm|wrangler)/i.test(`${row.summary ?? ""}\n${row.content ?? ""}`))?.summary ?? "n/a"}`,
    `- UnresolvedRequirements: ${unresolved.length > 0 ? unresolved.join("; ") : "none observed in lightweight scan"}`,
    "",
    "## Dirty Files",
    ...(repo.dirty_files.length > 0 ? repo.dirty_files.map((file) => `- ${file}`) : ["- none"])
  ].join("\n");
}

async function buildSnapshots(options) {
  const rows = await runD1(
    options,
    `SELECT id, project_id, source, summary, content, tags_json, created_at, utility_score, confidence_score, expires_at
       FROM memories
      WHERE tenant_id = ${sqlString(options.tenant)}
      ORDER BY created_at DESC
      LIMIT 5000;`
  );
  const projectIds = options.projects ?? [...new Set(rows.map((row) => row.project_id).filter(Boolean))].sort();
  const snapshots = [];
  for (const projectId of projectIds) {
    const repo = await inspectRepo(projectId);
    const content = buildContent(options, projectId, rows, repo);
    const tags = ["org-brain", "maintenance", "canonical-memory", "project-current-state", "project-health", "quality-v2", projectId];
    const assessment = assessMemoryUsefulness({ project_id: projectId, source: "org-brain", summary: `${projectId} current-state snapshot`, content, tags });
    snapshots.push({
      id: `mem_project_state_${options.tenant}_${projectId}`.replace(/[^A-Za-z0-9_]/g, "_"),
      external_key: `org-brain:project-current-state:${options.tenant}:${projectId}`,
      project_id: projectId,
      source: "org-brain",
      summary: assessment.summary,
      content,
      tags,
      confidence_score: assessment.confidence_score,
      utility_score: assessment.utility_score,
      expires_at: assessment.expires_at,
      repo
    });
  }
  return snapshots;
}

function buildApplySql(options, snapshots) {
  const now = Date.now();
  const statements = [];
  for (const snapshot of snapshots) {
    const tagsJson = JSON.stringify(snapshot.tags);
    statements.push(`
      UPDATE memories
         SET project_id = ${sqlString(snapshot.project_id)},
             content = ${sqlString(snapshot.content)},
             summary = ${sqlString(snapshot.summary)},
             tags_json = ${sqlString(tagsJson)},
             source = 'org-brain',
             created_at = ${now},
             kind = 'semantic',
             lifecycle_state = 'active',
             scope_type = 'project',
             scope_key = ${sqlString(snapshot.project_id)},
             actor_type = 'system',
             actor_id = 'project-current-state-snapshot',
             confidence_score = ${snapshot.confidence_score},
             utility_score = ${snapshot.utility_score},
             canonical_key = ${sqlString(snapshot.external_key)},
             consolidated_at = ${now},
             revised_at = ${now},
             expires_at = ${snapshot.expires_at ?? "NULL"}
       WHERE tenant_id = ${sqlString(options.tenant)}
         AND external_key = ${sqlString(snapshot.external_key)};
      INSERT INTO memories(
        id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at,
        kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score,
        canonical_key, current_version, consolidated_at, revised_at, expires_at
      )
      SELECT
        ${sqlString(snapshot.id)}, ${sqlString(options.tenant)}, ${sqlString(snapshot.project_id)},
        ${sqlString(snapshot.content)}, ${sqlString(snapshot.summary)}, ${sqlString(tagsJson)}, 'org-brain',
        ${sqlString(snapshot.external_key)}, ${now}, 'semantic', 'active', 'project', ${sqlString(snapshot.project_id)},
        'system', 'project-current-state-snapshot', ${snapshot.confidence_score}, ${snapshot.utility_score},
        ${sqlString(snapshot.external_key)}, 1, ${now}, ${now}, ${snapshot.expires_at ?? "NULL"}
      WHERE NOT EXISTS (
        SELECT 1 FROM memories
         WHERE tenant_id = ${sqlString(options.tenant)}
           AND external_key = ${sqlString(snapshot.external_key)}
      );
      DELETE FROM memories_fts
       WHERE tenant_id = ${sqlString(options.tenant)}
         AND memory_id IN (
           SELECT id FROM memories
            WHERE tenant_id = ${sqlString(options.tenant)}
              AND external_key = ${sqlString(snapshot.external_key)}
         );
      INSERT INTO memories_fts(memory_id, tenant_id, content)
        SELECT id, tenant_id, ${sqlString(`${snapshot.summary}\n${snapshot.content}`)}
          FROM memories
         WHERE tenant_id = ${sqlString(options.tenant)}
           AND external_key = ${sqlString(snapshot.external_key)};
    `);
  }
  return statements.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const snapshots = await buildSnapshots(options);
  if (options.apply && snapshots.length > 0) {
    await runD1(options, buildApplySql(options, snapshots));
  }
  const result = { applied: options.apply, count: snapshots.length, snapshots };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`project current-state snapshots: ${snapshots.length} (${options.apply ? "applied" : "dry-run"})`);
    for (const snapshot of snapshots) {
      console.log(`- ${snapshot.project_id}: ${snapshot.summary} repo=${snapshot.repo.repo_state} dirty=${snapshot.repo.dirty_count ?? "n/a"}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
