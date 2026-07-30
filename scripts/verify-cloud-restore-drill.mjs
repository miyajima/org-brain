#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

function findSnapshot(value) {
  if (!value) return null;
  if (
    typeof value === "object" &&
    "memory_count" in value &&
    "version_count" in value
  ) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSnapshot(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      const found = findSnapshot(nested);
      if (found) return found;
    }
  }
  return null;
}

function digest(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function compareCloudRestoreSnapshots(sourceRaw, restoredRaw, timing) {
  const source = findSnapshot(sourceRaw);
  const restored = findSnapshot(restoredRaw);
  if (!source || !restored) throw new Error("D1 snapshot JSON does not contain the expected row");
  const numericFields = [
    "memory_count",
    "version_count",
    "edge_count",
    "audit_count",
    "role_assignment_count"
  ];
  const comparisons = Object.fromEntries(numericFields.map((field) => [
    field,
    {
      source: Number(source[field] ?? 0),
      restored: Number(restored[field] ?? 0),
      match: Number(source[field] ?? 0) === Number(restored[field] ?? 0)
    }
  ]));
  const sourceDigest = digest(source.ordered_content_hashes);
  const restoredDigest = digest(restored.ordered_content_hashes);
  const startedAt = Number(timing.started_at);
  const finishedAt = Number(timing.finished_at);
  const snapshotAt = Number(source.snapshot_at || startedAt);
  const rpoMs = Math.abs(startedAt - snapshotAt);
  const rtoMs = Math.max(0, finishedAt - startedAt);
  const countsMatch = Object.values(comparisons).every((comparison) => comparison.match);
  const contentHashesMatch = sourceDigest === restoredDigest;
  const passed = countsMatch && contentHashesMatch && rpoMs <= 300_000 && rtoMs <= 3_600_000;
  return {
    passed,
    source_database: timing.source_database,
    restored_database: timing.restored_database,
    comparisons,
    content_hash_digest: {
      source: sourceDigest,
      restored: restoredDigest,
      match: contentHashesMatch
    },
    rpo_ms: rpoMs,
    rto_ms: rtoMs,
    targets: { rpo_ms: 300_000, rto_ms: 3_600_000 }
  };
}

async function main() {
  const [sourcePath, restoredPath, startedAt, finishedAt, sourceDatabase, restoredDatabase] =
    process.argv.slice(2);
  if (!sourcePath || !restoredPath || !startedAt || !finishedAt) {
    throw new Error(
      "usage: verify-cloud-restore-drill <source.json> <restored.json> <started-ms> <finished-ms> [source-db] [restored-db]"
    );
  }
  const [sourceRaw, restoredRaw] = await Promise.all([
    readFile(sourcePath, "utf8").then(JSON.parse),
    readFile(restoredPath, "utf8").then(JSON.parse)
  ]);
  const report = compareCloudRestoreSnapshots(sourceRaw, restoredRaw, {
    started_at: Number(startedAt),
    finished_at: Number(finishedAt),
    source_database: sourceDatabase ?? null,
    restored_database: restoredDatabase ?? null
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
