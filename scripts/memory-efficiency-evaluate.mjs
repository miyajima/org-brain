#!/usr/bin/env node
// Offline component replay. Never reads live memories or calls an AI provider.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { countContextTokens } from "../packages/orgbrain-cli/src/lib/compact-memory-context.mjs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--baseline-root") || !args.includes("--output")) {
  throw new Error("Usage: node scripts/memory-efficiency-evaluate.mjs --baseline-root <checkout> --output <json>");
}
const roots = { baseline: resolve(option("--baseline-root")), candidate: resolve(import.meta.dirname, "..") };
const sourceFiles = ["packages/orgbrain-cli/src/lib/local-memory-store.mjs", "packages/orgbrain-cli/src/local-mcp.mjs",
  "packages/shared/src/memory-capture-v2-runtime.mjs", "packages/orgbrain-cli/src/lib/compact-memory-context.mjs"];
const strong = "We decided to serialize SQLite diagnostics because concurrent writers contend on the same local database; when diagnosing SQLite lock errors, run the checks sequentially using scripts/local-memory.test.mjs and docs/MEMORY_USE_HISTORY.md.";
const weak = ["We decided to use the shared adapter for the application.",
  "Never print credentials in the application debug logs.", "Always keep the runtime configuration in the repository."];
const captureCases = [
  { id: "late_complete_lesson", text: [...weak, strong].join("\n\n"), expected: "serialize SQLite" },
  { id: "early_complete_lesson", text: [strong, ...weak].join("\n\n"), expected: "serialize SQLite" },
  { id: "transient_completion", text: "実装完了しました。`pnpm test` は成功し、commitとpushも完了しました。", none: true },
  { id: "unsupported_decision", text: "We decided to use the shared adapter for the application.", none: true },
  { id: "unresolved_gap", text: `${strong}\n## Gaps\nThe actual lock recovery is still unverified.`, none: true }
];
const sqlite = {
  content: "Run SQLite diagnostics sequentially to avoid database lock errors.", summary: "Serialize SQLite diagnostics",
  rationale: "Concurrent writers contend on the same SQLite database.",
  reuse_rule: "Only serialize diagnostics sharing one local database; independent databases can run concurrently."
};
const japanese = {
  content: "Cloudflareのデプロイ後は、稼働中APIの応答を確認する。", summary: "デプロイ後の稼働確認",
  rationale: "ローカルでのビルド成功だけでは、稼働中の構成や応答の正しさを証明できない。",
  reuse_rule: "公開先が承認済みのプロジェクトと一致する場合だけ実施し、別のプロジェクトなら停止する。"
};
const retrievalCases = [
  { id: "sqlite", query: "SQLite diagnostics database lock", memories: [sqlite], required: [sqlite.content, sqlite.rationale, sqlite.reuse_rule] },
  { id: "japanese_conditions", query: "Cloudflare デプロイ API 応答", memories: [japanese], required: [japanese.content, japanese.rationale, japanese.reuse_rule] },
  { id: "duplicate_lessons", query: "SQLite diagnostics database lock", memories: [sqlite, sqlite, sqlite], required: [sqlite.content, sqlite.rationale, sqlite.reuse_rule], maximum: 1 },
  { id: "oversized_first", query: "SQLite diagnostics database lock", memories: [{ ...sqlite, content: "SQLite diagnostics database lock background. ".repeat(900) }, sqlite], required: [sqlite.content, sqlite.reuse_rule] },
  { id: "irrelevant", query: "galactic bakery payroll", memories: [sqlite], abstain: true },
  { id: "conflicting", query: "SQLite diagnostics database lock", memories: [{ ...sqlite, conflicts: ["Procedure revoked pending investigation."] }], abstain: true }
];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const output = { schema: "memory-efficiency-component-replay/v1", generated_at: new Date().toISOString(),
  scope: "synthetic local component replay; no provider calls; same fixtures, budgets, and repetitions",
  token_basis: "o200k_base over complete serialized MCP text", repetitions: 5,
  actual_task_time: null, actual_provider_cost: null, user_bill_savings: null, variants: {} };

for (const [name, root] of Object.entries(roots)) {
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  const { extractDurableMemoryDrafts } = await load("packages/shared/src/memory-capture-v2-runtime.mjs");
  const { MEMORY_CAPTURE_HOOK_PROFILE } = await load("packages/shared/src/memory-capture-profile.generated.mjs");
  const { LocalMemoryStore } = await load("packages/orgbrain-cli/src/lib/local-memory-store.mjs");
  const { handleLocalMcpRequest } = await load("packages/orgbrain-cli/src/local-mcp.mjs");
  const captures = captureCases.map((item) => {
    const result = extractDurableMemoryDrafts({ source: "fixture", project_id: "efficiency", event_id: item.id, text: item.text }, { capture_profile: MEMORY_CAPTURE_HOOK_PROFILE });
    return { id: item.id, accepted: result.drafts.length, review: result.review_drafts.length,
      passed: item.none ? result.drafts.length === 0 : result.drafts.some((draft) => draft.content.includes(item.expected)) };
  });
  const retrievals = [];
  const directory = await mkdtemp(join(tmpdir(), `orgbrain-efficiency-${name}-`));
  try {
    for (const fixture of retrievalCases) {
      const store = new LocalMemoryStore(join(directory, `${fixture.id}.sqlite`), {
        env: {}, denseEmbeddingProvider: null,
        memoryJudge: async () => ({ mode: "off", applied: false, status: "disabled", decisions: [] })
      });
      for (const [index, memory] of fixture.memories.entries()) {
        await store.capture({ tenant_id: "default", project_id: fixture.id, work_type: "implementation", kind: "pitfall",
          source: "fixture", external_key: `${fixture.id}-${index}`, confidence_score: 0.9, utility_score: 0.8,
          source_references: [{ type: "file", ref: `docs/${fixture.id}-${index}.md` }], ...memory });
      }
      const samples = [];
      let last;
      for (let repeat = 0; repeat < 6; repeat++) {
        const started = performance.now();
        const result = await handleLocalMcpRequest(store, { method: "tools/call", params: {
          name: "orgbrain_context_enrich", arguments: { tenant_id: "default", project_id: fixture.id,
            query: fixture.query, work_type: "implementation", token_budget: 1500, top_k: 3 }
        } });
        const elapsed = performance.now() - started;
        if (result.isError) throw new Error(result.content[0].text);
        const text = result.content[0].text;
        last = JSON.parse(text);
        const evidenceText = JSON.stringify(last.evidence_bundle?.evidence ?? []);
        samples.push({ elapsed_ms: elapsed, tokens: countContextTokens(text),
          estimate_matches_actual: last.evidence_bundle?.estimated_tokens === countContextTokens(text),
          required_context_preserved: (fixture.required ?? []).every((needle) => evidenceText.includes(needle)),
          returned: last.results?.length ?? 0, abstained: last.evidence_bundle?.abstention_recommended === true });
      }
      const warm = samples.slice(1);
      const outcome = warm[0];
      retrievals.push({ id: fixture.id, tokens: median(warm.map((sample) => sample.tokens)),
        first_request_ms: Number(samples[0].elapsed_ms.toFixed(2)), warm_median_ms: Number(median(warm.map((sample) => sample.elapsed_ms)).toFixed(2)),
        returned: outcome.returned, abstained: outcome.abstained,
        required_context_preserved: outcome.required_context_preserved,
        within_budget: warm.every((sample) => sample.tokens <= 1500),
        estimate_matches_actual: warm.every((sample) => sample.estimate_matches_actual),
        passed: fixture.abstain ? outcome.abstained && outcome.returned === 0 : outcome.required_context_preserved
          && outcome.returned > 0 && outcome.returned <= (fixture.maximum ?? 3),
        reported_estimate: last.evidence_bundle?.estimated_tokens });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const sourceHashes = {};
  for (const file of sourceFiles) {
    try { sourceHashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex"); }
    catch (error) { if (error.code !== "ENOENT") throw error; sourceHashes[file] = null; }
  }
  output.variants[name] = { source_sha256: sourceHashes, captures, retrievals, summary: {
    capture_cases_passed: captures.filter((item) => item.passed).length, capture_cases: captures.length,
    retrieval_cases_passed: retrievals.filter((item) => item.passed).length, retrieval_cases: retrievals.length,
    total_response_tokens: retrievals.reduce((sum, item) => sum + item.tokens, 0),
    responses_within_budget: retrievals.filter((item) => item.within_budget).length,
    warm_median_ms: median(retrievals.map((item) => item.warm_median_ms))
  } };
}
const before = output.variants.baseline.summary, after = output.variants.candidate.summary;
output.comparison = { response_token_reduction_pct: Number((100 * (1 - after.total_response_tokens / before.total_response_tokens)).toFixed(2)),
  component_latency_change_pct: Number((100 * (after.warm_median_ms / before.warm_median_ms - 1)).toFixed(2)),
  economic_qualification: "inconclusive: parent-model task outcomes, usage, paid tools, and billing not measured" };
const destination = resolve(option("--output"));
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ ...output.comparison, before, after, report: destination }, null, 2));
