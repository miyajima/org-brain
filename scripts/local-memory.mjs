#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_LOCAL_DB,
  LocalMemoryStore,
  MEMORY_SCHEMA_VERSION
} from "./lib/local-memory-store.mjs";

function printHelp() {
  console.log(`OrgBrain local-first memory CLI

Usage:
  orgbrain init [--db <path>]
  orgbrain doctor [--db <path>]
  orgbrain memory capture [--content <text>] [--summary <text>] [--project-id <id>] [--tag <tag>]
  orgbrain memory search <query> [--tenant-id <id>] [--project-id <id>] [--limit <n>]
  orgbrain memory revise <memory-id> [--content <text>] [--summary <text>] [--tag <tag>]
  orgbrain memory suppress <memory-id> --reason <text>
  orgbrain memory delete <memory-id>
  orgbrain memory list [--tenant-id <id>] [--project-id <id>] [--limit <n>]
  orgbrain memory export [--format jsonl|markdown] [--output <path>]
  orgbrain index rebuild
  orgbrain backup create [--output <path>]
  orgbrain backup verify --from <path>
  orgbrain backup restore --from <path>
  orgbrain migrate --from <legacy-sqlite>
  orgbrain serve [--host 127.0.0.1] [--port 8788]
  orgbrain mcp
  orgbrain event ingest <codex|claude|opencode|openclaw> [json-payload]
  orgbrain hook <codex-context|codex-stop>
  orgbrain maintenance <run|status|install|uninstall> [--schedule daily] [--apply] [--execute]
  orgbrain cloud doctor [--root <checkout>] [--live]
  orgbrain cloud provision [--root <checkout>] [--with-vectorize] [--execute]
  orgbrain connector setup <codex|claude|opencode|openclaw> [--mode mcp|minimal-hooks] [--maintenance daily] [--scope user|project] [--execute]

Compatibility aliases:
  orgbrain upsert | search | list | export-markdown

Input:
  capture and revise accept JSON or plain text on stdin. JSON uses MemoryRecord v2
  snake_case fields. Local mode performs no external network requests.

Environment:
  ORGBRAIN_LOCAL_DB  SQLite path (default: ~/.org-brain/memory.sqlite)
`);
}

function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  const repeated = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.split("=", 2);
    if (["--json", "--help", "--force", "--live", "--execute", "--with-vectorize", "--apply"].includes(name)) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (["--tag", "--entity", "--conflict"].includes(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
    } else {
      values.set(name, value);
    }
  }
  return {
    positional,
    flags,
    get(name, fallback = undefined) {
      return values.get(name) ?? fallback;
    },
    all(name) {
      return repeated.get(name) ?? [];
    }
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseJsonOption(raw, fallback) {
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  return parsed;
}

async function readPayload(args) {
  const stdin = await readStdin();
  let body = {};
  if (stdin.startsWith("{")) body = JSON.parse(stdin);
  else if (stdin) body.content = stdin;
  const content = args.get("--content");
  const summary = args.get("--summary");
  return {
    ...body,
    ...(content !== undefined ? { content } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(args.get("--tenant-id") ? { tenant_id: args.get("--tenant-id") } : {}),
    ...(args.get("--project-id") ? { project_id: args.get("--project-id") } : {}),
    ...(args.get("--source") ? { source: args.get("--source") } : {}),
    ...(args.get("--external-key") ? { external_key: args.get("--external-key") } : {}),
    ...(args.get("--kind") ? { kind: args.get("--kind") } : {}),
    ...(args.get("--scope-type") ? { scope_type: args.get("--scope-type") } : {}),
    ...(args.get("--scope-key") ? { scope_key: args.get("--scope-key") } : {}),
    ...(args.get("--actor-type") ? { actor_type: args.get("--actor-type") } : {}),
    ...(args.get("--actor-id") ? { actor_id: args.get("--actor-id") } : {}),
    ...(args.get("--valid-from") ? { valid_from: Number(args.get("--valid-from")) } : {}),
    ...(args.get("--valid-until") ? { valid_until: Number(args.get("--valid-until")) } : {}),
    ...(args.get("--confidence") ? { confidence_score: Number(args.get("--confidence")) } : {}),
    ...(args.get("--utility") ? { utility_score: Number(args.get("--utility")) } : {}),
    ...(args.get("--rationale") ? { rationale: args.get("--rationale") } : {}),
    ...(args.all("--tag").length ? { tags: args.all("--tag") } : {}),
    ...(args.all("--entity").length ? { entities: args.all("--entity") } : {}),
    ...(args.all("--conflict").length ? { conflicts: args.all("--conflict") } : {}),
    ...(args.get("--source-references")
      ? { source_references: parseJsonOption(args.get("--source-references"), []) }
      : {}),
    ...(args.get("--evidence") ? { evidence: parseJsonOption(args.get("--evidence"), []) } : {}),
    ...(args.get("--permissions") ? { permissions: parseJsonOption(args.get("--permissions"), []) } : {})
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function collect(iterable, limit = Infinity) {
  const rows = [];
  for await (const item of iterable) {
    rows.push(item);
    if (rows.length >= limit) break;
  }
  return rows;
}

function toMarkdown(records) {
  return records
    .map((record) => {
      const metadata = [
        `- id: ${record.id}`,
        `- tenant: ${record.tenant_id}`,
        record.project_id ? `- project: ${record.project_id}` : null,
        `- kind: ${record.kind}`,
        `- state: ${record.lifecycle_state}`,
        `- source: ${record.source}`,
        `- version: ${record.current_version}`,
        `- content_hash: ${record.content_hash}`,
        record.tags.length ? `- tags: ${record.tags.join(", ")}` : null
      ].filter(Boolean);
      return `## ${record.summary || record.id}\n\n${metadata.join("\n")}\n\n${record.content}\n`;
    })
    .join("\n");
}

async function writeOutput(path, text) {
  const { writeFile } = await import("node:fs/promises");
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text, { encoding: "utf8", mode: 0o600 });
  return destination;
}

async function handleMemory(store, action, rest, args) {
  const tenantId = args.get("--tenant-id", "default");
  if (action === "capture" || action === "upsert") {
    const payload = await readPayload(args);
    emit(await store.capture({
      tenant_id: "default",
      project_id: null,
      kind: "episodic",
      lifecycle_state: "active",
      scope_type: payload.project_id ? "project" : "tenant",
      scope_key: payload.project_id || payload.tenant_id || "default",
      content: "",
      summary: null,
      tags: [],
      entities: [],
      source: "local",
      source_references: [],
      external_key: null,
      actor_type: "principal",
      actor_id: process.env.USER || "local-user",
      valid_from: null,
      valid_until: null,
      confidence_score: null,
      utility_score: null,
      rationale: null,
      evidence: [],
      conflicts: [],
      permissions: [],
      ...payload
    }));
    return;
  }
  if (action === "search") {
    const query = rest.join(" ").trim() || args.get("--query", "");
    emit(await store.search({
      tenant_id: tenantId,
      project_id: args.get("--project-id", null),
      query,
      limit: Number(args.get("--limit", 10))
    }));
    return;
  }
  if (action === "revise") {
    const memoryId = rest[0];
    if (!memoryId) throw new Error("memory revise requires <memory-id>");
    emit(await store.revise(tenantId, memoryId, await readPayload(args)));
    return;
  }
  if (action === "suppress") {
    const memoryId = rest[0];
    if (!memoryId) throw new Error("memory suppress requires <memory-id>");
    const reason = args.get("--reason");
    if (!reason) throw new Error("memory suppress requires --reason");
    emit(await store.suppress(tenantId, memoryId, reason, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    }));
    return;
  }
  if (action === "delete") {
    const memoryId = rest[0];
    if (!memoryId) throw new Error("memory delete requires <memory-id>");
    emit(await store.delete(tenantId, memoryId, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    }));
    return;
  }
  if (action === "list") {
    emit(await collect(
      store.export(tenantId, args.get("--project-id", null)),
      Math.max(1, Math.min(500, Number(args.get("--limit", 20))))
    ));
    return;
  }
  if (action === "export" || action === "export-markdown") {
    const records = await collect(store.export(tenantId, args.get("--project-id", null)));
    const format = action === "export-markdown" ? "markdown" : args.get("--format", "jsonl");
    const text = format === "markdown"
      ? toMarkdown(records)
      : `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`;
    const output = args.get("--output");
    if (output) emit({ ok: true, path: await writeOutput(output, text), count: records.length });
    else process.stdout.write(text);
    return;
  }
  throw new Error(`unknown memory command: ${action || "(missing)"}`);
}

async function readRequestBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store"
  });
  response.end(data);
}

async function serve(store, args) {
  const host = args.get("--host", "127.0.0.1");
  if (
    !["127.0.0.1", "::1", "localhost"].includes(host) &&
    process.env.ORGBRAIN_ALLOW_NON_LOOPBACK !== "1"
  ) {
    throw new Error("local mode only permits loopback hosts; set ORGBRAIN_ALLOW_NON_LOOPBACK=1 to opt in");
  }
  const port = Number(args.get("--port", 8788));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
  await store.init();
  const automaticBackups = process.env.ORGBRAIN_AUTO_BACKUP !== "false";
  const backupIntervalMs = Math.max(
    60_000,
    Number(process.env.ORGBRAIN_AUTO_BACKUP_INTERVAL_MS || 300_000)
  );
  const createAutomaticBackup = () => {
    const destination = join(
      dirname(store.dbPath),
      "backups",
      `auto-${new Date().toISOString().replaceAll(":", "-")}.sqlite`
    );
    return store.createBackup(destination);
  };
  const initialBackup = automaticBackups ? await createAutomaticBackup() : null;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true, schema_version: MEMORY_SCHEMA_VERSION, mode: "local" });
      } else if (request.method === "POST" && request.url === "/v1/memories/capture") {
        sendJson(response, 201, await store.capture(await readRequestBody(request)));
      } else if (request.method === "POST" && request.url === "/v1/memories/search") {
        sendJson(response, 200, await store.search(await readRequestBody(request)));
      } else {
        sendJson(response, 404, { error: "not_found" });
      }
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(port, host, () => {
    emit({
      ok: true,
      url: `http://${host}:${port}`,
      db: store.dbPath,
      automatic_backup: automaticBackups
        ? { interval_ms: backupIntervalMs, latest: initialBackup?.path ?? null }
        : { disabled: true }
    });
  });
  const backupTimer = automaticBackups
    ? setInterval(() => {
        void createAutomaticBackup().catch((error) => {
          process.stderr.write(`automatic backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }, backupIntervalMs)
    : null;
  backupTimer?.unref();
  const shutdown = () => {
    if (backupTimer) clearInterval(backupTimer);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const raw = process.argv.slice(2);
  const args = parseArgs(raw);
  if (args.flags.has("--help") || raw.length === 0) {
    printHelp();
    return;
  }

  let [command, action, ...rest] = args.positional;
  const aliases = new Set(["upsert", "search", "list", "export-markdown"]);
  if (aliases.has(command)) {
    rest = action ? [action, ...rest] : rest;
    action = command;
    command = "memory";
  }

  const store = new LocalMemoryStore(args.get("--db", process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB));
  if (command === "init") {
    await store.init();
    emit({ ok: true, db: store.dbPath, schema_version: MEMORY_SCHEMA_VERSION });
  } else if (command === "doctor") {
    const result = await store.doctor();
    emit(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "memory") {
    await handleMemory(store, action, rest, args);
  } else if (command === "index" && action === "rebuild") {
    await store.rebuildIndex();
    emit({ ok: true, ...(await store.verify()) });
  } else if (command === "backup" && action === "create") {
    const defaultPath = join(dirname(store.dbPath), "backups", `memory-${new Date().toISOString().replaceAll(":", "-")}.sqlite`);
    emit(await store.createBackup(args.get("--output", defaultPath)));
  } else if (command === "backup" && action === "verify") {
    const source = args.get("--from");
    if (!source) throw new Error("backup verify requires --from");
    emit(await store.verifyBackup(source));
  } else if (command === "backup" && action === "restore") {
    const source = args.get("--from");
    if (!source) throw new Error("backup restore requires --from");
    emit(await store.restoreBackup(source));
  } else if (command === "migrate") {
    const source = args.get("--from");
    if (!source) throw new Error("migrate requires --from");
    emit(await store.importLegacy(source));
  } else if (command === "serve") {
    await serve(store, args);
  } else if (command === "mcp") {
    const { startLocalMcp } = await import("./local-mcp.mjs");
    await startLocalMcp(store);
  } else if (command === "event" && action === "ingest") {
    const source = rest[0];
    if (!source) throw new Error("event ingest requires an agent source");
    const payload = rest.slice(1).join(" ") || await readStdin();
    const { ingestHookEvent } = await import("./hook-memory-bridge.mjs");
    await ingestHookEvent(source, payload);
  } else if (command === "hook" && action === "codex-context") {
    const { buildCodexMemoryContext } = await import("./codex-memory-context.mjs");
    const { loadEnvFallbacks } = await import("./hook-memory-bridge.mjs");
    await loadEnvFallbacks();
    const result = await buildCodexMemoryContext(await readStdin());
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "hook" && action === "codex-stop") {
    const { ingestHookEvent } = await import("./hook-memory-bridge.mjs");
    await ingestHookEvent("codex-stop", await readStdin(), { emit: false });
    process.stdout.write("{}\n");
  } else if (command === "maintenance") {
    const { runPersonalMaintenanceCommand } = await import("./personal-maintenance.mjs");
    emit(await runPersonalMaintenanceCommand(action, args));
  } else if (command === "cloud") {
    const { runCloudCommand } = await import("./cloud-operations.mjs");
    const result = await runCloudCommand(action, args);
    emit(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "connector") {
    const { runConnectorCommand } = await import("./connector-setup.mjs");
    emit(await runConnectorCommand(action, rest, args));
  } else {
    printHelp();
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
