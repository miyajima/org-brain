import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const execFileAsync = promisify(execFile);

async function runRepair(args) {
  const { stdout } = await execFileAsync(process.execPath, [
    resolve(import.meta.dirname, "memory-repair.mjs"),
    ...args,
    "--json"
  ], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

test("memory repair namespace entrypoints reject conflicting locations", async () => {
  const script = resolve(import.meta.dirname, "memory-repair.mjs");
  for (const args of [
    ["--entrypoint-location=local", "--local", "--remote"],
    ["--entrypoint-location=remote", "--remote", "--local"]
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [script, ...args, "--json"]),
      (error) => {
        assert.match(String(error.stderr), /entrypoint_location_conflict/u);
        return true;
      }
    );
  }
});

test("memory repair backs up, atomically derives/suppresses, and resumes idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-memory-repair-"));
  try {
    const dbPath = join(directory, "memory.sqlite");
    const outputDirectory = join(directory, "repair-output");
    const store = await new LocalMemoryStore(dbPath).init();
    const createdAt = Date.parse("2026-08-12T00:00:00.000Z");
    const captured = await store.capture({
      id: "legacy-hook-memory",
      tenant_id: "default",
      project_id: "org-brain",
      business_category_id: null,
      work_type: null,
      kind: "semantic",
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: "org-brain",
      content: [
        "## Conclusion",
        "We decided to use ORGBRAIN_API_URL because one canonical variable prevents configuration drift.",
        "",
        "The Stop hook must send one batch request because tool discovery adds latency.",
        "",
        "## Evidence",
        "packages/orgbrain-cli/src/hook-memory-bridge.mjs",
        "`pnpm test` passed"
      ].join("\n"),
      summary: "legacy hook transcript",
      tags: ["hook", "promoted"],
      entities: [],
      source: "codex",
      source_references: [],
      external_key: "legacy-hook-event",
      actor_type: "system",
      actor_id: "test",
      created_at: createdAt,
      valid_from: createdAt,
      valid_until: null,
      confidence_score: 0.7,
      utility_score: 0.7,
      canonical_key: null,
      rationale: null,
      evidence: [],
      conflicts: [],
      permissions: []
    });
    assert.equal(captured.memory_id, "legacy-hook-memory");

    const dryRun = await runRepair(["--local", "--db-path", dbPath]);
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.physical_delete_count, 0);
    assert.equal(dryRun.stats.derive_count, 2);
    assert.equal(dryRun.stats.suppress_count, 1);

    const applied = await runRepair([
      "--local", "--db-path", dbPath,
      "--apply", "--output-dir", outputDirectory
    ]);
    assert.equal(applied.mode, "apply");
    assert.match(applied.backup_path, /\.backup\.sqlite$/u);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    let versionCount;
    try {
      assert.equal(db.prepare("SELECT lifecycle_state FROM memories WHERE id=?").get("legacy-hook-memory").lifecycle_state, "suppressed");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source='memory-repair' AND lifecycle_state='active'").get().count, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE lifecycle_state='active' AND (business_category_id IS NULL OR work_type IS NULL)").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_deletions").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_edges WHERE relation='derived_from'").get().count, 2);
      assert.ok(db.prepare("SELECT COUNT(*) AS count FROM retrieval_units WHERE source_id IN (SELECT id FROM memories WHERE source='memory-repair')").get().count > 0);
      versionCount = db.prepare("SELECT COUNT(*) AS count FROM memory_versions").get().count;
    } finally {
      db.close();
    }

    for (const artifact of [
      applied.backup_path,
      join(outputDirectory, "memory-repair.manifest.json"),
      join(outputDirectory, "memory-repair.plan.json"),
      join(outputDirectory, "memory-repair.checkpoint.json"),
      join(outputDirectory, "memory-repair.report.json")
    ]) {
      assert.equal((await stat(artifact)).mode & 0o077, 0);
    }
    const manifest = JSON.parse(await readFile(join(outputDirectory, "memory-repair.manifest.json"), "utf8"));
    assert.match(manifest.backup_sha256, /^[a-f0-9]{64}$/u);

    const resumed = await runRepair([
      "--local", "--db-path", dbPath,
      "--apply", "--resume", "--output-dir", outputDirectory
    ]);
    assert.equal(resumed.backup_path, applied.backup_path);
    const resumedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(resumedDb.prepare("SELECT COUNT(*) AS count FROM memory_versions").get().count, versionCount);
    } finally {
      resumedDb.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory repair reports database_not_found without creating an empty database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-memory-repair-missing-"));
  const dbPath = join(directory, "missing.sqlite");
  try {
    let failure;
    try {
      await runRepair(["--local", "--db-path", dbPath]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, 2);
    assert.match(String(failure.stderr), /database_not_found/u);
    await assert.rejects(stat(dbPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
