#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { LocalMemoryStore } from "../lib/local-memory-store.mjs";

function parseArgs(argv) {
  const options = {
    port: 8085,
    db: ".benchmark/precisionmem-orgbrain.sqlite",
    minimumScore: 0.065
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      return argv[index];
    };
    if (value === "--port") options.port = Number(next());
    else if (value === "--db") options.db = next();
    else if (value === "--minimum-score") options.minimumScore = Number(next());
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be between 1 and 65535");
  }
  if (!Number.isFinite(options.minimumScore) || options.minimumScore < 0) {
    throw new Error("--minimum-score must be a non-negative finite number");
  }
  return options;
}

function memoryKind(type) {
  if (type === "decision") return "decision";
  if (type === "preference") return "preference";
  if (type === "constraint") return "constraint";
  return "fact";
}

function normalizeScope(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "user:universal";
}

function normalizeUserId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "test-user";
}

function isInactiveMetadata(metadata) {
  return Boolean(
    metadata?.superseded_by ||
    metadata?.resolved_at ||
    metadata?.type === "open_question"
  );
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

export function createPrecisionMemOperations({ store, reset, minimumScore = 0.065 }) {
  if (!store) throw new Error("createPrecisionMemBridge requires a store");
  if (!Number.isFinite(minimumScore) || minimumScore < 0) {
    throw new Error("minimumScore must be a non-negative finite number");
  }

  const add = async (body) => {
    const beliefId = String(body?.metadata?.beliefId ?? "").trim();
    const text = String(body?.text ?? "").trim();
    if (!beliefId || !text) {
      return { status: 400, body: { error: "text and metadata.beliefId are required" } };
    }
    const userId = normalizeUserId(body.user_id);
    const scope = normalizeScope(body?.metadata?.scope);
    await store.capture({
      id: beliefId,
      tenant_id: userId,
      project_id: scope,
      kind: memoryKind(body?.metadata?.type),
      lifecycle_state: isInactiveMetadata(body?.metadata) ? "suppressed" : "active",
      scope_type: "project",
      scope_key: scope,
      content: text,
      summary: text,
      tags: Array.isArray(body.aliases) ? body.aliases : [],
      entities: [],
      source: "precisionmembench",
      source_references: [{ type: "benchmark-belief", ref: beliefId }],
      external_key: `precisionmembench:${beliefId}`,
      actor_type: "benchmark",
      actor_id: "precisionmembench",
      valid_from: null,
      valid_until: null,
      confidence_score: 1,
      utility_score: 0.5,
      rationale: null,
      evidence: [],
      conflicts: [],
      permissions: []
    });
    return { status: 200, body: { ok: true } };
  };

  return {
    add,
    async reset() {
      if (typeof reset === "function") await reset();
      return { status: 200, body: { ok: true } };
    },
    async search(body) {
      const userId = normalizeUserId(body.user_id);
      const scope = normalizeScope(body.scope);
      const query = String(body.query ?? "");
      const requestedLimit = Number(body.limit);
      const limit = Number.isInteger(requestedLimit)
        ? Math.max(0, Math.min(50, requestedLimit))
        : 20;
      const results = query.trim() && limit > 0
        ? (await store.retrieveContext({
          tenant_id: userId,
          project_id: scope,
          principal_id: `precisionmembench:${userId}`,
          query,
          limit: 50,
          top_k: limit,
          token_budget: 8_000,
          search_mode: "hybrid_v4",
          minimum_total_score: minimumScore
        })).results.slice(0, limit)
        : [];
      return {
        status: 200,
        body: {
          results: results.map((result) => ({
            id: result.memory.id,
            memory: result.memory.content,
            metadata: { beliefId: result.memory.id },
            score: Number(result.score?.total ?? result.score ?? 0)
          }))
        }
      };
    }
  };
}

export function createPrecisionMemBridge(options) {
  const operations = createPrecisionMemOperations(options);
  return async function handle(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "DELETE" && url.pathname === "/reset") {
        const result = await operations.reset();
        writeJson(response, result.status, result.body);
        return;
      }
      if (
        (request.method === "POST" && (url.pathname === "/add" || url.pathname === "/update")) ||
        (request.method === "PUT" && url.pathname === "/update")
      ) {
        const result = await operations.add(await readJson(request));
        writeJson(response, result.status, result.body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/search") {
        const result = await operations.search(await readJson(request));
        writeJson(response, result.status, result.body);
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

async function clearStore(store) {
  await store.init();
  const db = store.open();
  try {
    db.exec(`
      DELETE FROM memories_fts;
      DELETE FROM memory_retrieval_units_fts;
      DELETE FROM memory_retrieval_units;
      DELETE FROM memory_embedding_features;
      DELETE FROM memory_embedding_feature_stats;
      DELETE FROM memory_embeddings;
      DELETE FROM memory_edges;
      DELETE FROM memory_versions;
      DELETE FROM memory_deletions;
      DELETE FROM memories;
    `);
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const store = new LocalMemoryStore(options.db);
  const server = createServer(createPrecisionMemBridge({
    store,
    reset: () => clearStore(store),
    minimumScore: options.minimumScore
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  process.stdout.write(`${JSON.stringify({
    ready: true,
    adapter: "orgbrain",
    url: `http://127.0.0.1:${options.port}`,
    db: options.db,
    minimum_score: options.minimumScore
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
