import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMemoryIngestionRegressionCorpus,
  compileIngestionCase,
  emitIngestionRegressionSessions,
  semanticTraceErrors
} from "./memory-ingestion-regression.mjs";
import { observeMemoryContractV2Event } from "../packages/shared/src/memory-contract-v2-runtime.mjs";

test("v4 generates semantic bilingual sessions with formal observe parity", async () => {
  const corpus = await buildMemoryIngestionRegressionCorpus();
  const root = await mkdtemp(path.join(tmpdir(), "orgbrain-ingestion-v4-"));
  const first = await emitIngestionRegressionSessions(corpus, root);
  const second = await emitIngestionRegressionSessions(corpus, root);
  assert.deepEqual(first, second);
  assert.equal(corpus.schema_version, 4);
  assert.deepEqual(corpus.language_counts, { en: 519, ja: 518 });
  assert.equal(
    Object.values(corpus.cohort_language_counts).every((counts) => Math.abs((counts.en ?? 0) - (counts.ja ?? 0)) <= 1),
    true
  );
  const formal = corpus.cases.find((item) => item.cohort === "decision");
  assert.ok(formal);
  assert.equal(formal.language, "ja");
  assert.equal(formal.semantic_expectation.scenario_id, "canonical_api_url");
  assert.equal(formal.semantic_expectation.decision_key, "canonical_api_url");
  assert.match(formal.input.decision, /ORGBRAIN_API_URL/u);
  assert.match(formal.input.rationale, /設定分岐/u);
  assert.match(formal.input.evidence_selectors.find((item) => item.type === "user_statement")?.ref ?? "", /ORGBRAIN_API_URL/u);
  assert.equal(
    semanticTraceErrors(formal, {
      ...formal.input,
      evidence: [{ type: "file" }, { type: "user_statement" }]
    }).length,
    0
  );
  const englishTwin = corpus.cases.find((item) =>
    item.cohort === "decision" && item.semantic_expectation.scenario_id === formal.semantic_expectation.scenario_id && item.language === "en"
  );
  assert.ok(englishTwin);
  assert.equal(englishTwin.semantic_expectation.decision_key, formal.semantic_expectation.decision_key);
  assert.deepEqual(englishTwin.semantic_expectation.rationale_claim_ids, formal.semantic_expectation.rationale_claim_ids);
  const compiled = compileIngestionCase(formal);
  assert.ok(compiled.candidateHash);
  const runtimeText = JSON.stringify(compiled.realtimeRows);
  assert.equal(runtimeText.includes('"expected_route"'), false);
  assert.equal(runtimeText.includes('"reason_code"'), false);
  assert.equal(runtimeText.includes('"rationale_claim_phrases"'), false);
  const observed = await observeMemoryContractV2Event(formal.input, { workspaceRoot: "/fixture/workspaces/org-brain" });
  const resultRow = compiled.initialRows.find((row) => row.payload?.type === "mcp_tool_call_end");
  const resultText = resultRow.payload.result.Ok.content[0].text;
  assert.equal(JSON.parse(resultText).event_hash, observed.event_hash);
  const oracle = JSON.parse(await readFile(path.join(root, "oracle.json"), "utf8"));
  assert.equal(oracle.cases.find((item) => item.case_id === formal.id).formal_observe_candidate_hash, compiled.candidateHash);
  assert.equal(oracle.cases.find((item) => item.case_id === formal.id).semantic_expectation.scenario_id, "canonical_api_url");
  assert.equal(oracle.cases.every((item) => item.candidate_max === 3), true);
});
