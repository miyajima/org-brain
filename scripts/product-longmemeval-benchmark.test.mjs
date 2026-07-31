import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeRows,
  runProductRetrieval,
  splitItems,
  summarize
} from "./product-longmemeval-benchmark.mjs";

test("normalizes the dataset preference category to the acceptance gate name", () => {
  const [row] = normalizeRows(JSON.stringify([{
    question_id: "question-1",
    question_type: "single-session-preference",
    question: "What do I prefer?",
    haystack_sessions: [["user: I prefer tea."]],
    haystack_session_ids: ["session-1"],
    answer_session_ids: ["session-1"]
  }]));
  assert.equal(row.category, "preference");
});

test("deterministic benchmark partition is not labeled as a sealed holdout", () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    evaluation_id: `question-${index + 1}`
  }));
  const split = splitItems(items);
  assert.equal(split.filter((item) => item.split === "development").length, 1);
  assert.equal(split.filter((item) => item.split === "hash_holdout").length, 100);
  assert.equal(split.some((item) => item.split.includes("sealed")), false);
});

test("sealed custom 100 applies only the holdout gate", () => {
  const rows = Array.from({ length: 5 }, (_, repeatIndex) =>
    Array.from({ length: 100 }, (_, itemIndex) => ({
      repeat: repeatIndex + 1,
      hit_at_k: itemIndex < 98,
      split: "hash_holdout",
      category: "multi-session",
      latency_ms: 10
    }))
  ).flat();
  const summary = summarize(rows, "dataset-hash", 5, {
    sealed: true,
    note: "manifest matched"
  });

  assert.equal(summary.gates.hash_100_recall_at_5.applicable, true);
  assert.equal(summary.gates.hash_100_recall_at_5.passed, true);
  assert.equal(summary.gates.hash_100_recall_at_5.sealed, true);
  assert.equal(summary.gates.full_500_recall_at_5.applicable, false);
  assert.equal(summary.gates.category_gates["multi-session"].applicable, false);
});

test("product retrieval runtime never receives evaluation labels or question identifiers", async () => {
  const observed = [];
  const store = {
    async capture(input) {
      observed.push({ operation: "capture", input });
      return { memory_id: `m-${observed.length}`, version: 1, operation: "capture", created: true };
    },
    async retrieveContext(input) {
      observed.push({ operation: "retrieveContext", input });
      return {
        results: [{
          memory: {
            source_references: [{ type: "session", ref: "source-1" }]
          },
          score: { total: 1 }
        }],
        evidence_bundle: { estimated_tokens: 10, abstention_recommended: false }
      };
    }
  };
  const runtimeInput = {
    tenant_id: "benchmark-r1-i1",
    question: "Which drink is preferred now?",
    question_date: "2026-01-02",
    sessions: [{
      source_id: "source-1",
      date: "2026-01-01",
      content: "user: I now prefer tea."
    }]
  };
  const result = await runProductRetrieval(runtimeInput, { store, topK: 5 });
  assert.deepEqual(result.source_ids, ["source-1"]);
  const serialized = JSON.stringify(observed);
  for (const forbidden of [
    "answer_session_ids",
    "gold_session_ids",
    "expected_session_ids",
    "question_id",
    "evaluation_id"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(observed.at(-1).input.search_mode, "hybrid_v4");
  assert.equal(observed[0].input.valid_from, null);
  assert.equal(observed[0].input.created_at, Date.parse("2026-01-01"));
});

test("product retrieval modules contain no LongMemEval-specific routing", async () => {
  const paths = [
    new URL("./lib/retrieval-units.mjs", import.meta.url),
    new URL("./lib/local-memory-store.mjs", import.meta.url),
    new URL("../packages/shared/src/retrieval-units.ts", import.meta.url),
    new URL("../packages/shared/src/memory-retrieval.ts", import.meta.url),
    new URL("../apps/api-gateway/src/memory-service.ts", import.meta.url)
  ];
  for (const path of paths) {
    const source = (await readFile(path, "utf8")).toLowerCase();
    for (const benchmarkName of ["longmemeval", "beam", "locomo", "precisionmembench"]) {
      assert.equal(source.includes(benchmarkName), false, `${path.pathname}: ${benchmarkName}`);
    }
    assert.equal(source.includes("answer_session_ids"), false, path.pathname);
    assert.equal(source.includes("gold_session_ids"), false, path.pathname);
    assert.equal(source.includes("generatecontent"), false, path.pathname);
    assert.equal(source.includes("gemini_api_key"), false, path.pathname);
  }
});
