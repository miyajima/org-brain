import assert from "node:assert/strict";
import test from "node:test";
import { compareThreeTurnContext, CONTEXT_SUPPLEMENT_CONTRACT, contextWindowSourceHash } from "./memory-extraction-router-context-compare.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v3.mjs";

test("rejects self-attested prior turns even when their content hash matches", () => {
  const bundle = { cases: [{ id: "case", phase: "locked", session_hash: "session", source_hash: "source", turns: [{ id: "s1", role: "assistant", content: "テストを実行しました。" }] }] };
  const gold = [{ case_id: "case", gold: { usefulness: "operational_history_only" } }];
  const previousTurns = [{ role: "user", content: "API方針としてRESTを採用する。" }];
  const supplement = { contract: CONTEXT_SUPPLEMENT_CONTRACT, cases: { case: { session_hash: "session", source_hash: "source", context_windows: [{ source_hash: contextWindowSourceHash(previousTurns), turns: previousTurns }] } } };
  assert.throws(() => compareThreeTurnContext(bundle, gold, supplement, MEMORY_EXTRACTION_ROUTER_MODEL_V3), /source_provenance_unverified/);
});

test("stops when the frozen source hash cannot be reproduced", () => {
  const bundle = { cases: [{ id: "case", phase: "locked", session_hash: "session", source_hash: "source", turns: [] }] };
  const supplement = { contract: CONTEXT_SUPPLEMENT_CONTRACT, cases: { case: { session_hash: "session", source_hash: "different", context_windows: [] } } };
  assert.throws(() => compareThreeTurnContext(bundle, [], supplement, MEMORY_EXTRACTION_ROUTER_MODEL_V3), /source_hash_mismatch/u);
});

test("rejects a prior window whose content does not match its frozen digest", () => {
  const bundle = { cases: [{ id: "case", phase: "locked", session_hash: "session", source_hash: "source", turns: [] }] };
  const supplement = { contract: CONTEXT_SUPPLEMENT_CONTRACT, cases: { case: { session_hash: "session", source_hash: "source", context_windows: [{ source_hash: "sha256:wrong", turns: [{ role: "user", content: "合成した本文" }] }] } } };
  assert.throws(() => compareThreeTurnContext(bundle, [], supplement, MEMORY_EXTRACTION_ROUTER_MODEL_V3), /prior_source_hash_mismatch/u);
});
