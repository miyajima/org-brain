// Exercise the built artifact over the actual MCP transport against an isolated snapshot.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, cp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const [artifact, snapshotRoot] = process.argv.slice(2);
const root = await realpath(await mkdtemp(join(tmpdir(), 'amp-staged-mcp-')));
await cp(join(snapshotRoot, 'augmented'), join(root, 'wiki'), { recursive: true });
await cp(join(snapshotRoot, 'features.json'), join(root, 'features.json'));
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(artifact), 'mcp'], stderr: 'pipe',
  env: { ...getDefaultEnvironment(), ORGBRAIN_LOCAL_DB: join(root, 'memory.sqlite'),
    ORGBRAIN_FEATURES_FILE: join(root, 'features.json'), ORGBRAIN_WIKI_ROOT: join(root, 'wiki'),
    ORGBRAIN_WIKI_ENGINE: resolve('packages/wiki-engine/target/debug/orgbrain-wiki-engine') } });
const client = new Client({ name: 'amp-staged-smoke', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000 } } });
const calls = [];
async function call(name, input, expectError = false) {
  const raw = await client.callTool({ name, arguments: input });
  let result;
  try { result = JSON.parse(raw.content[0].text); }
  catch { result = { error: raw.content[0].text }; }
  calls.push({ name, input, result });
  await writeFile(join(root, 'calls.json'), JSON.stringify(calls, null, 2) + '\n');
  assert.equal(Boolean(raw.isError), expectError, result.error ?? 'unexpected MCP error state');
  return result;
}
try {
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(t => t.name === 'orgbrain_wiki_amp_read'));
  const input = { query: 'Stop 共通抽出', path: 'amp/memories/orgbrain-stop-intake.md',
    facts: { runtime: 'local', session_extraction_mode: 'on', local_hook_capture: true, learning_mode: 'off', completed_turn_available: true } };
  const found = await call('orgbrain_wiki_amp_search', input);
  assert.equal(found.results[0].detail, 'summary');
  assert.equal(found.results[0].applicability, 'not_applicable');
  const next = found.results[0].next_read;
  const memory = await call(next.tool, next.arguments);
  assert.ok(memory.results[0].memory.exceptions.length);
  assert.equal(memory.results[0].evidence_integrity, 'not_checked');
  const source = await call(next.tool, { ...next.arguments, include_evidence: true, token_budget: 8000 });
  assert.ok(source.results[0].evidence.length);
  assert.ok(source.results[0].evidence.every(e => e.integrity === 'verified'));
  const apply = await call('orgbrain_wiki_amp_search', { ...input, mode: 'apply' });
  assert.equal(apply.results.length, 0); assert.equal(apply.fallback.used, false);
  const changed = await call(next.tool, { ...next.arguments, expected_hash: '0'.repeat(64) }, true);
  assert.equal(changed.error, 'amp_memory_changed');
  const raw = await call('orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', detail: 'memory' });
  assert.ok(raw.results.some(r => r.kind === 'source' && r.text.includes('1488')));
  const receipt = { artifact_sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'),
    successful_assertions: ['summary', 'exception_explanation', 'memory_read', 'pinned_evidence_read', 'apply_withheld', 'stale_read_rejected', 'legacy_original_found'], calls };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ receipt: join(root, 'receipt.json'), artifact_sha256: receipt.artifact_sha256, checks: receipt.successful_assertions, calls: calls.length }));
} finally { await client.close(); await transport.close(); }
