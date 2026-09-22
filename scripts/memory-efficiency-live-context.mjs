#!/usr/bin/env node
// Isolated live-agent experiment: no live memory database or provider access.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [manifestPath, taskId, variant, databasePath] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const task = manifest.tasks.find((item) => item.id === taskId);
if (!task || !["full", "compact"].includes(variant)) throw new Error("invalid_live_context_request");
const root = variant === "full" ? manifest.baseline_root : manifest.candidate_root;
const load = (file) => import(pathToFileURL(join(root, file)).href);
const { LocalMemoryStore } = await load("packages/orgbrain-cli/src/lib/local-memory-store.mjs");
const { handleLocalMcpRequest } = await load("packages/orgbrain-cli/src/local-mcp.mjs");
const store = new LocalMemoryStore(resolve(databasePath), {
  env: {}, denseEmbeddingProvider: null,
  memoryJudge: async () => ({ mode: "off", applied: false, status: "disabled", decisions: [] })
});
const setupStarted = performance.now();
for (const [index, lesson] of task.lessons.entries()) {
  await store.capture({ tenant_id: "default", project_id: "efficiency-live", work_type: "debug", kind: "pitfall",
    source: "source-verified-experiment", external_key: `${taskId}-${index}`, confidence_score: 0.9,
    utility_score: 0.8, ...lesson });
}
const setupMs = performance.now() - setupStarted;
const started = performance.now();
const result = await handleLocalMcpRequest(store, { method: "tools/call", params: {
  name: "orgbrain_context_enrich", arguments: { tenant_id: "default", project_id: "efficiency-live",
    work_type: "debug", query: task.query, task_title: task.title, top_k: 3 }
} });
const retrievalMs = performance.now() - started;
if (result.isError) throw new Error("context_retrieval_failed");
const context = result.content[0].text;
const body = JSON.parse(context);
console.log(JSON.stringify({ context, setup_ms: setupMs, retrieval_ms: retrievalMs,
  returned: body.results?.length ?? 0, abstained: body.evidence_bundle?.abstention_recommended,
  reported_tokens: body.evidence_bundle?.estimated_tokens,
  budget: body.evidence_bundle?.token_budget, provider_calls: 0 }));
