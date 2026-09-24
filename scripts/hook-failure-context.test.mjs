import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-failure-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "hooks.json"), "fixture-v1");
  const workspacesFile = path.join(root, "workspaces.json");
  await writeFile(workspacesFile, JSON.stringify({ version: 1, workspaces: {
    [workspace]: { tenant_id: "default", project_id: "org-brain", memory_learning_mode: "off" }
  } }));
  const dbPath = path.join(root, "memory.sqlite");
  const store = new LocalMemoryStore(dbPath);
  await store.useHistory("configure", { mode: "c", collect: true, sync: false });
  const env = { ORGBRAIN_WORKSPACES_FILE: workspacesFile, ORGBRAIN_LOCAL_DB: dbPath,
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "false", ORGBRAIN_ENABLE_ORG_SHARING: "false",
    ORGBRAIN_HOOK_ENV_FILES: path.join(root, "missing.env"), DOMAIN_RECALL_MODE: "off" };
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "failure-context-test", cwd: workspace,
    prompt: "Codex hooks の失敗を調べて" };
  return { root, workspace, workspacesFile, store, env, payload,
    run: (overrides = {}) => buildCodexMemoryContext({ ...payload, ...overrides }, { store, env }) };
}

async function lesson(ctx, id = "lesson", overrides = {}) {
  return ctx.store.capture({
    id, tenant_id: "default", project_id: "org-brain", work_type: "other", kind: "pitfall",
    content: "Codex hooks の失敗は設定の単位を修正して解決", summary: "Codex hooks の設定単位を修正",
    source: "test", external_key: id, capture_origin: "observed", verification_state: "verified", verified_at: Date.now(),
    confidence_score: 0.95, utility_score: 0.95,
    source_references: [{ type: "codex-turn", ref: `event:${id}` }],
    evidence: [{ type: "file", ref: "hooks.json", content_hash: createHash("sha256").update("fixture-v1").digest("hex") }],
    learning: { schema_version: 2, lesson_type: "failure", trigger: "Codex hooks の設定変更時",
      applicability: { target_files: ["hooks.json"], components: ["Codex hooks"] },
      failed_approach: "ミリ秒を秒として指定した", root_cause: "設定値の時間単位が違った",
      correction: "設定値をミリ秒に変換した", verified_outcome: "フックの実行テストが成功",
      avoidance_rule: "同じ設定項目を変更する場合のみ、単位を確認する。別の項目には適用しない。", gaps: [],
      ...overrides.learning },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "learning"))
  });
}

async function attempt(ctx, id = "attempt", overrides = {}) {
  return ctx.store.recordAttempt("default", {
    id, project_id: "org-brain", action_key: "hooks:run", action_label: "Codex hooks を実行",
    attempt_type: "tool_result", target: "Codex hooks", conditions: { revision: "v1" },
    outcome: "failure", result_summary: "終了コード1", failure_kind: "unknown", performed_at: 1000,
    executed_by_type: "agent", executed_by: "codex", evidence: [{ ref_type: "task_event", ref_id: `event:${id}`, content_hash: "a".repeat(64) }],
    source: "fixture", source_key: id, ...overrides
  }, { trusted: true });
}

function injected(ctx) {
  const db = ctx.store.open({ readOnly: true });
  try { return db.prepare("SELECT source_id,id FROM memory_usage_items WHERE reference_type='injected' ORDER BY rank").all(); }
  finally { db.close(); }
}

test("verified failure context preserves cause, correction, full conditions and matching receipts", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx);
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  for (const expected of ["検証済みの失敗教訓", "ミリ秒を秒として指定した", "設定値の時間単位が違った",
    "設定値をミリ秒に変換した", "フックの実行テストが成功", "別の項目には適用しない。", "event:lesson"]) {
    assert.ok(output.includes(expected), expected);
  }
  const rows = injected(ctx);
  assert.deepEqual(rows.map((row) => row.source_id), ["lesson"]);
  assert.ok(output.includes(rows[0].id));
  assert.ok(Buffer.byteLength(output) <= 7168);
});

test("unknown failures remain observations, and duplicate evidence uses only the complete lesson", async (t) => {
  const ctx = await fixture(t);
  await attempt(ctx);
  const first = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(first, /unknown/u);
  assert.match(first, /未解決とは断定しない/u);
  assert.match(first, /条件の変化と後続の成功記録を確認/u);
  await lesson(ctx, "same", { source_references: [{ type: "codex-turn", ref: "event:attempt" }] });
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /検証済みの失敗教訓/u);
  assert.doesNotMatch(output, /OrgBrain past attempts/u);
  const counts = await ctx.store.attemptUseReport("default", "org-brain");
  assert.equal(counts.find((row) => row.stage === "injected").count, 1);
});

test("a retrieved later verified success supersedes the same-condition failure in the brief", async (t) => {
  const ctx = await fixture(t);
  await attempt(ctx);
  await attempt(ctx, "resolved", { outcome: "success", failure_kind: undefined, result_summary: "Codex hooks が成功", performed_at: 2000 });
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /event:resolved/u);
  assert.doesNotMatch(output, /event:attempt/u);
  assert.doesNotMatch(output, /失敗の分類/u);
});

test("a successful tool exit does not replace a failed intervention", async (t) => {
  const ctx = await fixture(t);
  await attempt(ctx, "intervention", { attempt_type: "intervention", failure_kind: "deterministic" });
  await attempt(ctx, "tool-success", { outcome: "success", failure_kind: undefined, result_summary: "Codex hooks が成功", performed_at: 2000 });
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /event:intervention/u);
  assert.match(output, /event:tool-success/u);
});

test("oversized conditions omit the whole lesson and its receipt but retain a smaller entry", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx, "oversized", { learning: { root_cause: "原因".repeat(950), correction: "対処".repeat(950) } });
  await attempt(ctx, "small");
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /event:small/u);
  assert.doesNotMatch(output, /検証済みの失敗教訓|event:oversized|Use tracking: receipt/u);
  assert.deepEqual(injected(ctx), []);
  assert.ok(Buffer.byteLength(output) <= 7168);
});

test("failure brief has at most two entries and does not count omitted attempts as injected", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx, "one");
  await lesson(ctx, "two");
  await attempt(ctx, "third");
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.equal((output.match(/検証済みの失敗教訓/gu) ?? []).length, 2);
  assert.doesNotMatch(output, /event:third/u);
  assert.deepEqual(await ctx.store.attemptUseReport("default", "org-brain"), []);
});

test("legacy pitfalls do not acquire a verified cause or a fabricated correction", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx, "legacy", { verification_state: "unverified", learning: { lesson_type: null },
    reuse_rule: "同じ条件でのみ参考にする", rationale: "未検証の旧記録" });
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /未検証または情報不足/u);
  assert.match(output, /同じ条件でのみ参考にする/u);
  assert.doesNotMatch(output, /OrgBrain 検証済み|有効だった対処/u);
});

test("unrelated, cross-project, stale, expired and acknowledgement contexts do not inject failures", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx, "other-project", { project_id: "other-project" });
  await attempt(ctx, "other-attempt", { project_id: "other-project" });
  assert.doesNotMatch((await ctx.run())?.hookSpecificOutput.additionalContext ?? "", /event:|失敗教訓/u);
  await lesson(ctx, "expired", { expires_at: Date.now() - 1000 });
  assert.doesNotMatch((await ctx.run())?.hookSpecificOutput.additionalContext ?? "", /event:|失敗教訓/u);
  await lesson(ctx, "stale");
  await writeFile(path.join(ctx.workspace, "hooks.json"), "changed");
  for (const prompt of [ctx.payload.prompt, "mountain weather forecast", "ありがとう"]) {
    const result = await ctx.run({ prompt });
    assert.doesNotMatch(result?.hookSpecificOutput.additionalContext ?? "", /event:|失敗教訓/u);
  }
  assert.deepEqual(injected(ctx), []);
});

test("continuation prompt retains the earlier task when retrieving failure lessons", async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx);
  const transcript = path.join(ctx.root, "session.jsonl");
  await writeFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text: "Codex hooks の失敗を調べて" }] } }) + "\n");
  const output = (await ctx.run({ prompt: "その修正を進めて", transcript_path: transcript })).hookSpecificOutput.additionalContext;
  assert.match(output, /event:lesson/u);
});

test("eager lifecycle instructions and a complete lesson fit together without leaking personal fields", async (t) => {
  const ctx = await fixture(t);
  await writeFile(ctx.workspacesFile, JSON.stringify({ version: 1, workspaces: {
    [ctx.workspace]: { tenant_id: "default", project_id: "org-brain", memory_learning_mode: "eager" }
  } }));
  await lesson(ctx, "eager", { learning: { root_cause: "ops@example.com が設定単位を誤認した" } });
  const output = (await ctx.run()).hookSpecificOutput.additionalContext;
  assert.match(output, /OrgBrain memory protocol v2/u);
  assert.match(output, /OrgBrain eager learning is enabled/u);
  assert.match(output, /event:eager/u);
  assert.match(output, /\[REDACTED_EMAIL\]/u);
  assert.doesNotMatch(output, /ops@example\.com/u);
  assert.ok(Buffer.byteLength(output) <= 7168);
});

test("packaged CLI delivers the same failure context through the hook command", { skip: !process.env.ORGBRAIN_TEST_BUNDLE }, async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx);
  const output = execFileSync(process.execPath, [process.env.ORGBRAIN_TEST_BUNDLE, "hook", "codex-context"], {
    input: JSON.stringify(ctx.payload), encoding: "utf8", env: { ...process.env, ...ctx.env }
  });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(context, /検証済みの失敗教訓/u);
  assert.match(context, /別の項目には適用しない/u);
  assert.equal(injected(ctx).length, 1);
  assert.ok(Buffer.byteLength(context) <= 7168);
});

test("configured context wrapper preserves the packaged lesson", {
  skip: !process.env.ORGBRAIN_TEST_BUNDLE || !process.env.ORGBRAIN_TEST_CONTEXT_WRAPPER
}, async (t) => {
  const ctx = await fixture(t);
  await lesson(ctx);
  const output = execFileSync("python3", [process.env.ORGBRAIN_TEST_CONTEXT_WRAPPER, "--context-limit", "8192", "--",
    process.execPath, process.env.ORGBRAIN_TEST_BUNDLE, "hook", "codex-context"], {
    input: JSON.stringify(ctx.payload), encoding: "utf8", env: { ...process.env, ...ctx.env }
  });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(context, /検証済みの失敗教訓/u);
  assert.match(context, /別の項目には適用しない/u);
  assert.equal(injected(ctx).length, 1);
  assert.ok(Buffer.byteLength(context) <= 8192);
});
