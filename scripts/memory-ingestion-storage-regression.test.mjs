import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMemoryIngestionStorageRegression } from "./memory-ingestion-storage-regression.mjs";

test("bilingual semantic v4 sessions preserve meaning, retrieve reasons, and replay without growth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orgbrain-ingestion-storage-test-"));
  try {
    const result = await runMemoryIngestionStorageRegression({ outputDir: root });
    assert.equal(result.report.status, "passed");
    assert.deepEqual(result.report.language_counts, { en: 519, ja: 518 });
    assert.deepEqual(result.report.capture_lane_counts, { active: 225, review: 12, excluded: 200 });
    assert.equal(result.report.stored_language_counts.en + result.report.stored_language_counts.ja, 225);
    assert.equal(result.report.stored_decision_language_counts.en > 0, true);
    assert.equal(result.report.stored_decision_language_counts.ja > 0, true);
    assert.equal(result.report.storage.decision_memories, 75);
    assert.equal(result.report.storage.decision_fields_complete, true);
    assert.equal(result.report.semantic.storage.cases, 225);
    assert.equal(result.report.semantic.storage.error_count, 0);
    assert.equal(result.report.semantic.retrieval.error_count, 0);
    assert.equal(result.report.semantic.retrieval.checks > 0, true);
    assert.deepEqual(result.report.replay, {
      first_created: 225,
      second_created: 0,
      new_memory_count: 0,
      new_version_count: 0,
      new_quarantine_count: 0
    });
    const persisted = JSON.parse(await readFile(path.join(root, "storage-report.json"), "utf8"));
    assert.equal(persisted.privacy.local_only, true);
    assert.equal(persisted.privacy.outbound_network, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
