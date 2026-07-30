import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runProductRetrieval } from "./product-longmemeval-benchmark.mjs";

test("product retrieval runtime never receives evaluation labels or question identifiers", async () => {
  const observed = [];
  const store = {
    async capture(input) {
      observed.push({ operation: "capture", input });
      return { memory_id: `m-${observed.length}`, version: 1, operation: "capture", created: true };
    },
    async search(input) {
      observed.push({ operation: "search", input });
      return [{
        memory: {
          source_references: [{ type: "session", ref: "source-1" }]
        },
        score: { total: 1 }
      }];
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
  assert.equal(observed.at(-1).input.search_mode, "hybrid_v3");
});

test("product retrieval modules contain no LongMemEval-specific routing", async () => {
  const paths = [
    new URL("./lib/retrieval-units.mjs", import.meta.url),
    new URL("./lib/local-memory-store.mjs", import.meta.url),
    new URL("../packages/shared/src/retrieval-units.ts", import.meta.url),
    new URL("../packages/shared/src/memory-retrieval.ts", import.meta.url)
  ];
  for (const path of paths) {
    const source = (await readFile(path, "utf8")).toLowerCase();
    assert.equal(source.includes("longmemeval"), false, path.pathname);
    assert.equal(source.includes("answer_session_ids"), false, path.pathname);
    assert.equal(source.includes("gold_session_ids"), false, path.pathname);
  }
});
