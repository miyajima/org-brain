// CLI file reader and local review queue adapter; no transcript discovery.
import { open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { planConversationMemory } from '../../shared/src/conversation-memory-runtime.mjs';
export { planConversationMemory, CONVERSATION_MEMORY_SCHEMA } from '../../shared/src/conversation-memory-runtime.mjs';
import { TaskCommitmentStore } from './lib/task-commitment-store.mjs';
const MAX_BYTES = 64 * 1024;

export async function ingestConversationMemory(store, input, { execute = false, expectedPlanHash } = {}) {
  const plan = planConversationMemory(input);
  if (!execute) return { ...plan, executed: false };
  if (expectedPlanHash !== plan.plan_hash) throw new Error('conversation_plan_hash_mismatch');
  // Cloud owns the typed lifecycle/scope contract. Do not flatten a task-only
  // limit or structured playbook into the legacy local durable review queue.
  if (plan.candidates.some(candidate => ['playbook','task_constraint'].includes(candidate.memory_type))) {
    throw new Error('typed_conversation_requires_cloud_backend');
  }
  // This queue is excluded from active retrieval and autonomous promotion.
  const receipts = await new TaskCommitmentStore(store.dbPath).queueMemoryConfirmations({ tenantId: plan.tenant_id,
    projectId: plan.project_id, taskKey: plan.task_key, candidates: plan.candidates });
  return { ...plan, executed: true, pending_created: receipts.filter(receipt => receipt.created).length, receipts };
}

export async function runConversationImportCommand({ store, args }) {
  const backend = args.get('--backend', 'local');
  if (!['local', 'remote-mcp'].includes(backend)) throw new Error('invalid_conversation_backend');
  const filename = args.get('--input');
  if (!filename) throw new Error('conversation_import_requires_explicit_input_file');
  const file = await open(filename, 'r');
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('conversation_input_too_large_or_not_file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('conversation_input_too_large');
    try { input = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('invalid_conversation_json'); }
  } finally { await file.close(); }
  const options = { execute: args.flags.has('--execute'), expectedPlanHash: args.get('--expected-plan-hash') };
  if (backend === 'remote-mcp') {
    const { ingestRemoteConversationMemory } = await import('./remote-conversation-import.mjs');
    return ingestRemoteConversationMemory(input, { ...options,
      endpoint: args.get('--mcp-url', process.env.ORGBRAIN_MCP_URL), accessToken: process.env.ORGBRAIN_MCP_OAUTH_ACCESS_TOKEN });
  }
  return ingestConversationMemory(store, input, options);
}

// Reconcile CLI results through the existing hook receipt recorder. The result
// comes from the local MCP call, not from an import envelope or caller flags.
export async function recordConversationReviewReceipt(store, toolName, input, result) {
  if (!result?.candidate_id) return null;
  const queue = new TaskCommitmentStore(store.dbPath);
  await queue.init();
  const db = queue.open();
  let row;
  try {
    row = db.prepare("SELECT task_key FROM memory_confirmation_prompts WHERE tenant_id=? AND id=? AND task_key LIKE 'codex:conversation:%'")
      .get(input.tenant_id || 'default', result.candidate_id);
  } finally { db.close(); }
  if (!row) return null;
  return queue.recordMemoryConfirmationReceipt({ session_id: row.task_key.slice('codex:'.length),
    tool_name: toolName, tool_input: input, tool_result: result }, input.tenant_id || 'default');
}
