#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value.trim();
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
      tags: ["openclaw", "chunk"],
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

function renderOrgBrainMarkdown(memories) {
  const lines = [];
  lines.push("# OrgBrain Sync");
  lines.push("");
  lines.push(`GeneratedAt: ${new Date().toISOString()}`);
  lines.push("");
  for (const memory of memories) {
    const created = typeof memory.created_at === "number" ? new Date(memory.created_at).toISOString() : "unknown";
    lines.push(`## ${created} ${memory.id}`);
    lines.push("");
    lines.push(`- Source: ${memory.source ?? "org-brain"}`);
    if (memory.external_key) lines.push(`- ExternalKey: ${memory.external_key}`);
    if (memory.summary) {
      lines.push(`- Summary: ${String(memory.summary).slice(0, 1000)}`);
    }
    lines.push("");
    lines.push("```text");
    lines.push(String(memory.content ?? "").slice(0, 20_000));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function tryOpenClawReindex() {
  try {
    await execFileAsync("openclaw", ["memory", "index"], { maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const apiBase = getRequiredEnv("ORGBRAIN_API_BASE");
  const apiKey = getRequiredEnv("ORGBRAIN_API_KEY");
  const tenantId = (process.env.ORGBRAIN_TENANT_ID ?? "default").trim() || "default";
  const direction = (process.env.SYNC_DIRECTION ?? "both").trim().toLowerCase();
  const chunkLimit = normalizeInt(process.env.OPENCLAW_CHUNK_LIMIT, 200, 1, 1000);
  const batchSize = normalizeInt(process.env.SYNC_BATCH_SIZE, 50, 1, 200);
  const exportLimit = normalizeInt(process.env.ORGBRAIN_EXPORT_LIMIT, 200, 1, 500);

  const sqlitePath = resolveHome(process.env.OPENCLAW_MEMORY_DB ?? "~/.openclaw/memory/main.sqlite");
  const openclawWorkspace = resolveHome(process.env.OPENCLAW_WORKSPACE ?? "~/clawd");
  const exportFile = path.join(openclawWorkspace, "memory", "org-brain-sync.md");

  if (direction !== "both" && direction !== "import" && direction !== "export") {
    throw new Error("SYNC_DIRECTION must be one of: both, import, export");
  }

  if (direction === "both" || direction === "import") {
    const chunkRows = await readOpenClawChunks(sqlitePath, chunkLimit);
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

    console.log(
      `[import] synced chunks=${items.length} batches=${batches.length} inserted=${inserted} updated=${updated}`
    );
  }

  if (direction === "both" || direction === "export") {
    const memories = await fetchApiJson(
      apiBase,
      apiKey,
      `/v1/memories?tenant_id=${encodeURIComponent(tenantId)}&source=org-brain&limit=${exportLimit}`
    );
    const body = renderOrgBrainMarkdown(Array.isArray(memories) ? memories : []);

    await mkdir(path.dirname(exportFile), { recursive: true });
    await writeFile(exportFile, body, "utf8");
    const reindexed = await tryOpenClawReindex();
    console.log(`[export] wrote ${exportFile} entries=${Array.isArray(memories) ? memories.length : 0}`);
    console.log(`[export] openclaw memory index ${reindexed ? "ok" : "skipped"}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
