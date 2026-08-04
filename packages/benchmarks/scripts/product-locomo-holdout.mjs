#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalMemoryStore } from "../../orgbrain-cli/src/lib/local-memory-store.mjs";

function parseArgs(argv) {
  const options = {
    datasetPath: null,
    output: null,
    limit: 100,
    repeat: 1,
    topK: 5,
    concurrency: 1
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      return argv[index];
    };
    if (value === "--dataset-path") options.datasetPath = next();
    else if (value === "--output") options.output = next();
    else if (value === "--limit") options.limit = Number(next());
    else if (value === "--repeat") options.repeat = Number(next());
    else if (value === "--top-k") options.topK = Number(next());
    else if (value === "--concurrency") options.concurrency = Number(next());
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.datasetPath) throw new Error("--dataset-path is required");
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be >= 1");
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be >= 1");
  if (!Number.isInteger(options.topK) || options.topK < 1) throw new Error("--top-k must be >= 1");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be between 1 and 16");
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function evidenceSessions(evidence) {
  return [...new Set(
    (Array.isArray(evidence) ? evidence : [])
      .map((value) => /^D(\d+):/u.exec(String(value))?.[1])
      .filter(Boolean)
      .map((number) => `session_${number}`)
  )];
}

export function normalizeLocomo(raw) {
  const conversations = JSON.parse(raw);
  if (!Array.isArray(conversations)) throw new Error("LoCoMo dataset must be an array");
  const items = [];
  for (const [conversationIndex, item] of conversations.entries()) {
    const sampleId = String(item.sample_id ?? `sample-${conversationIndex + 1}`);
    const conversation = item.conversation ?? {};
    const sessions = [];
    for (let number = 1; conversation[`session_${number}`]; number += 1) {
      const date = String(conversation[`session_${number}_date_time`] ?? "");
      const messages = conversation[`session_${number}`];
      sessions.push({
        source_id: `session_${number}`,
        date,
        content: [
          date ? `Session date: ${date}` : "",
          ...messages.map((message) =>
            `${String(message.speaker ?? "unknown")}: ${String(message.text ?? "")}`
          )
        ].filter(Boolean).join("\n")
      });
    }
    for (const [questionIndex, qa] of (item.qa ?? []).entries()) {
      const expectedSessionIds = evidenceSessions(qa.evidence);
      if (expectedSessionIds.length === 0) continue;
      items.push({
        evaluation_id: `${sampleId}-q${questionIndex}`,
        category: String(qa.category ?? "uncategorized"),
        question: String(qa.question ?? ""),
        expected_session_ids: expectedSessionIds,
        sessions
      });
    }
  }
  return items.sort((left, right) =>
    sha256(left.evaluation_id).localeCompare(sha256(right.evaluation_id))
  );
}

/**
 * Integrity boundary: question identifiers, evidence annotations, and expected
 * session IDs stay in scorer scope. The product runtime receives only the
 * query and source sessions.
 */
export async function runLocomoRetrieval(runtimeInput, options = {}) {
  const store = options.store;
  if (!store) throw new Error("runLocomoRetrieval requires a MemoryStore");
  const principalId = "locomo-holdout-reader";
  for (const [sessionIndex, session] of runtimeInput.sessions.entries()) {
    const eventAt = 1_600_000_000_000 + sessionIndex;
    await store.capture({
      tenant_id: runtimeInput.tenant_id,
      project_id: "locomo-holdout",
      kind: "episodic",
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: "locomo-holdout",
      content: session.content,
      summary: null,
      tags: ["independent-holdout-source"],
      entities: [],
      source: "locomo-holdout",
      source_references: [{ type: "session", ref: session.source_id, captured_at: eventAt }],
      external_key: `source-session:${session.source_id}`,
      actor_type: "system",
      actor_id: "locomo-holdout-runner",
      created_at: eventAt,
      updated_at: eventAt,
      valid_from: null,
      valid_until: null,
      confidence_score: 1,
      utility_score: 0.5,
      rationale: null,
      evidence: [],
      conflicts: [],
      permissions: [{
        principal_type: "principal",
        principal_id: principalId,
        permissions: ["read"]
      }]
    });
  }
  const startedAt = performance.now();
  const context = await store.retrieveContext({
    tenant_id: runtimeInput.tenant_id,
    project_id: "locomo-holdout",
    query: runtimeInput.question,
    limit: 50,
    top_k: options.topK ?? 5,
    token_budget: 8_000,
    principal_id: principalId,
    search_mode: "hybrid_v4"
  });
  return {
    latency_ms: performance.now() - startedAt,
    evidence_tokens: context.evidence_bundle.estimated_tokens,
    source_ids: context.results.slice(0, options.topK ?? 5).flatMap((result) =>
      result.memory.source_references
        .filter((reference) => reference.type === "session")
        .map((reference) => reference.ref)
    )
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

function summarize(rows, datasetHash, selectedIdsHash, repeatCount) {
  const byRepeat = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const selected = rows.filter((row) => row.repeat === repeat);
    byRepeat.push({
      repeat,
      hits: selected.filter((row) => row.hit_at_k).length,
      total: selected.length,
      hit_rate_at_k: selected.filter((row) => row.hit_at_k).length / selected.length,
      p95_latency_ms: percentile(
        selected.map((row) => row.latency_ms).filter(Number.isFinite),
        0.95
      ),
      errors: selected.filter((row) => row.error).length
    });
  }
  return {
    benchmark: "LoCoMo independent evidence-session holdout",
    dataset_sha256: datasetHash,
    selected_ids_sha256: selectedIdsHash,
    repeat_count: repeatCount,
    scoring: "question-level hit when at least one evidence-bearing session appears in top-k",
    by_repeat: byRepeat
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await readFile(options.datasetPath, "utf8");
  const items = normalizeLocomo(raw).slice(0, options.limit);
  const output = options.output ?? join(
    process.cwd(),
    "artifacts",
    `product-locomo-holdout-${Date.now()}.jsonl`
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "", { mode: 0o600 });
  const rows = [];
  let appendQueue = Promise.resolve();
  for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
    let nextItemIndex = 0;
    const worker = async () => {
      while (nextItemIndex < items.length) {
        const itemIndex = nextItemIndex++;
        const item = items[itemIndex];
        const directory = await mkdtemp(join(tmpdir(), "orgbrain-locomo-holdout-"));
        let row;
        try {
          const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
          const retrieval = await runLocomoRetrieval({
            tenant_id: `locomo-r${repeat}-i${itemIndex + 1}`,
            question: item.question,
            sessions: item.sessions
          }, {
            store,
            topK: options.topK
          });
          const expected = new Set(item.expected_session_ids);
          const recalled = retrieval.source_ids.filter((id) => expected.has(id));
          row = {
            repeat,
            evaluation_id: item.evaluation_id,
            category: item.category,
            expected_source_count: expected.size,
            retrieved_source_ids: retrieval.source_ids,
            recalled_source_ids: recalled,
            hit_at_k: recalled.length > 0,
            latency_ms: Number(retrieval.latency_ms.toFixed(3)),
            error: null
          };
        } catch (error) {
          row = {
            repeat,
            evaluation_id: item.evaluation_id,
            category: item.category,
            expected_source_count: item.expected_session_ids.length,
            retrieved_source_ids: [],
            recalled_source_ids: [],
            hit_at_k: false,
            latency_ms: null,
            error: error instanceof Error ? error.message : String(error)
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        rows.push(row);
        appendQueue = appendQueue.then(() =>
          appendFile(output, `${JSON.stringify(row)}\n`, { mode: 0o600 })
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, items.length) }, () => worker())
    );
    await appendQueue;
  }
  const selectedIdsHash = sha256(items.map((item) => item.evaluation_id).join("\n"));
  process.stdout.write(`${JSON.stringify({
    output,
    runner: {
      search_mode: "hybrid_v4",
      retrieval_contract: "MemoryStore.retrieveContext",
      top_k: options.topK,
      concurrency: options.concurrency
    },
    summary: summarize(rows, sha256(raw), selectedIdsHash, options.repeat)
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
