import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveWikiSourceEvidence } from '../packages/orgbrain-cli/src/lib/wiki-source-evidence.mjs';

const id = '12345678-1234-4234-9234-123456789abc';
const ref = `source:${id}@1`;
const digest = text => createHash('sha256').update(text).digest('hex');
async function config(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-pagination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'integration.json');
  await writeFile(configPath, JSON.stringify({ enabled: true, wiki_id: 'personal', wiki_command: ['fixture', 'wiki'] }));
  return configPath;
}
function paged(text, calls, change = x => x) {
  const chars = Array.from(text);
  return async (_exe, args) => {
    assert.equal(args.at(-1), 'personal');
    const cursor = args.includes('--char-offset') ? Number(args[args.indexOf('--char-offset') + 1]) : 0;
    calls.push(cursor);
    const end = Math.min(cursor + 16000, chars.length);
    return { stdout: JSON.stringify(change({ source_id: id, version: 1, hash: digest(text),
      text: chars.slice(cursor, end).join(''), truncated: end < chars.length,
      next_char_offset: end < chars.length ? end : null }, cursor)) };
  };
}

test('Wiki intake hashes all Unicode pages and validates a range beyond the first page', async t => {
  const text = '判断😀\n'.repeat(11000), calls = [];
  const result = await resolveWikiSourceEvidence(`${ref}#L10000-L10001`, null,
    { configPath: await config(t), run: paged(text, calls) });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.content_hash, digest(text));
  assert.equal(result.evidence.verification_scope, 'source_provenance');
  assert.deepEqual(calls, [0, 16000, 32000]);
});

test('Wiki intake rejects changed identity, hash or bytes on later pages', async t => {
  const configPath = await config(t), text = 'x'.repeat(32001);
  for (const [change, reason] of [
    [p => ({ ...p, source_id: '87654321-1234-4234-9234-123456789abc' }), 'wiki_source_incomplete'],
    [p => ({ ...p, version: 2 }), 'wiki_source_incomplete'],
    [p => ({ ...p, hash: 'f'.repeat(64) }), 'wiki_source_digest_mismatch'],
    [p => ({ ...p, text: p.text.replace(/^x/, 'y') }), 'wiki_source_digest_mismatch'],
  ]) {
    const result = await resolveWikiSourceEvidence(ref, null, { configPath,
      run: paged(text, [], (p, cursor) => cursor ? change(p) : p) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.evidence, undefined);
  }
});

test('Wiki intake rejects missing, repeated, skipped and inconsistent cursors without looping', async t => {
  const configPath = await config(t);
  for (const change of [
    p => ({ ...p, next_char_offset: null }),
    p => ({ ...p, next_char_offset: 0 }),
    p => ({ ...p, next_char_offset: 16001 }),
    p => ({ ...p, truncated: false }),
    p => ({ ...p, text: '' }),
  ]) {
    const calls = [];
    const result = await resolveWikiSourceEvidence(ref, null,
      { configPath, run: paged('x'.repeat(32001), calls, change) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wiki_source_incomplete');
    assert.deepEqual(calls, [0]);
  }
});

test('Wiki intake bounds a continuously advancing but never complete source', async t => {
  let calls = 0;
  const result = await resolveWikiSourceEvidence(ref, null, { configPath: await config(t),
    run: async (_exe, args) => {
      const cursor = Number(args[args.indexOf('--char-offset') + 1]);
      calls++;
      return { stdout: JSON.stringify({ source_id: id, version: 1, hash: 'a'.repeat(64), text: 'x',
        truncated: true, next_char_offset: cursor + 1 }) };
    } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wiki_source_incomplete');
  assert(calls <= 256);
});
