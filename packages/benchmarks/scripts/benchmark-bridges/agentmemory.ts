#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const root = process.env.AGENTMEMORY_ROOT;
if (!root) throw new Error("AGENTMEMORY_ROOT is required");
const port = Number(process.env.PORT ?? 8789);
if (!Number.isInteger(port) || port < 1) throw new Error("PORT must be a positive integer");

const { SearchIndex } = await import(
  pathToFileURL(`${root.replace(/\/+$/u, "")}/src/state/search-index.ts`).href
);

let index = new SearchIndex();
let memories = new Map<string, Record<string, unknown>>();

async function body(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      json(response, 405, { error: "method not allowed" });
      return;
    }
    const payload = await body(request);
    if (request.url === "/reset") {
      index = new SearchIndex();
      memories = new Map();
      json(response, 200, { ok: true });
      return;
    }
    if (request.url === "/capture") {
      const record = payload.record ?? {};
      const id = String(record.id ?? record.external_key ?? `memory-${memories.size + 1}`);
      const content = String(record.content ?? record.summary ?? "");
      index.add({
        id,
        sessionId: String(record.project_id ?? "default"),
        timestamp: new Date(record.updated_at ?? Date.now()).toISOString(),
        type: String(record.kind ?? "conversation"),
        title: String(record.summary ?? content.slice(0, 80)),
        facts: [],
        narrative: content,
        concepts: Array.isArray(record.tags) ? record.tags.map(String) : [],
        files: [],
        importance: 5
      });
      memories.set(id, { ...record, id });
      json(response, 200, { id });
      return;
    }
    if (request.url === "/search") {
      const query = payload.query ?? {};
      const results = index.search(String(query.query ?? ""), Number(query.limit ?? 5))
        .map((row: { obsId: string; score: number }) => ({
          memory: memories.get(row.obsId),
          score: row.score
        }));
      json(response, 200, {
        results,
        usage: { turns: 1, cost_usd: 0 }
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
  process.stdout.write(`agentmemory benchmark bridge listening on 127.0.0.1:${port}\n`);
});
