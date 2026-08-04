#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadWorkspaceConfig,
  normalizeWorkspaceRoot,
  saveWorkspaceConfig
} from "./lib/workspace-config.mjs";

const SUPPORTED = new Set(["codex", "claude", "opencode", "openclaw"]);
const MODULE_PATH = fileURLToPath(import.meta.url);
const LOCAL_CLI_PATH = path.basename(MODULE_PATH) === "orgbrain.mjs"
  ? MODULE_PATH
  : fileURLToPath(new URL("./local-memory.mjs", import.meta.url));
const LOCAL_ONLY_ENV = {
  ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
  ORGBRAIN_ENABLE_ORG_SHARING: "false",
  ORGBRAIN_LOCAL_HOOK_CAPTURE: "true"
};

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

function parseEnv(raw) {
  const values = new Map();
  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function mergeLocalOnlyEnv(raw, dbPath, force = false) {
  const desired = { ...LOCAL_ONLY_ENV, ORGBRAIN_LOCAL_DB: dbPath };
  const current = parseEnv(raw);
  for (const [key, value] of Object.entries(desired)) {
    if (current.has(key) && current.get(key) !== value && !force) {
      throw new Error(`${key} is already ${current.get(key)}; rerun with --force to replace it for local-only hooks`);
    }
  }
  const remaining = String(raw ?? "")
    .split(/\r?\n/u)
    .filter((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
      return !match || !Object.hasOwn(desired, match[1]);
    })
    .join("\n")
    .trimEnd();
  const managed = [
    "# OrgBrain local-only Codex hook configuration.",
    ...Object.entries(desired).map(([key, value]) => `${key}=${value}`)
  ].join("\n");
  return `${remaining ? `${remaining}\n\n` : ""}${managed}\n`;
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function backupExisting(file, suffix) {
  if (await readOptional(file) === null) return null;
  const backup = `${file}.pre-orgbrain-${suffix}`;
  await copyFile(file, backup);
  await chmod(backup, 0o600);
  return backup;
}

async function writePrivateFile(file, content) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staged = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(staged, 0o600);
    await rename(staged, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    throw error;
  }
}

function isOrgBrainHook(handler) {
  return typeof handler?.command === "string" && /\bhook codex-(?:context|stop)\b/u.test(handler.command);
}

function mergeCodexHooks(raw, handlers) {
  let config = {};
  if (raw?.trim()) {
    config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Codex hooks.json must contain a JSON object");
    }
  }
  config.description ??= "Codex lifecycle hooks.";
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error("Codex hooks.json hooks must be an object");
  }
  for (const [event, handler] of Object.entries(handlers)) {
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const preserved = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((candidate) => !isOrgBrainHook(candidate));
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...preserved, { hooks: [handler] }];
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function hookCommand(baseCommand, envFile, action, errorLog) {
  return [
    `ORGBRAIN_HOOK_ENV_FILES=${shellQuote(envFile)}`,
    ...baseCommand.map(shellQuote),
    "hook",
    action,
    `2>>${shellQuote(errorLog)}`
  ].join(" ");
}

export function codexMinimalHooksPlan(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const workspace = normalizeWorkspaceRoot(options.workspace || process.cwd());
  const projectId = options.projectId?.trim() || path.basename(workspace);
  const tenantId = options.tenantId?.trim() || null;
  const orgBrainConfig = path.join(home, ".config", "org-brain");
  const envFile = path.join(orgBrainConfig, "hooks.env");
  const workspacesFile = path.join(orgBrainConfig, "workspaces.json");
  const errorLog = path.join(orgBrainConfig, "hook-errors.log");
  const hooksFile = path.join(home, ".codex", "hooks.json");
  const dbPath = expandHome(options.dbPath || path.join(home, ".org-brain", "memory.sqlite"), home);
  const baseCommand = options.command?.trim()
    ? [options.command.trim()]
    : [process.execPath, "--no-warnings", LOCAL_CLI_PATH];
  const handlers = {
    UserPromptSubmit: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-context", errorLog),
      timeout: 3,
      statusMessage: "Checking local OrgBrain memory",
      additionalContextLimit: 400
    },
    Stop: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-stop", errorLog),
      timeout: 3,
      statusMessage: "Saving durable local OrgBrain memory"
    }
  };
  return {
    agent: "codex",
    mode: "minimal-hooks",
    local_only: true,
    llm_calls: 0,
    resident_process: false,
    workspace: { path: workspace, tenant_id: tenantId, project_id: projectId },
    files: { env: envFile, workspaces: workspacesFile, hooks: hooksFile, errors: errorLog, db: dbPath },
    handlers,
    trust_required: true,
    verify: ["codex", "doctor"]
  };
}

export async function installCodexMinimalHooks(plan, options = {}) {
  const suffix = new Date().toISOString().replaceAll(":", "-");
  const envRaw = await readOptional(plan.files.env);
  const hooksRaw = await readOptional(plan.files.hooks);
  const mergedEnv = mergeLocalOnlyEnv(envRaw, plan.files.db, options.force === true);
  const mergedHooks = mergeCodexHooks(hooksRaw, plan.handlers);
  const workspaces = await loadWorkspaceConfig(plan.files.workspaces);
  workspaces.workspaces[plan.workspace.path] = {
    tenant_id: plan.workspace.tenant_id,
    project_id: plan.workspace.project_id
  };
  await mkdir(path.dirname(plan.files.env), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plan.files.hooks), { recursive: true, mode: 0o700 });
  await writeFile(plan.files.errors, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await chmod(plan.files.errors, 0o600);
  const backups = (await Promise.all([
    backupExisting(plan.files.env, suffix),
    backupExisting(plan.files.workspaces, suffix),
    backupExisting(plan.files.hooks, suffix)
  ])).filter(Boolean);
  await writePrivateFile(plan.files.env, mergedEnv);
  await saveWorkspaceConfig(plan.files.workspaces, workspaces);
  await writePrivateFile(plan.files.hooks, mergedHooks);
  const { LocalMemoryStore } = await import("./lib/local-memory-store.mjs");
  await new LocalMemoryStore(plan.files.db).init();
  return {
    ok: true,
    installed: true,
    agent: "codex",
    mode: "minimal-hooks",
    files: plan.files,
    backups,
    trust_required: true,
    next_step: "Restart Codex, open /hooks, and trust the OrgBrain UserPromptSubmit and Stop hooks."
  };
}

export function connectorPlan(agent, options = {}) {
  if (!SUPPORTED.has(agent)) throw new Error(`connector must be one of ${[...SUPPORTED].join(", ")}`);
  const serverCommand = options.command?.trim() || "orgbrain";
  const scope = options.scope === "project" ? "project" : "user";
  if (agent === "codex") {
    return { agent, transport: "stdio", executable: "codex", args: ["mcp", "add", "orgbrain", "--", serverCommand, "mcp"], verify: ["codex", "mcp", "get", "orgbrain", "--json"], documentation: "https://developers.openai.com/codex/mcp/" };
  }
  if (agent === "claude") {
    return { agent, transport: "stdio", executable: "claude", args: ["mcp", "add", "orgbrain", "--scope", scope, "--", serverCommand, "mcp"], verify: ["claude", "mcp", "get", "orgbrain"], documentation: "https://docs.anthropic.com/en/docs/claude-code/mcp" };
  }
  if (agent === "opencode") {
    return { agent, transport: "stdio", executable: "opencode2", args: ["mcp", "add", "orgbrain", ...(scope === "user" ? ["--global"] : []), "--", serverCommand, "mcp"], verify: ["opencode2", "mcp", "list"], documentation: "https://opencode.ai/v2/docs/mcp-servers" };
  }
  return { agent, transport: "stdio", executable: null, args: null, verify: ["openclaw", "config", "validate"], config_merge: { mcp: { servers: { orgbrain: { transport: "stdio", command: serverCommand, args: ["mcp"] } } } }, documentation: "https://docs.openclaw.ai/cli/mcp" };
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${executable} ${args.join(" ")} exited ${code}`)));
  });
}

export async function runConnectorCommand(action, rest, args) {
  if (action !== "setup") throw new Error(`unknown connector command: ${action || "(missing)"}`);
  const agent = rest[0]?.toLowerCase();
  const mode = args.get("--mode", "mcp");
  if (mode === "minimal-hooks") {
    if (agent !== "codex") throw new Error("--mode minimal-hooks is currently supported only for codex");
    const maintenance = args.get("--maintenance", null);
    if (maintenance && maintenance !== "daily") throw new Error("--maintenance must be daily");
    const plan = codexMinimalHooksPlan({
      command: args.get("--command", null),
      workspace: args.get("--workspace", process.cwd()),
      projectId: args.get("--project-id", null),
      tenantId: args.get("--tenant-id", null),
      dbPath: args.get("--db", null)
    });
    if (maintenance === "daily") {
      const { personalMaintenancePlan } = await import("./personal-maintenance.mjs");
      plan.maintenance = personalMaintenancePlan({
        command: args.get("--command", null),
        dbPath: plan.files.db,
        tenantId: plan.workspace.tenant_id || "default"
      });
    }
    if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
    const installed = await installCodexMinimalHooks(plan, { force: args.flags.has("--force") });
    if (plan.maintenance) {
      const { installPersonalMaintenance } = await import("./personal-maintenance.mjs");
      installed.maintenance = await installPersonalMaintenance(plan.maintenance);
    }
    return installed;
  }
  if (mode !== "mcp") throw new Error("--mode must be mcp or minimal-hooks");
  const plan = connectorPlan(agent, { command: args.get("--command", "orgbrain"), scope: args.get("--scope", "user") });
  if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
  if (!plan.executable) throw new Error("OpenClaw setup requires merging plan.config_merge into its config, then running the verify command");
  await run(plan.executable, plan.args);
  return { ok: true, installed: true, agent, verify: plan.verify };
}
