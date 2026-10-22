import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexMemoryContext } from '../packages/orgbrain-cli/src/codex-memory-context.mjs';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import { LOCAL_MEMORY_DETAIL_RECEIPT_TTL_MS } from '../packages/orgbrain-cli/src/lib/local-memory-detail-receipt.mjs';
import { handleLocalMcpRequest } from '../packages/orgbrain-cli/src/local-mcp.mjs';

const call = (id, name, args) => ({ payload: { type: 'custom_tool_call', call_id: id, name, arguments: args } });
const out = (id, output) => ({ payload: { type: 'custom_tool_call_output', call_id: id, output } });
const codeRunnerOutput = (value) => [
  { type: 'input_text', text: 'Script completed\n\nOutput:\n' },
  { type: 'input_text', text: JSON.stringify(value) }
];

function rewriteCandidate(context, update) {
  return context.split('\n\n').map(part => {
    try {
      const candidate = JSON.parse(part);
      if (candidate?.detail_ref?.arguments) {
        update(candidate.detail_ref.arguments);
        return JSON.stringify(candidate);
      }
    } catch { /* Preserve non-candidate context parts. */ }
    return part;
  }).join('\n\n');
}

async function pendingStopFixture({ fullBodyPresent = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orgbrain-pending-detail-'));
  const workspace = path.join(directory, 'project');
  const workspacesFile = path.join(directory, 'workspaces.json');
  const store = new LocalMemoryStore(path.join(directory, 'memory.sqlite'), { denseEmbeddingProvider: null });
  try {
    await writeFile(workspacesFile, JSON.stringify({ version: 1, workspaces: {
      [workspace]: { tenant_id: 't', project_id: 'p', default_work_type: 'implementation' }
    } }));
    await store.init();
    await store.useHistory('configure', { mode: 'c', collect: true, sync: false });
    const memoryContent = 'For alpha execution, check the recorded state before retrying so the procedure remains idempotent.';
    await store.capture({ tenant_id: 't', project_id: 'p', kind: 'decision', work_type: 'implementation',
      content: memoryContent,
      summary: fullBodyPresent ? memoryContent : 'Alpha execution procedure: check recorded state before retrying.',
      source: 'test', external_key: 'pending-alpha', tags: [] });
    store.relevanceSelector = { provider: 'working-llm', select: () => { throw new Error('hook must not call a relevance model'); } };

    const hook = await buildCodexMemoryContext({ hook_event_name: 'UserPromptSubmit', session_id: 'pending-alpha-session',
      principal_id: 'alice', cwd: workspace, prompt: 'How should I retry the alpha execution procedure after a timeout?' }, {
      store, env: { ORGBRAIN_WORKSPACES_FILE: workspacesFile, ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false' }
    });
    assert.ok(hook?.hookSpecificOutput?.additionalContext);
    const injectedContext = hook.hookSpecificOutput.additionalContext;
    const tracking = injectedContext.split('\n\n').find(part => part.startsWith('Use tracking: receipt;'));
    assert.ok(tracking, 'the native hook must inject a usage receipt');
    const taskId = tracking.match(/task_id=([^;]+)/u)?.[1];
    const projectId = tracking.match(/project_id=([^;]+)/u)?.[1];
    const usageId = tracking.match(/usage_id=([^;]+)/u)?.[1];
    const usageItems = JSON.parse(tracking.match(/items=(\[[^\n]*?\])(?:\s|$)/u)?.[1] ?? '[]');
    const candidatePart = injectedContext.split('\n\n').find(part => part.startsWith('{') && part.includes('"memory_id"'));
    assert.ok(candidatePart, 'the native hook must inject a pending candidate preview');
    const candidate = JSON.parse(candidatePart);
    assert.equal(candidate.full_body_omitted, !fullBodyPresent);
    assert.equal(candidate.detail_ref.tool, 'orgbrain_memory_get');
    assert.equal(candidate.detail_ref.arguments.principal_id, 'alice');
    const usageItem = usageItems.find(item => item.source_id === candidate.memory_id && item.source_version === candidate.current_version);
    assert.ok(taskId && projectId && usageId && usageItem, 'the preview and injected usage item must agree');

    const getResult = await handleLocalMcpRequest(store, { method: 'tools/call', params: {
      name: candidate.detail_ref.tool, arguments: candidate.detail_ref.arguments
    } });
    assert.equal(getResult.isError, false, getResult.content[0].text);
    const getValue = JSON.parse(getResult.content[0].text);
    assert.equal(getValue.memory.id, candidate.memory_id);
    assert.equal(getValue.memory.current_version, candidate.current_version);

    const observation = {
      usage_id: usageId, usage_item_id: usageItem.usage_item_id, source_id: candidate.memory_id,
      source_version: candidate.current_version, task_id: taskId, project_id: projectId,
      work_type: 'implementation', context: {
        task: 'retry alpha execution after timeout', target: 'avoid duplicate execution',
        constraints: 'preserve the recorded state', conditions: 'the first attempt timed out'
      }, action_call_id: 'outer-action-call'
    };
    const observeResult = await handleLocalMcpRequest(store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_observe', arguments: { tenant_id: 't', schema_version: 2, lesson_type: 'success', use_observation: observation }
    } });
    assert.equal(observeResult.isError, false, observeResult.content[0].text);

    const rows = ({ includeGet = true, actionBeforeGet = false, mutateGet = null, mutateContext = null } = {}) => {
      const context = mutateContext ? mutateContext(injectedContext) : injectedContext;
      const injection = { payload: { type: 'message', role: 'developer', content: context } };
      const get = () => {
        let envelope = getResult;
        if (mutateGet) {
          const value = JSON.parse(getResult.content[0].text);
          const changed = mutateGet(value);
          envelope = { ...getResult, content: getResult.content.map((part, index) => index === 0
            ? { ...part, text: JSON.stringify(changed) } : part) };
        }
        return [call('outer-get-call', 'functions.exec', 'await tools.mcp__orgbrain__orgbrain_memory_get(...)'),
          out('outer-get-call', codeRunnerOutput(envelope))];
      };
      const action = [call('outer-action-call', 'functions.exec', 'perform the alpha procedure'),
        out('outer-action-call', JSON.stringify({ exit_code: 0, status: 'succeeded' }))];
      const observe = [call('outer-observe-call', 'functions.exec', 'await tools.mcp__orgbrain__orgbrain_memory_observe(...)'),
        out('outer-observe-call', codeRunnerOutput(observeResult))];
      return [injection, ...(actionBeforeGet ? [...action, ...(includeGet ? get() : [])]
        : [...(includeGet ? get() : []), ...action]), ...observe];
    };

    return {
      store, directory, taskId, projectId, usageItem, candidate, getValue, rows,
      close: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('a pending hook candidate read through native MCP can support a verified Stop use record', async () => {
  const f = await pendingStopFixture();
  try {
    const db = f.store.open();
    try {
      const receiptId = f.getValue.detail_receipt;
      assert.match(receiptId, /^orgbrain-detail-receipt:[0-9a-f-]{36}$/u);
      const receipt = db.prepare('SELECT * FROM local_memory_detail_receipts WHERE id=?').get(receiptId);
      assert.equal(receipt.actor_principal, process.env.ORGBRAIN_USE_PRINCIPAL || 'local');
      assert.equal(receipt.request_principal, 'alice');
      assert.equal(receipt.memory_id, f.candidate.memory_id);
      assert.equal(receipt.source_version, f.candidate.current_version);
      assert.equal(receipt.expires_at - receipt.created_at, LOCAL_MEMORY_DETAIL_RECEIPT_TTL_MS);
      assert.deepEqual(db.prepare('PRAGMA table_info(local_memory_detail_receipts)').all().map(row => row.name)
        .filter(name => /body|content|command|credential|token/iu.test(name)), []);
    } finally { db.close(); }

    const result = await collectMemoryUse(f.store, { rows: f.rows(), tenantId: 't', projectId: f.projectId, taskId: f.taskId, turnId: 'pending-alpha-stop' });
    assert.equal(result.delivered, 1);
    assert.equal(result.recorded, 1);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.assessment_gaps, {});
    const context = f.store.open();
    try {
      assert.equal(context.prepare('SELECT count(*) AS n FROM memory_use_contexts WHERE tenant_id=? AND usage_item_id=?')
        .get('t', f.usageItem.usage_item_id).n, 1);
      const assessment = context.prepare('SELECT * FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?')
        .get('t', f.usageItem.usage_item_id);
      assert.equal(assessment.used_state, 'used');
      assert.equal(assessment.reason_code, 'verified_action_context');

      const duplicate = await collectMemoryUse(f.store, { rows: f.rows(), tenantId: 't', projectId: f.projectId, taskId: f.taskId, turnId: 'pending-alpha-stop' });
      assert.equal(duplicate.recorded, 1);
      assert.equal(context.prepare('SELECT count(*) AS n FROM memory_use_contexts WHERE tenant_id=? AND usage_item_id=?')
        .get('t', f.usageItem.usage_item_id).n, 1);
      assert.equal(context.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?')
        .get('t', f.usageItem.usage_item_id).n, 1);
    } finally { context.close(); }
  } finally { await f.close(); }
});

test('a detail read does not create a receipt while local use collection is disabled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orgbrain-detail-disabled-'));
  const store = new LocalMemoryStore(path.join(directory, 'memory.sqlite'), { denseEmbeddingProvider: null });
  try {
    await store.init();
    await store.useHistory('configure', { mode: 'c', collect: false, sync: false });
    const captured = await store.capture({ tenant_id: 't', project_id: 'p', kind: 'decision', work_type: 'implementation',
      content: 'Check the current state before retrying the disabled-collection procedure.',
      summary: 'Check the current state before retrying.', source: 'test', external_key: 'detail-disabled', tags: [] });
    const result = await handleLocalMcpRequest(store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_get', arguments: { tenant_id: 't', project_id: 'p', work_type: 'implementation',
        memory_id: captured.memory_id, expected_version: 1 }
    } });
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).detail_receipt, undefined);
    const db = store.open();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='local_memory_detail_receipts'").get().n, 0);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pending detail evidence fails closed for missing, forged, stale, mismatched or out-of-order reads', async (t) => {
  const scenarios = [
    ['preview only', f => f.rows({ includeGet: false })],
    ['unissued nonce', f => f.rows({ mutateGet: value => ({ ...value, detail_receipt: `orgbrain-detail-receipt:${'0'.repeat(8)}-0000-4000-8000-000000000000` }) })],
    ['altered body with a real nonce', f => f.rows({ mutateGet: value => ({ ...value, memory: { ...value.memory, content: 'not the observed memory body' } }) })],
    ['wrong tenant scope', f => f.rows({ mutateContext: value => rewriteCandidate(value, args => { args.tenant_id = 'other'; }) })],
    ['wrong project scope', f => f.rows({ mutateContext: value => rewriteCandidate(value, args => { args.project_id = 'other'; }) })],
    ['wrong request principal', f => f.rows({ mutateContext: value => rewriteCandidate(value, args => { args.principal_id = 'mallory'; }) })],
    ['wrong pinned version', f => f.rows({ mutateGet: value => ({ ...value, memory: { ...value.memory, current_version: value.memory.current_version + 1 } }) })],
    ['expired nonce', f => {
      const db = f.store.open();
      try { db.prepare('UPDATE local_memory_detail_receipts SET expires_at=? WHERE id=?').run(Date.now() - 1, f.getValue.detail_receipt); }
      finally { db.close(); }
      return f.rows();
    }],
    ['source suppressed before Stop', f => {
      const db = f.store.open();
      try { db.prepare('UPDATE memories SET lifecycle_state=? WHERE tenant_id=? AND id=?').run('suppressed', 't', f.candidate.memory_id); }
      finally { db.close(); }
      return f.rows();
    }],
    ['source version changed before Stop', f => {
      const db = f.store.open();
      try { db.prepare('UPDATE memories SET current_version=? WHERE tenant_id=? AND id=?').run(f.candidate.current_version + 1, 't', f.candidate.memory_id); }
      finally { db.close(); }
      return f.rows();
    }],
    ['action before get', f => f.rows({ actionBeforeGet: true })]
  ];
  for (const [name, makeRows] of scenarios) await t.test(name, async () => {
    const f = await pendingStopFixture();
    try {
      const result = await collectMemoryUse(f.store, { rows: makeRows(f), tenantId: 't', projectId: f.projectId, taskId: f.taskId, turnId: `pending-negative-${name}` });
      assert.equal(result.recorded, 0);
      assert.deepEqual(result.rejected, ['use_retrieval_not_observed']);
      const db = f.store.open();
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_use_contexts WHERE tenant_id=? AND usage_item_id=?')
          .get('t', f.usageItem.usage_item_id).n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?')
          .get('t', f.usageItem.usage_item_id).n, 0);
      } finally { db.close(); }
    } finally { await f.close(); }
  });
});

test('a normal MCP pending search preview needs a pinned authenticated detail read before action', async () => {
  const f = await pendingStopFixture();
  try {
    const searchArgs = { tenant_id: 't', project_id: f.projectId, task_id: f.taskId, principal_id: 'alice',
      work_type: 'implementation', query: 'How should I retry the alpha execution procedure after a timeout?' };
    const searchResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_search', arguments: searchArgs
    } });
    assert.equal(searchResult.isError, false, searchResult.content[0].text);
    const searchValue = JSON.parse(searchResult.content[0].text);
    assert.equal(searchValue.meta.local_relevance.status, 'pending_host_selection');
    const candidate = searchValue.candidates.find(value => value.memory_id === f.candidate.memory_id);
    assert.equal(candidate.full_body_omitted, true);
    const item = searchValue.meta.usage_items.find(value => value.source_id === candidate.memory_id
      && value.source_version === candidate.current_version);
    assert.ok(item);

    const observation = {
      usage_id: searchValue.meta.usage_id, usage_item_id: item.usage_item_id, source_id: item.source_id,
      source_version: item.source_version, task_id: f.taskId, project_id: f.projectId, work_type: 'implementation',
      context: { task: 'retry alpha execution after timeout', target: 'avoid duplicate execution',
        constraints: 'preserve the recorded state', conditions: 'the first attempt timed out' }, action_call_id: 'mcp-action-call'
    };
    const observeResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_observe', arguments: { tenant_id: 't', schema_version: 2, lesson_type: 'success', use_observation: observation }
    } });
    assert.equal(observeResult.isError, false, observeResult.content[0].text);

    const mcpEvent = (id, tool, args, result) => ({ payload: { type: 'mcp_tool_call_end', call_id: id,
      invocation: { tool, arguments: args }, result } });
    const action = [
      { payload: { type: 'function_call', call_id: 'mcp-action-call', name: 'functions.exec', input: 'perform the alpha procedure' } },
      { payload: { type: 'function_call_output', call_id: 'mcp-action-call', output: JSON.stringify({ exit_code: 0, status: 'succeeded' }) } }
    ];
    const transcript = [mcpEvent('mcp-search-call', 'orgbrain_memory_search', searchArgs, searchResult),
      ...action, mcpEvent('mcp-observe-call', 'orgbrain_memory_observe', { use_observation: observation }, observeResult)];
    const previewOnly = await collectMemoryUse(f.store, { rows: transcript, tenantId: 't', projectId: f.projectId,
      taskId: f.taskId, turnId: 'pending-mcp-search-preview-only' });
    assert.equal(previewOnly.recorded, 0);
    assert.deepEqual(previewOnly.rejected, ['use_retrieval_not_observed']);

    const getArgs = candidate.detail_ref.arguments;
    const getResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: candidate.detail_ref.tool, arguments: getArgs
    } });
    const complete = [mcpEvent('mcp-search-call', 'orgbrain_memory_search', searchArgs, searchResult),
      mcpEvent('mcp-get-call', candidate.detail_ref.tool, getArgs, getResult), ...action,
      mcpEvent('mcp-observe-call', 'orgbrain_memory_observe', { use_observation: observation }, observeResult)];
    const accepted = await collectMemoryUse(f.store, { rows: complete, tenantId: 't', projectId: f.projectId,
      taskId: f.taskId, turnId: 'pending-mcp-search-with-detail' });
    assert.equal(accepted.recorded, 1);
    assert.deepEqual(accepted.rejected, []);
  } finally { await f.close(); }
});

test('an MCP candidate with its full body in the preview still needs a pinned authenticated detail read', async () => {
  const f = await pendingStopFixture({ fullBodyPresent: true });
  try {
    const searchArgs = { tenant_id: 't', project_id: f.projectId, task_id: f.taskId, principal_id: 'alice',
      work_type: 'implementation', query: 'How should I retry the alpha execution procedure after a timeout?' };
    const searchResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_search', arguments: searchArgs
    } });
    assert.equal(searchResult.isError, false, searchResult.content[0].text);
    const searchValue = JSON.parse(searchResult.content[0].text);
    assert.equal(searchValue.meta.local_relevance.status, 'pending_host_selection');
    const candidate = searchValue.candidates.find(value => value.memory_id === f.candidate.memory_id);
    assert.equal(candidate.full_body_omitted, false);
    assert.equal(candidate.preview, f.getValue.memory.content);
    const item = searchValue.meta.usage_items.find(value => value.source_id === candidate.memory_id
      && value.source_version === candidate.current_version);
    assert.ok(item);

    const observation = {
      usage_id: searchValue.meta.usage_id, usage_item_id: item.usage_item_id, source_id: item.source_id,
      source_version: item.source_version, task_id: f.taskId, project_id: f.projectId, work_type: 'implementation',
      context: { task: 'retry alpha execution after timeout', target: 'avoid duplicate execution',
        constraints: 'preserve the recorded state', conditions: 'the first attempt timed out' }, action_call_id: 'mcp-short-action-call'
    };
    const observeResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: 'orgbrain_memory_observe', arguments: { tenant_id: 't', schema_version: 2, lesson_type: 'success', use_observation: observation }
    } });
    assert.equal(observeResult.isError, false, observeResult.content[0].text);

    const mcpEvent = (id, tool, args, result) => ({ payload: { type: 'mcp_tool_call_end', call_id: id,
      invocation: { tool, arguments: args }, result } });
    const action = [
      { payload: { type: 'function_call', call_id: 'mcp-short-action-call', name: 'functions.exec', input: 'perform the alpha procedure' } },
      { payload: { type: 'function_call_output', call_id: 'mcp-short-action-call', output: JSON.stringify({ exit_code: 0, status: 'succeeded' }) } }
    ];
    const observe = mcpEvent('mcp-short-observe-call', 'orgbrain_memory_observe', { use_observation: observation }, observeResult);
    const search = mcpEvent('mcp-short-search-call', 'orgbrain_memory_search', searchArgs, searchResult);
    const previewOnly = await collectMemoryUse(f.store, { rows: [search, ...action, observe], tenantId: 't',
      projectId: f.projectId, taskId: f.taskId, turnId: 'pending-mcp-short-preview-only' });
    assert.equal(previewOnly.recorded, 0);
    assert.deepEqual(previewOnly.rejected, ['use_retrieval_not_observed']);

    const getArgs = candidate.detail_ref.arguments;
    const getResult = await handleLocalMcpRequest(f.store, { method: 'tools/call', params: {
      name: candidate.detail_ref.tool, arguments: getArgs
    } });
    const get = mcpEvent('mcp-short-get-call', candidate.detail_ref.tool, getArgs, getResult);
    const complete = [search, get, ...action, observe];
    const accepted = await collectMemoryUse(f.store, { rows: complete, tenantId: 't', projectId: f.projectId,
      taskId: f.taskId, turnId: 'pending-mcp-short-with-detail' });
    assert.equal(accepted.recorded, 1);
    assert.deepEqual(accepted.rejected, []);

    for (const [name, corrupt] of [
      ['missing omission flag', value => { delete value.full_body_omitted; }],
      ['malformed omission flag', value => { value.full_body_omitted = 'false'; }]
    ]) {
      const malformedValue = JSON.parse(searchResult.content[0].text);
      corrupt(malformedValue.candidates.find(value => value.memory_id === candidate.memory_id));
      const malformedSearch = { ...searchResult, content: searchResult.content.map((part, index) => index === 0
        ? { ...part, text: JSON.stringify(malformedValue) } : part) };
      const rejected = await collectMemoryUse(f.store, { rows: [mcpEvent(`mcp-short-${name}`, 'orgbrain_memory_search', searchArgs, malformedSearch),
        get, ...action, observe], tenantId: 't', projectId: f.projectId, taskId: f.taskId, turnId: `pending-mcp-${name}` });
      assert.equal(rejected.recorded, 0, name);
      assert.deepEqual(rejected.rejected, ['use_retrieval_not_observed'], name);
    }
  } finally { await f.close(); }
});
