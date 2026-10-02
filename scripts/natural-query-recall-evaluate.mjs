#!/usr/bin/env node
// Network-free default MCP retrieval replay. Never loads production databases.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { fixtureSource, positiveCases, negativeCases, seedRecallFixture } from "./fixtures/natural-query-recall.mjs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--baseline-root") || !args.includes("--output")) {
  throw new Error("Usage: node scripts/natural-query-recall-evaluate.mjs --baseline-root <checkout> --output <json>");
}
const roots = { baseline: resolve(option("--baseline-root")), candidate: resolve(import.meta.dirname, "..") };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sourceFiles = ["packages/orgbrain-cli/src/lib/local-memory-store.mjs",
  "packages/orgbrain-cli/src/lib/local-task-query.mjs", "packages/shared/src/retrieval-units-core.mjs",
  "packages/orgbrain-cli/src/local-mcp.mjs", "packages/orgbrain-cli/src/lib/compact-memory-context.mjs"];
const output = { schema: "natural-query-recall/v1", generated_at: new Date().toISOString(),
  scope: "synthetic local component regression replay, not held-out or production recall; no provider calls",
  fixture_source: fixtureSource, fixture_sha256: sha256(await readFile(new URL("./fixtures/natural-query-recall.mjs", import.meta.url))),
  node: process.version, icu: process.versions.icu, default_minimum_score_unchanged: true,
  top_k: 3, token_budget: 1500, warm_repetitions: 3,
  actual_task_time: null, actual_task_tokens: null, actual_provider_cost: null, variants: {} };
// Fail closed if an unexpectedly enabled provider tries to use fetch.
globalThis.fetch = async () => { throw new Error("offline_replay_network_forbidden"); };
for (const [name, root] of Object.entries(roots)) {
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  const { LocalMemoryStore } = await load("packages/orgbrain-cli/src/lib/local-memory-store.mjs");
  const { handleLocalMcpRequest } = await load("packages/orgbrain-cli/src/local-mcp.mjs");
  const { countContextTokens } = await load("packages/orgbrain-cli/src/lib/compact-memory-context.mjs");
  const directory = await mkdtemp(join(tmpdir(), `orgbrain-query-${name}-`));
  const cases = [];
  try {
    const stores = new Map();
    for (const fixture of [...positiveCases, ...negativeCases]) {
      const isolated = fixture.isolated ?? "all";
      if (!stores.has(isolated)) {
        const store = new LocalMemoryStore(join(directory, `${isolated}.sqlite`), { env: {}, denseEmbeddingProvider: null,
          memoryJudge: async () => ({ mode: "off", applied: false, status: "disabled", decisions: [] }),
          contextSearchJudge: null });
        stores.set(isolated, { store, ids: await seedRecallFixture(store, fixture.isolated) });
      }
      const { store, ids } = stores.get(isolated);
      const search = await store.search({ tenant_id: fixture.tenant_id ?? "recall",
        project_id: fixture.project_id ?? "fixture", principal_id: "reader", query: fixture.query,
        limit: 3, minimum_total_score: 0.065, work_type: "implementation" });
      const retrieved = search.map((item) => ids.get(item.memory.id) ?? "unknown");
      const samples = [];
      for (let repeat = 0; repeat < 4; repeat++) {
        const started = performance.now();
        const response = await handleLocalMcpRequest(store, { method: "tools/call", params: {
          name: "orgbrain_context_enrich", arguments: { tenant_id: fixture.tenant_id ?? "recall",
            project_id: fixture.project_id ?? "fixture", principal_id: "reader", query: fixture.query,
            top_k: 3, token_budget: 1500, work_type: "implementation", usage_purpose: "test" }
        } });
        const elapsed = performance.now() - started;
        if (response.isError) throw new Error(response.content[0].text);
        const text = response.content[0].text, result = JSON.parse(text);
        const returned = (result.results ?? []).map((item) => ids.get(item.memory?.id ?? item.id) ?? "unknown");
        samples.push({ returned, elapsed_ms: elapsed, response_tokens: countContextTokens(text),
          abstained: result.evidence_bundle?.abstention_recommended === true,
          missing_evidence: result.evidence_bundle?.missing_evidence ?? [] });
      }
      const sample = samples[1], expected = fixture.expected ?? [];
      const relevant = sample.returned.filter((key) => expected.includes(key)).length;
      cases.push({ id: fixture.id, category: fixture.category ?? "negative", query: fixture.query, expected,
        retrieved, search_recall_at_3: expected.length ? retrieved.filter((key) => expected.includes(key)).length / expected.length : null,
        ...sample, elapsed_ms: undefined, first_request_ms: Number(samples[0].elapsed_ms.toFixed(2)),
        warm_median_ms: Number(median(samples.slice(1).map((s) => s.elapsed_ms)).toFixed(2)),
        stable: samples.every((s) => JSON.stringify(s.returned) === JSON.stringify(sample.returned)),
        within_budget: samples.every((s) => s.response_tokens <= 1500),
        hit: expected.length > 0 && relevant > 0,
        recall_at_3: expected.length ? relevant / expected.length : null,
        precision_at_3: sample.returned.length ? relevant / sample.returned.length : null,
        passed: expected.length ? relevant === expected.length : sample.returned.length === 0 && sample.abstained });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const sourceHashes = {};
  for (const file of sourceFiles) {
    try { sourceHashes[file] = sha256(await readFile(join(root, file))); }
    catch (error) { if (error.code !== "ENOENT") throw error; sourceHashes[file] = null; }
  }
  const positives = cases.filter((c) => c.category !== "negative");
  const negatives = cases.filter((c) => c.category === "negative");
  output.variants[name] = { source_sha256: sourceHashes, cases, summary: {
    positive_cases: positives.length, hits_at_3: positives.filter((c) => c.hit).length,
    search_hits_at_3: positives.filter((c) => c.search_recall_at_3 > 0).length,
    macro_search_recall_at_3: positives.reduce((sum, c) => sum + c.search_recall_at_3, 0) / positives.length,
    macro_recall_at_3: positives.reduce((sum, c) => sum + c.recall_at_3, 0) / positives.length,
    returned_precision: positives.reduce((sum, c) => sum + c.returned.filter((key) => c.expected.includes(key)).length, 0)
      / (positives.reduce((sum, c) => sum + c.returned.length, 0) || 1),
    negative_cases: negatives.length, negative_abstentions: negatives.filter((c) => c.passed).length,
    false_positive_cases: negatives.filter((c) => c.returned.length > 0).length,
    original_full_hits: positives.filter((c) => c.category === "original-full" && c.hit).length,
    natural_hits: positives.filter((c) => c.category === "natural" && c.hit).length,
    all_stable: cases.every((c) => c.stable), all_within_budget: cases.every((c) => c.within_budget),
    warm_median_ms: median(cases.map((c) => c.warm_median_ms))
  } };
}
const destination = resolve(option("--output"));
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ report: destination, baseline: output.variants.baseline.summary,
  candidate: output.variants.candidate.summary }, null, 2));
