import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { planEpisodicAging } from "../packages/shared/src/episodic-aging.mjs";

const day = 86_400_000;
const now = 200 * day;

test("episodic aging uses verified post-use evidence and stays in shadow mode", () => {
  const result = planEpisodicAging([
    { id: "unused", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day },
    { id: "used", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day, last_verified_use_at: now - 2 * day },
    { id: "reported", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day, last_reported_use_at: now - day },
    { id: "held", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day, legal_hold: 1 },
    { id: "conflict", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day, unresolved_integrity: 1 },
    { id: "expired", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * day, expires_at: now - day },
    { id: "fact", kind: "fact", lifecycle_state: "active", created_at: now - 181 * day }
  ], { now });
  assert.equal(result.mode, "shadow");
  assert.deepEqual(result.candidates.map((item) => [item.id, item.stage]), [["reported", "compaction_candidate"], ["unused", "compaction_candidate"]]);
  assert.equal(result.mutations, 0);
});

test("local shadow scan ignores a reported use and honors a verified outcome evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-aging-db-"));
  const dbPath = join(directory, "memory.sqlite");
  const at = Date.now();
  try {
    const store = await new LocalMemoryStore(dbPath).init();
    for (const id of ["reported", "verified"]) {
      await store.capture({ id, tenant_id: "default", project_id: "p", kind: "episodic",
        lifecycle_state: "active", scope_type: "project", scope_key: "p", source: "manual",
        external_key: `aging:${id}`, actor_type: "principal", actor_id: "owner", content: `${id} history`,
        created_at: at - 181 * day });
    }
    const db = new DatabaseSync(dbPath);
    try {
      for (const [id, verification] of [["reported", "unverified"], ["verified", "verified"]]) {
        db.prepare(`INSERT INTO memory_use_contexts
          (id,tenant_id,usage_item_id,source_type,source_id,source_version,project_id,task_id,work_type,principal,context_json,request_hash,verification_state,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`context:${id}`, "default", `usage:${id}`, "memory", id, 1, "p", "task", "implementation", "owner", "{}", `hash:${id}`, verification, at - day);
        db.prepare(`INSERT INTO memory_use_evaluations
          (id,tenant_id,context_id,assessment_json,outcome,verification_state,proof_id,request_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(`evaluation:${id}`, "default", `context:${id}`, "{}", "positive", verification, `proof:${id}`, `hash:${id}`, at - day);
      }
    } finally { db.close(); }
    const plan = await store.planEpisodicAging("default", "p", at);
    assert.deepEqual(plan.candidates.map((item) => item.id), ["reported"]);
    assert.equal(plan.mutations, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
