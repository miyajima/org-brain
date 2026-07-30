import assert from "node:assert/strict";
import test from "node:test";
import { compareCloudRestoreSnapshots } from "./verify-cloud-restore-drill.mjs";

const snapshot = {
  result: [{
    results: [{
      memory_count: 3,
      version_count: 4,
      edge_count: 2,
      audit_count: 8,
      role_assignment_count: 2,
      ordered_content_hashes: "aaa,bbb,ccc",
      snapshot_at: 1_700_000_000_000,
      max_updated_at: 1_700_000_000_000
    }]
  }]
};

test("cloud restore verifier enforces counts, hashes, RPO, and RTO", () => {
  const report = compareCloudRestoreSnapshots(snapshot, structuredClone(snapshot), {
    started_at: 1_700_000_100_000,
    finished_at: 1_700_000_120_000,
    source_database: "staging",
    restored_database: "drill"
  });
  assert.equal(report.passed, true);
  assert.equal(report.rpo_ms, 100_000);
  assert.equal(report.rto_ms, 20_000);
  assert.equal(report.content_hash_digest.match, true);

  const corrupted = structuredClone(snapshot);
  corrupted.result[0].results[0].ordered_content_hashes = "aaa,evil,ccc";
  assert.equal(compareCloudRestoreSnapshots(snapshot, corrupted, {
    started_at: 1_700_000_100_000,
    finished_at: 1_700_000_120_000
  }).passed, false);
});
