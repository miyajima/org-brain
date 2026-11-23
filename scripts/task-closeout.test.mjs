import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { resolveCloseoutIdentity } from "../packages/orgbrain-cli/src/lib/task-closeout.mjs";

const cli = fileURLToPath(new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url));
const snapshot = {
  scope: "Implement bounded checkpoint CLI",
  completed: [{ work: "Read the existing task-store contract", evidence: [{ kind: "read", ref: "read:task-store" }] }],
  unverified: [{ reason: "not_run", detail: "Real cloud behavior was not exercised" }],
  next_action: "Run the cloud check if authorized"
};
const base = { tenantId: "tenant-one", projectId: "project-one", workspace: "/checkout-one", taskId: "task-one" };

test("checkpoint statistics separate real reads, reported use and reported effects", async (t) => {
  const { store } = await fixture(t);
  const now = Date.now();
  await store.saveCloseout(base, snapshot, now);
  await store.resumeCloseout(base, now); // inspection is not usage
  assert.equal((await store.closeoutStats(base)).reads, 0);
  const first = await store.resumeCloseoutTracked(base, now + 1);
  const second = await store.resumeCloseoutTracked(base, now + 2);
  assert.ok(first.read_id);
  await store.reportCloseoutUse(base, first.read_id, { use: "used" });
  await store.reportCloseoutUse(base, first.read_id, { effect: "positive", evidence: "check:review-42" });
  await store.reportCloseoutUse(base, second.read_id, { use: "not_used" });
  await assert.rejects(store.reportCloseoutUse(base, second.read_id, { effect: "positive", evidence: "check:review-42" }), /task_checkpoint_effect_requires_use/);
  await assert.rejects(store.reportCloseoutUse({ ...base, projectId: "other" }, first.read_id, { use: "used" }), /task_checkpoint_read_not_found/);
  const stats = await store.closeoutStats(base);
  assert.deepEqual(stats, { reads: 2, used: 1, not_used: 1, use_unknown: 0, positive: 1, neutral: 0, negative: 0, effect_unknown: 0, effect_unreported: 1 });
  await store.reportCloseoutUse(base, first.read_id, { effect: "clear" });
  await store.reportCloseoutUse(base, first.read_id, { use: "unknown" });
  const corrected = await store.closeoutStats(base);
  assert.equal(corrected.use_unknown, 1);
  assert.equal(corrected.positive, 0);
  assert.equal(corrected.effect_unreported, 2);
  assert.equal(await store.resumeCloseoutTracked(base, now + 7 * 86400000), null);
  assert.deepEqual(await store.closeoutStats({ ...base, projectId: "other" }), { reads: 0, used: 0, not_used: 0, use_unknown: 0, positive: 0, neutral: 0, negative: 0, effect_unknown: 0, effect_unreported: 0 });
});

test("checkpoint CLI records resumptions and exposes scoped reported statistics", async (t) => {
  const { dir, db } = await fixture(t);
  const workspace = join(dir, "project");
  await mkdir(workspace);
  const config = join(dir, "workspaces.json");
  await writeFile(config, JSON.stringify({ version: 3, workspaces: { [workspace]: { tenant_id: "tenant-one", project_id: "project-one" } } }));
  const run = (operation, input, extra = []) => spawnSync(process.execPath,
    [cli, "task", "checkpoint", operation, "--task-id", "task-one", "--db", db, ...extra],
    { cwd: workspace, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", env: { ...process.env, ORGBRAIN_WORKSPACES_FILE: config } });
  assert.equal(run("save", snapshot, ["--input", "-"]).status, 0);
  assert.equal(run("inspect").status, 0);
  let stats = JSON.parse(run("stats").stdout);
  assert.equal(stats.stats.reads, 0);
  const resumed = JSON.parse(run("resume").stdout);
  assert.ok(resumed.read_id);
  assert.equal(run("report", { read_id: resumed.read_id, use: "used" }, ["--input", "-"]).status, 0);
  assert.equal(run("report", { read_id: resumed.read_id, effect: "positive", evidence: "check:review-42" }, ["--input", "-"]).status, 0);
  stats = JSON.parse(run("stats").stdout);
  assert.equal(stats.stats.reads, 1);
  assert.equal(stats.stats.used, 1);
  assert.equal(stats.stats.positive, 1);
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orgbrain-closeout-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, "checkpoint.sqlite");
  return { dir, db, store: new TaskCommitmentStore(db) };
}

test("checkpoint replace is atomic per exact scope, resumes historically and expires", async (t) => {
  const { store, db } = await fixture(t);
  const firstTime = Date.now();
  assert.equal(await store.resumeCloseout(base, firstTime), null);
  await assert.rejects(access(db), { code: "ENOENT" });
  const first = await store.saveCloseout(base, snapshot, firstTime);
  const secondInput = { ...snapshot, unverified: [], next_action: null };
  const second = await store.saveCloseout(base, secondInput, firstTime);
  assert.equal(second.checkpoint_id, first.checkpoint_id);
  const historical = await store.resumeCloseout(base, firstTime);
  assert.equal(historical.verification, "historical_not_reverified");
  assert.deepEqual(historical.checkpoint, secondInput);
  assert.equal(historical.checkpoint.completed[0].evidence[0].kind, "read");
  for (const mismatch of [
    { tenantId: "tenant-two" }, { projectId: "project-two" }, { taskId: "task-two" }, { workspace: "/checkout-two" }
  ]) assert.equal(await store.resumeCloseout({ ...base, ...mismatch }, firstTime), null);
  assert.equal(await store.resumeCloseout(base, second.expires_at), null);
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM task_context_checkpoints").get().count, 1);
  } finally { raw.close(); }
  if (process.platform !== "win32") assert.equal((await stat(db)).mode & 0o777, 0o600);
});

test("invalid or sensitive payload cannot be stored as raw working data", async (t) => {
  const { store, db } = await fixture(t);
  const initial = { ...snapshot, next_action: "Ask editor@example.com about token=secret-private-value" };
  await store.saveCloseout(base, initial);
  for (const input of [
    { ...snapshot, raw_transcript: "private" },
    { ...snapshot, completed: [{ ...snapshot.completed[0], evidence: [] }] },
    { ...snapshot, completed: [{ ...snapshot.completed[0], evidence: [{ kind: "check", ref: "ghp_short_fakecredential1234567890" }] }] },
    { ...snapshot, completed: [{ ...snapshot.completed[0], evidence: [{ kind: "check", ref: "https://example.com/raw/log" }] }] },
    { ...snapshot, unverified: [{ reason: "unrecognized", detail: "gap" }] },
    { ...snapshot, next_action: "One\nTwo" }
  ]) await assert.rejects(store.saveCloseout(base, input), /^Error: task_checkpoint_/u);
  const result = await store.resumeCloseout(base);
  assert.equal(result.checkpoint.next_action, "Ask [REDACTED_EMAIL] about [REDACTED_SECRET]");
  assert.equal(result.checkpoint.completed[0].evidence[0].ref, "read:task-store");
  const raw = new DatabaseSync(db);
  try {
    assert.doesNotMatch(raw.prepare("SELECT payload_json FROM task_context_checkpoints").get().payload_json, /editor@example|secret-private-value/u);
    raw.exec("UPDATE task_context_checkpoints SET payload_json = '{}'");
  } finally { raw.close(); }
  await assert.rejects(store.resumeCloseout(base), /task_checkpoint_integrity_mismatch/u);
});

test("CLI uses mapped authority and does not put closeout in memory, commitments, or delivery", async (t) => {
  const { db, dir, store } = await fixture(t);
  const workspace1 = join(dir, "project-a");
  const workspace2 = join(dir, "project-b");
  const unmapped = join(dir, "unmapped");
  await Promise.all([workspace1, workspace2, unmapped].map((entry) => mkdir(entry)));
  const config = join(dir, "workspaces.json");
  const membership = { tenant_id: base.tenantId, project_id: base.projectId };
  await writeFile(config, JSON.stringify({ version: 3, workspaces: { [workspace1]: membership, [workspace2]: membership } }), { mode: 0o600 });
  const run = (args, input, cwd = workspace1, subcommand = ["task", "checkpoint"]) => spawnSync(
    process.execPath, [cli, ...subcommand, ...args, "--db", db], {
      cwd, input, encoding: "utf8", env: { ...process.env, ORGBRAIN_WORKSPACES_FILE: config }
    });
  const task = ["--task-id", base.taskId];
  const save = run(["save", ...task, "--input", "-"], JSON.stringify(snapshot));
  assert.equal(save.status, 0, save.stderr);
  assert.equal(JSON.parse(save.stdout).saved, true);
  const found = run(["resume", ...task]);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).verification, "historical_not_reverified");
  assert.deepEqual(JSON.parse(found.stdout).checkpoint, snapshot);
  if (process.platform !== "win32") {
    const alias = join(dir, "project-alias");
    await symlink(workspace1, alias);
    assert.equal(JSON.parse(run(["resume", ...task], undefined, alias).stdout).found, true);
  }
  assert.equal(JSON.parse(run(["resume", ...task], undefined, workspace2).stdout).found, false);
  assert.match(run(["resume", ...task], undefined, unmapped).stderr, /requires_tenant_and_project/u);
  assert.match(run(["resume"]).stderr, /explicit_task_id_required/u);
  assert.match(run(["resume", ...task, "--tenant-id", "other"]).stderr, /invalid_command/u);
  assert.match(run(["save", ...task, "--input", "-"], " ".repeat(17_000)).stderr, /input_too_large/u);
  const legacyScope = { tenantId: base.tenantId, projectId: base.projectId, taskKey: `codex:${base.taskId}` };
  assert.equal(await store.latestCheckpoint(legacyScope), null);
  await store.checkpoint({ ...legacyScope, payload: { commitments: [{ decision_key: "legacy" }] } });
  assert.equal((await store.latestCheckpoint(legacyScope)).payload.commitments[0].decision_key, "legacy");
  assert.equal(JSON.parse(run(["resume", ...task]).stdout).found, true);
  const listing = run(["list", "--tenant-id", base.tenantId, "--project-id", base.projectId], undefined, workspace1, ["memory"]);
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /bounded checkpoint|task-store|historical_not_reverified/u);
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    for (const table of ["task_commitments", "memory_learning_candidates", "memory_learning_outbox"]) {
      assert.equal(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  } finally { raw.close(); }
});

test("linked worktree inherits project authority without sharing checkpoint identity", async (t) => {
  const { dir, store } = await fixture(t);
  const repo = join(dir, "repo");
  const linked = join(dir, "linked");
  await mkdir(repo);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=test@invalid.example", "commit", "--allow-empty", "-qm", "test");
  git("worktree", "add", "--detach", linked, "HEAD");
  const nested = join(linked, "nested");
  await mkdir(nested);
  const config = join(dir, "workspaces.json");
  await writeFile(config, JSON.stringify({ version: 3, workspaces: { [repo]: { tenant_id: base.tenantId, project_id: base.projectId } } }), { mode: 0o600 });
  const env = { ORGBRAIN_WORKSPACES_FILE: config };
  const primary = await resolveCloseoutIdentity(repo, base.taskId, env);
  const child = await resolveCloseoutIdentity(nested, base.taskId, env);
  assert.deepEqual(child, { ...primary, workspace: linked });
  await store.saveCloseout(primary, snapshot);
  assert.equal(await store.resumeCloseout(child), null);
  await store.saveCloseout(child, { ...snapshot, next_action: null });
  assert.equal((await store.resumeCloseout(child)).checkpoint.next_action, null);
  assert.equal((await store.resumeCloseout(primary)).checkpoint.next_action, snapshot.next_action);
});

test("only a fresh scoped committed lesson can enter normal proposal and explicit review", async (t) => {
  const { db, dir } = await fixture(t);
  const project = join(dir, "repo");
  await mkdir(project);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  const rule = "Bind every SQLite checkpoint to its mapped project and exact worktree.";
  const lesson = {
    conclusion: rule,
    rationale: "A common repository location cannot uniquely identify a linked worktree.",
    reuse_when: "When a tool persists resumable work in a database shared by several worktrees.",
    source: { path: "policy.md", start_line: 3, end_line: 3 }
  };
  const doc = join(project, "policy.md");
  await writeFile(doc, `# Project handbook\n\n${rule}\nCompleted the implementation.\n${snapshot.next_action}\n`);
  git("add", "policy.md");
  if (process.platform !== "win32") {
    await symlink("policy.md", join(project, "link.md"));
    git("add", "link.md");
  }
  git("-c", "user.name=Fixture", "-c", "user.email=test@invalid.example", "commit", "-qm", "policy");
  const commit = git("rev-parse", "HEAD");
  // Working changes cannot replace the independent, committed source or its hash.
  await writeFile(doc, "# Uncommitted replacement\n");
  await writeFile(join(project, ".orgbrain.local.json"), JSON.stringify({ version: 1, tenant_id: base.tenantId, project_id: base.projectId }), { mode: 0o600 });
  const config = join(dir, "workspaces.json");
  await writeFile(config, JSON.stringify({ version: 3, workspaces: {
    [project]: { tenant_id: base.tenantId, project_id: base.projectId, default_work_type: "implementation" }
  } }), { mode: 0o600 });
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, "--db", db], {
    cwd: project, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ORGBRAIN_WORKSPACES_FILE: config, USER: "reviewer-fixture" }
  });
  const checkpoint = (command, input) => run(["task", "checkpoint", command, "--task-id", base.taskId, "--input", "-"], input);
  assert.match(checkpoint("propose-lesson", lesson).stderr, /task_lesson_checkpoint_missing/u);
  const saved = checkpoint("save", snapshot);
  assert.equal(saved.status, 0, saved.stderr);
  for (const [input, reason] of [
    [{ ...lesson, tenant_id: "other" }, "invalid_shape"],
    [{ ...lesson, conclusion: `${rule} Production also passed.` }, "conclusion_not_in_source"],
    [{ ...lesson, source: { ...lesson.source, path: "../policy.md" } }, "invalid_source"],
    [{ ...lesson, source: { ...lesson.source, path: "missing.md" } }, "source_unavailable"],
    [{ ...lesson, conclusion: "Completed the implementation.", source: { ...lesson.source, start_line: 4, end_line: 4 } }, "transient_progress"],
    [{ ...lesson, conclusion: snapshot.next_action, source: { ...lesson.source, start_line: 5, end_line: 5 } }, "transient_progress"],
    ...(process.platform === "win32" ? [] : [[{ ...lesson, source: { ...lesson.source, path: "link.md" } }, "source_unavailable"]])
  ]) {
    assert.match(checkpoint("propose-lesson", input).stderr, new RegExp(`task_lesson_${reason}`, "u"));
  }
  const proposal = checkpoint("propose-lesson", lesson);
  assert.equal(proposal.status, 0, proposal.stderr);
  const proposed = JSON.parse(proposal.stdout);
  assert.equal(proposed.saved, false);
  assert.equal(proposed.source_verification, "committed_document_passage");
  assert.equal(proposed.proposed_memory.project_id, base.projectId);
  assert.equal(proposed.proposed_memory.work_type, "implementation");
  assert.equal(proposed.proposed_evidence[0].evidence_ref, `git:${commit}:policy.md#L3-L3`);
  for (const text of [snapshot.scope, snapshot.completed[0].work, snapshot.unverified[0].detail, snapshot.next_action]) {
    assert.ok(!proposal.stdout.includes(text));
  }
  const dbHandle = new DatabaseSync(db, { readOnly: true });
  try {
    assert.equal(dbHandle.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 0);
  } finally { dbHandle.close(); }
  const { handleLocalMcpRequest } = await import("../packages/orgbrain-cli/src/local-mcp.mjs");
  const { LocalMemoryStore } = await import("../packages/orgbrain-cli/src/lib/local-memory-store.mjs");
  const store = new LocalMemoryStore(db);
  const request = async (name, arguments_) => handleLocalMcpRequest(store, { method: "tools/call", params: { name, arguments: arguments_ } });
  const confirm = (fields) => request("orgbrain_memories_confirm", { confirmation_token: proposed.confirmation_token, tenant_id: base.tenantId, approved: true, ...fields });
  const response = (value) => JSON.parse(value.content[0].text);
  const spoof = await request("orgbrain_memories_propose", {
    source: "task-closeout-lesson", item: { content: "Unreviewed fabricated provenance" }
  });
  assert.match(response(spoof).error, /requires_scoped_proposal/u);
  assert.match(response(await confirm({})).error, /review_answer_required/u);
  assert.match(response(await confirm({ tenant_id: "other", review_answer: "保存する" })).error, /confirmation/u);
  assert.match(response(await confirm({ review_answer: "修正: 別の未検証ルール", corrected_content: "別の未検証ルール" })).error,
    /pinned_source_review_requires_new_proposal/u);
  const result = await confirm({ review_answer: "保存する" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(response(result).saved, true);
  const final = new DatabaseSync(db, { readOnly: true });
  try {
    const row = final.prepare("SELECT * FROM memories").get();
    assert.equal(row.actor_id, "reviewer-fixture");
    assert.equal(row.project_id, base.projectId);
    assert.equal(row.kind, "semantic");
    assert.equal(row.source, "task-closeout-lesson");
    assert.equal(row.verification_state, "partial");
    assert.equal(row.verified_at, null);
    const [recordedSource] = JSON.parse(row.source_refs_json);
    assert.equal(recordedSource.ref, `repo:${base.projectId}/policy.md`);
    assert.match(recordedSource.content_hash, /^[a-f0-9]{64}$/u);
    assert.match(row.evidence_json, /committed source/u);
    assert.match(row.content, /Bind every SQLite checkpoint/u);
    assert.match(row.content, /A common repository location/u);
    assert.match(row.content, /When a tool persists/u);
    assert.doesNotMatch(row.content, /Real cloud behavior/u);
  } finally { final.close(); }
});
