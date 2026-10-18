import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRetrieval } from "./local-retrieval-comparison.mjs";

test("comparison counts misses, rank discount, and unrelated queries independently", () => {
  const result = summarizeRetrieval([
    {expected_ids:["a"],rank:1,returned_ids:["a"],elapsed_ms:10},
    {expected_ids:["b"],rank:2,returned_ids:["c","b"],elapsed_ms:20},
    {expected_ids:["d"],rank:0,returned_ids:[],elapsed_ms:30},
    {expected_ids:[],rank:0,returned_ids:["irrelevant"],elapsed_ms:40},
    {expected_ids:[],rank:0,returned_ids:[],elapsed_ms:50}
  ]);
  assert.equal(result.hit_at_1, 1/3);
  assert.equal(result.hit_at_5, 2/3);
  assert.equal(result.mrr_at_5, 0.5);
  assert.equal(result.negative_any_result_rate, 0.5);
  assert.equal(result.latency_ms_p50, 30);
  assert.equal(summarizeRetrieval([]).hit_at_5, null);
});
