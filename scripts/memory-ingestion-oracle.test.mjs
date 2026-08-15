import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadMemoryIngestionOracle,
  qualifyMemoryIngestionOracle,
  validateMemoryIngestionOracleDefinition
} from "./memory-ingestion-oracle.mjs";

test("locked ingestion oracle qualifies all independent decision-table layers", async () => {
  const loaded = await loadMemoryIngestionOracle();
  const structural = validateMemoryIngestionOracleDefinition(loaded.definition, loaded.expectedHash);
  assert.equal(structural.passed, true);
  assert.equal(structural.total_cases, 40);
  assert.deepEqual(structural.layer_counts, { contract: 14, verification: 11, routing: 15 });

  const result = await qualifyMemoryIngestionOracle();
  assert.equal(result.passed, true);
  assert.equal(result.locked, true);
  assert.deepEqual(result.route_counts, { active: 3, review: 2, excluded: 10 });
  assert.equal(result.label_mismatch_count, 0);
  assert.equal(result.metamorphic_pair_count, 8);
  assert.equal(result.metamorphic_violation_count, 0);
  assert.equal(result.labels_derived_from_runtime, false);
});

test("oracle lock and runtime comparison reject a relabeled expected outcome", async () => {
  const loaded = await loadMemoryIngestionOracle();
  const tampered = structuredClone(loaded.definition);
  tampered.routing_cases.find((item) => item.id === "route-active-success").expected.route = "review";

  const structural = validateMemoryIngestionOracleDefinition(tampered, loaded.expectedHash);
  assert.equal(structural.passed, false);
  assert.ok(structural.errors.includes("oracle_hash_mismatch"));

  const result = await qualifyMemoryIngestionOracle({ definition: tampered, expectedHash: loaded.expectedHash });
  assert.equal(result.passed, false);
  assert.equal(result.locked, false);
  assert.equal(result.label_mismatch_count, 1);
});

test("oracle rejects labels declared as runtime-derived", async () => {
  const loaded = await loadMemoryIngestionOracle();
  const invalid = structuredClone(loaded.definition);
  invalid.label_policy.labels_derived_from_runtime = true;
  const result = validateMemoryIngestionOracleDefinition(invalid);
  assert.equal(result.passed, false);
  assert.ok(result.errors.includes("runtime_derived_labels_forbidden"));
});

test("qualification report is private and is required by the quality CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-oracle-report-"));
  const reportPath = join(directory, "private", "oracle.json");
  const manifestPath = join(directory, "quality.json");
  try {
    const qualification = spawnSync(process.execPath, [
      new URL("./memory-ingestion-oracle.mjs", import.meta.url).pathname,
      "--output",
      reportPath
    ], { encoding: "utf8" });
    assert.equal(qualification.status, 0, qualification.stderr);
    assert.equal((await stat(reportPath)).mode & 0o077, 0);
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status, "qualified");

    await writeFile(manifestPath, `${JSON.stringify({ schema_version: 2, measurements: [] })}\n`, "utf8");
    const certification = spawnSync(process.execPath, [
      new URL("./memory-quality-certify.mjs", import.meta.url).pathname,
      "--manifest",
      manifestPath,
      "--oracle-report",
      reportPath
    ], { encoding: "utf8" });
    assert.equal(certification.status, 0, certification.stderr);
    const output = JSON.parse(certification.stdout);
    assert.equal(output.certification.oracle_qualification.pass, true);
    assert.equal(output.certification.status, "insufficient_evidence");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
