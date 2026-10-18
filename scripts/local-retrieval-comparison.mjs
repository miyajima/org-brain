#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { localDenseEmbeddingProviderFromEnvironment } from "../packages/orgbrain-cli/src/lib/local-dense-embedding.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function summarizeRetrieval(items) {
  const positives = items.filter((row) => row.expected_ids.length > 0);
  const negatives = items.filter((row) => row.expected_ids.length === 0);
  const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    positive_count: positives.length,
    hit_at_1: mean(positives.map((row) => row.rank === 1 ? 1 : 0)),
    hit_at_5: mean(positives.map((row) => row.rank > 0 && row.rank <= 5 ? 1 : 0)),
    mrr_at_5: mean(positives.map((row) => row.rank > 0 && row.rank <= 5 ? 1 / row.rank : 0)),
    negative_count: negatives.length,
    negative_any_result_rate: mean(negatives.map((row) => row.returned_ids.length ? 1 : 0)),
    latency_ms_p50: [...items.map((row) => row.elapsed_ms)].sort((a,b) => a-b)[Math.floor(items.length / 2)] ?? null
  };
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i+1]);
  for (const name of ["--db", "--queries", "--output"]) if (!args.get(name)) throw new Error(`missing ${name}`);
  const provider = localDenseEmbeddingProviderFromEnvironment();
  if (!provider) throw new Error("comparison requires an explicitly configured dense provider");
  const queryBytes = await readFile(args.get("--queries"));
  const { queries } = JSON.parse(queryBytes);
  if (!Array.isArray(queries) || !queries.length) throw new Error("queries must be nonempty");
  const at = args.has("--at") ? Number(args.get("--at")) : Date.now();
  if (!Number.isFinite(at) || at <= 0) throw new Error("--at must be a positive epoch in milliseconds");
  const dbPath = resolve(args.get("--db"));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const corpusRows = db.prepare("SELECT id, tenant_id, project_id, current_version, content_hash, lifecycle_state FROM memories ORDER BY id").all();
  const ids = new Set(corpusRows.filter((row) => row.tenant_id === "default").map((row) => row.id));
  for (const row of queries) for (const id of row.expected_ids) if (!ids.has(id)) throw new Error(`unknown target ${id}`);
  db.close();
  const corpusHash = digest(JSON.stringify(corpusRows));
  const sparse = new LocalMemoryStore(dbPath, { denseEmbeddingProvider: null });
  const actualCalls = { query_calls: 0, document_batches: 0, document_count: 0 };
  const originalQuery = provider.embedQuery.bind(provider);
  const originalDocuments = provider.embedDocuments.bind(provider);
  provider.embedQuery = async (query) => { actualCalls.query_calls += 1; return originalQuery(query); };
  provider.embedDocuments = async (texts) => {
    actualCalls.document_batches += 1;
    actualCalls.document_count += texts.length;
    return originalDocuments(texts);
  };
  const dense = new LocalMemoryStore(dbPath, { denseEmbeddingProvider: provider });
  const run = async (store) => {
    const items = [];
    for (const row of queries) {
      const start = performance.now();
      const candidates = await store.search({tenant_id: "default", query: row.query, project_id: null, limit: 5, search_mode: "hybrid_v4", at});
      const selected = await store.selectMemorySearchResults(candidates, {
        tenant_id: "default", project_id: null, query: row.query, usage_purpose: "test"
      });
      const returned = selected.results.map((entry) => entry.memory.id);
      const index = returned.findIndex((id) => row.expected_ids.includes(id));
      items.push({...row, rank: index + 1, returned_ids: returned, elapsed_ms: performance.now() - start});
    }
    return { metrics: summarizeRetrieval(items), items };
  };
  const baseline = await run(sparse);
  process.stderr.write("Sparse baseline complete; rebuilding dense projection in the supplied evaluation DB.\n");
  const projection = await dense.rebuildDenseEmbeddings({tenant_id: "default"});
  const result = await run(dense);
  const check = new DatabaseSync(dbPath, {readOnly: true});
  const after = check.prepare("SELECT id, tenant_id, project_id, current_version, content_hash, lifecycle_state FROM memories ORDER BY id").all();
  const embeddingRows = check.prepare("SELECT provider,feature_count,vector_format,count(*) AS count FROM memory_retrieval_unit_embeddings_v4 GROUP BY provider,feature_count,vector_format").all();
  check.close();
  if (digest(JSON.stringify(after)) !== corpusHash) throw new Error("comparison corpus changed");
  const tags = await (await fetch(`${provider.endpoint}/api/tags`)).json();
  const model = tags.models?.find((row) => row.name === provider.model || row.model === provider.model);
  const report = {
    schema: "local-retrieval-comparison/v1", at, corpus_hash: corpusHash, corpus_count: corpusRows.length,
    query_hash: digest(queryBytes), query_origin: "authored from existing summaries before retrieving results; incomplete relevance labels",
    search_mode: "hybrid_v4", project_filter: null, candidate_limit: 5,
    provider: provider.provider, model_digest: model?.digest ?? null, model_details: model?.details ?? null,
    dimensions: provider.dimensions, projection, embedding_rows: embeddingRows, actual_calls: actualCalls,
    sparse: baseline, dense: result
  };
  await writeFile(args.get("--output"), JSON.stringify(report, null, 2) + "\n", {mode: 0o600, flag: "wx"});
  process.stdout.write(JSON.stringify({corpus_count: report.corpus_count, projection, actual_calls: actualCalls,
    sparse: baseline.metrics, dense: result.metrics, output: args.get("--output")}) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
