#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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
import { DEFAULT_AUTONOMY_POLICY, normalizeAutonomyPolicy } from "../../shared/src/autonomy-policy.mjs";

const SUPPORTED = new Set(["codex", "claude", "cursor", "opencode", "openclaw"]);
const MODULE_PATH = fileURLToPath(import.meta.url);
const LOCAL_CLI_PATH = path.basename(MODULE_PATH) === "orgbrain.mjs"
  ? MODULE_PATH
  : fileURLToPath(new URL("./local-memory.mjs", import.meta.url));
const LOCAL_ONLY_ENV = {
  ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
  ORGBRAIN_ENABLE_ORG_SHARING: "false",
  ORGBRAIN_LOCAL_HOOK_CAPTURE: "true",
  ORGBRAIN_MEMORY_CAPTURE_V2_MODE: "off",
  ORGBRAIN_MEMORY_COMMITMENTS_MODE: "on"
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
  return typeof handler?.command === "string" && /\bhook codex-(?:context|stop|pre-tool|post-tool|pre-compact)\b/u.test(handler.command);
}

export function mergeCodexHooks(raw, handlers) {
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
  for (const [event, specification] of Object.entries(handlers)) {
    const { matcher, ...handler } = specification;
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const preserved = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((candidate) => !isOrgBrainHook(candidate));
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...preserved, { ...(matcher ? { matcher } : {}), hooks: [handler] }];
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

function remoteUrl(rawUrl, tenantId) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("--url must use https outside localhost");
  }
  if (tenantId) url.searchParams.set("tenant_id", tenantId);
  return url.toString();
}

function isManagedHook(handler) {
  return typeof handler?.command === "string" &&
    /\bhook\s+(?:claude-(?:context|stop)|cursor-(?:context|stop)|flush)\b/u.test(handler.command);
}

export function mergeClaudeHooks(raw, handlers) {
  let config = {};
  if (raw?.trim()) config = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude settings.json must contain a JSON object");
  }
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error("Claude settings.json hooks must be an object");
  }
  for (const [event, handler] of Object.entries(handlers)) {
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const preserved = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((candidate) => !isManagedHook(candidate));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...preserved, { hooks: [handler] }];
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function mergeCursorHooks(raw, handlers) {
  let config = { version: 1, hooks: {} };
  if (raw?.trim()) config = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Cursor hooks.json must contain a JSON object");
  }
  if (config.version !== 1) throw new Error("Cursor user hooks require hooks.json version 1");
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error("Cursor hooks.json hooks must be an object");
  }
  for (const [event, handler] of Object.entries(handlers)) {
    const hooks = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    config.hooks[event] = [...hooks.filter((candidate) => !isManagedHook(candidate)), handler];
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function cloudCredentialContent(options) {
  return [
    "# OrgBrain per-installation hook credentials. Do not share this file.",
    "ORGBRAIN_ENABLE_CLOUD_MEMORY=true",
    "ORGBRAIN_ENABLE_ORG_SHARING=true",
    "ORGBRAIN_LOCAL_HOOK_CAPTURE=true",
    "ORGBRAIN_LOCAL_CONTEXT_ENABLED=true",
    `ORGBRAIN_LOCAL_DB=${options.dbPath}`,
    `ORGBRAIN_MCP_URL=${options.url}`,
    `ORGBRAIN_MCP_CLIENT_ID=${options.clientId}`,
    `ORGBRAIN_MCP_CLIENT_SECRET=${options.clientSecret}`,
    `ORGBRAIN_CLIENT_INSTALLATION_ID=${options.installationId}`,
    `ORGBRAIN_HOOK_OUTBOX=${options.outboxFile}`,
    `ORGBRAIN_TENANT_ID=${options.tenantId}`
  ].join("\n") + "\n";
}

async function hiddenTtyInput(prompt) {
  const input = createReadStream("/dev/tty");
  const output = createWriteStream("/dev/tty");
  if (typeof input.setRawMode !== "function") {
    input.destroy();
    output.destroy();
    throw new Error("A setup secret environment variable is required when no masked TTY is available");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.setRawMode(false);
      input.destroy();
      output.end("\n");
    };
    input.on("data", (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("setup cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    });
    input.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function setupSecret(envName, prompt) {
  const configured = process.env[envName]?.trim();
  if (configured) return configured;
  if (!process.stdin.isTTY) throw new Error(`${envName} is required in non-interactive setup`);
  return String(await hiddenTtyInput(prompt)).trim();
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
    SessionStart: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-context", errorLog),
      timeout: 2,
      statusMessage: "Restoring OrgBrain task commitments",
      additionalContextLimit: 8_192
    },
    UserPromptSubmit: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-context", errorLog),
      timeout: 3,
      statusMessage: "Checking OrgBrain task commitments",
      additionalContextLimit: 8_192
    },
    PreToolUse: {
      matcher: "request_user_input",
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-pre-tool", errorLog),
      timeout: 1,
      statusMessage: "Checking prior OrgBrain decisions"
    },
    PostToolUse: {
      matcher: "request_user_input",
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-post-tool", errorLog),
      timeout: 2,
      statusMessage: "Saving OrgBrain task commitment"
    },
    PreCompact: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-pre-compact", errorLog),
      timeout: 3,
      statusMessage: "Checkpointing OrgBrain task commitments"
    },
    PostCompact: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-context", errorLog),
      timeout: 2,
      statusMessage: "Restoring OrgBrain task commitments after compaction",
      additionalContextLimit: 8_192
    },
    Stop: {
      type: "command",
      command: hookCommand(baseCommand, envFile, "codex-stop", errorLog),
      timeout: 5,
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
    project_id: plan.workspace.project_id,
    autonomy: normalizeAutonomyPolicy(DEFAULT_AUTONOMY_POLICY)
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

export function remoteMcpPlan(agent, options = {}) {
  if (!["codex", "claude", "cursor"].includes(agent)) {
    throw new Error("remote-mcp is supported only for codex, claude, or cursor");
  }
  if (!options.url?.trim()) throw new Error("--url is required for remote-mcp");
  const scope = options.scope === "project" ? "project" : "user";
  const url = remoteUrl(options.url.trim(), options.tenantId?.trim() || "default");
  if (agent === "codex") {
    return {
      agent,
      mode: "remote-mcp",
      transport: "streamable-http",
      auth: "oauth",
      executable: "codex",
      args: ["mcp", "add", "orgbrain", "--url", url],
      post_install: { executable: "codex", args: ["mcp", "login", "orgbrain"] },
      verify: ["codex", "mcp", "get", "orgbrain", "--json"]
    };
  }
  if (agent === "claude") {
    return {
      agent,
      mode: "remote-mcp",
      transport: "http",
      auth: "oauth",
      executable: "claude",
      args: ["mcp", "add", "--transport", "http", "--scope", scope, "orgbrain", url],
      verify: ["claude", "mcp", "get", "orgbrain"],
      first_connection_auth: true
    };
  }
  const definition = JSON.stringify({ name: "orgbrain", url });
  return {
    agent,
    mode: "remote-mcp",
    transport: "http",
    auth: "oauth",
    executable: "cursor",
    args: ["--add-mcp", definition, ...(scope === "project" ? ["--mcp-workspace"] : [])],
    verify: ["cursor", "--version"],
    first_connection_auth: true
  };
}

export function cloudHooksPlan(agent, options = {}) {
  if (!["codex", "claude", "cursor"].includes(agent)) {
    throw new Error("cloud-hooks is supported only for codex, claude, or cursor");
  }
  const installationId = options.installationId?.trim();
  if (!installationId) throw new Error("installationId is required after enrollment");
  const home = path.resolve(options.home || os.homedir());
  const workspace = normalizeWorkspaceRoot(options.workspace || process.cwd());
  const projectId = options.projectId?.trim() || path.basename(workspace);
  const tenantId = options.tenantId?.trim() || "default";
  const orgBrainConfig = path.join(home, ".config", "org-brain");
  const clientDirectory = path.join(orgBrainConfig, "clients", installationId);
  const envFile = path.join(clientDirectory, "credentials.env");
  const outboxFile = path.join(clientDirectory, "outbox.jsonl");
  const workspacesFile = path.join(orgBrainConfig, "workspaces.json");
  const errorLog = path.join(clientDirectory, "hook-errors.log");
  const dbPath = expandHome(options.dbPath || path.join(home, ".org-brain", "memory.sqlite"), home);
  const baseCommand = options.command?.trim()
    ? [options.command.trim()]
    : [process.execPath, "--no-warnings", LOCAL_CLI_PATH];
  const command = (action) => hookCommand(baseCommand, envFile, action, errorLog);
  let hooksFile;
  let handlers;
  if (agent === "codex") {
    hooksFile = path.join(home, ".codex", "hooks.json");
    handlers = {
      UserPromptSubmit: { type: "command", command: command("codex-context"), timeout: 3, additionalContextLimit: 400 },
      Stop: { type: "command", command: command("codex-stop"), timeout: 3 }
    };
  } else if (agent === "claude") {
    hooksFile = path.join(home, ".claude", "settings.json");
    handlers = {
      SessionStart: { type: "command", command: command("flush"), timeout: 3 },
      UserPromptSubmit: { type: "command", command: command("claude-context"), timeout: 3 },
      Stop: { type: "command", command: command("claude-stop"), timeout: 3 },
      SessionEnd: { type: "command", command: command("flush"), timeout: 3 }
    };
  } else {
    hooksFile = path.join(home, ".cursor", "hooks.json");
    handlers = {
      sessionStart: { command: command("flush"), timeout: 3, failClosed: false },
      beforeSubmitPrompt: { command: command("cursor-context"), timeout: 3, failClosed: false },
      stop: { command: command("cursor-stop"), timeout: 3, failClosed: false },
      sessionEnd: { command: command("flush"), timeout: 3, failClosed: false }
    };
  }
  return {
    agent,
    mode: "cloud-hooks",
    local_only: false,
    llm_calls: 0,
    resident_process: false,
    installation_id: installationId,
    workspace: { path: workspace, tenant_id: tenantId, project_id: projectId },
    files: { env: envFile, outbox: outboxFile, workspaces: workspacesFile, hooks: hooksFile, errors: errorLog, db: dbPath },
    handlers,
    credentials_required: [
      "ORGBRAIN_SETUP_ACCESS_CLIENT_ID",
      "ORGBRAIN_SETUP_ACCESS_CLIENT_SECRET",
      "ORGBRAIN_SETUP_ENROLLMENT_CODE"
    ]
  };
}

export async function activateClientInstallation(options) {
  const target = new URL(options.url);
  target.pathname = `${target.pathname.replace(/\/+$/u, "")}/client-installations/activate`;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "CF-Access-Client-Id": options.clientId,
      "CF-Access-Client-Secret": options.clientSecret
    },
    body: JSON.stringify({
      enrollment_code: options.enrollmentCode,
      client_type: options.clientType
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || !body.data?.id || body.data.client_type !== options.clientType) {
    throw new Error(`OrgBrain client installation activation failed (${response.status})`);
  }
  return body.data;
}

async function prepareCloudHookTargets(plan, options = {}) {
  if (plan.agent === "cursor") await assertCursorUserHooksSupported(options.cursorVersionOutput);
  const hooksRaw = await readOptional(plan.files.hooks);
  const mergedHooks = plan.agent === "codex"
    ? mergeCodexHooks(hooksRaw, plan.handlers)
    : plan.agent === "claude"
      ? mergeClaudeHooks(hooksRaw, plan.handlers)
      : mergeCursorHooks(hooksRaw, plan.handlers);
  const workspaces = await loadWorkspaceConfig(plan.files.workspaces);
  return { mergedHooks, workspaces };
}

export async function preflightCloudHooks(plan, options = {}) {
  await prepareCloudHookTargets(plan, options);
  return {
    ok: true,
    agent: plan.agent,
    mode: plan.mode,
    writes: 0,
    llm_calls: 0
  };
}

export async function installCloudHooks(plan, credentials) {
  const suffix = new Date().toISOString().replaceAll(":", "-");
  const { mergedHooks, workspaces } = await prepareCloudHookTargets(plan);
  workspaces.workspaces[plan.workspace.path] = {
    tenant_id: plan.workspace.tenant_id,
    project_id: plan.workspace.project_id
  };
  await mkdir(path.dirname(plan.files.env), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plan.files.hooks), { recursive: true, mode: 0o700 });
  await writeFile(plan.files.errors, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await writeFile(plan.files.outbox, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await chmod(plan.files.errors, 0o600);
  await chmod(plan.files.outbox, 0o600);
  const backups = (await Promise.all([
    backupExisting(plan.files.env, suffix),
    backupExisting(plan.files.workspaces, suffix),
    backupExisting(plan.files.hooks, suffix)
  ])).filter(Boolean);
  await writePrivateFile(plan.files.env, cloudCredentialContent({
    url: credentials.url,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    installationId: plan.installation_id,
    outboxFile: plan.files.outbox,
    tenantId: plan.workspace.tenant_id,
    dbPath: plan.files.db
  }));
  await saveWorkspaceConfig(plan.files.workspaces, workspaces);
  await writePrivateFile(plan.files.hooks, mergedHooks);
  const { LocalMemoryStore } = await import("./lib/local-memory-store.mjs");
  await new LocalMemoryStore(plan.files.db).init();
  return {
    ok: true,
    installed: true,
    agent: plan.agent,
    mode: plan.mode,
    installation_id: plan.installation_id,
    files: plan.files,
    backups,
    llm_calls: 0
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
  if (agent === "cursor") {
    const definition = JSON.stringify({
      name: "orgbrain",
      command: serverCommand,
      args: ["mcp"]
    });
    return {
      agent,
      transport: "stdio",
      executable: "cursor",
      args: ["--add-mcp", definition, ...(scope === "project" ? ["--mcp-workspace"] : [])],
      verify: ["cursor", "--version"],
      documentation: "https://cursor.com/changelog/2-4"
    };
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

function runCapture(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve(output)
      : reject(new Error(`${executable} ${args.join(" ")} exited ${code}`)));
  });
}

export function cursorSupportsUserHooks(versionOutput) {
  const match = String(versionOutput).match(/(?:^|\n)(\d+)\.(\d+)\.(\d+)(?:\n|$)/u);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 7);
}

export async function assertCursorUserHooksSupported(versionOutput) {
  const output = versionOutput ?? await runCapture("cursor", ["--version"]);
  if (!cursorSupportsUserHooks(output)) {
    throw new Error("Current Cursor does not advertise user-scope hooks support (Cursor 1.7 or newer is required)");
  }
}

export async function runConnectorCommand(action, rest, args) {
  if (action !== "setup") throw new Error(`unknown connector command: ${action || "(missing)"}`);
  const agent = rest[0]?.toLowerCase();
  const mode = args.get("--mode", "mcp");
  if (mode === "remote-mcp") {
    const plan = remoteMcpPlan(agent, {
      url: args.get("--url", null),
      tenantId: args.get("--tenant-id", "default"),
      scope: args.get("--scope", "user")
    });
    if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
    await run(plan.executable, plan.args);
    if (plan.post_install) await run(plan.post_install.executable, plan.post_install.args);
    return { ok: true, installed: true, agent, mode, verify: plan.verify };
  }
  if (mode === "cloud-hooks") {
    const url = args.get("--url", null);
    if (!url) throw new Error("--url is required for cloud-hooks");
    if (!["codex", "claude", "cursor"].includes(agent)) {
      throw new Error("--mode cloud-hooks is supported only for codex, claude, or cursor");
    }
    if (!args.flags.has("--execute")) {
      return {
        ok: true,
        dry_run: true,
        plan: {
          agent,
          mode,
          url: remoteUrl(url, null),
          tenant_id: args.get("--tenant-id", "default"),
          workspace: normalizeWorkspaceRoot(args.get("--workspace", process.cwd())),
          llm_calls: 0,
          writes: [
            "~/.config/org-brain/clients/<installation-id>/credentials.env",
            agent === "codex"
              ? "~/.codex/hooks.json"
              : agent === "claude"
                ? "~/.claude/settings.json"
                : "~/.cursor/hooks.json"
          ],
          credentials_required: [
            "ORGBRAIN_SETUP_ACCESS_CLIENT_ID",
            "ORGBRAIN_SETUP_ACCESS_CLIENT_SECRET",
            "ORGBRAIN_SETUP_ENROLLMENT_CODE"
          ]
        }
      };
    }
    const preflightPlan = cloudHooksPlan(agent, {
      installationId: "preflight",
      tenantId: args.get("--tenant-id", "default"),
      workspace: args.get("--workspace", process.cwd()),
      projectId: args.get("--project-id", null),
      dbPath: args.get("--db", null),
      command: args.get("--command", null)
    });
    await preflightCloudHooks(preflightPlan);
    const clientId = await setupSecret("ORGBRAIN_SETUP_ACCESS_CLIENT_ID", "Cloudflare Access Client ID: ");
    const clientSecret = await setupSecret("ORGBRAIN_SETUP_ACCESS_CLIENT_SECRET", "Cloudflare Access Client Secret: ");
    const enrollmentCode = await setupSecret("ORGBRAIN_SETUP_ENROLLMENT_CODE", "OrgBrain enrollment code: ");
    const mcpUrl = remoteUrl(url, null);
    const installation = await activateClientInstallation({
      url: mcpUrl,
      clientId,
      clientSecret,
      enrollmentCode,
      clientType: agent
    });
    const plan = cloudHooksPlan(agent, {
      installationId: installation.id,
      url: mcpUrl,
      tenantId: installation.tenant_id,
      workspace: args.get("--workspace", process.cwd()),
      projectId: args.get("--project-id", null),
      dbPath: args.get("--db", null),
      command: args.get("--command", null)
    });
    try {
      return await installCloudHooks(plan, { url: mcpUrl, clientId, clientSecret });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Client installation ${installation.id} is active, but local hook setup failed. ` +
        `Revoke this installation in Org Brain, fix the local error, and create a new enrollment. Cause: ${detail}`
      );
    }
  }
  if (mode === "minimal-hooks") {
    if (agent !== "codex") throw new Error("--mode minimal-hooks is currently supported only for codex");
    // New local installations always start the autonomous shadow controller.
    // Keep --maintenance daily as a compatibility spelling for existing
    // scripts, while avoiding a human approval step for the default path.
    const maintenance = args.get("--maintenance", "daily");
    if (maintenance && maintenance !== "daily") throw new Error("--maintenance must be daily");
    const plan = codexMinimalHooksPlan({
      command: args.get("--command", null),
      workspace: args.get("--workspace", process.cwd()),
      projectId: args.get("--project-id", null),
      tenantId: args.get("--tenant-id", null),
      dbPath: args.get("--db", null)
    });
    if (maintenance === "daily") {
      const { autonomousMaintenancePlan } = await import("./personal-maintenance.mjs");
      plan.maintenance = autonomousMaintenancePlan({
        command: args.get("--command", null),
        dbPath: plan.files.db,
        tenantId: plan.workspace.tenant_id || "default",
        workspace: plan.workspace.path
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
  if (mode !== "mcp") throw new Error("--mode must be mcp, remote-mcp, cloud-hooks, or minimal-hooks");
  const plan = connectorPlan(agent, { command: args.get("--command", "orgbrain"), scope: args.get("--scope", "user") });
  if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
  if (!plan.executable) throw new Error("OpenClaw setup requires merging plan.config_merge into its config, then running the verify command");
  await run(plan.executable, plan.args);
  return { ok: true, installed: true, agent, verify: plan.verify };
}
