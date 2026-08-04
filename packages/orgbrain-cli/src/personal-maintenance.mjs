#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { planMemoryMaintenance } from "./lib/memory-maintenance-core.mjs";
import { DEFAULT_LOCAL_DB, LocalMemoryStore } from "./lib/local-memory-store.mjs";

export const PERSONAL_MAINTENANCE_LABEL = "com.orgbrain.personal-maintenance";
const MODULE_PATH = fileURLToPath(import.meta.url);
const LOCAL_CLI_PATH = path.basename(MODULE_PATH) === "orgbrain.mjs"
  ? MODULE_PATH
  : fileURLToPath(new URL("./local-memory.mjs", import.meta.url));
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 128 * 1024;
const RETAINED_LOG_BYTES = 64 * 1024;
const AUTOMATIC_SOURCES = new Set(["codex", "claude", "cursor", "openclaw", "opencode"]);

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistArray(values) {
  return ["    <array>", ...values.map((value) => `      <string>${xmlEscape(value)}</string>`), "    </array>"].join("\n");
}

function renderLaunchAgent(plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(plan.label)}</string>
  <key>ProgramArguments</key>
${plistArray(plan.program_arguments)}
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(plan.files.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(plan.files.stderr)}</string>
</dict>
</plist>
`;
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateFile(file, content) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
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

async function writeState(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensurePrivateLog(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await chmod(file, 0o600);
}

async function trimLog(file) {
  const details = await stat(file).catch(() => null);
  if (!details || details.size <= MAX_LOG_BYTES) return;
  const raw = await readFile(file);
  await writePrivateFile(file, raw.subarray(Math.max(0, raw.length - RETAINED_LOG_BYTES)));
}

async function acquireLock(file, now = Date.now()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  try {
    await writeFile(file, `${JSON.stringify({ pid: process.pid, acquired_at: now })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const details = await stat(file).catch(() => null);
    if (!details || now - details.mtimeMs <= LOCK_STALE_MS) return false;
    await unlink(file).catch(() => undefined);
    try {
      await writeFile(file, `${JSON.stringify({ pid: process.pid, acquired_at: now })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      return true;
    } catch (retryError) {
      if (retryError?.code === "EEXIST") return false;
      throw retryError;
    }
  }
}

function sameSynthesizedMemory(existing, synthesized) {
  if (!existing) return false;
  const currentTags = [...existing.tags].sort();
  const nextTags = [...synthesized.tags].sort();
  return (
    existing.project_id === synthesized.project_id &&
    existing.summary === synthesized.summary &&
    existing.content === synthesized.content &&
    JSON.stringify(currentTags) === JSON.stringify(nextTags) &&
    existing.lifecycle_state === "active"
  );
}

async function collectTenantMemories(store, tenantId) {
  const memories = [];
  for await (const memory of store.export(tenantId)) memories.push(memory);
  return memories;
}

export async function runLocalMaintenance(store, options = {}) {
  const tenantId = options.tenantId || "default";
  const now = options.now ?? Date.now();
  const memories = await collectTenantMemories(store, tenantId);
  const active = memories.filter((memory) =>
    memory.lifecycle_state !== "suppressed" && AUTOMATIC_SOURCES.has(memory.source)
  );
  const rows = active.map((memory) => ({
    ...memory,
    tags_json: JSON.stringify(memory.tags)
  }));
  const plan = planMemoryMaintenance(rows, {
    tenantId,
    now,
    digestOlderThanDays: options.digestOlderThanDays ?? 7,
    duplicateOlderThanDays: options.duplicateOlderThanDays ?? 14,
    digestGroupMin: options.digestGroupMin ?? 4
  });
  const synthesized = [...plan.canonicals, ...plan.digests];
  const existingByKey = new Map(
    memories
      .filter((memory) => memory.source === "org-brain" && memory.external_key)
      .map((memory) => [memory.external_key, memory])
  );
  const changedSynthesized = synthesized.filter(
    (memory) => !sameSynthesizedMemory(existingByKey.get(memory.external_key), memory)
  );

  const before = await store.doctor();
  let repairedIndexes = false;
  let synthesizedCount = 0;
  let suppressedCount = 0;
  if (options.apply === true) {
    if (!before.ok) {
      await store.rebuildIndex();
      repairedIndexes = true;
      const repaired = await store.doctor();
      if (!repaired.ok) {
        throw new Error(`local memory verification failed after index repair: ${repaired.errors.join("; ")}`);
      }
    }
    if (changedSynthesized.length > 0) {
      await store.captureBatch(changedSynthesized.map((memory) => ({
        tenant_id: tenantId,
        project_id: memory.project_id,
        scope_type: memory.project_id ? "project" : "tenant",
        scope_key: memory.project_id || tenantId,
        kind: "semantic",
        lifecycle_state: "active",
        content: memory.content,
        summary: memory.summary,
        tags: memory.tags,
        source: "org-brain",
        external_key: memory.external_key,
        actor_type: "system",
        actor_id: "personal-maintenance",
        created_at: memory.created_at,
        confidence_score: 0.8,
        utility_score: 0.8,
        rationale: "Deterministic local memory consolidation without an LLM call.",
        evidence: memory.member_ids.map((id) => ({ type: "memory", ref: id }))
      })));
      synthesizedCount = changedSynthesized.length;
    }
    for (const compaction of plan.compactions) {
      const current = memories.find((memory) => memory.id === compaction.id);
      if (!current || current.lifecycle_state === "suppressed") continue;
      await store.suppress(tenantId, compaction.id, `personal maintenance: ${compaction.reason}`, {
        actor_type: "system",
        actor_id: "personal-maintenance"
      });
      suppressedCount += 1;
    }
  }
  const after = options.apply === true ? await store.doctor() : before;
  return {
    ok: after.ok,
    mode: "local-personal",
    llm_calls: 0,
    cloud_writes: 0,
    tenant_id: tenantId,
    apply_requested: options.apply === true,
    applied: options.apply === true,
    repaired_indexes: repairedIndexes,
    planned: {
      ...plan.stats,
      synthesized_change_count: changedSynthesized.length
    },
    applied_counts: {
      synthesized: synthesizedCount,
      suppressed: suppressedCount
    },
    doctor: after
  };
}

export async function runPersonalMaintenance(store, options = {}) {
  const startedAt = options.now ?? Date.now();
  const stateFile = options.stateFile;
  const lockFile = options.lockFile;
  await Promise.all([
    options.stdoutLog ? trimLog(options.stdoutLog) : undefined,
    options.stderrLog ? trimLog(options.stderrLog) : undefined
  ]);
  const locked = await acquireLock(lockFile, startedAt);
  if (!locked) {
    return { ok: true, skipped: "already-running", lock_file: lockFile };
  }
  try {
    const result = await runLocalMaintenance(store, options);
    const state = {
      version: 1,
      last_started_at: startedAt,
      last_finished_at: Date.now(),
      ok: result.ok,
      result: {
        mode: result.mode,
        llm_calls: result.llm_calls,
        cloud_writes: result.cloud_writes,
        tenant_id: result.tenant_id,
        apply_requested: result.apply_requested,
        repaired_indexes: result.repaired_indexes,
        planned: result.planned,
        applied_counts: result.applied_counts,
        doctor_errors: result.doctor.errors
      }
    };
    await writeState(stateFile, state);
    return { ...result, state_file: stateFile };
  } catch (error) {
    await writeState(stateFile, {
      version: 1,
      last_started_at: startedAt,
      last_finished_at: Date.now(),
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  } finally {
    await unlink(lockFile).catch(() => undefined);
  }
}

export function personalMaintenancePlan(options = {}) {
  if ((options.schedule || "daily") !== "daily") throw new Error("maintenance schedule must be daily");
  const home = path.resolve(options.home || os.homedir());
  const configDirectory = path.join(home, ".config", "org-brain");
  const dbPath = path.resolve(options.dbPath || path.join(home, ".org-brain", "memory.sqlite"));
  const baseCommand = options.command?.trim()
    ? [options.command.trim()]
    : [process.execPath, "--no-warnings", LOCAL_CLI_PATH];
  const plan = {
    label: PERSONAL_MAINTENANCE_LABEL,
    schedule: "daily",
    local_only: true,
    llm_calls: 0,
    cloud_writes: 0,
    tenant_id: options.tenantId?.trim() || "default",
    program_arguments: [
      ...baseCommand,
      "maintenance",
      "run",
      "--apply",
      "--tenant-id",
      options.tenantId?.trim() || "default",
      "--db",
      dbPath,
      "--state-file",
      path.join(configDirectory, "maintenance-state.json"),
      "--lock-file",
      path.join(configDirectory, "maintenance.lock"),
      "--stdout-log",
      path.join(configDirectory, "maintenance.log"),
      "--stderr-log",
      path.join(configDirectory, "maintenance-errors.log")
    ],
    files: {
      plist: path.join(home, "Library", "LaunchAgents", `${PERSONAL_MAINTENANCE_LABEL}.plist`),
      state: path.join(configDirectory, "maintenance-state.json"),
      lock: path.join(configDirectory, "maintenance.lock"),
      stdout: path.join(configDirectory, "maintenance.log"),
      stderr: path.join(configDirectory, "maintenance-errors.log"),
      backups: path.join(configDirectory, "backups"),
      db: dbPath
    }
  };
  return { ...plan, plist: renderLaunchAgent(plan) };
}

async function runProcess(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => resolve({ code: -1, stdout: "", stderr: error.message }));
    child.on("exit", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

async function isLoaded(plan, options = {}) {
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) return false;
  const runner = options.runner ?? runProcess;
  const result = await runner("launchctl", ["print", `gui/${uid}/${plan.label}`]);
  return result.code === 0;
}

export async function installPersonalMaintenance(plan, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("personal maintenance installation currently supports macOS only");
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("unable to resolve the current macOS user id");
  const runner = options.runner ?? runProcess;
  const current = await readOptional(plan.files.plist);
  const changed = current !== plan.plist;
  const loadedBefore = await isLoaded(plan, { runner, uid });
  let backup = null;

  await mkdir(path.dirname(plan.files.plist), { recursive: true });
  await mkdir(path.dirname(plan.files.state), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(plan.files.state), 0o700);
  await Promise.all([
    ensurePrivateLog(plan.files.stdout),
    ensurePrivateLog(plan.files.stderr)
  ]);
  if (changed && current !== null) {
    await mkdir(plan.files.backups, { recursive: true, mode: 0o700 });
    await chmod(plan.files.backups, 0o700);
    backup = path.join(plan.files.backups, `${path.basename(plan.files.plist)}.${new Date().toISOString().replaceAll(":", "-")}`);
    await copyFile(plan.files.plist, backup);
    await chmod(backup, 0o600);
  }
  if (changed && loadedBefore) {
    const stopped = await runner("launchctl", ["bootout", `gui/${uid}/${plan.label}`]);
    if (stopped.code !== 0 && await isLoaded(plan, { runner, uid })) {
      throw new Error(`launchctl bootout failed: ${stopped.stderr.trim() || stopped.stdout.trim() || stopped.code}`);
    }
  }
  if (changed) await writePrivateFile(plan.files.plist, plan.plist);

  const loadedAfterWrite = changed ? false : loadedBefore;
  if (!loadedAfterWrite) {
    const result = await runner("launchctl", ["bootstrap", `gui/${uid}`, plan.files.plist]);
    if (result.code !== 0) {
      if (current !== null) {
        await writePrivateFile(plan.files.plist, current);
        if (loadedBefore) await runner("launchctl", ["bootstrap", `gui/${uid}`, plan.files.plist]);
      } else {
        await unlink(plan.files.plist).catch(() => undefined);
      }
      throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
  }
  await runner("launchctl", ["enable", `gui/${uid}/${plan.label}`]);
  const loaded = await isLoaded(plan, { runner, uid });
  if (!loaded) throw new Error("LaunchAgent was written but is not loaded");
  return {
    ok: true,
    installed: true,
    changed,
    loaded,
    schedule: plan.schedule,
    llm_calls: 0,
    cloud_writes: 0,
    plist: plan.files.plist,
    backup
  };
}

export async function personalMaintenanceStatus(plan, options = {}) {
  const platform = options.platform ?? process.platform;
  const plist = await readOptional(plan.files.plist);
  const stateRaw = await readOptional(plan.files.state);
  let state = null;
  if (stateRaw) {
    try {
      state = JSON.parse(stateRaw);
    } catch {
      state = { ok: false, error: "maintenance state file is invalid JSON" };
    }
  }
  return {
    ok: platform === "darwin",
    supported: platform === "darwin",
    installed: plist !== null,
    loaded: platform === "darwin" ? await isLoaded(plan, options) : false,
    schedule: plan.schedule,
    llm_calls: 0,
    cloud_writes: 0,
    plist: plan.files.plist,
    state
  };
}

export async function uninstallPersonalMaintenance(plan, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("personal maintenance installation currently supports macOS only");
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("unable to resolve the current macOS user id");
  const runner = options.runner ?? runProcess;
  const loaded = await isLoaded(plan, { runner, uid });
  if (loaded) {
    await runner("launchctl", ["bootout", `gui/${uid}/${plan.label}`]);
    if (await isLoaded(plan, { runner, uid })) throw new Error("LaunchAgent could not be unloaded");
  }
  const current = await readOptional(plan.files.plist);
  let backup = null;
  if (current !== null) {
    await mkdir(plan.files.backups, { recursive: true, mode: 0o700 });
    await chmod(plan.files.backups, 0o700);
    backup = path.join(plan.files.backups, `${path.basename(plan.files.plist)}.uninstalled-${new Date().toISOString().replaceAll(":", "-")}`);
    await rename(plan.files.plist, backup);
    await chmod(backup, 0o600);
  }
  return { ok: true, installed: false, loaded: false, backup };
}

export async function runPersonalMaintenanceCommand(action, args, options = {}) {
  const plan = personalMaintenancePlan({
    command: args.get("--command", null),
    schedule: args.get("--schedule", "daily"),
    dbPath: args.get("--db", process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB),
    tenantId: args.get("--tenant-id", "default")
  });
  if (action === "run") {
    const positiveNumber = (name, fallback, minimum = 1) => {
      const value = Number(args.get(name, fallback));
      if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
      return value;
    };
    const store = options.store ?? new LocalMemoryStore(plan.files.db);
    return runPersonalMaintenance(store, {
      apply: args.flags.has("--apply"),
      tenantId: plan.tenant_id,
      stateFile: args.get("--state-file", plan.files.state),
      lockFile: args.get("--lock-file", plan.files.lock),
      stdoutLog: args.get("--stdout-log", plan.files.stdout),
      stderrLog: args.get("--stderr-log", plan.files.stderr),
      digestOlderThanDays: positiveNumber("--digest-older-than-days", 7),
      duplicateOlderThanDays: positiveNumber("--duplicate-older-than-days", 14),
      digestGroupMin: positiveNumber("--digest-group-min", 4, 2)
    });
  }
  if (action === "status") return personalMaintenanceStatus(plan, options);
  if (action === "install") {
    if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
    return installPersonalMaintenance(plan, options);
  }
  if (action === "uninstall") {
    if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
    return uninstallPersonalMaintenance(plan, options);
  }
  throw new Error(`unknown maintenance command: ${action || "(missing)"}`);
}
