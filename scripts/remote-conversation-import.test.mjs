import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planConversationMemory } from '../packages/shared/src/conversation-memory-runtime.mjs';
import { ingestRemoteConversationMemory } from '../packages/orgbrain-cli/src/remote-conversation-import.mjs';

const fixture = () => ({ schema_version: 'conversation-memory/v1', tenant_id: 'fixture', project_id: 'test-project',
  session_id: 'test-session', event_id: 'test-event', occurred_at: '2026-10-03T09:00:00Z', producer: 'manual',
  sources: [{ id: 'test-source', role: 'user', ref: 'fixture:user-choice', text: 'Use synthetic staging inputs.' }],
  candidates: [{ id: 'test-decision', kind: 'decision', claim_type: 'user_decision', conclusion: 'Use synthetic staging inputs.',
    rationale: 'The fixture controls the inputs.', reuse_rule: 'Synthetic tests only.', source_ids: ['test-source'] }] });

test('remote preview is deterministic and requires neither a network call nor local state', async () => {
  const input = fixture(); let calls = 0;
  const preview = await ingestRemoteConversationMemory(input, { fetchImpl: async () => { calls++; throw Error('No network'); } });
  assert.equal(preview.plan_hash, planConversationMemory(input).plan_hash);
  assert.equal(preview.executed, false);
  assert.equal(preview.remote_receipt_validated, false);
  assert.equal(calls, 0);
});

test('remote execute uses existing OAuth over modern MCP and checks the scoped receipt', async () => {
  const input = fixture(), plan = planConversationMemory(input);
  const response = { ...plan, executed: true, pending_created: 1, receipts: [{ id: plan.candidates[0].id, candidate_hash: plan.candidates[0].candidate_hash, confirmation_token: 'C' + 'A'.repeat(25), status: 'pending' }] };
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://example.invalid/mcp');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['MCP-Protocol-Version'], '2026-07-28');
    assert.equal(options.headers.authorization, 'Bearer fixture-access-token');
    const rpc = JSON.parse(options.body);
    assert.equal(rpc.params.name, 'orgbrain_conversation_memories_stage');
    assert.deepEqual(rpc.params.arguments.conversation, input);
    assert.equal(rpc.params.arguments.expected_plan_hash, plan.plan_hash);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(response) }] } }),
      { headers: { 'content-type': 'application/json' } });
  };
  const options = { execute: true, expectedPlanHash: plan.plan_hash, endpoint: 'https://example.invalid/mcp',
    accessToken: 'fixture-access-token', fetchImpl };
  assert.equal((await ingestRemoteConversationMemory(input, options)).pending_created, 1);
  const privateInput = fixture(); privateInput.sources[0].text += ' alice@example.invalid';
  await assert.rejects(ingestRemoteConversationMemory(privateInput, { ...options,
    expectedPlanHash: planConversationMemory(privateInput).plan_hash,
    fetchImpl: async () => { throw Error('PII must not reach transport'); } }), /requires_redacted_input/);
  for (const bad of [{ expectedPlanHash: 'a'.repeat(64) }, { accessToken: undefined },
    { endpoint: 'http://example.invalid/mcp' }, { endpoint: 'https://example.invalid/mcp?token=fixture' }]) {
    await assert.rejects(ingestRemoteConversationMemory(input, { ...options, ...bad }));
  }
  const rpcResponse = body => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
  assert.equal((await ingestRemoteConversationMemory(input, { ...options, fetchImpl: async () => new Response(
    `event: message\ndata: ${rpcResponse(response)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) })).remote_receipt_validated, true);
  for (const malformed of [{ ...response, receipts: [] }, { ...response, receipts: [{ ...response.receipts[0], candidate_hash: 'b'.repeat(64) }] },
    { ...response, pending_created: 5 }]) {
    await assert.rejects(ingestRemoteConversationMemory(input, { ...options, fetchImpl: async () => new Response(rpcResponse(malformed)) }), /response_mismatch/);
  }
  await assert.rejects(ingestRemoteConversationMemory(input, { ...options, fetchImpl: async () => new Response('denied', { status: 403 }) }), /http_403/);
  await assert.rejects(ingestRemoteConversationMemory(input, { ...options, fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) }), /invalid_or_failed_response/);
  await assert.rejects(ingestRemoteConversationMemory(input, { ...options, fetchImpl: async () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ...response, tenant_id: 'other' }) }] } })) }), /response_mismatch/);
});

test('the remote CLI preview does not initialize a local DB and execute fails closed without OAuth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orgbrain-cloud-conversation-'));
  try {
    const input = join(directory, 'event.json'), db = join(directory, 'must-not-exist.sqlite');
    await writeFile(input, JSON.stringify(fixture()));
    const env = { ...process.env, ORGBRAIN_LOCAL_DB: db, ORGBRAIN_MCP_OAUTH_ACCESS_TOKEN: '', ORGBRAIN_MCP_URL: '' };
    const args = [resolve(process.env.ORGBRAIN_CONVERSATION_CLI_ENTRY || 'packages/orgbrain-cli/src/local-memory.mjs'), 'memory', 'import', 'conversation', '--backend', 'remote-mcp', '--input', input];
    const preview = JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
    assert.equal(preview.backend, 'remote-mcp');
    assert.equal(preview.executed, false);
    assert.throws(() => execFileSync(process.execPath, [...args, '--execute', '--expected-plan-hash', preview.plan_hash],
      { env, encoding: 'utf8', stdio: 'pipe' }), /requires_existing_oauth/);
    await assert.rejects(access(db));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
