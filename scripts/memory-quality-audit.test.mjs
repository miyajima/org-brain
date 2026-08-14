import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { runAudit } from "./memory-quality-audit.mjs";

test("memory quality audit scans every local row and emits only sanitized evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-quality-audit-"));
  const dbPath = join(directory, "memory.sqlite");
  const reportPath = join(directory, "private", "baseline.json");
  const secret = "api_key=secret-value-that-must-not-appear";
  try {
    const store = await new LocalMemoryStore(dbPath).init();
    await store.capture({
      id: "audit-credential", tenant_id: "default", project_id: "org-brain", kind: "fact",
      lifecycle_state: "active", scope_type: "project", scope_key: "org-brain",
      content: `The old setting contained ${secret}`, summary: "Credential candidate", tags: [], entities: [],
      source: "manual", source_references: [], external_key: "audit:credential", actor_type: "system", actor_id: "test",
      rationale: null, reuse_rule: null, evidence: [], conflicts: [], permissions: []
    });
    await store.capture({
      id: "audit-hook", tenant_id: "default", project_id: "org-brain", kind: "semantic",
      lifecycle_state: "active", scope_type: "project", scope_key: "org-brain",
      content: `## Conclusion\nThe hook must send one batch request.\n\n${"x".repeat(900)}`,
      summary: "Legacy hook payload", tags: ["hook", "promoted"], entities: [], source: "codex",
      source_references: [], external_key: "audit:hook", actor_type: "system", actor_id: "test",
      rationale: null, reuse_rule: null, evidence: [], conflicts: [], permissions: []
    });
    const { report } = await runAudit(["--local", "--db-path", dbPath, "--report", reportPath, "--json"]);
    assert.equal(report.scan.complete, true);
    assert.equal(report.counts.memories_total, 2);
    assert.equal(report.counts.active_credential_candidates, 1);
    assert.equal(report.counts.active_raw_hook_candidates, 1);
    assert.equal(report.counts.active_expired, 0);
    assert.deepEqual(report.credential_rotation_required, [{ memory_id: "audit-credential", reason_code: "rotation_required" }]);
    assert.equal(report.integrity.raw_content_emitted, false);
    assert.equal(report.integrity.candidate_text_emitted, false);
    assert.equal(report.integrity.credential_values_emitted, false);
    assert.equal(report.integrity.physical_delete_count, 0);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(serialized, /The hook must send one batch request/u);
    assert.match(report.report_sha256, /^[a-f0-9]{64}$/u);
    assert.equal((await stat(reportPath)).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")).scan.memory_ids.sort(), ["audit-credential", "audit-hook"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory quality audit handles a schema without decision memories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-quality-audit-legacy-"));
  const dbPath = join(directory, "memory.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, business_category_id TEXT, work_type TEXT, source TEXT, external_key TEXT, content TEXT, summary TEXT, tags_json TEXT, kind TEXT, lifecycle_state TEXT, created_at INTEGER, valid_from INTEGER, valid_until INTEGER, expires_at INTEGER, confidence_score REAL, utility_score REAL, entities_json TEXT, rationale TEXT, reuse_rule TEXT, evidence_json TEXT, source_refs_json TEXT, conflicts_json TEXT, current_version INTEGER)");
    db.exec("CREATE TABLE business_categories(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, is_active INTEGER NOT NULL)");
    db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "legacy-1", "default", "org-brain", null, null, "manual", "legacy:1", "A durable fact.", "Fact", "[]", "fact", "active", Date.now(), null, null, null, 0.7, 0.7, "[]", null, null, "[]", "[]", "[]", 1
    );
    db.close();
    const { report } = await runAudit(["--local", "--db-path", dbPath]);
    assert.equal(report.counts.memories_total, 1);
    assert.equal(report.schema.decision_memories_present, false);
    assert.equal(report.counts.active_without_content_hash, null);
    assert.equal(report.integrity.raw_content_emitted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
