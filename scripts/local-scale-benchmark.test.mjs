import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url).pathname;

test("local scale benchmark clears stale v3 projections when reusing a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-scale-test-"));
  const dbPath = join(directory, "scale.sqlite");
  const outputPath = join(directory, "scale.json");
  try {
    const benchmarkArgs = [
      "scripts/local-scale-benchmark.mjs",
      "--count",
      "24",
      "--queries",
      "3",
      "--db",
      dbPath,
      "--output",
      outputPath
    ];
    execFileSync(process.execPath, benchmarkArgs, { cwd: repositoryRoot, stdio: "ignore" });

    const staleDb = new DatabaseSync(dbPath);
    staleDb.prepare(
      `INSERT INTO memory_retrieval_units(
        id, memory_id, tenant_id, project_id, unit_type, text, content_hash,
        extractor, extractor_version, extraction_state, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "stale-v3-unit",
      "deleted-memory",
      "stale-tenant",
      "stale-project",
      "atomic",
      "stale v3 projection",
      "d312a776ceda5728faf4236d72ab567adcd05e85032ca5516b3f23d48b8bb432",
      "test",
      "test",
      "degraded",
      Date.now()
    );
    staleDb.close();

    execFileSync(process.execPath, benchmarkArgs, { cwd: repositoryRoot, stdio: "ignore" });
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.passed, true);
    assert.equal(report.settings.legacy_v3_projection, false);
    assert.equal(report.verification.retrieval_unit_count, 0);
    assert.ok(report.verification.retrieval_unit_v4_count > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
