#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_FILES = [
  "~/.config/org-brain/hooks.env",
  "~/.openclaw/.env",
  "~/.agents/.env",
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env")
];

const AGENT_TARGETS = [
  {
    id: "openclaw",
    homeDir: "~/.openclaw",
    exportDir: "~/.openclaw/memory",
    exportFile: "org-brain-sync.md",
    importSQLite: "~/.openclaw/memory/main.sqlite",
    reindexCommand: ["openclaw", "memory", "index"]
  },
  {
    id: "codex",
    homeDir: "~/.codex",
    exportDir: "~/.codex/memories",
    exportFile: "org-brain-sync.md",
    importMarkdownDir: "~/.codex/memories"
  },
  {
    id: "claude",
    homeDir: "~/.claude",
    exportDir: "~/.claude/memories",
    exportFile: "org-brain-sync.md",
    importMarkdownDir: "~/.claude/memories"
  },
  {
    id: "cursor",
    homeDir: "~/.cursor",
    exportDir: "~/.cursor/memories",
    exportFile: "org-brain-sync.md",
    importMarkdownDir: "~/.cursor/memories"
  },
  {
    id: "opencode",
    homeDir: "~/.opencode",
    exportDir: "~/.opencode/memories",
    exportFile: "org-brain-sync.md"
  },
  {
    id: "hermes",
    homeDir: "~/.hermes",
    exportDir: "~/.hermes/memories",
    exportFile: "org-brain-sync.md"
  }
];

function resolveHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function getOptionalEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getRequiredEnv(key) {
  const value = getOptionalEnv(key);
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function parseEnvText(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    result[key] = value.replace(/\\n/g, "\n");
  }
  return result;
}

export async function loadEnvFallbacks() {
  const configured = process.env.ORGBRAIN_HOOK_ENV_FILES;
  const files = (configured ? configured.split(/[:,;]/) : DEFAULT_ENV_FILES)
    .map((entry) => resolveHome(entry.trim()))
    .filter(Boolean);

  for (const file of files) {
    try {
      const raw = await (await import("node:fs/promises")).readFile(file, "utf8");
      const parsed = parseEnvText(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // Ignore missing env files.
    }
  }
}

export function resolveApiBase(env = process.env) {
  const canonical = typeof env.ORGBRAIN_API_URL === "string" ? env.ORGBRAIN_API_URL.trim() : "";
  if (canonical) return canonical;
  const alias = typeof env.ORGBRAIN_API_BASE === "string" ? env.ORGBRAIN_API_BASE.trim() : "";
  if (alias) return alias;
  throw new Error("Missing required env: ORGBRAIN_API_URL");
}

function normalizeInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function fetchApiJson(baseUrl, apiKey, route, init = {}) {
  const res = await fetch(buildApiUrl(baseUrl, route), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...(init.headers ?? {})
    }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`API request failed (${res.status}) route=${route}`);
  }
  return body.data;
}

function buildApiUrl(baseUrl, route) {
  const base = new URL(baseUrl);
  const normalizedRoute = route.replace(/^\/+/, "");
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(normalizedRoute, `${base.origin}${basePath}`);
}

async function readOpenClawChunks(sqlitePath, limit) {
  const sql = [
    "SELECT",
    "  id,",
    "  path,",
    "  start_line,",
    "  end_line,",
    "  text,",
    "  updated_at",
    "FROM chunks",
    "WHERE text IS NOT NULL",
    "ORDER BY updated_at DESC",
    `LIMIT ${limit};`
  ].join(" ");

  const { stdout } = await execFileAsync("sqlite3", ["-json", sqlitePath, sql], {
    maxBuffer: 32 * 1024 * 1024
  });

  if (!stdout.trim()) return [];
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => typeof r?.id === "string" && typeof r?.text === "string");
}

function toUpsertItems(rows) {
  return rows.map((row) => {
    const pathText = typeof row.path === "string" ? row.path : "unknown";
    const start = typeof row.start_line === "number" ? row.start_line : 0;
    const end = typeof row.end_line === "number" ? row.end_line : 0;
    const summary = `${pathText}:${start}-${end}`;
    return {
      external_key: `openclaw:${row.id}`,
      content: String(row.text).slice(0, 20_000),
      summary,
      tags: ["openclaw", "chunk", "curated-memory"],
      created_at: typeof row.updated_at === "number" ? row.updated_at : Date.now()
    };
  });
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function digestHex(value) {
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return {};
  const frontmatter = raw.slice(4, end).split(/\r?\n/);
  const parsed = {};
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    try {
      parsed[key] = JSON.parse(value);
    } catch {
      parsed[key] = value.trim();
    }
  }
  return parsed;
}

function inferProjectIdFromMarkdown(raw) {
  const frontmatter = parseFrontmatter(raw);
  if (typeof frontmatter.project_id === "string" && frontmatter.project_id.trim()) {
    return frontmatter.project_id.trim().slice(0, 128);
  }
  const match = raw.match(/^- Project:\s*(.+)$/im);
  if (!match) return null;
  const value = match[1].trim();
  if (!value || value === "(global)") return null;
  return path.basename(value).slice(0, 128);
}

async function readMarkdownImportItems(target, limit) {
  if (!target.importMarkdownDir) return [];
  if (!(await pathExists(target.importMarkdownDir))) return [];
  const entries = await readdir(target.importMarkdownDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && /\.md(?:own)?$/i.test(entry.name) && entry.name !== target.exportFile)
    .slice(0, limit);
  const items = [];
  for (const entry of files) {
    const file = path.join(target.importMarkdownDir, entry.name);
    const raw = await readFile(file, "utf8").catch(() => "");
    const content = raw.trim();
    if (content.length < 40) continue;
    const hash = await digestHex(`${target.id}:${file}:${content}`);
    items.push({
      external_key: `${target.id}:markdown:${hash.slice(0, 32)}`,
      content: content.slice(0, 20_000),
      summary: `${target.id} markdown memory: ${entry.name}`.slice(0, 1000),
      tags: [target.id, "markdown-import", "curated-memory"],
      project_id: inferProjectIdFromMarkdown(content),
      created_at: Date.now()
    });
  }
  return items;
}

export function renderOrgBrainMarkdown(memories, targetId, tenantId = "default") {
  const lines = [];
  lines.push("---");
  lines.push(`target: ${JSON.stringify(targetId)}`);
  lines.push(`tenant: ${JSON.stringify(tenantId)}`);
  lines.push(`generated_at: ${JSON.stringify(new Date().toISOString())}`);
  lines.push("---");
  lines.push("");
  lines.push("# OrgBrain Sync");
  lines.push("");
  lines.push(`Target: ${targetId}`);
  lines.push(`GeneratedAt: ${new Date().toISOString()}`);
  lines.push("");
  for (const memory of memories) {
    const created = typeof memory.created_at === "number" ? new Date(memory.created_at).toISOString() : "unknown";
    lines.push(`## ${created} ${memory.id}`);
    lines.push("");
    lines.push(`- Source: ${memory.source ?? "org-brain"}`);
    if (memory.external_key) lines.push(`- ExternalKey: ${memory.external_key}`);
    if (memory.summary) lines.push(`- Summary: ${String(memory.summary).slice(0, 1000)}`);
    if (memory.project_id !== undefined) lines.push(`- Project: ${memory.project_id ?? "(global)"}`);
    lines.push(`- Tenant: ${memory.tenant_id ?? tenantId}`);
    lines.push(`- MemoryKind: ${memory.kind ?? memory.memory_kind ?? "episodic"}`);
    lines.push(`- LifecycleState: ${memory.lifecycle_state ?? "active"}`);
    lines.push("");
    lines.push("```yaml");
    lines.push(`tenant: ${JSON.stringify(memory.tenant_id ?? tenantId)}`);
    lines.push(`project_id: ${JSON.stringify(memory.project_id ?? null)}`);
    lines.push(`source: ${JSON.stringify(memory.source ?? "org-brain")}`);
    lines.push(`external_key: ${JSON.stringify(memory.external_key ?? null)}`);
    lines.push(`memory_kind: ${JSON.stringify(memory.kind ?? memory.memory_kind ?? "episodic")}`);
    lines.push(`lifecycle_state: ${JSON.stringify(memory.lifecycle_state ?? "active")}`);
    lines.push("```");
    lines.push("");
    lines.push("```text");
    lines.push(String(memory.content ?? "").slice(0, 20_000));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function tryReindex(target) {
  if (!target.reindexCommand) return { status: "skipped", reason: "no-reindex-command" };
  try {
    await execFileAsync(target.reindexCommand[0], target.reindexCommand.slice(1), {
      maxBuffer: 8 * 1024 * 1024
    });
    return { status: "ok" };
  } catch {
    return { status: "skipped", reason: "command-failed" };
  }
}

function resolveTargets() {
  return AGENT_TARGETS.map((target) => ({
    ...target,
    homeDir: resolveHome(target.homeDir),
    exportDir: resolveHome(target.exportDir),
    importMarkdownDir: target.importMarkdownDir ? resolveHome(target.importMarkdownDir) : null,
    importSQLite: target.importSQLite ? resolveHome(target.importSQLite) : null
  })).filter((target) => target.homeDir && target.exportDir);
}

async function pathExists(pathname) {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function importOpenClawIfPresent(apiBase, apiKey, tenantId, chunkLimit, batchSize, targets) {
  const openclawTarget = targets.find((target) => target.id === "openclaw");
  if (!openclawTarget || !openclawTarget.importSQLite) return null;
  if (!(await pathExists(openclawTarget.importSQLite))) return null;

  const chunkRows = await readOpenClawChunks(openclawTarget.importSQLite, chunkLimit);
  const items = toUpsertItems(chunkRows);
  const batches = chunkArray(items, batchSize);
  let inserted = 0;
  let updated = 0;

  for (const batch of batches) {
    const result = await fetchApiJson(apiBase, apiKey, "/v1/memories/upsert", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        source: "openclaw",
        items: batch
      })
    });
    inserted += Number(result.inserted ?? 0);
    updated += Number(result.updated ?? 0);
  }

  return {
    syncedChunks: items.length,
    batches: batches.length,
    inserted,
    updated
  };
}

export async function importMarkdownMemoriesIfPresent(apiBase, apiKey, tenantId, markdownLimit, batchSize, targets) {
  const importTargets = targets.filter((target) => target.importMarkdownDir && target.id !== "openclaw");
  const results = [];
  for (const target of importTargets) {
    if (!(await pathExists(target.homeDir))) {
      results.push({ target: target.id, status: "skipped", reason: "missing-home-dir" });
      continue;
    }
    const items = await readMarkdownImportItems(target, markdownLimit);
    if (items.length === 0) {
      results.push({ target: target.id, status: "skipped", reason: "no-markdown-memories" });
      continue;
    }
    let inserted = 0;
    let updated = 0;
    for (const batch of chunkArray(items, batchSize)) {
      const result = await fetchApiJson(apiBase, apiKey, "/v1/memories/upsert", {
        method: "POST",
        body: {
          tenant_id: tenantId,
          source: target.id,
          items: batch
        }
      });
      inserted += Number(result.inserted ?? 0);
      updated += Number(result.updated ?? 0);
    }
    results.push({ target: target.id, status: "imported", memories: items.length, inserted, updated });
  }
  return results;
}

async function fetchExportMemories(apiBase, apiKey, tenantId, exportLimit, exportSource) {
  const route = new URLSearchParams({
    tenant_id: tenantId,
    limit: String(exportLimit)
  });
  if (exportSource) route.set("source", exportSource);
  return fetchApiJson(apiBase, apiKey, `/v1/memories?${route.toString()}`);
}

async function exportToTargets(memories, targets, tenantId) {
  const results = [];
  for (const target of targets) {
    if (!(await pathExists(target.homeDir))) {
      results.push({ target: target.id, status: "skipped", reason: "missing-home-dir" });
      continue;
    }

    const exportFile = path.join(target.exportDir, target.exportFile);
    await mkdir(target.exportDir, { recursive: true });
    await writeFile(exportFile, renderOrgBrainMarkdown(memories, target.id, tenantId), "utf8");
    const reindex = await tryReindex(target);
    results.push({
      target: target.id,
      status: "exported",
      exportFile,
      reindex
    });
  }
  return results;
}

export async function main() {
  await loadEnvFallbacks();
  const apiBase = resolveApiBase();
  const apiKey = getRequiredEnv("ORGBRAIN_API_KEY");
  const tenantId = (process.env.ORGBRAIN_TENANT_ID ?? "default").trim() || "default";
  const direction = (process.env.SYNC_DIRECTION ?? "both").trim().toLowerCase();
  const chunkLimit = normalizeInt(process.env.OPENCLAW_CHUNK_LIMIT, 200, 1, 1000);
  const batchSize = normalizeInt(process.env.SYNC_BATCH_SIZE, 50, 1, 200);
  const exportLimit = normalizeInt(process.env.ORGBRAIN_EXPORT_LIMIT, 200, 1, 500);
  const exportSource = (process.env.ORGBRAIN_EXPORT_SOURCE ?? "").trim() || null;
  const targets = resolveTargets();

  if (!["both", "import", "export"].includes(direction)) {
    throw new Error("SYNC_DIRECTION must be one of: both, import, export");
  }

  if (direction === "both" || direction === "import") {
    const importResult = await importOpenClawIfPresent(apiBase, apiKey, tenantId, chunkLimit, batchSize, targets);
    if (importResult) {
      console.log(
        `[import] openclaw chunks=${importResult.syncedChunks} batches=${importResult.batches} inserted=${importResult.inserted} updated=${importResult.updated}`
      );
    } else {
      console.log("[import] openclaw skipped (missing home dir or sqlite)");
    }
    const markdownLimit = normalizeInt(process.env.AGENT_MARKDOWN_IMPORT_LIMIT, 100, 1, 500);
    const markdownResults = await importMarkdownMemoriesIfPresent(apiBase, apiKey, tenantId, markdownLimit, batchSize, targets);
    for (const result of markdownResults) {
      if (result.status !== "imported") {
        console.log(`[import] ${result.target} markdown skipped (${result.reason})`);
        continue;
      }
      console.log(
        `[import] ${result.target} markdown memories=${result.memories} inserted=${result.inserted} updated=${result.updated}`
      );
    }
  }

  if (direction === "both" || direction === "export") {
    const memories = await fetchExportMemories(apiBase, apiKey, tenantId, exportLimit, exportSource);
    const exportResults = await exportToTargets(Array.isArray(memories) ? memories : [], targets, tenantId);
    for (const result of exportResults) {
      if (result.status !== "exported") {
        console.log(`[export] ${result.target} skipped (${result.reason})`);
        continue;
      }
      const reindexStatus =
        result.reindex.status === "ok" ? "reindex=ok" : `reindex=skipped(${result.reindex.reason})`;
      console.log(`[export] ${result.target} wrote ${result.exportFile} ${reindexStatus}`);
    }
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
