import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskCommitmentStore } from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';
import { memoryConfirmationQuestion } from '../packages/orgbrain-cli/src/lib/memory-confirmation-hints.mjs';
import { resolveWorkspaceMapping } from '../packages/orgbrain-cli/src/lib/workspace-config.mjs';
import { assessMemoryUsefulnessV2, classifyMemoryReviewAnswer } from '../packages/shared/src/memory-usefulness-runtime.mjs';

test('worktree inherits only its Git common repository and explicit off wins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-mapping-'));
  try {
    const main = path.join(root, 'main'); const worktree = path.join(root, 'tree');
    execFileSync('git', ['init', main]);
    execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '--detach', worktree]);
    const config = { workspaces: { [main]: { project_id: 'project', memory_learning_mode: 'on' } } };
    assert.equal((await resolveWorkspaceMapping(config, worktree)).source, 'git-common-repository');
    await mkdir(path.join(worktree, 'sub'));
    assert.equal((await resolveWorkspaceMapping(config, path.join(worktree, 'sub'))).entry.project_id, 'project');
    config.workspaces[worktree] = { project_id: 'project', memory_learning_mode: 'off' };
    assert.equal((await resolveWorkspaceMapping(config, path.join(worktree, 'sub'))).entry.memory_learning_mode, 'off');
    const unrelated = path.join(root, 'other', 'main'); await mkdir(unrelated, { recursive: true });
    assert.equal((await resolveWorkspaceMapping(config, unrelated)).entry, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offer does not consume a slot; asynchronous ACK is not consent; token receipt is monotonic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-lifecycle-'));
  try {
    const store = new TaskCommitmentStore(path.join(root, 'state.db'));
    const scope = { tenantId: 'tenant', projectId: 'project', taskKey: 'codex:session', deliverySessionKey: 'codex:session' };
    await store.queueMemoryConfirmations({ ...scope, candidates: [{ candidate_hash: 'a'.repeat(64), conclusion: 'Use source hashes', reason: '未確認', category_label: '決定事項と根拠', reuse_rule: '未確認', category: 'decision', content: 'Use source hashes', source_references: [{ type: 'user', ref: 'turn:1' }] }] });
    const first = await store.takeMemoryConfirmationBatch(scope);
    assert.equal(first.length, 1);
    assert.equal((await store.takeMemoryConfirmationBatch(scope)).length, 1);
    const question = memoryConfirmationQuestion(first[0]);
    const hook = { session_id: 'session', project_id: 'project', tool_name: 'functions.request_user_input_async', tool_input: { questions: [{ title: '作業方法を選ぶ', options: ['保存する', '別の方法'] }, { title: question.question, options: question.options.map(v => v.label) }] }, tool_result: { ok: true } };
    await store.ingestToolResult(hook, 'tenant');
    assert.equal((await store.takeMemoryConfirmationBatch(scope)).length, 0);
    assert.equal((await store.memoryReviewStatus(scope)).labels.length, 0);
    await store.ingestToolResult({ ...hook, tool_result: { answers: ['保存する', 'まだ決めていない'] } }, 'tenant');
    assert.equal((await store.memoryReviewStatus(scope)).labels[0].label, 'not_decided');
    await store.ingestToolResult({ session_id: 'session', tool_name: 'mcp__orgbrain__orgbrain_memories_propose', tool_input: { review_context: { candidate_id: first[0].id } }, tool_result: { candidate_id: first[0].id, confirmation_token: 'token' } }, 'tenant');
    const receipt = { session_id: 'session', tool_name: 'mcp__orgbrain__orgbrain_memories_confirm', tool_input: { confirmation_token: 'token' }, tool_result: { candidate_id: first[0].id, saved: true, approved: true, memory_id: 'memory', review_label: 'corrected', review_answer: '修正: Keep the source hash and role.' } };
    await store.ingestToolResult(receipt, 'tenant');
    await store.ingestToolResult(receipt, 'tenant');
    await store.ingestToolResult({ ...receipt, tool_name: 'mcp__orgbrain__orgbrain_memories_confirmation_status', tool_result: { status: 'unknown', saved: null } }, 'tenant');
    await store.ingestToolResult({ ...hook, tool_result: { answers: ['保存しない'] } }, 'tenant');
    const report = await store.memoryReviewStatus(scope);
    assert.equal(report.labels.length, 2);
    assert.equal(report.states[0].save_state, 'saved');
    assert.equal((await store.memoryReviewStatus({ ...scope, tenantId: 'other' })).labels.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown is not zero and saving is not evidence of task improvement', () => {
  const assessment = assessMemoryUsefulnessV2({ basis: 'human_confirmation' });
  assert.equal(assessment.axes.task_contribution.status, 'unknown');
  assert.equal(assessment.disposition, 'needs_evidence');
  assert.equal(assessMemoryUsefulnessV2({ stage: 'use', project_id: 'a', task_project_id: 'b' }).disposition, 'exclude');
  assert.equal(assessMemoryUsefulnessV2({ stage: 'use', expires_at: 1 }).disposition, 'exclude');
  assert.equal(classifyMemoryReviewAnswer('まだ決めていない'), 'not_decided');
  assert.equal(classifyMemoryReviewAnswer('保存しない'), 'not_needed');
  assert.equal(classifyMemoryReviewAnswer('はい'), 'unknown');
});

test('confirmation-only Stop queues a decision without automatic writes even with extraction enabled', async () => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'review-stop-'));
  try {
    const transcript = path.join(root, 'turn.jsonl');
    const records = [
      { type: 'turn_context', payload: { turn_id: 'turn-review', cwd: root } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '今後、このプロジェクトの認証APIはOAuthを必ず使う方針に決定します。' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '認証APIはOAuthを使う方針です。' }] } }
    ];
    await writeFile(transcript, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const envFile = path.join(root, 'empty.env'); await writeFile(envFile, '');
    const workspaceFile = path.join(root, 'workspaces.json');
    await writeFile(workspaceFile, JSON.stringify({ version: 3, workspaces: { [root]: { tenant_id: 'tenant', project_id: 'project', memory_learning_mode: 'confirm', memory_capture_v2_mode: 'on' } } }));
    const env = { ...process.env, ORGBRAIN_HOOK_ENV_FILES: envFile, ORGBRAIN_WORKSPACES_FILE: workspaceFile,
      ORGBRAIN_LOCAL_DB: path.join(root, 'state.db'), ORGBRAIN_ENABLE_CLOUD_MEMORY: 'true', ORGBRAIN_ENABLE_ORG_SHARING: 'true', ORGBRAIN_MEMORY_EXTRACTION_MODE: 'on', ORGBRAIN_MCP_URL: 'https://must-not-contact.invalid/mcp', ORGBRAIN_MCP_CLIENT_ID: 'test-client', ORGBRAIN_MCP_CLIENT_SECRET: 'fixture-secret', ORGBRAIN_TENANT_ID: 'tenant' };
    const output = execFileSync(process.execPath, ['--no-warnings', 'packages/orgbrain-cli/src/local-memory.mjs', 'hook', 'codex-stop'], { env,
      input: JSON.stringify({ session_id: 'session', turn_id: 'turn-review', cwd: root, transcript_path: transcript, last_assistant_message: '認証APIはOAuthを使う方針です。' }), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), {});
    const store = new TaskCommitmentStore(env.ORGBRAIN_LOCAL_DB);
    const report = await store.memoryReviewStatus({ tenantId: 'tenant', projectId: 'project' });
    assert.equal(report.activity[0].event, 'codex-stop');
    assert.equal(report.activity[0].status.mode, 'confirmation-only');
    const batch = await store.takeMemoryConfirmationBatch({ tenantId: 'tenant', projectId: 'project', taskKey: 'codex:session', deliverySessionKey: 'codex:session' });
    assert.equal(batch.length, 1);
    assert.match(batch[0].conclusion, /OAuth/);
    assert.equal(batch[0].reason, '未確認');
    assert.equal(batch[0].source_references[0].role, 'user');
    assert.match(batch[0].source_references[0].content_hash, /^sha256:[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
