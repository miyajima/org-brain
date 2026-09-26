import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-integrity-"));
  const store = await new LocalMemoryStore(join(directory, "memory.sqlite")).init();
  const capture = async (id, kind = "fact") => {
    await store.capture({
      id, tenant_id: "default", project_id: "org-brain", kind,
      lifecycle_state: "active", scope_type: "project", scope_key: "org-brain",
      content: `${id} current guidance`, summary: id, tags: [], entities: [],
      source: "manual", source_references: [{ type: "file", ref: "docs/SPEC.md" }],
      external_key: `integrity:${id}`, actor_type: "principal", actor_id: "owner",
      owner_principal: "owner", evidence: [], conflicts: [], permissions: []
    });
  };
  return { store, capture, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("a reported error is review only; confirmed wrong suppresses the matching version", async () => {
  const { store, capture, cleanup } = await fixture();
  try {
    await capture("old-guidance");
    const report = await store.reportMemoryFeedback({ tenant_id: "default", memory_id: "old-guidance", memory_version: 1,
      kind: "wrong", reason: "The source procedure changed", evidence: [{ type: "file", ref: "docs/SPEC.md" }], reporter_principal: "reader" });
    assert.equal(report.status, "reported");
    assert.equal((await store.get("default", "old-guidance")).lifecycle_state, "active");
    const reviewed = await store.reviewMemoryFeedback({ tenant_id: "default", feedback_id: report.id,
      decision: "confirm", reviewer_principal: "owner" });
    assert.equal(reviewed.status, "confirmed");
    assert.equal((await store.get("default", "old-guidance")).lifecycle_state, "suppressed");
  } finally { await cleanup(); }
});

test("local feedback refuses credential text", async () => {
  const { store, capture, cleanup } = await fixture();
  try {
    await capture("secret-report");
    await assert.rejects(store.reportMemoryFeedback({ tenant_id: "default", memory_id: "secret-report",
      memory_version: 1, kind: "wrong", reason: "api_key=secret-value-that-must-not-appear",
      evidence: [{ type: "file", ref: "docs/SPEC.md" }], reporter_principal: "reader" }), /sensitive_memory_denied/u);
  } finally { await cleanup(); }
});

test("confirmed contradiction remains visible until an authorized reviewer resolves it", async () => {
  const { store, capture, cleanup } = await fixture();
  try {
    await capture("claim-a");
    await capture("claim-b");
    const relation = await store.proposeMemoryRelation({ tenant_id: "default", from_memory_id: "claim-a", from_version: 1,
      to_memory_id: "claim-b", to_version: 1, relation: "contradicts",
      evidence: [{ type: "file", ref: "docs/SPEC.md" }], proposer_principal: "reader" });
    assert.equal(relation.status, "proposed");
    assert.equal((await store.listMemoryIntegrityIssues("default", "org-brain")).contradictions.length, 0);
    await store.reviewMemoryRelation({ tenant_id: "default", relation_id: relation.id,
      decision: "confirm", reviewer_principal: "owner" });
    assert.equal((await store.listMemoryIntegrityIssues("default", "org-brain")).contradictions.length, 1);
    const found = await store.search({ tenant_id: "default", project_id: "org-brain", query: "claim-a", limit: 10 });
    assert.deepEqual(found.find((item) => item.memory.id === "claim-a")?.integrity_warnings, ["unresolved_contradiction"]);
    await assert.rejects(store.reviewMemoryRelation({ tenant_id: "default", relation_id: relation.id,
      decision: "resolve", reviewer_principal: "reader" }), /reviewer_not_authorized/u);
    await store.reviewMemoryRelation({ tenant_id: "default", relation_id: relation.id,
      decision: "resolve", reviewer_principal: "owner" });
    assert.equal((await store.listMemoryIntegrityIssues("default", "org-brain")).contradictions.length, 0);
  } finally { await cleanup(); }
});

test("a suppressed memory can restore exact historical content as a new version", async () => {
  const { store, capture, cleanup } = await fixture();
  try {
    await capture("restore-me");
    await store.revise("default", "restore-me", { content: "revised guidance", actor_id: "new-owner",
      project_id: "restricted-project", scope_key: "restricted-project", permissions: [{ principal: "new-owner" }] });
    await store.suppress("default", "restore-me", "outdated");
    const restored = await store.restoreMemoryVersion("default", "restore-me", 1, "new-owner");
    assert.equal(restored.operation, "restore");
    const memory = await store.get("default", "restore-me");
    assert.equal(memory.content, "restore-me current guidance");
    assert.equal(memory.lifecycle_state, "active");
    assert.equal(memory.current_version, 4);
    assert.equal(memory.actor_id, "new-owner");
    assert.equal(memory.project_id, "restricted-project");
    assert.deepEqual(memory.permissions, [{ principal: "new-owner" }]);
  } finally { await cleanup(); }
});

test("relations cannot cross projects or confirm after either version changes", async () => {
  const { store, capture, cleanup } = await fixture();
  try {
    await capture("first");
    await store.capture({ id: "other", tenant_id: "default", project_id: "other-project", kind: "fact",
      lifecycle_state: "active", scope_type: "project", scope_key: "other-project", content: "other project fact",
      source: "manual", external_key: "integrity:other", actor_type: "principal", actor_id: "owner", owner_principal: "owner" });
    await assert.rejects(store.proposeMemoryRelation({ tenant_id: "default", from_memory_id: "first", from_version: 1,
      to_memory_id: "other", to_version: 1, relation: "contradicts", evidence: [{ type: "file", ref: "docs/SPEC.md" }],
      proposer_principal: "reader" }), /relation_scope_or_version_mismatch/u);
    await capture("second");
    const edge = await store.proposeMemoryRelation({ tenant_id: "default", from_memory_id: "first", from_version: 1,
      to_memory_id: "second", to_version: 1, relation: "contradicts", evidence: [{ type: "file", ref: "docs/SPEC.md" }],
      proposer_principal: "reader" });
    await store.revise("default", "first", { content: "corrected fact" });
    await assert.rejects(store.reviewMemoryRelation({ tenant_id: "default", relation_id: edge.id,
      decision: "confirm", reviewer_principal: "owner" }), /relation_version_changed/u);
  } finally { await cleanup(); }
});
