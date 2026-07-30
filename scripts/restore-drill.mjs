#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";

const RPO_TARGET_MS = 5 * 60 * 1000;
const RTO_TARGET_MS = 60 * 60 * 1000;

function captureInput(index, createdAt) {
  return {
    tenant_id: "restore-drill",
    project_id: "orgbrain",
    kind: index % 2 === 0 ? "decision" : "fact",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: "orgbrain",
    content: `Restore drill durable record ${index}`,
    summary: `Restore record ${index}`,
    tags: ["restore-drill"],
    entities: ["OrgBrain"],
    source: "restore-drill",
    source_references: [{ type: "ci", ref: "restore-drill" }],
    external_key: `restore:${index}`,
    actor_type: "service",
    actor_id: "restore-drill",
    created_at: createdAt,
    valid_from: createdAt,
    valid_until: null,
    confidence_score: 1,
    utility_score: 1,
    rationale: "Verify recoverability.",
    evidence: [],
    conflicts: [],
    permissions: []
  };
}

const directory = await mkdtemp(join(tmpdir(), "orgbrain-restore-drill-"));
const dbPath = join(directory, "memory.sqlite");
const backupPath = join(directory, "backup.sqlite");
const outputPath = process.argv[2] ? resolve(process.argv[2]) : null;

try {
  const store = new LocalMemoryStore(dbPath);
  const lastWriteAt = Date.now();
  for (let index = 0; index < 100; index += 1) {
    await store.capture(captureInput(index, lastWriteAt + index));
  }
  const before = await store.verify();
  const backupStartedAt = Date.now();
  await store.createBackup(backupPath);
  const recoveryStarted = performance.now();
  const failed = new DatabaseSync(dbPath);
  failed.exec(`
    DELETE FROM memories_fts;
    DELETE FROM memory_versions;
    DELETE FROM memory_edges;
    DELETE FROM memories;
  `);
  failed.close();
  await store.restoreBackup(backupPath);
  const rtoMs = performance.now() - recoveryStarted;
  const after = await store.verify();
  const rpoMs = Math.max(0, backupStartedAt - lastWriteAt);
  const report = {
    profile: "local-sqlite-restore-v1",
    generated_at: new Date().toISOString(),
    targets: { rpo_ms: RPO_TARGET_MS, rto_ms: RTO_TARGET_MS },
    observed: { rpo_ms: rpoMs, rto_ms: Number(rtoMs.toFixed(3)) },
    integrity: {
      before,
      after,
      counts_match: before.record_count === after.record_count,
      versions_match: before.version_count === after.version_count,
      digest_match: before.content_digest === after.content_digest
    },
    passed:
      before.ok &&
      after.ok &&
      rpoMs <= RPO_TARGET_MS &&
      rtoMs <= RTO_TARGET_MS &&
      before.record_count === after.record_count &&
      before.version_count === after.version_count &&
      before.content_digest === after.content_digest
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, text, { mode: 0o600 });
  process.stdout.write(text);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
