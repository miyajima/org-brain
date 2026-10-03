#!/usr/bin/env node
// Run both implementations against identical hashed fixtures, clock and bounds.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadReplayFixtures, settings, replay } from "./fixtures/natural-instruction-recall.mjs";
import { memories, positiveCases } from "./fixtures/natural-query-recall.mjs";
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (!option("--baseline-root") || !option("--fixtures-root") || !option("--output")) {
  throw new Error("Use --baseline-root <checkout> --fixtures-root <private-input-directory> --output <private-json>");
}
const candidateRoot = resolve(import.meta.dirname, "..");
const baselineRoot = resolve(option("--baseline-root"));
const fixturesRoot = resolve(option("--fixtures-root"));
const outputPath = resolve(option("--output"));
for (const root of [candidateRoot, baselineRoot]) {
  if ([fixturesRoot, outputPath].some((path) => path === root || path.startsWith(`${root}${sep}`))) {
    throw new Error("Keep private replay fixtures and output outside repository checkouts");
  }
}
const { files, sourceClean, primary, posthoc } = await loadReplayFixtures(fixturesRoot);
const at = Date.parse(primary.freeze);
if (!Number.isFinite(at)) throw new Error("Private fixture needs a valid frozen timestamp");
const originalNow = Date.now;
Date.now = () => at;
globalThis.fetch = async () => { throw new Error("offline_replay_network_forbidden"); };
const output = { schema: "natural-instruction-recall/v1", generated_at: new Date(originalNow()).toISOString(),
  scope: "Regression replay of previously observed misses, not held-out, automatic-capture, production or comparative task-benefit evidence",
  primary_query_unchanged: true, fixture_sha256: files, source_clean_primary: true,
  settings, node: process.version, icu: process.versions.icu, repetitions: 3,
  production_db_access: false, provider_calls: 0, actual_task_savings: null, variants: {} };
const projection = (rows) => rows.map(({ id, search_ids, delivered_ids, scores }) => ({ id, search_ids, delivered_ids, scores }));
try {
  for (const [name, root] of Object.entries({ baseline: baselineRoot, candidate: candidateRoot })) {
    const load = (file) => import(pathToFileURL(join(root, "packages/orgbrain-cli/src/lib", file)).href);
    const { LocalMemoryStore } = await load("local-memory-store.mjs");
    const { buildCompactMemoryContext } = await load("compact-memory-context.mjs");
    const runs = [];
    for (let repeat = 0; repeat < output.repetitions; repeat++) runs.push({
      primary: await replay(LocalMemoryStore, buildCompactMemoryContext, sourceClean.records, primary.cases, at),
      posthoc: await replay(LocalMemoryStore, buildCompactMemoryContext, posthoc.records, posthoc.cases, at)
    });
    const rows = runs[0];
    const remaining = await replay(LocalMemoryStore, buildCompactMemoryContext,
      memories.map(({ key, ...memory }) => ({ ...memory, id: key, source: memory.source_references?.[0]?.ref })),
      positiveCases.filter(({ category }) => category === "original-full"), at);
    const implementation_sha256 = {};
    for (const file of ["local-memory-store.mjs", "local-task-query.mjs", "compact-memory-context.mjs"]) {
      implementation_sha256[file] = createHash("sha256").update(await readFile(join(root, "packages/orgbrain-cli/src/lib", file))).digest("hex");
    }
    const hits = (row) => row.expected.filter((id) => row.delivered_ids.includes(id)).length;
    output.variants[name] = { ...rows, remaining_original_full_probes: remaining,
      base_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      implementation_sha256, summary: {
      primary_expected_memories: primary.cases[0].expected.length,
      primary_delivered_relevant: hits(rows.primary[0]),
      posthoc_keyword_hits: rows.posthoc.filter((row) => row.kind === "posthoc_keyword_probe" && hits(row)).length,
      posthoc_natural_hits: rows.posthoc.filter((row) => row.kind === "posthoc_natural_probe" && hits(row)).length,
      remaining_original_full_hits: remaining.filter((row) => hits(row)).length,
      negative_abstentions: rows.posthoc.filter((row) => !row.expected.length && !row.delivered_ids.length && row.abstention_recommended).length,
      fields_preserved: [...rows.primary, ...rows.posthoc].every((row) => row.fields_preserved),
      within_budget: [...rows.primary, ...rows.posthoc].every((row) => row.response_tokens <= settings.token_budget),
      stable_ids_and_scores: runs.every((run) => ["primary", "posthoc"].every((kind) =>
        JSON.stringify(projection(run[kind])) === JSON.stringify(projection(rows[kind]))))
    }, repeat_projections: runs.map((run) => ({ primary: projection(run.primary), posthoc: projection(run.posthoc) })) };
  }
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(output.variants).map(([name, run]) => [name, run.summary])), null, 2));
} finally { Date.now = originalNow; }
