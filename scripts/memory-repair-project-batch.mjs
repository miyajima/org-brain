#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { runD1Query, sqlString } from "../packages/benchmarks/src/metrics-common.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const REPAIR_SCRIPT = resolve(ROOT, "scripts/memory-repair.mjs");
const DEFAULT_MAX_SCOPES = 10;

function parseArgs(argv) {
  const options = {
    tenant: "default",
    outputRoot: null,
    scopeState: null,
    apply: false,
    resume: false,
    maxScopes: DEFAULT_MAX_SCOPES,
    excludeProjects: new Set(["org-brain"])
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--resume") { options.resume = true; continue; }
    const match = /^(--tenant|--output-root|--scope-state|--max-scopes|--exclude-project)(?:=(.*))?$/u.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`${match[1]} requires a value`);
    if (match[1] === "--tenant") options.tenant = value;
    if (match[1] === "--output-root") options.outputRoot = resolve(value);
    if (match[1] === "--scope-state") options.scopeState = resolve(value);
    if (match[1] === "--max-scopes") options.maxScopes = Number.parseInt(value, 10);
    if (match[1] === "--exclude-project") options.excludeProjects.add(value);
  }
  if (!options.outputRoot) throw new Error("--output-root is required");
  if (!Number.isInteger(options.maxScopes) || options.maxScopes < 1 || options.maxScopes > 100) {
    throw new Error("--max-scopes must be between 1 and 100");
  }
  if (options.resume && !options.apply) throw new Error("--resume requires --apply");
  if (options.scopeState && options.resume) throw new Error("--scope-state cannot be combined with --resume");
  return options;
}

function scopeKey(projectId) {
  return projectId ?? "__NULL_PROJECT__";
}

function scopeHash(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function discoverScopes(options) {
  const rows = await runD1Query({ location: "remote", database: "open-brain" }, `
    SELECT project_id, COUNT(*) AS row_count,
           SUM(CASE WHEN lifecycle_state IS NULL OR lifecycle_state != 'suppressed' THEN 1 ELSE 0 END) AS active_count
    FROM memories
    WHERE tenant_id = ${sqlString(options.tenant)}
    GROUP BY project_id
    HAVING active_count > 0
    ORDER BY active_count DESC, project_id;
  `);
  return rows
    .map((row) => ({
      project_id: row.project_id == null ? null : String(row.project_id),
      row_count: Number(row.row_count ?? 0),
      active_count: Number(row.active_count ?? 0)
    }))
    .filter((scope) => scope.project_id === null || !options.excludeProjects.has(scope.project_id));
}

async function runRepair(options, scope, scopeDirectory) {
  const reportPath = resolve(scopeDirectory, "memory-repair.report.json");
  const args = [REPAIR_SCRIPT, "--remote", "--tenant", options.tenant, "--page-size", "250"];
  if (scope.project_id === null) args.push("--project-null");
  else args.push("--project", scope.project_id);
  if (options.apply) {
    args.push("--apply", "--output-dir", scopeDirectory);
    if (existsSync(resolve(scopeDirectory, "memory-repair.checkpoint.json")) &&
        existsSync(resolve(scopeDirectory, "memory-repair.manifest.json")) &&
        existsSync(resolve(scopeDirectory, "memory-repair.plan.json"))) {
      args.push("--resume");
    }
  }
  else args.push("--dry-run", "--report", reportPath);
  try {
    await execFileAsync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "repair_child_failed")
      .replace(/\s+/gu, " ")
      .slice(0, 400);
    return { passed: false, reason_code: "repair_child_failed", detail };
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  return {
    passed: true,
    scanned_count: report.scanned_count,
    decision_scanned_count: report.decision_scanned_count,
    applied_action_count: report.applied_action_count,
    stats: report.stats,
    physical_delete_count: report.physical_delete_count
  };
}

function emptyAggregate() {
  return {
    scanned_count: 0,
    decision_scanned_count: 0,
    applied_action_count: 0,
    derive_count: 0,
    update_count: 0,
    suppress_count: 0,
    credential_count: 0,
    physical_delete_count: 0
  };
}

function addAggregate(aggregate, result) {
  aggregate.scanned_count += Number(result.scanned_count ?? 0);
  aggregate.decision_scanned_count += Number(result.decision_scanned_count ?? 0);
  aggregate.applied_action_count += Number(result.applied_action_count ?? 0);
  for (const key of ["derive_count", "update_count", "suppress_count", "credential_count"]) {
    aggregate[key] += Number(result.stats?.[key] ?? 0);
  }
  aggregate.physical_delete_count += Number(result.physical_delete_count ?? 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  await chmod(options.outputRoot, 0o700);
  const statePath = resolve(options.outputRoot, "batch-state.json");
  let state;
  if (options.resume) {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.tenant_id !== options.tenant || state.mode !== (options.apply ? "apply" : "dry-run")) {
      throw new Error("batch_state_target_mismatch");
    }
  } else {
    let sourceState = null;
    if (options.scopeState) {
      sourceState = JSON.parse(await readFile(options.scopeState, "utf8"));
      if (sourceState.tenant_id !== options.tenant || sourceState.mode !== "apply") {
        throw new Error("scope_state_target_mismatch");
      }
    }
    const sourceCompleted = new Set(sourceState?.completed_scope_keys ?? []);
    const scopes = sourceState
      ? sourceState.scopes.filter((scope) => !sourceCompleted.has(scopeKey(scope.project_id)))
      : await discoverScopes(options);
    state = {
      version: 1,
      tenant_id: options.tenant,
      mode: options.apply ? "apply" : "dry-run",
      physical_delete_count: 0,
      scopes,
      completed_scope_keys: [],
      failed_scope_key: null,
      results: []
    };
    await writePrivateJson(statePath, state);
  }

  const completed = new Set(state.completed_scope_keys);
  const pending = state.scopes.filter((scope) => !completed.has(scopeKey(scope.project_id)));
  const selected = pending.slice(0, options.maxScopes);
  const aggregate = emptyAggregate();
  for (const scope of selected) {
    const key = scopeKey(scope.project_id);
    const directory = resolve(options.outputRoot, `scope-${scopeHash(key)}`);
    const result = await runRepair(options, scope, directory);
    state.results.push({ scope_key: key, scope_hash: scopeHash(key), ...result });
    if (!result.passed) {
      state.failed_scope_key = key;
      await writePrivateJson(statePath, state);
      throw new Error("repair_batch_scope_failed");
    }
    state.completed_scope_keys.push(key);
    state.physical_delete_count += Number(result.physical_delete_count ?? 0);
    addAggregate(aggregate, result);
    await writePrivateJson(statePath, state);
  }
  console.log(JSON.stringify({
    mode: state.mode,
    tenant_id: state.tenant_id,
    scopes_processed: selected.length,
    scopes_remaining: state.scopes.length - state.completed_scope_keys.length,
    aggregate,
    physical_delete_count: state.physical_delete_count
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, reason_code: error?.message ?? "repair_batch_failed" }));
  process.exitCode = 1;
});
