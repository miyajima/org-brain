#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "../apps/console/node_modules/@playwright/test/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "apps/api-gateway/node_modules/.bin/wrangler");
const CONFIG = path.join(ROOT, "apps/api-gateway/wrangler.local.toml");
const ASTRO = path.join(ROOT, "apps/console/node_modules/.bin/astro");
const API_KEY = "dev-org-brain-api-key";
const GROUP_ID = "01ADMINSMOKEGROUP0000000000";
const MEMBER = "user:admin-smoke-member";

function sanitizeDiagnostic(value) {
  return String(value)
    .replaceAll(API_KEY, "[REDACTED_API_KEY]")
    .replace(/\/(?:Users|private|tmp)\/[^\s:]+/gu, "[REDACTED_PATH]")
    .replace(/\s+/gu, " ");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} exited ${code}: ${sanitizeDiagnostic(stderr).slice(-500)}`)));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function spawnObserved(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  const append = (key, chunk) => {
    output[key] = `${output[key]}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.smokeOutput = output;
  return child;
}

function startupFailure(child, label) {
  const output = child?.smokeOutput ?? {};
  const tail = sanitizeDiagnostic(output.stderr || output.stdout || "no process output").slice(-800);
  return `${label}_exited:${child?.exitCode ?? child?.signalCode ?? "unknown"}:${tail}`;
}

async function waitFor(url, { child, label, headers = {}, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(startupFailure(child, label));
    try { const response = await fetch(url, { headers }); if (response.status >= 200 && response.status < 500) return; } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server_not_ready:${label}:${url}:${startupFailure(child, label)}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function assertPortGone(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); } catch { return true; }
  throw new Error(`process_or_port_still_active:${url}`);
}

async function apiJson(apiBase, pathname) {
  const response = await fetch(`${apiBase}${pathname}`, { headers: { "x-api-key": API_KEY, accept: "application/json" } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`api_check_failed:${pathname}:${response.status}`);
  return payload;
}

export async function runAdminRealSmoke() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-admin-real-"));
  await chmod(directory, 0o700);
  const stateDir = path.join(directory, "d1");
  const seedFile = path.join(directory, "seed.sql");
  const apiPort = await freePort();
  const consolePort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const consoleBase = `http://127.0.0.1:${consolePort}`;
  const childEnv = { ...process.env, WRANGLER_LOG_PATH: path.join(directory, "wrangler-logs") };
  let apiProcess;
  let consoleProcess;
  let browser;
  try {
    await run(WRANGLER, ["d1", "migrations", "apply", "open-brain", "--local", "--persist-to", stateDir, "--config", CONFIG], { env: childEnv });
    const now = Date.now();
    await writeFile(seedFile, `
INSERT INTO user_profiles(tenant_id,principal,display_name,full_name,email,email_verified,status,provision_source,full_name_source,created_at,updated_at)
VALUES('default','${MEMBER}','Smoke User','Smoke User','smoke@example.invalid',1,'active','legacy','legacy',${now},${now});
INSERT INTO groups(id,tenant_id,slug,name,description,created_by_principal,created_at,updated_at,deleted_at,source,external_id)
VALUES('${GROUP_ID}','default','admin-smoke','Admin smoke group','Disposable UX smoke','user:local-dev',${now},${now},NULL,'local',NULL);
INSERT INTO group_members(tenant_id,group_id,principal,role,created_at,updated_at,source)
VALUES('default','${GROUP_ID}','user:local-dev','owner',${now},${now},'local'),
      ('default','${GROUP_ID}','${MEMBER}','member',${now},${now},'local');
INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,project_id,group_ids_json,restricted_subjects_json,storage_location,policy_version,created_by_principal,created_at,updated_at)
VALUES('admin-smoke-policy','default','memory','admin-smoke-memory','group','user:local-dev',NULL,'["${GROUP_ID}"]','[]','d1',1,'user:local-dev',${now},${now});
`, { mode: 0o600 });
    await run(WRANGLER, ["d1", "execute", "open-brain", "--local", "--persist-to", stateDir, "--config", CONFIG, "--file", seedFile], { env: childEnv });

    apiProcess = spawnObserved(WRANGLER, ["dev", "--host", "127.0.0.1", "--port", String(apiPort), "--persist-to", stateDir, "--config", CONFIG], { cwd: ROOT, env: childEnv });
    await waitFor(`${apiBase}/v1/organization?tenant_id=default`, {
      child: apiProcess,
      label: "api",
      headers: { "x-api-key": API_KEY, accept: "application/json" }
    });
    consoleProcess = spawnObserved(ASTRO, ["dev", "--host", "127.0.0.1", "--port", String(consolePort)], {
      cwd: path.join(ROOT, "apps/console"),
      env: { ...childEnv, ORGBRAIN_CONSOLE_RUNTIME: "node", API_BASE_URL: apiBase, INTERNAL_API_KEY: API_KEY,
        ACCESS_JWT_REQUIRED: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true", INSIGHTS_UI_MODE: "on", MEMORY_QUALITY_UI_MODE: "on" }
    });
    await waitFor(`${consoleBase}/groups/${GROUP_ID}?tenant_id=default`, { child: consoleProcess, label: "console" });

    const before = await apiJson(apiBase, `/v1/groups/${GROUP_ID}/members/${encodeURIComponent(MEMBER)}/impact?tenant_id=default`);
    if (before.data?.impact?.lost_count !== 1 || !before.data?.impact_digest) throw new Error("impact_preview_not_proven");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${consoleBase}/groups/${GROUP_ID}?tenant_id=default`);
    const remove = page.getByRole("button", { name: "Remove Smoke User from group" });
    await remove.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Remove Smoke User from group");
      return button && !button.hasAttribute("disabled");
    });
    await remove.click();
    await page.getByRole("button", { name: "Apply change" }).click();
    await page.getByText("Membership updated", { exact: true }).waitFor();

    const group = await apiJson(apiBase, `/v1/groups/${GROUP_ID}?tenant_id=default`);
    if (group.data.members.some((member) => member.principal === MEMBER)) throw new Error("membership_still_present_after_ui_removal");
    await browser.close();
    browser = null;
    await stop(consoleProcess);
    await stop(apiProcess);
    consoleProcess = null;
    apiProcess = null;

    const query = await run(WRANGLER, ["d1", "execute", "open-brain", "--local", "--persist-to", stateDir, "--config", CONFIG,
      "--command", `SELECT COUNT(*) AS count FROM group_members WHERE tenant_id='default' AND group_id='${GROUP_ID}' AND principal='${MEMBER}'`, "--json"], { env: childEnv });
    const rows = JSON.parse(query.stdout);
    const count = Number(rows?.[0]?.results?.[0]?.count ?? -1);
    if (count !== 0) throw new Error("d1_membership_readback_failed");
    await Promise.all([assertPortGone(apiBase), assertPortGone(consoleBase)]);
    return { status: "passed", synthetic_tenant: "default", impact_lost_count: 1, membership_count_after: count, ports_released: true, temporary_d1_removed: true };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stop(consoleProcess);
    await stop(apiProcess);
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const report = await runAdminRealSmoke();
  process.stdout.write(`${JSON.stringify({ ok: report.status === "passed", report })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
