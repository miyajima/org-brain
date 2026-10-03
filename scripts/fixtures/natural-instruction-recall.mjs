// Public, fully invented archive/storage examples. Private historical replay
// inputs must be supplied separately; this file contains no private source data.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const at = Date.parse("2026-10-03T00:00:00Z");
export const syntheticRecords = [
  { id: "archive-method", summary: "Safe archive restore method", content: "A safe archive restore method can run against an isolated snapshot. The archive fixture required checksum dependencies.",
    rationale: "The isolated snapshot protects live archives.", reuse_rule: "Only apply this historical procedure to a matching archive format after checking the current version.", source: "fixtures/archive-method.md" },
  { id: "storage-failure", summary: "Previous storage failure", content: "A previous storage failure resulted from overlapping maintenance jobs.",
    rationale: "Concurrent writers corrupted shared state.", reuse_rule: "Use a dedicated storage volume for each maintenance job; do not erase user data.", source: "fixtures/storage-failure.md" }
];
export const syntheticPrimary = {
  id: "synthetic-compound-instruction", query: "What archive restore method can run safely and what previous storage failure should we avoid?",
  expected: ["archive-method", "storage-failure"]
};
export const syntheticCases = [
  { id: "archive-keywords", query: "archive restore method isolated snapshot", expected: ["archive-method"] },
  { id: "archive-natural", query: "What dependencies does the archive fixture require?", expected: ["archive-method"] },
  { id: "storage-keywords", query: "previous storage failure overlapping maintenance jobs", expected: ["storage-failure"] },
  { id: "storage-natural", query: "What previous storage failure should we avoid?", expected: ["storage-failure"] },
  { id: "unknown-incident", query: "ArchiveBatch731 missing checksum evidence root cause", expected: [] },
  { id: "unknown-cause", query: "Does the previous storage failure prove the cause of ArchiveBatch731 checksum mismatch?", expected: [] },
  { id: "unknown-history", query: "Why did the archive environment disappear?", expected: [] },
  { id: "unknown-current-state", query: "Have the current archive restore 999 tests actually passed?", expected: [] },
  { id: "wrong-project", query: "archive restore method isolated snapshot", project_id: "another-project", expected: [] },
  { id: "unrelated", query: "galactic bakery payroll reconciliation", expected: [] }
];

// A caller-supplied hash manifest prevents accidental query/corpus tuning during
// a private replay. Never copy these inputs or full replay outputs into Git.
export async function loadReplayFixtures(root) {
  const files = JSON.parse(await readFile(join(root, "fixture-sha256.json"), "utf8"));
  const fixtures = {};
  for (const name of ["frozen-prospective-queries.json", "source-clean-corpus.json", "frozen-posthoc-corpus-queries.json"]) {
    const bytes = await readFile(join(root, name));
    if (!files[name] || createHash("sha256").update(bytes).digest("hex") !== files[name]) throw new Error(`Frozen fixture changed: ${name}`);
    fixtures[name] = JSON.parse(bytes);
  }
  return { files, sourceClean: fixtures["source-clean-corpus.json"], primary: fixtures["frozen-prospective-queries.json"],
    posthoc: fixtures["frozen-posthoc-corpus-queries.json"] };
}
export const settings = { top_k: 3, minimum_total_score: 0.065, token_budget: 1500 };

export async function withStore(LocalMemoryStore, records, run, queryAt = at) {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-instruction-recall-"));
  try {
    const store = new LocalMemoryStore(join(directory, "isolated.sqlite"), {
      env: {}, denseEmbeddingProvider: null, contextSearchJudge: null,
      memoryJudge: async () => ({ mode: "off", applied: false, status: "disabled", decisions: [] })
    });
    for (const record of records) await store.capture({
      tenant_id: "instruction-recall", project_id: "fixture-project", work_type: "review", kind: "pitfall",
      confidence_score: 0.9, utility_score: 0.8, created_at: queryAt, ...record,
      source: "isolated-source-replay", external_key: record.id,
      source_references: record.source_references ?? [{ type: "file", ref: record.source }]
    });
    return await run(store);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function queryStore(store, buildCompactMemoryContext, testCase, overrides = {}, queryAt = at) {
  const results = await store.search({ tenant_id: "instruction-recall", project_id: testCase.project_id ?? "fixture-project",
    principal_id: "reader", query: testCase.query, work_type: "review", at: queryAt,
    limit: settings.top_k, minimum_total_score: settings.minimum_total_score, ...overrides });
  const { response } = buildCompactMemoryContext({ results, query: testCase.query, topK: settings.top_k,
    tokenBudget: settings.token_budget, at: queryAt, usageId: "isolated-replay-not-real-use", verificationSampled: false });
  return { results, response };
}

export async function replay(LocalMemoryStore, buildCompactMemoryContext, records, cases, queryAt = at) {
  return withStore(LocalMemoryStore, records, async (store) => {
    const rows = [];
    for (const testCase of cases) {
      const { results, response } = await queryStore(store, buildCompactMemoryContext, testCase, {}, queryAt);
      rows.push({ ...testCase, search_ids: results.map(({ memory }) => memory.id),
        delivered_ids: response.results.map(({ memory }) => memory.id),
        scores: results.map(({ memory, score }) => ({ id: memory.id, total: score.total })),
        abstention_recommended: response.evidence_bundle.abstention_recommended,
        missing_evidence: response.evidence_bundle.missing_evidence,
        evidence_status: response.evidence_bundle.evidence_status,
        response_tokens: response.evidence_bundle.estimated_tokens,
        fields_preserved: response.evidence_bundle.evidence.every((evidence) => {
          const record = records.find(({ id }) => id === evidence.memory_id);
          return evidence.text === record.content && evidence.rationale === record.rationale
            && evidence.reuse_rule === record.reuse_rule && evidence.source_reference.ref === record.source
            && evidence.verification_state === "unverified";
        }) });
    }
    return rows;
  }, queryAt);
}
