import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';

const cli = process.env.ORGBRAIN_TEST_CLI || resolve('packages/orgbrain-cli/src/local-memory.mjs');
async function fixture(mode = 'eager') {
  const root = await mkdtemp(join(tmpdir(), 'orgbrain-question-answer-'));
  const dbPath = join(root, 'memory.sqlite');
  const workspaces = join(root, 'workspaces.json');
  const envFile = join(root, 'empty.env');
  await writeFile(envFile, 'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
  await writeFile(workspaces, JSON.stringify({ version: 3, workspaces: { [root]: {
    tenant_id: 'tenant', project_id: 'project', default_work_type: 'implementation',
    memory_learning_mode: mode, memory_capture_v2_mode: 'on'
  } } }));
  const env = { ...process.env, ORGBRAIN_HOOK_ENV_FILES: envFile, ORGBRAIN_WORKSPACES_FILE: workspaces,
    ORGBRAIN_LOCAL_DB: dbPath, ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false',
    ORGBRAIN_MEMORY_EXTRACTION_MODE: 'off', ORGBRAIN_USE_SYNC: 'off', ORGBRAIN_USE_COLLECT: 'off',
    ORGBRAIN_USE_CONTEXT: 'off', ORGBRAIN_USE_RANKING: 'off', ORGBRAIN_TENANT_ID: 'tenant' };
  const store = await new LocalMemoryStore(dbPath).init();
  return { root, env, store, hook(payload) {
    return JSON.parse(execFileSync(process.execPath, ['--no-warnings', cli, 'hook', 'codex-post-tool'], {
      env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'question-session',
        turn_id: 'question-turn', cwd: root, ...payload })
    }));
  }, prompt(payload) {
    return execFileSync(process.execPath, ['--no-warnings', cli, 'hook', 'codex-context'], {
      env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit',
        session_id: 'question-session', cwd: root, ...payload })
    });
  }, async rows() { const db = store.open({ readOnly: true }); try {
    return db.prepare("SELECT * FROM memories WHERE tenant_id='tenant' AND source='question-answer'").all();
  } finally { db.close(); } }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const question = { id: 'agent_rollout', question: 'どのAgentから認証しますか？',
  options: [{ label: 'Codex先行' }, { label: 'Claude先行' }] };
function answerPayload(answer = 'Codex先行') { return { tool_name: 'request_user_input',
  tool_input: { questions: [question] }, tool_result: { answers: { agent_rollout: answer } } }; }

test('eager: actual question answers become searchable decisions once, and corrections revise the same memory', async () => {
  const f = await fixture();
  try {
    const first = f.hook(answerPayload());
    let rows = await f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'decision');
    assert.equal(rows[0].verification_state, 'verified');
    assert.match(rows[0].content, /どのAgentから認証しますか.*Codex先行/u);
    assert.equal(rows[0].rationale, null);
    assert.equal(first.question_answer_memories.saved, 1);
    const replay = f.hook(answerPayload());
    rows = await f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current_version, 1);
    assert.equal(replay.question_answer_memories.deduplicated, 1);
    const id = rows[0].id;
    f.hook(answerPayload('Claude先行'));
    rows = await f.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].current_version, 2);
    assert.match(rows[0].content, /Claude先行/u);
    const found = await f.store.search({ tenant_id: 'tenant', project_id: 'project', query: 'Claude先行', limit: 10 });
    assert.ok(found.some(x => x.memory.id === id));
  } finally { await f.cleanup(); }
});

test('eager: no submitted answer, failed tool, indecision and secret values never become confirmed decisions', async () => {
  const f = await fixture();
  try {
    f.hook({ ...answerPayload(), tool_result: { answers: {} } });
    f.hook({ ...answerPayload(), tool_result: { isError: true, answers: { agent_rollout: 'Codex先行' } } });
    f.hook(answerPayload('まだ決めていない'));
    f.hook(answerPayload('password=private-test-value'));
    assert.equal((await f.rows()).length, 0);
  } finally { await f.cleanup(); }
});

test('confirm and off retain their existing consent boundary', async () => {
  for (const mode of ['confirm', 'off']) {
    const f = await fixture(mode);
    try { f.hook(answerPayload()); assert.equal((await f.rows()).length, 0); }
    finally { await f.cleanup(); }
  }
});

test('async: a shown question is not an answer; its actual later choice is captured on prompt submission', async () => {
  const f = await fixture();
  try {
    f.hook({ tool_name: 'request_user_input_async', tool_call_id: 'async-question',
      tool_input: { questions: [{ title: question.question, options: ['Codex先行', 'Claude先行'] }] },
      tool_result: { status: 'pending' } });
    assert.equal((await f.rows()).length, 0);
    f.prompt({ turn_id: 'answer-turn', prompt: 'Claude先行' });
    const rows = await f.rows();
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /Claude先行/u);
    assert.doesNotMatch(rows[0].content, /回答: Codex先行/u);
  } finally { await f.cleanup(); }
});

test('async: unrelated prompt never adopts a preselected choice or saves an inferred answer', async () => {
  const f = await fixture();
  try {
    f.hook({ tool_name: 'request_user_input_async', tool_call_id: 'async-question',
      tool_input: { questions: [{ title: question.question, options: ['Codex先行', 'Claude先行'] }] },
      tool_result: { status: 'pending' } });
    f.prompt({ turn_id: 'another-task', prompt: 'ローカルの管理画面を検証して' });
    assert.equal((await f.rows()).length, 0);
  } finally { await f.cleanup(); }
});

test('async: task isolation and short or explicitly bound replies preserve the actual answer', async () => {
  const f = await fixture();
  try {
    f.hook({ tool_name: 'request_user_input_async', tool_call_id: 'short-question',
      tool_input: { questions: [{ title: '候補を選んでください', options: ['A', 'B'] }] },
      tool_result: { status: 'pending' } });
    f.prompt({ session_id: 'different-session', prompt: 'A' });
    assert.equal((await f.rows()).length, 0);
    f.prompt({ prompt: 'B' });
    assert.equal((await f.rows()).length, 1);
    f.hook({ tool_name: 'request_user_input_async', tool_call_id: 'free-question',
      tool_input: { questions: [{ title: '今回の適用範囲を指定してください' }] },
      tool_result: { status: 'pending' } });
    f.prompt({ prompt: '回答: 管理画面に限定する' });
    assert.equal((await f.rows()).length, 2);
    assert.ok((await f.rows()).some(row => row.content.includes('管理画面に限定する')));
  } finally { await f.cleanup(); }
});

test('sensitive option selected by ID is redacted in commitments and never persisted as decision memory', async () => {
  const f = await fixture();
  try {
    f.hook({ tool_name: 'request_user_input', tool_input: { questions: [{ id: 'sensitive',
      question: 'テスト用の選択', options: [{ id: 'selected', label: 'password=private-test-value' }] }] },
      tool_result: { answers: { sensitive: 'selected' } } });
    assert.equal((await f.rows()).length, 0);
    const db = f.store.open({ readOnly: true });
    try {
      const rows = db.prepare('SELECT answer_json FROM task_commitments').all();
      assert.equal(rows.length, 1);
      assert.doesNotMatch(rows[0].answer_json, /private-test-value/u);
    } finally { db.close(); }
  } finally { await f.cleanup(); }
});
