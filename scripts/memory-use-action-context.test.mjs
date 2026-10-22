import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './lib/memory-use-fixture.mjs';
import { memoryUseActionContext } from '../packages/orgbrain-cli/src/lib/memory-use-action-context.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import { receiveLocalUseObservation } from '../packages/orgbrain-cli/src/lib/local-use-observations.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TaskCommitmentStore } from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';

const scope = { tenantId: 't', projectId: 'p', taskId: 'prior-task' };
const payload = { tool_name: 'functions.exec', tool_call_id: 'call_actual_action', tool_input: 'PRIVATE INPUT', tool_response: 'PRIVATE RESULT' };
const call = (id, name, args) => ({ payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
const out = (id, value) => ({ payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(value) } });

test('PostToolUse exposes a scoped actual action ID; hint alone never establishes use', async () => {
  const f = await fixture();
  try {
    const hint = await memoryUseActionContext(f.store, { ...scope, payload });
    assert.equal(hint.action_call_id, payload.tool_call_id);
    assert.equal(hint.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(hint.hookSpecificOutput.additionalContext.includes(payload.tool_call_id));
    assert.equal(JSON.stringify(hint).includes('PRIVATE'), false);
    assert.equal((await f.store.useHistory('report', { tenant_id: 't' })).total.not_assessed, 1);
    const input = { usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      project_id: 'p', task_id: 'prior-task', work_type: 'implementation', context: f.payload.context,
      action_call_id: hint.action_call_id };
    const receipt = await receiveLocalUseObservation(f.store, 't', input);
    const rows = [call('retrieval', 'orgbrain_memory_search', { project_id: 'p', task_id: 'prior-task' }),
      out('retrieval', { meta: { usage_id: 'usage', usage_items: [{ usage_item_id: 'item', source_id: f.id, source_version: 1 }] } }),
      call(payload.tool_call_id, 'exec_command', { cmd: 'fixture check' }), out(payload.tool_call_id, { exit_code: 0 }),
      call('observe', 'orgbrain_memory_observe', { use_observation: input }), out('observe', receipt)];
    assert.equal((await collectMemoryUse(f.store, { ...scope, rows, turnId: 'turn' })).recorded, 1);
    const report = await f.store.useHistory('report', { tenant_id: 't' });
    assert.equal(report.total.action_observed, 1);
    assert.equal(report.verified_positive_effects, 0);
  } finally { await f.close(); }
});

test('no native ID, conflicting IDs, wrong scope or disabled collection cannot produce an action hint', async () => {
  const f = await fixture();
  try {
    for (const changed of [
      { payload: { tool_name: 'exec_command' } },
      { payload: { ...payload, call_id: 'call_other_action' } },
      { taskId: 'other-task' }, { projectId: 'other-project' }, { principal: 'other-principal' },
      { payload: { ...payload, tool_name: 'mcp__orgbrain__orgbrain_memory_observe' } }
    ]) assert.equal((await memoryUseActionContext(f.store, { ...scope, payload, ...changed })).hookSpecificOutput, undefined);
    await f.store.useHistory('configure', { mode: 'off', collect: false });
    assert.equal((await memoryUseActionContext(f.store, { ...scope, payload })).hookSpecificOutput, undefined);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_contexts').get().n, 0);
  } finally { await f.close(); }
});

test('native CLI PostToolUse returns the identifier context independently of attempt allowlists', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE memory_usage_events SET task_id='codex:prior-task'").run();
    const mapping = join(f.dir, 'workspaces.json'), envFile = join(f.dir, 'hooks.env');
    await writeFile(mapping, JSON.stringify({ version: 3, workspaces: { [f.dir]: { tenant_id: 't', project_id: 'p', memory_learning_mode: 'off' } } }));
    await writeFile(envFile, 'ORGBRAIN_ENABLE_CLOUD_MEMORY=false\nORGBRAIN_LOCAL_HOOK_CAPTURE=false\n');
    const cli = process.env.ORGBRAIN_TEST_CLI_PATH ?? new URL('../packages/orgbrain-cli/src/local-memory.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, ['--no-warnings', cli, 'hook', 'codex-post-tool'], {
      env: { HOME: f.dir, PATH: process.env.PATH, ORGBRAIN_LOCAL_DB: join(f.dir, 'db.sqlite'), ORGBRAIN_WORKSPACES_FILE: mapping,
        ORGBRAIN_HOOK_ENV_FILES: envFile, ORGBRAIN_ATTEMPT_HOOK_PROJECTS: '' },
      input: JSON.stringify({ ...payload, cwd: f.dir, session_id: 'prior-task', turn_id: 'turn', tool_response: { exit_code: 0 } }), encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.action_call_id, payload.tool_call_id);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(output.attempt, undefined);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_contexts').get().n, 0);
  } finally { await f.close(); }
});

test('usage report distinguishes new active records from quarantine and explains unknowns per purpose', async () => {
  const f = await fixture();
  try {
    await new TaskCommitmentStore(join(f.dir, 'db.sqlite')).init();
    f.db.prepare("UPDATE memory_usage_events SET usage_purpose='task'").run();
    f.db.prepare(`INSERT INTO memory_learning_candidates
      (id,tenant_id,project_id,task_key,external_key,payload_json,status,reason_codes_json,created_at,expires_at)
      VALUES('candidate','t','p','prior-task','session:test','{}','quarantine','[]',?,?)`).run(Date.now(), Date.now() + 86400000);
    const report = await f.store.useHistory('report', { tenant_id: 't', project_id: 'p' });
    assert.equal(report.memory_inventory.total, 1);
    assert.equal(report.memory_inventory.active, 1);
    assert.equal(report.memory_inventory.created_last_7_days, 1);
    assert.equal(report.memory_inventory.quarantine_candidates, 1);
    assert.equal(report.memory_inventory.candidates_created_last_7_days, 1);
    assert.equal(report.unassessed_reasons_by_purpose.task.delivery_not_confirmed, 1);
    assert.equal(report.unassessed_reasons_by_purpose.audit.delivery_not_confirmed, undefined);
  } finally { await f.close(); }
});
