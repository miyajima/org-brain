#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";

function parseArgs(argv) {
  const options = {
    count: 100_000,
    queries: 200,
    db: resolve(".benchmark", "local-scale.sqlite"),
    output: resolve("benchmark-results", "local-scale-latest.json"),
    progress: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = arg.includes("=") ? arg.split("=", 2)[1] : undefined;
    if (arg === "--count" || arg.startsWith("--count=")) {
      options.count = Number(value ?? argv[++index]);
    } else if (arg === "--queries" || arg.startsWith("--queries=")) {
      options.queries = Number(value ?? argv[++index]);
    } else if (arg === "--db" || arg.startsWith("--db=")) {
      options.db = resolve(value ?? argv[++index]);
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      options.output = resolve(value ?? argv[++index]);
    } else if (arg === "--progress") {
      options.progress = true;
    }
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("--count must be a positive integer");
  if (!Number.isInteger(options.queries) || options.queries < 1) throw new Error("--queries must be a positive integer");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue / 100) - 1);
  return sorted[Math.max(0, index)];
}

async function seed(store, count, progress) {
  await store.init();
  const db = store.open();
  const insertMemory = db.prepare(
    `INSERT INTO memories(
      id, tenant_id, project_id, kind, lifecycle_state, scope_type, scope_key,
      content, summary, tags_json, entities_json, source, source_refs_json,
      external_key, actor_type, actor_id, created_at, updated_at, content_hash,
      current_version, root_memory_id, revised_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = db.prepare(
    "INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities) VALUES(?,?,?,?,?,?)"
  );
  const insertVersion = db.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, snapshot_json, content_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?)`
  );
  const started = performance.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM memories_fts;
      DELETE FROM memory_edges;
      DELETE FROM memory_versions;
      DELETE FROM memory_deletions;
      DELETE FROM memories;
    `);
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      const id = `scale-${String(index).padStart(6, "0")}`;
      const marker = `scalequery${String(index).padStart(6, "0")}`;
      const content = `${marker} durable scale memory ${index} with authoritative local provenance.`;
      const summary = `${marker} memory ${index}`;
      const contentHash = sha256(content);
      const sourceReferences = [{ type: "benchmark", ref: `scale:${index}` }];
      const snapshot = {
        id,
        tenant_id: "scale",
        project_id: "scale-project",
        kind: "fact",
        lifecycle_state: "active",
        scope_type: "project",
        scope_key: "scale-project",
        content,
        summary,
        tags: ["scale"],
        entities: [],
        source: "scale-benchmark",
        source_references: sourceReferences,
        external_key: id,
        actor_type: "benchmark",
        actor_id: "scale",
        created_at: now + index,
        updated_at: now + index,
        valid_from: null,
        valid_until: null,
        confidence_score: 0.9,
        utility_score: 0.9,
        content_hash: contentHash,
        current_version: 1,
        rationale: null,
        evidence: [],
        conflicts: [],
        permissions: []
      };
      insertMemory.run(
        id,
        "scale",
        "scale-project",
        "fact",
        "active",
        "project",
        "scale-project",
        content,
        summary,
        '["scale"]',
        "[]",
        "scale-benchmark",
        JSON.stringify(sourceReferences),
        id,
        "benchmark",
        "scale",
        now + index,
        now + index,
        contentHash,
        1,
        id,
        now + index
      );
      insertFts.run(id, "scale", content, summary, '["scale"]', "[]");
      insertVersion.run(
        `scale-version-${String(index).padStart(6, "0")}`,
        id,
        "scale",
        1,
        "capture",
        JSON.stringify(snapshot),
        contentHash,
        now + index
      );
      if (progress && (index + 1) % 10_000 === 0) {
        process.stderr.write(`seeded ${index + 1}/${count}\n`);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return performance.now() - started;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.db), { recursive: true });
  const store = new LocalMemoryStore(options.db);
  const seedDurationMs = await seed(store, options.count, options.progress);
  const indexStarted = performance.now();
  await store.rebuildIndex();
  const indexDurationMs = performance.now() - indexStarted;
  const latencies = [];
  const coldLatencies = [];
  let failures = 0;
  for (let index = 0; index < options.queries; index += 1) {
    const target = Math.floor(index * options.count / options.queries);
    const marker = `scalequery${String(target).padStart(6, "0")}`;
    const started = performance.now();
    const results = await store.search({
      tenant_id: "scale",
      project_id: "scale-project",
      query: `${marker} authoritative provenance`,
      limit: 5,
      search_mode: "hybrid_v4"
    });
    const latency = performance.now() - started;
    if (index === 0) coldLatencies.push(latency);
    else latencies.push(latency);
    if (results[0]?.memory.id !== `scale-${String(target).padStart(6, "0")}`) failures += 1;
  }
  const verification = await store.verify();
  const warmLatencies = latencies.length > 0 ? latencies : coldLatencies;
  const inspection = store.open({ readOnly: true });
  let segmentCount;
  try {
    segmentCount = Number(
      inspection.prepare(
        "SELECT COUNT(*) AS count FROM memory_retrieval_units_v4 WHERE unit_type = 'segment'"
      ).get().count
    );
  } finally {
    inspection.close();
  }
  const memory = process.memoryUsage();
  const report = {
    benchmark: "orgbrain-local-scale-v1",
    generated_at: new Date().toISOString(),
    settings: {
      record_count: options.count,
      query_count: options.queries,
      search_mode: "hybrid_v4",
      embedding_provider: "local-sparse-feature-hash-v2-degraded",
      quality_embedding_contract: "pinned ONNX float16 BLOB",
      segment_candidate_limit: 24,
      parent_candidate_limit: 50,
      target_p95_ms: 500
    },
    metrics: {
      seed_duration_ms: Number(seedDurationMs.toFixed(2)),
      index_duration_ms: Number(indexDurationMs.toFixed(2)),
      cold_search_latency_ms: Number(coldLatencies[0].toFixed(2)),
      warm_search_latency_p50_ms: Number(percentile(warmLatencies, 50).toFixed(2)),
      warm_search_latency_p95_ms: Number(percentile(warmLatencies, 95).toFixed(2)),
      warm_search_latency_max_ms: Number(Math.max(...warmLatencies).toFixed(2)),
      segment_count: segmentCount,
      memory_rss_bytes: memory.rss,
      memory_heap_used_bytes: memory.heapUsed,
      retrieval_failures: failures,
      database_bytes: (await stat(options.db)).size
    },
    verification,
    passed:
      failures === 0 &&
      verification.ok &&
      segmentCount <= options.count * 2 &&
      percentile(warmLatencies, 95) <= 500
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
