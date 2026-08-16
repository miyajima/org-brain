import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMemoryIngestionRegressionCorpus,
  compileIngestionCase,
  emitIngestionRegressionSessions
} from "./memory-ingestion-regression.mjs";

test("v3 generates blind deterministic dual-route sessions with formal observe parity", async () => {
  const corpus = await buildMemoryIngestionRegressionCorpus();
  const root = await mkdtemp(path.join(tmpdir(), "orgbrain-ingestion-v3-"));
  const first = await emitIngestionRegressionSessions(corpus, root);
  const second = await emitIngestionRegressionSessions(corpus, root);
  assert.deepEqual(first, second);
  const formal = corpus.cases.find((item) => item.cohort === "decision");
  assert.ok(formal);
  const compiled = compileIngestionCase(formal);
  assert.ok(compiled.candidateHash);
  const runtimeText = JSON.stringify(compiled.realtimeRows);
  assert.doesNotMatch(runtimeText, /expected_route|reason_code/iu);
  const oracle = JSON.parse(await readFile(path.join(root, "oracle.json"), "utf8"));
  assert.equal(oracle.cases.find((item) => item.case_id === formal.id).formal_observe_candidate_hash, compiled.candidateHash);
  assert.equal(oracle.cases.every((item) => item.candidate_max === 3), true);
});
