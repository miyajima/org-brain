import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseAmpPage, searchAmp, validateAmpPage, ampJsonSchema } from '../packages/orgbrain-cli/src/lib/agent-memory-protocol.mjs';
import * as amp from '../packages/orgbrain-cli/src/lib/agent-memory-protocol.mjs';
import { WikiService, setWikiFeature, countWikiTokens } from '../packages/orgbrain-cli/src/lib/wiki-service.mjs';
import { callWikiTool, WIKI_TOOLS } from '../packages/orgbrain-cli/src/lib/wiki-mcp.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const sha = 'a'.repeat(64);
const fact = (key, value) => ({ key, equals: value });
const page = data => `# ${data.title}\n\n\`\`\`amp\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
function memory(overrides = {}) {
  return { protocol: 'amp/0.1', kind: 'memory', id: 'intake-status', revision: 1,
    title: 'キュー受付から有効化を確認する', aliases: ['queued', '起動したら使える？'],
    status: 'active', basis: 'implementation', claim: 'queued と worker.started だけでは有効化を示さない。',
    rationale: '受付と処理完了は別の状態だから。', reuse_when: 'ローカルの投入結果を説明するとき。',
    conditions: [fact('runtime', 'local')], exceptions: [{ when: [fact('deleted', true)], reason: '削除された記憶は利用しない。' }],
    procedure: ['保存されたIDと版を読む。', 'active を確認する。'], limitations: ['実クライアントでの成功は未確認。'],
    evidence: [{ ref: 'source:source-one@1#L1-L2', sha256: sha }], ...overrides };
}
function index(refs = [{ id: 'intake-status', path: 'amp/status.md', hash: sha }]) {
  return { protocol: 'amp/0.1', kind: 'index', id: 'intake', revision: 1, title: '記憶はいつ使える？',
    aliases: ['起動', '有効化'], question: 'キューに入れば使える？', summary: '受付と有効化の確認手順へ進む。',
    entries: refs.map(ref => ({ question: '起動から有効化を調べる', aliases: ['queued'], summary: '状態を順に確認する。', memory: ref })) };
}
function fixture({ records = { 'amp/index.md': index(), 'amp/status.md': memory() }, hits = ['amp/index.md'], source = {}, read = {} } = {}) {
  const calls = [];
  const wiki = { async request(input) {
    calls.push(input);
    if (input.op === 'search') return { hits: hits.map(path => ({ kind: 'page', owner_id: path })), truncated: false };
    if (input.op === 'read') {
      const path = input.path ?? input.page_id;
      if (!records[path]) throw Error('page_not_found');
      return { page_id: path, path, project_id: 'p', hash: sha, content: page(records[path]), truncated: false, ...read };
    }
    if (input.op === 'source_read') return { source_id: 'source-one', version: 1, hash: sha, text: 'queued は受付。\n起動は完了ではない。\n', start_line: 1, end_line: 2, truncated: false, ...source };
    throw Error('unexpected operation: ' + input.op);
  } };
  return { wiki, calls };
}
const query = { query: '起動 有効化', facts: { runtime: 'local', deleted: false }, token_budget: 3000, mode: 'apply', detail: 'evidence', fallback: false };

test('explanation keeps a non-applicable memory and the specific exception; apply still withholds it', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { ...query, mode: 'explain', detail: 'memory', facts: { runtime: 'local', deleted: true } });
  assert.equal(result.results[0].applicability, 'not_applicable');
  assert.deepEqual(result.results[0].explanation.exceptions, ['削除された記憶は利用しない。']);
  assert.deepEqual(result.results[0].memory.exceptions, memory().exceptions);
  const excluded = await searchAmp(wiki, { ...query, facts: { runtime: 'local', deleted: true } });
  assert.equal(excluded.results.length, 0);
});

test('summary, pinned memory read, and evidence read are distinct stages', async () => {
  const { wiki, calls } = fixture();
  const found = await searchAmp(wiki, { query: query.query, facts: query.facts, fallback: false });
  const hit = found.results[0];
  assert.equal(hit.detail, 'summary');
  assert.equal(hit.requires_read, true);
  assert.equal(hit.memory, undefined);
  assert.equal(calls.filter(c => c.op === 'source_read').length, 0);
  assert.equal(hit.next_read.tool, 'orgbrain_wiki_amp_read');
  const read = await amp.readAmp(wiki, hit.next_read.arguments);
  assert.deepEqual(read.results[0].memory.limitations, memory().limitations);
  assert.deepEqual(read.results[0].memory.exceptions, memory().exceptions);
  assert.equal(read.results[0].evidence_integrity, 'not_checked');
  assert.equal(calls.filter(c => c.op === 'source_read').length, 0);
  const evidence = await amp.readAmp(wiki, { ...hit.next_read.arguments, include_evidence: true });
  assert.equal(evidence.results[0].evidence[0].integrity, 'verified');
  await assert.rejects(amp.readAmp(wiki, { ...hit.next_read.arguments, expected_hash: 'b'.repeat(64) }), /amp_memory_changed/);
});

test('long Japanese questions are searched in batches within the engine term limit', async () => {
  const { wiki, calls } = fixture();
  wiki.request = ((request) => async input => {
    if (input.op === 'search' && input.query.split(/\s+/).length > 8) throw Error('invalid_query_terms');
    return request(input);
  })(wiki.request);
  const result = await searchAmp(wiki, { query: '起動要求が成功した記憶はもう使える？条件と例外と確認方法と保存と検索の違いを知りたい。', fallback: false });
  assert.ok(result.results.length);
  assert.ok(calls.filter(c => c.op === 'search').length > 1);
  assert.ok(calls.filter(c => c.op === 'search').every(c => c.query.split(/\s+/).length <= 8));
});

test('memory view keeps qualifications under budget without repeating original text', async () => {
  const { wiki, calls } = fixture();
  const result = await searchAmp(wiki, { ...query, mode: 'explain', detail: 'memory', token_budget: 1200 });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].memory.conditions, memory().conditions);
  assert.deepEqual(result.results[0].memory.exceptions, memory().exceptions);
  assert.equal(result.results[0].evidence_integrity, 'not_checked');
  assert.equal(calls.filter(c => c.op === 'source_read').length, 0);
  assert.ok(countWikiTokens(result) <= 1200);
});

test('a primary claim match ranks above the same words mentioned only as limitations', async () => {
  const direct = memory({ id: 'z-direct', title: '起動 有効化 確認', claim: '起動要求と有効化を分けて確認する。' });
  const incidental = memory({ id: 'a-incidental', title: '別の試験', aliases: [], claim: '記録された候補は1件。', rationale: '試験報告。', reuse_when: '件数を調べる。', procedure: [], limitations: ['起動 有効化 確認は別の試験。'] });
  const { wiki } = fixture({ records: { 'amp/z.md': direct, 'amp/a.md': incidental }, hits: ['amp/a.md', 'amp/z.md'] });
  const result = await searchAmp(wiki, { query: '起動 有効化 確認', fallback: false, limit: 1 });
  assert.equal(result.results[0].id, 'z-direct');
});

test('index routes to a full atomic memory with pinned source and all qualifications', async () => {
  const { wiki, calls } = fixture();
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 1);
  const hit = result.results[0];
  assert.equal(hit.memory.id, 'intake-status');
  assert.deepEqual(hit.memory.exceptions, memory().exceptions);
  assert.deepEqual(hit.memory.limitations, memory().limitations);
  assert.equal(hit.applicability, 'matched');
  assert.equal(hit.evidence[0].integrity, 'verified');
  assert.equal(result.semantic_verification, 'not_performed');
  assert.equal(result.writes_performed, false);
  assert.ok(calls.some(c => c.op === 'source_read' && c.version === 1 && c.start_line === 1 && c.end_line === 2));
});

test('missing context is unknown; false conditions and true exceptions withhold the memory', async () => {
  const { wiki } = fixture();
  const unknown = await searchAmp(wiki, { ...query, facts: {} });
  assert.equal(unknown.results[0].applicability, 'unknown');
  assert.deepEqual(unknown.results[0].missing_facts.sort(), ['deleted', 'runtime']);
  for (const facts of [{ runtime: 'cloud', deleted: false }, { runtime: 'local', deleted: true }]) {
    const result = await searchAmp(wiki, { ...query, facts });
    assert.equal(result.results.length, 0);
    assert.equal(result.gaps[0].reason, facts.deleted ? 'exception_matches' : 'conditions_mismatch');
  }
});

test('stale index pins never resolve silently to a new memory version', async () => {
  const { wiki } = fixture({ read: { hash: 'b'.repeat(64) } });
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 0);
  assert.ok(result.gaps.some(g => g.reason === 'memory_hash_mismatch'));
});

test('broken, changed, or truncated evidence is never delivered as verified', async t => {
  for (const source of [{ hash: 'b'.repeat(64) }, { version: 2 }, { truncated: true }, { start_line: 2 }]) {
    await t.test(JSON.stringify(source), async () => {
      const { wiki } = fixture({ source });
      const result = await searchAmp(wiki, query);
      assert.equal(result.results.length, 0);
      assert.ok(result.gaps.some(g => g.reason.startsWith('evidence_')));
    });
  }
});

test('scope is checked on linked pages, not just the search hit; no fallback widens it', async () => {
  const { wiki, calls } = fixture({ read: { project_id: 'other' } });
  const result = await searchAmp(wiki, { ...query, project_id: 'p' });
  assert.equal(result.results.length, 0);
  assert.ok(calls.filter(c => c.op === 'search').every(c => c.project_id === 'p'));
  assert.equal(calls.filter(c => c.op === 'source_read').length, 0);
});

test('direct memory retrieval works without an index, and duplicate paths are read once', async () => {
  const { wiki, calls } = fixture({ hits: ['amp/status.md', 'amp/status.md'] });
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 1);
  assert.equal(calls.filter(c => c.op === 'read').length, 1);
});

test('budget drops whole memories, retaining explicit incompleteness', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { ...query, token_budget: 256 });
  assert.equal(result.results.length, 0);
  assert.equal(result.truncated, true);
  assert.ok(countWikiTokens(result) <= 256);
  assert.equal(result.answer_completeness_verified, false);
});

test('parser rejects unpinned references, extra authority fields, duplicate blocks, and unknown versions', () => {
  const m = memory();
  assert.equal(parseAmpPage(page(m)).id, m.id);
  const invalid = [
    { ...m, protocol: 'amp/999' }, { ...m, verified: true },
    { ...m, evidence: [{ ref: 'source:source-one', sha256: sha }] },
    { ...m, conditions: [fact('__proto__', true)] },
    { ...m, exceptions: [] }, // An empty list is valid and explicitly means none known.
  ];
  for (const value of invalid.slice(0, -1)) assert.throws(() => parseAmpPage(page(value)), /amp_/);
  assert.deepEqual(parseAmpPage(page(invalid.at(-1))).exceptions, []);
  assert.throws(() => parseAmpPage(page(m) + page(m)), /amp_/);
  assert.throws(() => parseAmpPage(page(index([{ id: 'x', path: '../outside.md', hash: sha }]))), /amp_/);
  assert.ok(ampJsonSchema().oneOf || ampJsonSchema().anyOf);
});

test('validation checks every index entry even when it would not match a query', async () => {
  const { wiki } = fixture({ records: { 'amp/index.md': index([{ id: 'missing', path: 'amp/missing.md', hash: sha }]) } });
  const result = await validateAmpPage(wiki, { path: 'amp/index.md' });
  assert.equal(result.valid, false);
  assert.ok(result.gaps.some(g => g.reason === 'page_not_found'));
});

test('draft and superseded records are excluded, read failures stay explicit', async () => {
  for (const status of ['draft', 'superseded']) {
    const { wiki } = fixture({ records: { 'amp/status.md': memory({ status }) }, hits: ['amp/status.md'] });
    const result = await searchAmp(wiki, query);
    assert.equal(result.results.length, 0);
    assert.equal(result.gaps[0].reason, 'memory_not_active');
  }
  const { wiki } = fixture({ hits: ['amp/missing.md'] });
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 0);
  assert.ok(result.gaps.some(g => g.reason === 'page_not_found'));
});

test('an index cannot widen the path filter; unknown filters are rejected', async () => {
  const { wiki } = fixture({ records: { 'amp/index.md': index([{ id: 'intake-status', path: 'outside/status.md', hash: sha }]), 'outside/status.md': memory() } });
  const result = await searchAmp(wiki, { ...query, path_prefix: 'amp/' });
  assert.equal(result.results.length, 0);
  assert.ok(result.gaps.some(g => g.reason === 'amp_path_scope_mismatch'));
  await assert.rejects(searchAmp(wiki, { ...query, tenant_id: 'private' }), /amp_invalid_input/);
});

test('execution claims require event context; malformed blocks remain visible during search', async () => {
  assert.throws(() => parseAmpPage(page(memory({ basis: 'reported_execution' }))), /amp_event_required/);
  const { wiki } = fixture();
  const request = wiki.request;
  wiki.request = async input => { const result = await request(input); if (input.op === 'read') result.content += result.content; return result; };
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 0);
  assert.ok(result.gaps.some(g => g.reason === 'amp_block_required_once'));
});

test('the same logical ID in two pages is withheld instead of picking one arbitrarily', async () => {
  const { wiki } = fixture({ records: { 'amp/one.md': memory(), 'amp/two.md': memory({ revision: 2 }) }, hits: ['amp/one.md', 'amp/two.md'] });
  const result = await searchAmp(wiki, query);
  assert.equal(result.results.length, 0);
  assert.equal(result.gaps.filter(g => g.reason === 'ambiguous_memory_id').length, 2);
});

test('a result limit reports how many complete memories were omitted', async () => {
  const { wiki } = fixture({ records: { 'amp/one.md': memory(), 'amp/two.md': memory({ id: 'second-memory' }) }, hits: ['amp/one.md', 'amp/two.md'] });
  const result = await searchAmp(wiki, { ...query, limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.omitted_results, 1);
  assert.equal(result.truncated, true);
});

test('real Wiki CLI and MCP share retrieval, validation, and feature-off behavior', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'amp-integration-')));
  const config = join(home, 'features.json');
  const wiki = new WikiService({ config, root: join(home, 'wiki'), binary: resolve('packages/wiki-engine/target/debug/orgbrain-wiki-engine') });
  try {
    await setWikiFeature(config, true); await wiki.request({ op: 'init' });
    const source = await wiki.request({ op: 'ingest', name: 'intake.txt', text: 'queued は受付。\n起動は完了ではない。\n' });
    const m = memory({ evidence: [{ ref: `source:${source.source_id}@${source.version}#L1-L2`, sha256: source.hash }] });
    const saved = await wiki.request({ op: 'put', path: 'amp/status.md', content: page(m) });
    await wiki.request({ op: 'put', path: 'amp/index.md', content: page(index([{ id: m.id, path: 'amp/status.md', hash: saved.hash }])) });
    assert.ok(WIKI_TOOLS.some(t => t.name === 'orgbrain_wiki_amp_search'));
    const mcp = await callWikiTool({}, 'orgbrain_wiki_amp_search', query, { wiki });
    assert.equal(mcp.results[0].memory.id, m.id);
    const valid = await callWikiTool({}, 'orgbrain_wiki_amp_validate', { path: 'amp/index.md' }, { wiki });
    assert.equal(valid.valid, true);
    const env = { ...process.env, ORGBRAIN_FEATURES_FILE: config, ORGBRAIN_WIKI_ROOT: wiki.root, ORGBRAIN_WIKI_ENGINE: wiki.binary };
    const cli = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-search', '起動 有効化', '--facts-json', JSON.stringify(query.facts)], { env, encoding: 'utf8', stdio: 'pipe' }));
    const ampHit = cli.results.find(r => r.kind === 'amp');
    assert.equal(ampHit.id, m.id);
    const viaRead = await callWikiTool({}, 'orgbrain_wiki_amp_read', ampHit.next_read.arguments, { wiki });
    assert.equal(viaRead.results[0].memory.id, m.id);
    const cliRead = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-read', 'amp/status.md', '--expected-hash', saved.hash, '--facts-json', JSON.stringify(query.facts)], { env, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliRead.results[0].memory.id, m.id);
    const cliEvidence = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-read', 'amp/status.md', '--expected-hash', saved.hash, '--include-evidence'], { env, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliEvidence.results[0].evidence[0].integrity, 'verified');
    const cliNoFallback = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-search', '起動', '--no-fallback'], { env, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliNoFallback.fallback.used, false);
    await wiki.request({ op: 'ingest', name: 'unmapped.txt', text: '月次枠の残りは1488、必要な予約は2800。新しい呼び出しは0件。\n' });
    const fallback = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', detail: 'memory' }, { wiki });
    assert.ok(fallback.results.some(r => r.kind === 'source' && r.text.includes('1488')));
    assert.equal(fallback.fallback.used, true);
    const sourceSummary = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', token_budget: 1000 }, { wiki });
    const original = sourceSummary.results.find(r => r.kind === 'source');
    const originalRead = await callWikiTool({}, original.next_read.tool, original.next_read.arguments, { wiki });
    assert.equal(originalRead.hash, original.expected_source_hash);
    assert.match(originalRead.text, /新しい呼び出しは0件/);
    const fullOriginal = fallback.results.find(r => r.kind === 'source');
    assert.equal(fullOriginal.end_line, originalRead.end_line);
    assert.equal(fullOriginal.id, `source:${originalRead.source_id}@${originalRead.version}#L${originalRead.start_line}-L${originalRead.end_line}`);
    const onlyAmp = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', fallback: false }, { wiki });
    assert.equal(onlyAmp.results.length, 0);
    const scoped = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', detail: 'memory', project_id: 'absent-project' }, { wiki });
    assert.equal(scoped.results.length, 0);
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('packages/orgbrain-cli/src/local-memory.mjs'), 'mcp'], stderr: 'pipe',
      env: { ...getDefaultEnvironment(), ORGBRAIN_LOCAL_DB: join(home, 'memory.sqlite'), ORGBRAIN_FEATURES_FILE: config, ORGBRAIN_WIKI_ROOT: wiki.root, ORGBRAIN_WIKI_ENGINE: wiki.binary } });
    const client = new Client({ name: 'amp-defaults-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000 } } });
    try {
      await client.connect(transport);
      const found = await client.callTool({ name: 'orgbrain_wiki_amp_search', arguments: { query: '起動 有効化', path: 'amp/status.md' } });
      assert.equal(Boolean(found.isError), false);
      assert.equal(JSON.parse(found.content[0].text).results[0].requires_read, true);
      const read = await client.callTool({ name: 'orgbrain_wiki_amp_read', arguments: { path: 'amp/status.md', expected_hash: saved.hash } });
      assert.equal(Boolean(read.isError), false);
      assert.equal(JSON.parse(read.content[0].text).results[0].evidence_integrity, 'not_checked');
    } finally { await client.close(); await transport.close(); }
    assert.throws(() => execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-search', '起動', '--tenant-id', 'private'], { env, encoding: 'utf8', stdio: 'pipe' }), /amp_invalid_cli_options/);
    assert.throws(() => execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-validate', 'amp/index.md', '--facts-json', '{}'], { env, encoding: 'utf8', stdio: 'pipe' }), /amp_invalid_cli_options/);
    await setWikiFeature(config, false);
    await assert.rejects(callWikiTool({}, 'orgbrain_wiki_amp_search', query, { wiki }), /feature_disabled/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
