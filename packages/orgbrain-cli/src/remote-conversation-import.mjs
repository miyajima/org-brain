import { planConversationMemory } from '../../shared/src/conversation-memory-runtime.mjs';
import { modernMcpHeaders, modernMcpRequest } from './lib/mcp-modern-request.mjs';

const MAX_RESPONSE_BYTES = 256 * 1024;

export async function readResponse(response) {
  if (!response.body) throw new Error('remote_mcp_empty_response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('remote_mcp_response_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/u)) {
      const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const message = JSON.parse(data);
      if (message.id === 1) return message;
    }
    throw new Error('remote_mcp_missing_response');
  }
  return JSON.parse(text);
}

export async function ingestRemoteConversationMemory(input, { execute = false, expectedPlanHash,
  endpoint, accessToken, fetchImpl = globalThis.fetch } = {}) {
  const plan = planConversationMemory(input);
  if (!execute) return { ...plan, backend: 'remote-mcp', executed: false, remote_receipt_validated: false,
    mcp_tool: 'orgbrain_conversation_memories_stage' };
  if (expectedPlanHash !== plan.plan_hash) throw new Error('conversation_plan_hash_mismatch');
  // Do not upload the raw PII/path-bearing form of a locally redacted summary.
  // The caller must explicitly supply its reviewed, already-redacted envelope.
  if (plan.redacted_fields.length) throw new Error('remote_conversation_requires_redacted_input');
  if (typeof endpoint !== 'string' || !endpoint || typeof accessToken !== 'string' || !accessToken) {
    throw new Error('remote_conversation_requires_existing_oauth');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('invalid_remote_mcp_endpoint');
  }
  // The pinned provider returns opaque colon-delimited tokens. Accept opaque
  // printable ASCII, while rejecting whitespace/control characters and bounds.
  if (accessToken.length > 8192 || !/^[\x21-\x7e]+$/u.test(accessToken)) throw new Error('invalid_existing_oauth_token');
  let response;
  try {
    response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { ...modernMcpHeaders('tools/call', 'orgbrain_conversation_memories_stage'), authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(modernMcpRequest({ id: 1, method: 'tools/call', name: 'orgbrain_conversation_memories_stage',
        params: { arguments: { tenant_id: plan.tenant_id, conversation: input, execute: true, expected_plan_hash: plan.plan_hash } } })) });
  } catch { throw new Error('remote_mcp_request_failed'); }
  if (!response.ok) throw new Error(`remote_mcp_http_${response.status}`);
  let rpc, result;
  try {
    rpc = await readResponse(response);
    if (rpc.id !== 1 || rpc.error || rpc.result?.isError) throw new Error();
    result = rpc.result?.structuredContent ?? JSON.parse(rpc.result.content.find(item => item.type === 'text').text);
  } catch { throw new Error('remote_mcp_invalid_or_failed_response'); }
  if (result.plan_hash !== plan.plan_hash || result.tenant_id !== plan.tenant_id || result.project_id !== plan.project_id
    || result.executed !== true || result.active_memories_created !== 0 || !Array.isArray(result.receipts)) {
    throw new Error('remote_conversation_response_mismatch');
  }
  const expected = new Map(plan.candidates.map(candidate => [candidate.id, candidate.candidate_hash]));
  if (result.receipts.length !== expected.size || !Number.isInteger(result.pending_created)
    || result.pending_created < 0 || result.pending_created > expected.size) throw new Error('remote_conversation_response_mismatch');
  const seen = new Set();
  for (const receipt of result.receipts) {
    if (!expected.has(receipt.id) || seen.has(receipt.id) || receipt.candidate_hash !== expected.get(receipt.id)
      || !/^[A-Z0-9]{26}$/u.test(receipt.confirmation_token ?? '')
      || receipt.confirmation_guard_required === true && (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1)
      || !['pending', 'expired', 'saved', 'not_requested', 'processing', 'failed', 'consumed', 'superseded', 'cancelled'].includes(receipt.status)) throw new Error('remote_conversation_response_mismatch');
    seen.add(receipt.id);
  }
  return { ...result, backend: 'remote-mcp', remote_receipt_validated: true };
}
