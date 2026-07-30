#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";

const DEFAULT_DATASET_URL =
  "https://huggingface.co/datasets/LIXINYI33/longmemeval-s/resolve/main/longmemeval_s_cleaned.json";
const CATEGORY_GATES = {
  "knowledge-update": { minimum: 78, total: 78 },
  "multi-session": { minimum: 132, total: 133 },
  "single-session-assistant": { minimum: 56, total: 56 },
  preference: { minimum: 29, total: 30 },
  "single-session-user": { minimum: 69, total: 70 },
  "temporal-reasoning": { minimum: 129, total: 133 }
};

function parseArgs(argv) {
  const options = {
    datasetPath: null,
    datasetUrl: DEFAULT_DATASET_URL,
    output: null,
    limit: 0,
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
    else if (value === "--dataset-url") options.datasetUrl = next();
    else if (value === "--output") options.output = next();
    else if (value === "--limit") options.limit = Number(next());
    else if (value === "--repeat") options.repeat = Number(next());
    else if (value === "--top-k") options.topK = Number(next());
    else if (value === "--concurrency") options.concurrency = Number(next());
    else if (value === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/product-longmemeval-benchmark.mjs [options]",
          "  --dataset-path <path>  Read an existing LongMemEval-S JSON file",
          "  --dataset-url <url>    Dataset URL when no local path is supplied",
          "  --output <path>        Raw JSONL output path",
          "  --limit <n>            Run the first n hash-ordered items",
          "  --repeat <n>           Full independent repetitions (acceptance: 5)",
          "  --top-k <n>            Retrieval depth (acceptance: 5)",
          "  --concurrency <n>      Independent product-path evaluations in parallel"
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${value}`);
  }
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

function scalar(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function sessionContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((message) => {
        if (typeof message === "string") return message;
        if (!message || typeof message !== "object") return "";
        return `${scalar(message.role || message.speaker || "unknown")}: ${scalar(message.content || message.text)}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.session_text === "string") return value.session_text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.messages)) return sessionContent(value.messages);
  return "";
}

function normalizeRows(raw) {
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.items)
        ? parsed.items
        : [];
  return rows.map((row, itemIndex) => {
    const rawSessions = row.haystack_sessions ?? row.history ?? row.sessions ?? [];
    const sessionIds = row.haystack_session_ids ?? row.session_ids ?? [];
    const sessionDates = row.haystack_dates ?? row.session_dates ?? [];
    const sessions = (Array.isArray(rawSessions) ? rawSessions : []).map((session, sessionIndex) => ({
      source_id: scalar(
        sessionIds[sessionIndex] ??
          session?.session_id ??
          session?.id ??
          `session-${sessionIndex + 1}`
      ),
      date: scalar(sessionDates[sessionIndex] ?? session?.session_date ?? session?.date),
      content: sessionContent(session)
    })).filter((session) => session.content);
    return {
      evaluation_id: scalar(row.question_id ?? row.id ?? `item-${itemIndex + 1}`),
      category: scalar(row.question_type ?? row.category ?? "uncategorized"),
      question: scalar(row.question ?? row.query ?? row.input?.question),
      question_date: scalar(row.question_date ?? row.query_date),
      expected_session_ids: (row.answer_session_ids ?? row.gold_session_ids ?? [])
        .map(scalar)
        .filter(Boolean),
      sessions
    };
  });
}

function splitItems(items) {
  const ordered = [...items].sort((left, right) =>
    sha256(left.evaluation_id).localeCompare(sha256(right.evaluation_id))
  );
  const developmentSize = Math.min(400, Math.max(0, ordered.length - 100));
  const developmentIds = new Set(ordered.slice(0, developmentSize).map((item) => item.evaluation_id));
  return ordered.map((item) => ({
    ...item,
    split: developmentIds.has(item.evaluation_id) ? "development" : "sealed_holdout"
  }));
}

function parseTimestamp(value, fallback) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

/**
 * Integrity boundary: the runtime only receives query/session source data.
 * Evaluation IDs, expected answers, and expected session IDs stay in scorer
 * scope and are not reachable from capture/search.
 */
export async function runProductRetrieval(runtimeInput, options = {}) {
  const store = options.store;
  if (!store) throw new Error("runProductRetrieval requires a MemoryStore");
  const principalId = "benchmark-reader";
  for (const [sessionIndex, session] of runtimeInput.sessions.entries()) {
    const eventAt = parseTimestamp(session.date, 1_600_000_000_000 + sessionIndex);
    await store.capture({
      tenant_id: runtimeInput.tenant_id,
      project_id: "product-retrieval-evaluation",
      kind: "episodic",
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: "product-retrieval-evaluation",
      content: session.content,
      summary: null,
      tags: ["benchmark-source-session"],
      entities: [],
      source: "product-retrieval-evaluation",
      source_references: [{ type: "session", ref: session.source_id, captured_at: eventAt }],
      external_key: `source-session:${session.source_id}`,
      actor_type: "system",
      actor_id: "product-retrieval-runner",
      created_at: eventAt,
      updated_at: eventAt,
      valid_from: eventAt,
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
  const results = await store.search({
    tenant_id: runtimeInput.tenant_id,
    project_id: "product-retrieval-evaluation",
    query: runtimeInput.question,
    limit: options.topK ?? 5,
    principal_id: principalId,
    search_mode: "hybrid_v3",
    at: parseTimestamp(runtimeInput.question_date, Date.now())
  });
  return {
    latency_ms: performance.now() - startedAt,
    source_ids: results.flatMap((result) =>
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

function summarize(rows, datasetHash, repeatCount) {
  const byRepeat = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const selected = rows.filter((row) => row.repeat === repeat);
    byRepeat.push({
      repeat,
      hits: selected.filter((row) => row.hit_at_k).length,
      total: selected.length,
      recall_at_k: selected.length ? selected.filter((row) => row.hit_at_k).length / selected.length : 0,
      holdout_recall_at_k: (() => {
        const holdout = selected.filter((row) => row.split === "sealed_holdout");
        return holdout.length ? holdout.filter((row) => row.hit_at_k).length / holdout.length : null;
      })(),
      p95_latency_ms: percentile(selected.map((row) => row.latency_ms), 0.95)
    });
  }
  const minimumRecall = Math.min(...byRepeat.map((row) => row.recall_at_k));
  const minimumHoldoutRecall = Math.min(
    ...byRepeat.map((row) => row.holdout_recall_at_k).filter((value) => value !== null)
  );
  const categories = {};
  for (const category of new Set(rows.map((row) => row.category))) {
    const perRepeat = byRepeat.map(({ repeat }) => {
      const selected = rows.filter((row) => row.repeat === repeat && row.category === category);
      return {
        hits: selected.filter((row) => row.hit_at_k).length,
        total: selected.length
      };
    });
    categories[category] = {
      minimum_hits: Math.min(...perRepeat.map((row) => row.hits)),
      total: Math.max(...perRepeat.map((row) => row.total))
    };
  }
  const categoryGates = Object.fromEntries(
    Object.entries(CATEGORY_GATES).map(([category, gate]) => [
      category,
      {
        ...gate,
        actual: categories[category]?.minimum_hits ?? 0,
        passed:
          (categories[category]?.minimum_hits ?? 0) >= gate.minimum &&
          (categories[category]?.total ?? 0) === gate.total
      }
    ])
  );
  const fullSize = byRepeat.every((row) => row.total === 500);
  return {
    dataset_sha256: datasetHash,
    repeat_count: repeatCount,
    scoring: "question-level hit when at least one expected source session appears in top-k",
    by_repeat: byRepeat,
    categories,
    gates: {
      full_500_recall_at_5: {
        target: 0.986,
        actual: minimumRecall,
        passed: fullSize && minimumRecall >= 0.986
      },
      sealed_100_recall_at_5: {
        target: 0.98,
        actual: minimumHoldoutRecall,
        passed: fullSize && minimumHoldoutRecall >= 0.98
      },
      category_gates: categoryGates
    }
  };
}

async function loadDataset(options) {
  if (options.datasetPath) return readFile(options.datasetPath, "utf8");
  const response = await fetch(options.datasetUrl);
  if (!response.ok) throw new Error(`dataset download failed: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawDataset = await loadDataset(options);
  const datasetHash = sha256(rawDataset);
  let items = splitItems(normalizeRows(rawDataset));
  if (options.limit > 0) items = items.slice(0, options.limit);
  const output = options.output ?? join(process.cwd(), "artifacts", `product-longmemeval-${Date.now()}.jsonl`);
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
        const directory = await mkdtemp(join(tmpdir(), "orgbrain-product-benchmark-"));
        let row;
        try {
          const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
          const runtimeInput = {
            tenant_id: `benchmark-r${repeat}-i${itemIndex + 1}`,
            question: item.question,
            question_date: item.question_date,
            sessions: item.sessions
          };
          const retrieval = await runProductRetrieval(runtimeInput, {
            store,
            topK: options.topK
          });
          const expected = new Set(item.expected_session_ids);
          const recalled = retrieval.source_ids.filter((id) => expected.has(id));
          row = {
            repeat,
            evaluation_id: item.evaluation_id,
            split: item.split,
            category: item.category,
            expected_source_count: expected.size,
            retrieved_source_ids: retrieval.source_ids,
            recalled_source_ids: recalled,
            hit_at_k: recalled.length > 0,
            all_expected_recalled: expected.size > 0 && recalled.length === expected.size,
            latency_ms: Number(retrieval.latency_ms.toFixed(3)),
            error: null
          };
        } catch (error) {
          row = {
            repeat,
            evaluation_id: item.evaluation_id,
            split: item.split,
            category: item.category,
            expected_source_count: item.expected_session_ids.length,
            retrieved_source_ids: [],
            recalled_source_ids: [],
            hit_at_k: false,
            all_expected_recalled: false,
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
  const summary = summarize(rows, datasetHash, options.repeat);
  process.stdout.write(`${JSON.stringify({
    output,
    runner: {
      search_mode: "hybrid_v3",
      top_k: options.topK,
      concurrency: options.concurrency
    },
    summary
  }, null, 2)}\n`);
  if (
    options.limit === 0 &&
    options.repeat >= 5 &&
    (!summary.gates.full_500_recall_at_5.passed ||
      !summary.gates.sealed_100_recall_at_5.passed ||
      Object.values(summary.gates.category_gates).some((gate) => !gate.passed))
  ) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
