import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

test("strict memory repair remains dry-run only and never derives active rows", async () => {
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
    assert.equal(dryRun.stats.derive_count, 0);
    assert.equal(dryRun.stats.update_count, 0);
    assert.equal(dryRun.stats.quarantine_count, 1);

    await assert.rejects(
      runRepair(["--local", "--db-path", dbPath, "--apply", "--output-dir", outputDirectory]),
      (error) => {
        assert.match(String(error.stderr), /strict_repair_apply_requires_certified_pipeline/u);
        return true;
      }
    );

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT lifecycle_state FROM memories WHERE id=?").get("legacy-hook-memory").lifecycle_state, "active");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source='memory-repair'").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_deletions").get().count, 0);
    } finally {
      db.close();
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
