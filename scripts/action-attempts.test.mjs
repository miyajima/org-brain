import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { buildCodexAttemptImportReport, applyCodexAttemptImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { preflightHookAction, recordHookActionResult } from "../packages/orgbrain-cli/src/lib/action-attempt-hook.mjs";
import { safeAttemptActionLabel } from "../packages/shared/src/attempt-history-runtime.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-action-attempts-"));
  const store = new LocalMemoryStore(join(root, "memory.sqlite"));
  return { root, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function attempt(id, overrides = {}) {
  return {
    id, project_id: "consentside", action_key: "sip:gateway:retry", action_label: "SIP gateway を再設定",
    target: "staging gateway", conditions: { version: "v1", config: "a" }, outcome: "failure",
    result_summary: "設定値が拒否された", failure_kind: "deterministic", performed_at: Date.now() - 1_000,
    executed_by_type: "agent", executed_by: "codex", evidence: [{ ref_type: "task_event", ref_id: `event:${id}`, content_hash: "a".repeat(64) }],
    source: "fixture", source_key: `source:${id}`, ...overrides
  };
}

test("verified attempts stop identical remedies, allow a changed hypothesis, and preserve corrections", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("first"), { trusted: true });
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 1);
    const blocked = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } });
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.prior_attempts[0].evidence[0].ref_id, "event:first");
    const feedback = await ctx.store.recordAttemptMetricEvent("default", {
      project_id: "consentside", kind: "feedback", source: "mcp",
      related_event_id: blocked.preflight_event_id, feedback_verdict: "false_block",
      evidence: [{ ref_type: "task_event", ref_id: "event:feedback", content_hash: "c".repeat(64) }]
    });
    assert.equal(feedback.verification_state, "reported");
    const changed = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v2", config: "a" } });
    assert.equal(changed.reason, "change_hypothesis_required");
    const proposed = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v2", config: "a" }, change_hypothesis: "新しい版で設定が受理される", alternatives: [{ action_key: "sip:gateway:other", label: "別の経路" }] });
    assert.equal(proposed.decision, "allow");
    assert.equal(proposed.alternative_candidates[0].status, "no_accessible_prior_attempt");
    await ctx.store.recordAttempt("default", attempt("correction", { supersedes_id: "first", outcome: "success", result_summary: "実際には成功していた", failure_kind: undefined, performed_at: Date.now() }), { trusted: true });
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "allow");
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 1);
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 0);
    const metrics = await ctx.store.actionAttemptMetricsReport("default", "consentside");
    assert.equal(metrics.preflight_blocks, 1);
    assert.equal(metrics.false_blocks_reported, 1);
    assert.equal(metrics.false_blocks_verified, 0);
  } finally { await ctx.cleanup(); }
});

test("a later verified success resolves an earlier failure without changing the audit record", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("failed-earlier", {
      performed_at: Date.parse("2026-08-25T00:00:00Z")
    }), { trusted: true });
    await ctx.store.recordAttempt("default", attempt("success-later", {
      outcome: "success", failure_kind: undefined, result_summary: "再試行は成功",
      performed_at: Date.parse("2026-08-26T00:00:00Z")
    }), { trusted: true });
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "allow");
    await ctx.store.recordAttempt("default", attempt("reported-after-success", {
      performed_at: Date.parse("2026-08-27T00:00:00Z")
    }));
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "warn");
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 3);
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 0);
  } finally { await ctx.cleanup(); }
});

test("a verified transient failure warns instead of blocking", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("transient", { failure_kind: "transient" }), { trusted: true });
    const result = await ctx.store.preflightAction("default", {
      project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" }
    });
    assert.equal(result.decision, "warn");
    assert.equal(result.reason, "failure_not_deterministic_or_verified");
  } finally { await ctx.cleanup(); }
});

test("public MCP records remain reported and context exposes dated evidence without claiming use", async () => {
  const ctx = await fixture();
  try {
    const input = attempt("reported", { action_label: "Zoom callback を再設定" });
    const recorded = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_attempt_record", arguments: { attempt: input } } });
    const row = JSON.parse(recorded.content[0].text);
    assert.equal(row.verification_state, "reported");
    assert.equal(row.executed_by_type, "unknown");
    const check = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: input.action_key, conditions: input.conditions });
    assert.equal(check.decision, "warn");
    const enriched = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_context_enrich", arguments: { project_id: "consentside", query: "Zoom callback", work_type: "implementation" } } });
    const context = JSON.parse(enriched.content[0].text);
    assert.equal(context.prior_attempts[0].action_label, input.action_label);
    assert.equal(context.prior_attempts[0].performed_at, input.performed_at);
    assert.equal(context.prior_attempts[0].evidence.length, 1);
    assert.equal(context.attempt_usage_ids.length, 1);
    const adoption = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_attempt_use_record", arguments: {
      project_id: "consentside", attempt_id: row.id, stage: "adopted", task_id: "task-one",
      evidence: [{ ref_type: "task_event", ref_id: "event:adoption", content_hash: "b".repeat(64) }]
    } } });
    assert.equal(JSON.parse(adoption.content[0].text).verification_state, "reported");
    const useReport = await ctx.store.attemptUseReport("default", "consentside");
    assert.deepEqual(useReport.map((item) => [item.stage, item.verification_state, item.count]), [
      ["adopted", "reported", 1], ["returned", "observed", 1]
    ]);
    const metrics = await ctx.store.actionAttemptMetricsReport("default", "consentside");
    assert.equal(metrics.context_queries, 1);
    assert.equal(metrics.history_return_rate, 1);
    assert.equal(metrics.verified_adoption_rate, 0);
    await assert.rejects(() => ctx.store.recordAttempt("default", attempt("secret", { result_summary: "api_key=supersecretvalue" }), { trusted: true }), /sensitive_result_summary/u);
    assert.equal(safeAttemptActionLabel("curl --token=supersecretvalue https://example.invalid", "exec_command"), "exec_command operation");
    await assert.rejects(() => ctx.store.recordAttempt("default", attempt("secret-label", { action_label: "token=supersecretvalue" }), { trusted: true }), /sensitive_action_label/u);
  } finally { await ctx.cleanup(); }
});

test("verified principal attribution needs a current profile; unknown executor stays unknown", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.updateProfile("default", "user:alice", { display_name: "A" });
    await ctx.store.recordAttempt("default", attempt("alice", {
      executed_by_type: "principal", executed_by: "user:alice", performed_at: Date.parse("2026-08-25T00:00:00Z")
    }), { trusted: true, principal: "user:requester" });
    await ctx.store.recordAttempt("default", attempt("unknown", {
      action_key: "sip:gateway:other", executed_by_type: "unknown", executed_by: null,
      performed_at: Date.parse("2026-08-26T00:00:00Z")
    }), { trusted: true });
    const rows = await ctx.store.searchAttempts("default", { project_id: "consentside" });
    const named = rows.find((row) => row.id === "alice");
    assert.equal(named.requested_by, "user:requester");
    assert.match(named.summary_ja, /2026年8月25日にAさんが/u);
    assert.ok(named.evidence.length);
    const unknown = rows.find((row) => row.id === "unknown");
    assert.match(unknown.summary_ja, /実行者未確認/u);
    assert.doesNotMatch(unknown.summary_ja, /Aさん/u);
  } finally { await ctx.cleanup(); }
});

test("structured failed PostToolUse result is saved before task completion", async () => {
  const ctx = await fixture();
  try {
    const result = await recordHookActionResult({
      tool_name: "functions.exec_command", session_id: "session-one", tool_call_id: "call-one",
      tool_input: { cmd: "npm run check", workdir: ctx.root },
      tool_result: { exit_code: 2, output: "private diagnostic" }
    }, ctx.store, "default", "consentside");
    assert.equal(result.recorded, true);
    const rows = await ctx.store.searchAttempts("default", { project_id: "consentside" });
    assert.equal(rows[0].outcome, "failure");
    assert.equal(rows[0].attempt_type, "tool_result");
    assert.equal(rows[0].verification_state, "verified");
    assert.ok(!JSON.stringify(rows[0]).includes("private diagnostic"));
  } finally { await ctx.cleanup(); }
});

test("PreToolUse blocks a confirmed duplicate in the same clean checkout and warns after a change", async () => {
  const ctx = await fixture();
  try {
    const workspace = join(ctx.root, "repo");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "before\n");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    const cmd = "npm run broken-fix";
    const actionKey = `tool:exec_command:${sha(cmd).slice(0, 48)}`;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    await ctx.store.recordAttempt("default", attempt("known", {
      action_key: actionKey, action_label: cmd, conditions: { git_head: head, tracked_diff: sha("") }
    }), { trusted: true });
    const payload = { tool_name: "functions.exec_command", tool_input: { cmd, workdir: workspace }, cwd: workspace };
    const blocked = await preflightHookAction(payload, ctx.store, "default", "consentside");
    assert.equal(blocked.decision, "block");
    await writeFile(join(workspace, "file.txt"), "changed\n");
    const changed = await preflightHookAction(payload, ctx.store, "default", "consentside");
    assert.equal(changed.decision, "warn");
    assert.equal(changed.reason, "change_hypothesis_required");
    const opaque = await preflightHookAction({ tool_name: "functions.exec", tool_input: { code: "const x = await tools.exec_command(dynamic)" }, cwd: workspace }, ctx.store, "default", "consentside");
    assert.equal(opaque.reason, "opaque_tool_action");
  } finally { await ctx.cleanup(); }
});

test("historical import accepts structured command outcomes, excludes opaque output, and is idempotent", async () => {
  const ctx = await fixture();
  try {
    const workspace = join(ctx.root, "consentside");
    const sessionsRoot = join(ctx.root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionsRoot);
    const sessionId = "session-fixture";
    const base = { timestamp: "2026-08-25T00:00:00.000Z", type: "session_meta", payload: { id: sessionId, cwd: workspace, thread_source: "user" } };
    const event = (id, exit, second) => ({ timestamp: `2026-08-25T00:00:0${second}.000Z`, type: "event_msg", payload: {
      type: "item_completed", completed_at_ms: Date.parse(`2026-08-25T00:00:0${second}.000Z`),
      item: { type: "CommandExecution", id, cwd: pathToFileURL(workspace).href,
        command: ["/bin/zsh", "-lc", "npm run check"], exit_code: exit, stdout: "private output", stderr: "" }
    } });
    const file = join(sessionsRoot, "one.jsonl");
    await writeFile(file, [base, event("exec-one", 2, 1), event("exec-two", 0, 2),
      { timestamp: "2026-08-25T00:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "opaque", output: "[object Object]" } }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const options = { workspaceRoot: workspace, sessionFiles: [file], sessionsRoot, env: {
      ORGBRAIN_ENABLE_CLOUD_MEMORY: "false", ORGBRAIN_ENABLE_ORG_SHARING: "false",
      ORGBRAIN_WORKSPACES_FILE: join(ctx.root, "missing.json"), ORGBRAIN_TENANT_ID: "default"
    } };
    const report = await buildCodexAttemptImportReport(options);
    assert.equal(report.summary.candidates, 2);
    assert.equal(report.summary.nonzero_tool_exits, 1);
    assert.ok(!JSON.stringify(report).includes("private output"));
    const unrelated = join(sessionsRoot, "unrelated.jsonl");
    await writeFile(unrelated, `${JSON.stringify({ ...base, payload: { ...base.payload, id: "unrelated", cwd: ctx.root } })}\n`);
    options.sessionFiles.push(unrelated);
    const first = await applyCodexAttemptImportReport(report, { ...options, store: ctx.store, expectedPlanHash: report.plan_hash });
    const second = await applyCodexAttemptImportReport(report, { ...options, store: ctx.store, expectedPlanHash: report.plan_hash });
    assert.equal(first.created, 2);
    assert.equal(second.deduplicated, 2);
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 2);
  } finally { await ctx.cleanup(); }
});
