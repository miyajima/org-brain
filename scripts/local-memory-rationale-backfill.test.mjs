import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { normalizeMemoryContractV2Event } from "../packages/shared/src/memory-contract-v2-runtime.mjs";
import {
  applyLocalBackfillPlan,
  buildLocalBackfillPlan,
  readLocalMemories
} from "./local-memory-rationale-backfill.mjs";

const EVIDENCE_DIGEST = `sha256:${"a".repeat(64)}`;
const execFile = promisify(execFileCallback);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-local-rationale-backfill-"));
  await chmod(directory, 0o700);
  const dbPath = join(directory, "memory.sqlite");
  return {
    directory,
    dbPath,
    async cleanup() { await rm(directory, { recursive: true, force: true }); }
  };
}

function content({ reuse = true, conclusion = "chunk-1は84点のため、局所改善を採用する。" } = {}) {
  return [
    "AIma営業会話の改善根拠です。元の顧客・AImaの逐語発話は保存せず、再利用できる判断だけを記録します。",
    "対象: chunk-1",
    `結論: ${conclusion}`,
    "理由: 冒頭の名乗りを自然にし、取り次ぎ依頼を簡潔にする。",
    reuse ? "再利用条件: 90点以下のまとまりだけを最小限改善し、承認済み事実と回帰ガードを維持する。" : ""
  ].filter(Boolean).join("\n");
}

function captureInput(overrides = {}) {
  return {
    tenant_id: "default",
    project_id: "aima",
    kind: "decision",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: "aima",
    content: content(),
    summary: "AIma営業 chunk-1 の改善根拠",
    tags: ["aima", "sales-coaching", "improvement-rationale"],
    source: "aima",
    external_key: "aima:improvement-rationale:run-1:chunk-1",
    actor_type: "principal",
    actor_id: "test",
    confidence_score: 0.82,
    utility_score: 0.86,
    rationale: "冒頭の名乗りを自然にし、取り次ぎ依頼を簡潔にする。",
    evidence: [{
      evidence_type: "artifact",
      evidence_ref: "aima/aima-chunked-run-1/result.json#chunks/chunk-1",
      relation: "supports",
      content_hash: EVIDENCE_DIGEST
    }],
    source_references: [{
      type: "artifact",
      ref: "aima/aima-chunked-run-1/result.json#chunks/chunk-1",
      content_hash: EVIDENCE_DIGEST
    }],
    verification_state: "unverified",
    capture_origin: "legacy",
    capture_route: "legacy",
    ...overrides
  };
}

test("local planner only selects structured AIma rationale rows with stable evidence", async () => {
  const rows = [
    {
      ...captureInput(),
      id: "candidate",
      current_version: 2,
      learning: null,
      reuse_rule: null
    },
    {
      ...captureInput({ content: content({ reuse: false }), external_key: "aima:improvement-rationale:run-1:missing" }),
      id: "missing-reuse",
      current_version: 1,
      learning: null,
      reuse_rule: null
    },
    {
      ...captureInput({ external_key: "other:memory" }),
      id: "wrong-key",
      current_version: 1,
      learning: null,
      reuse_rule: null
    },
    {
      ...captureInput(),
      id: "already-structured",
      current_version: 3,
      learning: { schema_version: 2 },
      reuse_rule: "already structured"
    }
  ];
  const plan = buildLocalBackfillPlan(rows, { tenantId: "default", projectId: "aima", now: 1234 });
  assert.equal(plan.target_count, 1);
  assert.equal(plan.skipped_count, 3);
  assert.deepEqual(plan.skipped_by_reason, {
    missing_reuse_rule: 1,
    not_aima_rationale: 1,
    learning_already_present: 1
  });
  const change = plan.changes[0];
  assert.equal(change.memory_id, "candidate");
  assert.equal(change.external_key, "aima:improvement-rationale:run-1:chunk-1");
  assert.equal(change.current_version, 2);
  assert.equal(change.patch.reuse_rule, "90点以下のまとまりだけを最小限改善し、承認済み事実と回帰ガードを維持する。");
  assert.equal(change.patch.verification_state, "partial");
  assert.equal(change.patch.capture_origin, "repair");
  assert.equal(change.patch.capture_route, "repair");
  assert.equal(change.patch.learning.capture_intent, "review");
  assert.deepEqual(change.patch.learning.evidence_selectors, [{
    type: "doc",
    ref: "aima/aima-chunked-run-1/result.json#chunks/chunk-1",
    digest: EVIDENCE_DIGEST,
    supports: ["decision", "rationale", "reuse_rule"]
  }]);
  assert.deepEqual(change.patch.learning.applicability.target_files, []);
  assert.ok(change.patch.learning.gaps.length > 0);
  const normalizedLearning = await normalizeMemoryContractV2Event(change.patch.learning);
  assert.equal(normalizedLearning.accepted, true);
  assert.match(plan.plan_digest, /^sha256:[a-f0-9]{64}$/u);
});

test("apply creates a backup, revises instead of replacing the memory, rebuilds, and is idempotent", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const captured = await store.capture(captureInput());
    const before = await store.get("default", captured.memory_id);
    const source = readLocalMemories({ dbPath: ctx.dbPath, tenantId: "default", projectId: "aima" });
    const plan = buildLocalBackfillPlan(source.rows, { tenantId: "default", projectId: "aima", now: 1234 });
    assert.equal(plan.target_count, 1);

    const backupPath = join(ctx.directory, "backups", "before.sqlite");
    const applied = await applyLocalBackfillPlan(store, plan, { backupPath });
    assert.equal(applied.status, "applied");
    assert.equal(applied.applied_count, 1);
    assert.equal(applied.skipped_idempotent_count, 0);
    assert.equal(applied.doctor.ok, true);
    assert.equal(applied.backup.path, backupPath);
    assert.equal(applied.backup.ok, true);

    const after = await store.get("default", captured.memory_id);
    assert.equal(after.id, before.id);
    assert.equal(after.external_key, before.external_key);
    assert.equal(after.current_version, before.current_version + 1);
    assert.equal(after.rationale, before.rationale);
    assert.equal(after.reuse_rule, "90点以下のまとまりだけを最小限改善し、承認済み事実と回帰ガードを維持する。");
    assert.equal(after.verification_state, "partial");
    assert.equal(after.capture_origin, "repair");
    assert.equal(after.capture_route, "repair");
    assert.equal(after.learning.capture_intent, "review");
    assert.equal((await store.versions("default", captured.memory_id)).length, 2);
    assert.equal((await store.verify()).ok, true);

    const cli = new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url);
    const cliResult = await execFile(process.execPath, [
      cli.pathname,
      "--db", ctx.dbPath,
      "memory", "list",
      "--tenant-id", "default",
      "--project-id", "aima",
      "--limit", "5"
    ], { cwd: new URL("..", import.meta.url).pathname });
    assert.match(cliResult.stdout, /aima:improvement-rationale:run-1:chunk-1/u);
    assert.match(cliResult.stdout, /"reuse_rule"\s*:\s*"90点以下のまとまりだけを最小限改善/u);

    const rerunSource = readLocalMemories({ dbPath: ctx.dbPath, tenantId: "default", projectId: "aima" });
    const rerunPlan = buildLocalBackfillPlan(rerunSource.rows, { tenantId: "default", projectId: "aima", now: 1234 });
    assert.equal(rerunPlan.target_count, 0);
    assert.equal(rerunPlan.skipped_by_reason.learning_already_present, 1);
    const noop = await applyLocalBackfillPlan(store, rerunPlan, { backupPath: join(ctx.directory, "backups", "noop.sqlite") });
    assert.equal(noop.status, "noop");
  } finally {
    await ctx.cleanup();
  }
});

test("readLocalMemories refuses a non-current schema before any initialization", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.capture(captureInput());
    const database = store.open();
    try { database.exec("PRAGMA user_version = 23"); } finally { database.close(); }
    assert.throws(
      () => readLocalMemories({ dbPath: ctx.dbPath, tenantId: "default", projectId: "aima" }),
      /schema version 23 != 24/u
    );
  } finally {
    await ctx.cleanup();
  }
});
