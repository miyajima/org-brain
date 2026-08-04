import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const WORKSPACE_CONFIG_VERSION = 1;
export const DEFAULT_WORKSPACES_FILE = "~/.config/org-brain/workspaces.json";
export const DEFAULT_LEGACY_PROJECT_NAMES_FILE = "~/.config/org-brain/project-names.json";

export function resolveHomePath(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function normalizeWorkspaceRoot(value) {
  const resolved = resolveHomePath(typeof value === "string" ? value.trim() : "");
  return resolved ? path.resolve(resolved) : "";
}

function normalizeId(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : null;
}

function emptyWorkspaceConfig() {
  return { version: WORKSPACE_CONFIG_VERSION, workspaces: {} };
}

function normalizeWorkspaceEntry(raw, workspaceRoot) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`workspace entry must be an object: ${workspaceRoot}`);
  }
  const tenantId = raw.tenant_id === null ? null : normalizeId(raw.tenant_id);
  const projectId = raw.project_id === null ? null : normalizeId(raw.project_id);
  if (tenantId === null && raw.tenant_id !== null) {
    throw new Error(`workspace tenant_id is required or must be null: ${workspaceRoot}`);
  }
  if (projectId === null && raw.project_id !== null) {
    throw new Error(`workspace project_id is required or must be null: ${workspaceRoot}`);
  }
  return { tenant_id: tenantId, project_id: projectId };
}

export function normalizeWorkspaceConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workspace config must be an object");
  }
  if (raw.version !== WORKSPACE_CONFIG_VERSION) {
    throw new Error(`workspace config version must be ${WORKSPACE_CONFIG_VERSION}`);
  }
  if (!raw.workspaces || typeof raw.workspaces !== "object" || Array.isArray(raw.workspaces)) {
    throw new Error("workspace config workspaces must be an object");
  }
  const workspaces = {};
  for (const [rawRoot, entry] of Object.entries(raw.workspaces)) {
    const workspaceRoot = normalizeWorkspaceRoot(rawRoot);
    if (!workspaceRoot) continue;
    workspaces[workspaceRoot] = normalizeWorkspaceEntry(entry, workspaceRoot);
  }
  return { version: WORKSPACE_CONFIG_VERSION, workspaces };
}

export function workspacesFileFromEnv(env = process.env) {
  return resolveHomePath(env.ORGBRAIN_WORKSPACES_FILE?.trim() || DEFAULT_WORKSPACES_FILE);
}

export function legacyProjectNamesFileFromEnv(env = process.env) {
  return resolveHomePath(env.ORGBRAIN_PROJECT_NAMES_FILE?.trim() || DEFAULT_LEGACY_PROJECT_NAMES_FILE);
}

export async function loadWorkspaceConfig(file = workspacesFileFromEnv()) {
  try {
    const raw = await readFile(file, "utf8");
    return normalizeWorkspaceConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyWorkspaceConfig();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Org Brain workspace config at ${file}: ${detail}`);
  }
}

export async function loadLegacyProjectNames(file = legacyProjectNamesFileFromEnv()) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("legacy project names must be an object");
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([rawRoot, rawProjectId]) => [normalizeWorkspaceRoot(rawRoot), normalizeId(rawProjectId)])
        .filter(([workspaceRoot, projectId]) => workspaceRoot && projectId)
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid legacy Org Brain project map at ${file}: ${detail}`);
  }
}

export async function saveWorkspaceConfig(file, config) {
  const normalized = normalizeWorkspaceConfig(config);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await chmod(staged, 0o600);
    await rename(staged, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    throw error;
  }
  return normalized;
}

async function acquireWorkspaceConfigLock(file, options = {}) {
  const directory = path.dirname(file);
  const lockFile = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const startedAt = Date.now();
  await mkdir(directory, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
      } catch (writeError) {
        await handle.close().catch(() => undefined);
        await unlink(lockFile).catch(() => undefined);
        throw writeError;
      }
      await handle.close();
      return async () => unlink(lockFile).catch(() => undefined);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lockFile).catch(() => null);
      const lockText = await readFile(lockFile, "utf8").catch(() => "");
      const lockPid = Number.parseInt(lockText.split(/\s+/, 1)[0] ?? "", 10);
      let ownerAlive = false;
      if (Number.isInteger(lockPid) && lockPid > 0) {
        try {
          process.kill(lockPid, 0);
          ownerAlive = true;
        } catch (processError) {
          ownerAlive = processError?.code === "EPERM";
        }
      }
      if (!ownerAlive && lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await unlink(lockFile).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Org Brain workspace config lock: ${lockFile}`);
      }
      await delay(25);
    }
  }
}

export async function withWorkspaceConfigLock(file, operation, options = {}) {
  const release = await acquireWorkspaceConfigLock(file, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function migrateLegacyProjectNames(config, legacyNames, tenantId) {
  const normalizedTenantId = normalizeId(tenantId);
  let changed = false;
  for (const [rawRoot, rawProjectId] of Object.entries(legacyNames ?? {})) {
    const workspaceRoot = normalizeWorkspaceRoot(rawRoot);
    const projectId = normalizeId(rawProjectId);
    if (!workspaceRoot || !projectId || config.workspaces[workspaceRoot]) continue;
    config.workspaces[workspaceRoot] = {
      tenant_id: normalizedTenantId,
      project_id: projectId
    };
    changed = true;
  }
  return { config, changed };
}

export function tenantFallbackFromEnv(env = process.env, options = {}) {
  const configured = configuredTenantFromEnv(env);
  if (configured) return configured;
  if (options.organizationSharing) {
    throw new Error(
      "Organization sharing requires a workspace tenant mapping or explicit ORGBRAIN_TENANT_ID"
    );
  }
  return "default";
}

export function configuredTenantFromEnv(env = process.env) {
  return normalizeId(env.ORGBRAIN_TENANT_ID);
}

function parseProjectRootOverrides(raw) {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed)
        .map(([projectId, root]) => [normalizeId(projectId), normalizeWorkspaceRoot(root)])
        .filter(([projectId, root]) => projectId && root)
    );
  } catch {
    return new Map();
  }
}

export function projectRootsFromWorkspaceConfig(config, tenantId = null) {
  const roots = new Map();
  const ambiguous = new Set();
  for (const [workspaceRoot, entry] of Object.entries(config.workspaces)) {
    const localDefaultMatch = tenantId === "default" && entry.tenant_id === null;
    if (tenantId && entry.tenant_id !== tenantId && !localDefaultMatch) continue;
    if (!entry.project_id || ambiguous.has(entry.project_id)) continue;
    if (roots.has(entry.project_id) && roots.get(entry.project_id) !== workspaceRoot) {
      roots.delete(entry.project_id);
      ambiguous.add(entry.project_id);
      continue;
    }
    roots.set(entry.project_id, workspaceRoot);
  }
  return roots;
}

export async function loadProjectRootMappings(options = {}) {
  const env = options.env ?? process.env;
  const config = await loadWorkspaceConfig(options.workspacesFile ?? workspacesFileFromEnv(env));
  const roots = projectRootsFromWorkspaceConfig(config, options.tenantId ?? null);
  for (const [projectId, root] of parseProjectRootOverrides(env.ORGBRAIN_PROJECT_ROOTS)) {
    roots.set(projectId, root);
  }
  return roots;
}
