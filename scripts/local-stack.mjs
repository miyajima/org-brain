#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, chmod, mkdir, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, ".local/production-dump/local-state");
const config = path.join(root, "apps/api-gateway/wrangler.local.toml");
const wrangler = path.join(root, "apps/api-gateway/node_modules/.bin/wrangler");

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`)));
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function pathExists(value) {
  try { await access(value); return true; } catch { return false; }
}

async function localMigrationState(expectedCount) {
  if (!(await pathExists(stateDir))) return { applied: 0, expected: expectedCount, latest: null };
  const d1Directory = path.join(stateDir, "v3/d1/miniflare-D1DatabaseObject");
  const files = await readdir(d1Directory).catch(() => []);
  const databaseName = files.find((name) => /^[a-f0-9]+\.sqlite$/u.test(name));
  if (!databaseName) return { applied: 0, expected: expectedCount, latest: null };
  const database = new DatabaseSync(path.join(d1Directory, databaseName), { readOnly: true });
  try {
    const table = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type=? AND name=?").get("table", "d1_migrations");
    if (Number(table?.count ?? 0) === 0) return { applied: 0, expected: expectedCount, latest: null };
    const row = database.prepare("SELECT COUNT(*) AS applied, MAX(name) AS latest FROM d1_migrations").get();
    return { applied: Number(row?.applied ?? 0), expected: expectedCount, latest: row?.latest ?? null };
  } finally {
    database.close();
  }
}

async function checks() {
  const [apiPort, consolePort, wranglerPresent, statePresent, devVarsPresent, pnpmVersion, migrationFiles] = await Promise.all([
    portAvailable(8787),
    portAvailable(4321),
    pathExists(wrangler),
    pathExists(stateDir),
    pathExists(path.join(root, "apps/api-gateway/.dev.vars")),
    run("pnpm", ["--version"], { capture: true }).then((result) => result.stdout.trim()).catch(() => null),
    readdir(path.join(root, "migrations")).then((names) => names.filter((name) => /^\d{4}_.+\.sql$/u.test(name)))
  ]);
  const [migrationState, stateStat] = await Promise.all([
    localMigrationState(migrationFiles.length),
    statePresent ? stat(stateDir) : null
  ]);
  const [major, minor] = process.versions.node.split(".").map(Number);
  return [
    { id: "node", ok: major > 22 || (major === 22 && minor >= 13), value: process.versions.node },
    { id: "pnpm", ok: Boolean(pnpmVersion), value: pnpmVersion ?? "not found" },
    { id: "wrangler", ok: wranglerPresent, value: wrangler },
    { id: "api-dev-vars", ok: devVarsPresent, value: devVarsPresent ? "apps/api-gateway/.dev.vars" : "missing", recovery: "cp apps/api-gateway/.dev.vars.example apps/api-gateway/.dev.vars" },
    { id: "migrations", ok: migrationFiles.length > 0, value: `${migrationFiles.length} files` },
    { id: "migration-state", ok: migrationState.applied === migrationState.expected, value: `${migrationState.applied}/${migrationState.expected} applied${migrationState.latest ? `; latest ${migrationState.latest}` : ""}`, recovery: "pnpm local:prepare" },
    { id: "local-state", ok: statePresent, severity: "warning", value: statePresent ? stateDir : "not created yet", mode: stateStat ? `0${(stateStat.mode & 0o777).toString(8)}` : null },
    { id: "backup", ok: statePresent, severity: "warning", value: "Stop local:start, then back up the complete state directory before restoration or migration." },
    { id: "api-port", ok: apiPort, value: apiPort ? "8787 available" : "8787 already in use" },
    { id: "console-port", ok: consolePort, value: consolePort ? "4321 available" : "4321 already in use" }
  ];
}

async function prepare() {
  const startedAt = Date.now();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const migrationFiles = await readdir(path.join(root, "migrations"));
  await run(wrangler, [
    "d1", "migrations", "apply", "open-brain", "--local",
    "--persist-to", stateDir,
    "--config", config
  ], { capture: true });
  return {
    ok: true,
    state_dir: stateDir,
    migrations: migrationFiles.filter((name) => /^\d{4}_.+\.sql$/u.test(name)).length,
    duration_ms: Date.now() - startedAt
  };
}

async function waitFor(url, init = {}, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500) return response.status;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become ready: ${lastError}`);
}

async function start() {
  const preflight = await checks();
  const errors = preflight.filter((item) => !item.ok && item.severity !== "warning" && item.id !== "migration-state");
  if (errors.length) throw new Error(`local preflight failed: ${errors.map((item) => `${item.id}=${item.value}`).join(", ")}`);
  const prepared = await prepare();
  const postflight = await checks();
  const postflightErrors = postflight.filter((item) => !item.ok && item.severity !== "warning");
  if (postflightErrors.length) throw new Error(`local prepare failed: ${postflightErrors.map((item) => `${item.id}=${item.value}`).join(", ")}`);
  const children = [
    spawn("pnpm", ["run", "local:api"], { cwd: root, env: process.env, stdio: "inherit", shell: false }),
    spawn("pnpm", ["run", "local:console"], { cwd: root, env: process.env, stdio: "inherit", shell: false })
  ];
  const stop = () => {
    for (const child of children) if (!child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitFor("http://127.0.0.1:8787/v1/organization?tenant_id=default", {
      headers: { "x-api-key": "dev-org-brain-api-key" }
    });
    await waitFor("http://127.0.0.1:4321/");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      api_url: "http://127.0.0.1:8787",
      console_url: "http://127.0.0.1:4321",
      state_dir: stateDir,
      migrations: prepared.migrations,
      next_steps: [
        "Open http://127.0.0.1:4321/?tenant_id=default&lang=ja",
        "Capture through POST /v1/memories/capture with x-api-key: dev-org-brain-api-key",
        "Verify through POST /v1/memories/retrieve-context",
        "For private Codex memory: pnpm exec orgbrain init && pnpm exec orgbrain connector setup codex --execute"
      ]
    }, null, 2)}\n`);
    await Promise.race(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
  } finally {
    stop();
  }
}

const command = process.argv[2] ?? "start";
if (command === "doctor") {
  const result = await checks();
  process.stdout.write(`${JSON.stringify({
    ok: result.every((item) => item.ok || item.severity === "warning"),
    state_dir: stateDir,
    checks: result
  }, null, 2)}\n`);
} else if (command === "prepare") {
  process.stdout.write(`${JSON.stringify(await prepare(), null, 2)}\n`);
} else if (command === "start") {
  await start();
} else {
  throw new Error(`unknown local stack command: ${command}`);
}
