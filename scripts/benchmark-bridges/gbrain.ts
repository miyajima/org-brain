#!/usr/bin/env bun

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const root = process.env.GBRAIN_ROOT;
if (!root) throw new Error("GBRAIN_ROOT is required");
const packageRoot = `${root.replace(/\/+$/gu, "")}/node_modules/gbrain/src/core`;
const { PGLiteEngine } = await import(
  pathToFileURL(`${packageRoot}/pglite-engine.ts`).href
);
const { importFromContent } = await import(
  pathToFileURL(`${packageRoot}/import-file.ts`).href
);

const port = Number(process.env.PORT ?? 8791);
if (!Number.isInteger(port) || port < 1) throw new Error("PORT must be a positive integer");

const preserveTables = new Set([
  "sources",
  "config",
  "gbrain_cycle_locks",
  "subagent_rate_leases"
]);

let engine = new PGLiteEngine();
let recordsBySlug = new Map<string, Record<string, unknown>>();

function slugFor(record: Record<string, unknown>) {
  const id = String(record.id ?? record.external_key ?? `memory-${recordsBySlug.size + 1}`);
  return `benchmark/${id}`.toLowerCase();
}

async function resetTables() {
  const rows = await engine.executeRaw<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const tables = rows
    .map((row) => row.tablename)
    .filter((table) => !preserveTables.has(table));
  if (tables.length === 0) return;
  const list = tables.map((table) => `"${table.replace(/"/gu, "\"\"")}"`).join(", ");
  await engine.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

async function reset() {
  await resetTables();
  recordsBySlug = new Map();
}

async function body(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

await engine.connect({});
await engine.initSchema();

createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    const payload = await body(request);
    if (request.url === "/reset") {
      await reset();
      json(response, 200, { ok: true });
      return;
    }
    if (request.url === "/capture") {
      const record = (payload.record ?? {}) as Record<string, unknown>;
      const slug = slugFor(record);
      const content = String(record.content ?? record.summary ?? "");
      const source = [
        "---",
        "type: note",
        `tenant_id: ${String(record.tenant_id ?? "default")}`,
        `project_id: ${String(record.project_id ?? "")}`,
        `kind: ${String(record.kind ?? "note")}`,
        "---",
        "",
        content
      ].join("\n");
      await importFromContent(engine, slug, source, { noEmbed: true });
      recordsBySlug.set(slug, { ...record });
      json(response, 200, { id: record.id, slug });
      return;
    }
    if (request.url === "/search") {
      const query = payload.query ?? {};
      const limit = Math.max(1, Number(query.limit ?? 5));
      const rows = await engine.searchKeyword(String(query.query ?? ""), { limit });
      const results = rows
        .map((row: { slug: string; score?: number }) => {
          const slug = row.slug.toLowerCase();
          const memory = recordsBySlug.get(slug);
          return memory ? { memory, score: row.score ?? 0 } : null;
        })
        .filter(Boolean);
      json(response, 200, {
        results,
        usage: { turns: 1, cost_usd: 0 },
        meta: { provider: "gbrain", mode: "keyword", llm_in_retrieval_loop: false }
      });
      return;
    }
    if (request.url === "/capabilities") {
      json(response, 200, {});
      return;
    }
    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`gbrain benchmark bridge listening on 127.0.0.1:${port}\n`);
});
