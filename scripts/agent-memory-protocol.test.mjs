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
      return { page_id: path, path, project_id: 'p', hash: sha, content: typeof records[path] === 'string' ? records[path] : page(records[path]), truncated: false, ...read };
    }
    if (input.op === 'source_read') return { source_id: 'source-one', version: 1, hash: sha, text: 'queued は受付。\n起動は完了ではない。\n', start_line: 1, end_line: 2, truncated: false, ...source };
    throw Error('unexpected operation: ' + input.op);
  } };
  return { wiki, calls };
}
const query = { memory_format: "json", query: '起動 有効化', facts: { runtime: 'local', deleted: false }, token_budget: 3000, mode: 'apply', detail: 'evidence', fallback: false };

const projectIndex = `---
amp: "0.4"
kind: project_index
project_id: p
---
# プロジェクトの作法

作業前に共通ルールを読み、対象の手順を選ぶ。

## Always
- [共通ルール](amp/rules.md): すべての作業の前に読む。

## Procedures
- [ローカルサーバー起動](amp/start.md): 開発画面を確認するとき。
- [文章の確認](amp/style.md): 執筆・推敲するとき。
`;

test('Markdown procedures preserve code fences and match the same structured information', async () => {
  const markdown = '---\namp: "0.3"\nconditions: {"runtime":"local"}\n---\n# 起動\n\n実行前に確認する。\n\n## Procedure\n1. 次を実行する。\n```sh\n# start\n## Exceptions\npnpm run local:api\n```\n2. 応答を確認する。\n\n## Exceptions\n- 本番では実行しない。\n\n## Limitations\n- 稼働中の状態は別途確認。\n';
  const doc = parseAmpPage(markdown);
  assert.equal(doc.procedure.length, 2);
  assert.match(doc.procedure[0], /# start\n## Exceptions\npnpm run local:api/);
  assert.deepEqual(doc.exceptions, [{ when: [], reason: '本番では実行しない。' }]);
  const outputs = [];
  for (const content of [markdown, page(doc)]) {
    const { wiki } = fixture({ records: { 'amp/start.md': content }, hits: ['amp/start.md'] });
    const result = await searchAmp(wiki, { query: '起動', detail: 'memory', memory_format: 'json', fallback: false });
    outputs.push(result.results[0].memory);
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('procedure sections retain subheadings and list-looking lines inside code examples on save', async () => {
  const markdown = '---\namp: "0.3"\n---\n# 確認\n\n起動結果を読む。\n\n## Procedure\n1. 例を確認。\n```text\n1. output sample\n- output item\n```\n### 補足\n補足を含む。\n2. 結果を記録。\n\n## Limitations\n- 本番未確認。\n';
  const writes = [];
  const wiki = { request: async input => { writes.push(input); return { hash: sha }; } };
  await amp.saveAmp(wiki, { markdown });
  const saved = parseAmpPage(writes[0].content);
  assert.equal(saved.procedure.length, 2);
  assert.match(saved.procedure[0], /1\. output sample\n- output item/);
  assert.match(saved.procedure[0], /### 補足\n補足を含む。/);
  assert.deepEqual(saved.limitations, ['本番未確認。']);
  assert.equal(saved.claim, '起動結果を読む。');
});

test('code-only procedure items round-trip through both Markdown and structured saves', async () => {
  const code = '```sh\n# start\n## Exceptions\necho ok\n```';
  for (const input of [{ markdown: `---\namp: "0.3"\n---\n# 起動\n\n起動前に確認。\n\n## Procedure\n${code}\n` },
    { memory: { title: '起動', claim: '起動前に確認。', procedure: [code, '出力を確認。'] } }]) {
    let content;
    const wiki = { request: async request => { content = request.content; return { hash: sha }; } };
    await amp.saveAmp(wiki, input);
    const saved = parseAmpPage(content);
    assert.equal(saved.procedure[0], code);
    assert.deepEqual(saved.exceptions, []);
    if (input.memory) assert.deepEqual(saved.procedure, input.memory.procedure);
  }
});

test('indented code fences retain the following rationale after a save roundtrip', async () => {
  const markdown = '---\namp: "0.3"\n---\nClaim.\n\n## Procedure\n   ```sh\n   echo ok\n   ```\n\n## Rationale\nReason.\n';
  let content;
  const wiki = { request: async request => { content = request.content; return { hash: sha }; } };
  await amp.saveAmp(wiki, { markdown });
  const saved = parseAmpPage(content);
  assert.equal(saved.rationale, 'Reason.');
  assert.deepEqual(saved.procedure, parseAmpPage(markdown).procedure);
});

test('project procedure labels find the intended body without a body keyword hit', async () => {
  const records = { 'amp/projects/p/index.md': projectIndex,
    'amp/start.md': { protocol: 'amp/0.4', kind: 'memory', claim: 'pnpm local:api と pnpm local:console を別々に実行する。',
      limitations: ['本番への公開には使わない。'] } };
  const { wiki, calls } = fixture({ records, hits: [] });
  const result = await searchAmp(wiki, { query: 'サーバー起動', project_id: 'p', detail: 'memory', fallback: false });
  assert.equal(result.results[0]?.path, 'amp/start.md');
  assert.match(result.results[0].memory, /本番への公開には使わない/);
  assert.equal(calls.some(c => c.op === 'read' && c.path === 'amp/style.md'), false);
});

test('an oversized first memory does not force later complete memories into unread summaries', async () => {
  const records = { 'amp/large.md': { protocol: 'amp/0.4', kind: 'memory', title: '起動と確認',
    claim: '起動 確認 ' + 'これは長い手順の前提条件です。'.repeat(100) },
    'amp/short.md': { protocol: 'amp/0.4', kind: 'memory', title: '起動', claim: '起動前に設定を確認する。',
      exceptions: [{ when: [], reason: '本番では利用しない。' }] } };
  const { wiki } = fixture({ records, hits: Object.keys(records) });
  const result = await searchAmp(wiki, { query: '起動 確認', detail: 'memory', fallback: false, token_budget: 700 });
  const short = result.results.find(r => r.path === 'amp/short.md');
  assert.equal(typeof short?.memory, 'string');
  assert.match(short.memory, /本番では利用しない/);
  const large = result.results.find(r => r.path === 'amp/large.md');
  assert.equal(large?.requires_read, true);
  assert.ok(countWikiTokens(result) <= 700);
});

test('a small result limit does not discard the best source across query batches', async () => {
  const texts = {
    'b-early': 'alpha beta gamma delta epsilon zeta eta theta: introductory material.',
    'a-late': 'iota kappa: unrelated closing notes.',
    'z-combined': 'alpha beta gamma delta epsilon zeta eta iota kappa: use only after the final check.',
  };
  const wiki = { async request(input) {
    if (input.op === 'search') return { hits: input.scope === 'sources' ? Object.entries(texts)
      .filter(([, text]) => text.includes(input.query)).map(([owner_id, snippet]) => ({ kind: 'source', owner_id, version: 1,
        chunk_id: owner_id, heading: 'notes', snippet, start_line: 1, end_line: 1 })) : [], truncated: false };
    if (input.op === 'source_read') return { source_id: input.source_id, version: 1, hash: sha, text: texts[input.source_id],
      start_line: 1, end_line: 1, truncated: false };
    throw Error(input.op);
  } };
  const result = await searchAmp(wiki, { query: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', detail: 'memory', limit: 1 });
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].id, /^source:z-combined@1#/);
  assert.match(result.results[0].text, /only after the final check/);
});

test('project index is delivered without a query match, and its pinned read keeps all routes', async () => {
  const { wiki, calls } = fixture({ records: { 'amp/projects/p/index.md': projectIndex }, hits: [] });
  const result = await searchAmp(wiki, { query: '新しい作業', project_id: 'p', fallback: false, token_budget: 1200 });
  assert.equal(result.project_index.path, 'amp/projects/p/index.md');
  assert.equal(result.project_index.requires_read, true);
  const read = await amp.readAmp(wiki, { ...result.project_index.next_read.arguments, token_budget: 3000 });
  assert.deepEqual(read.results[0].index.entries.map(e => [e.question, e.when, e.path]), [
    ['共通ルール', 'always', 'amp/rules.md'], ['ローカルサーバー起動', 'task', 'amp/start.md'], ['文章の確認', 'task', 'amp/style.md'],
  ]);
  assert.equal(read.results[0].requires_read, false);
  assert.equal(calls.some(c => c.op === 'source_read' || c.op === 'put'), false);
  await assert.rejects(amp.readAmp(wiki, { ...result.project_index.next_read.arguments, expected_hash: 'b'.repeat(64) }), /amp_memory_changed/);
  assert.ok(countWikiTokens(result) <= 1200);
});

test('project index never broadens project or explicit path scope', async () => {
  const { wiki, calls } = fixture({ records: { 'amp/projects/p/index.md': projectIndex }, hits: [] });
  assert.equal((await searchAmp(wiki, { query: '作業', fallback: false })).project_index, undefined);
  assert.equal((await searchAmp(wiki, { query: '作業', project_id: 'p', path_prefix: 'notes/', fallback: false })).project_index, undefined);
  assert.equal(calls.some(c => c.op === 'read'), false);
  const other = fixture({ records: { 'amp/projects/p/index.md': projectIndex }, hits: [], read: { project_id: 'other' } });
  const rejected = await searchAmp(other.wiki, { query: '作業', project_id: 'p', fallback: false });
  assert.equal(rejected.project_index.status, 'unavailable');
  assert.equal(JSON.stringify(rejected).includes('文章の確認'), false);
});

test('a small budget reports an omitted project index without hiding the need to read it', async () => {
  const { wiki } = fixture({ records: { 'amp/projects/p/index.md': projectIndex }, hits: [] });
  const result = await searchAmp(wiki, { query: '作業', project_id: 'p', fallback: false, token_budget: 256 });
  assert.ok(countWikiTokens(result) <= 256);
  assert.equal(result.project_index.requires_read, true);
});

test('project index save enforces one canonical path and matching project ownership', async () => {
  const writes = [];
  const wiki = { request: async input => { writes.push(input); return { hash: sha }; } };
  const saved = await amp.saveAmp(wiki, { markdown: projectIndex, project_id: 'p' });
  assert.equal(saved.path, 'amp/projects/p/index.md');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].project_id, 'p');
  assert.equal(parseAmpPage(writes[0].content).entries.length, 3);
  for (const extra of [{ project_id: 'other' }, { project_id: 'p', path: 'somewhere.md' }, {}]) {
    await assert.rejects(amp.saveAmp(wiki, { markdown: projectIndex, ...extra }), /amp_project_index_scope/);
  }
  assert.equal(writes.length, 1);
});

test('project index rejects encoded paths beyond the read limit before any write', async () => {
  const writes = [];
  const wiki = { request: async input => { writes.push(input); return { hash: sha }; } };
  const project_id = 'あ'.repeat(60);
  const markdown = projectIndex.replace('project_id: p', `project_id: ${project_id}`);
  await assert.rejects(amp.saveAmp(wiki, { project_id, markdown }));
  assert.equal(writes.length, 0);
});

test('long project ids still allow ordinary memory search without a project index', async () => {
  const project_id = 'あ'.repeat(60);
  const { wiki } = fixture({ records: { 'amp/note.md': { protocol: 'amp/0.4', kind: 'memory', claim: 'Canary note' } },
    hits: ['amp/note.md'], read: { project_id } });
  const result = await searchAmp(wiki, { project_id, query: 'Canary', fallback: false });
  assert.equal(result.results[0].path, 'amp/note.md');
});

test('project index validation binds every linked memory to the index owner even without an input filter', async () => {
  const content = projectIndex.replace(/## Procedures[\s\S]*/, '');
  const { wiki } = fixture({ records: { 'amp/projects/p/index.md': content, 'amp/rules.md': memory() }, hits: [] });
  const request = wiki.request;
  wiki.request = async input => {
    const result = await request(input);
    return input.op === 'read' && input.path === 'amp/rules.md' ? { ...result, project_id: 'q' } : result;
  };
  const result = await validateAmpPage(wiki, { path: 'amp/projects/p/index.md' });
  assert.equal(result.valid, false);
  assert.ok(result.gaps.some(g => g.reason === 'project_scope_mismatch'));
});

test('direct reads and search both withhold expired or not-yet-valid procedures', async () => {
  for (const validity of [{ valid_until: '2000-01-01' }, { valid_from: '2999-01-01' }]) {
    const doc = { protocol: 'amp/0.3', kind: 'memory', claim: '起動の手順', ...validity };
    const { wiki } = fixture({ records: { 'amp/start.md': doc }, hits: ['amp/start.md'] });
    assert.equal((await searchAmp(wiki, { query: '起動', fallback: false })).results.length, 0);
    await assert.rejects(amp.readAmp(wiki, { path: 'amp/start.md', expected_hash: sha }), /amp_memory_(expired|not_yet_valid)/);
  }
});

test('malformed Markdown memories cannot reappear as ordinary fallback passages', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'amp-fallback-format-')));
  const config = join(home, 'features.json');
  const wiki = new WikiService({ config, root: join(home, 'wiki'), binary: resolve('packages/wiki-engine/target/debug/orgbrain-wiki-engine') });
  try {
    await setWikiFeature(config, true); await wiki.request({ op: 'init' });
    await wiki.request({ op: 'put', path: 'amp/broken.md', project_id: 'p', content:
      '---\namp: "0.3"\nconditions: invalid\n---\n# glacier\n\nglacier を実行する。\n' });
    const result = await searchAmp(wiki, { query: 'glacier', project_id: 'p', detail: 'memory' });
    assert.equal(result.results.length, 0);
    assert.ok(result.gaps.some(g => g.reason === 'amp_invalid_conditions'));
    await wiki.request({ op: 'put', path: 'ordinary.md', project_id: 'p', content: '# glacier\n\nglacier の通常資料。\n' });
    const ordinary = await searchAmp(wiki, { query: 'glacier', project_id: 'p', detail: 'memory' });
    assert.equal(ordinary.results.length, 1);
    assert.match(ordinary.results[0].text, /通常資料/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

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
  const found = await searchAmp(wiki, { memory_format: "json", query: query.query, facts: query.facts, fallback: false });
  const hit = found.results[0];
  assert.equal(hit.detail, 'summary');
  assert.equal(hit.requires_read, true);
  assert.equal(hit.memory, undefined);
  assert.equal(calls.filter(c => c.op === 'source_read').length, 0);
  assert.equal(hit.next_read.tool, 'orgbrain_wiki_amp_read');
  const read = await amp.readAmp(wiki, { ...hit.next_read.arguments, memory_format: "json" });
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
  const result = await searchAmp(wiki, { memory_format: "json", query: '起動要求が成功した記憶はもう使える？条件と例外と確認方法と保存と検索の違いを知りたい。', fallback: false });
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
  const result = await searchAmp(wiki, { memory_format: "json", query: '起動 有効化 確認', fallback: false, limit: 1 });
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

test('budget never returns a partial memory, retaining explicit incompleteness', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { ...query, token_budget: 256 });
  assert.ok(result.results.every(r => r.memory === undefined && r.evidence === undefined && r.requires_read === true));
  assert.equal(result.truncated, true);
  assert.ok(countWikiTokens(result) <= 256);
  assert.equal(result.answer_completeness_verified, false);
});

const longClaim = 'queued と worker.started だけでは有効化を示さない。'.repeat(28);
test('an oversized full memory degrades to a read pointer instead of an empty result', async () => {
  const { wiki } = fixture({ records: { 'amp/status.md': memory({ claim: longClaim }) }, hits: ['amp/status.md'] });
  const result = await searchAmp(wiki, { ...query, mode: 'explain', detail: 'memory', token_budget: 600 });
  assert.equal(result.results.length, 1);
  const hit = result.results[0];
  assert.equal(hit.memory, undefined);
  assert.equal(hit.requires_read, true);
  assert.equal(hit.next_read.tool, 'orgbrain_wiki_amp_read');
  assert.equal(result.degraded_results, 1);
  assert.equal(result.truncated, true);
  assert.ok(countWikiTokens(result) <= 600);
  const read = await amp.readAmp(wiki, { ...hit.next_read.arguments, token_budget: 4000, memory_format: "json" });
  assert.equal(read.results[0].memory.claim, longClaim);
});

test('a degraded apply-mode candidate still requires a verified read', async () => {
  const { wiki } = fixture({ records: { 'amp/status.md': memory({ claim: longClaim }) }, hits: ['amp/status.md'] });
  const result = await searchAmp(wiki, { ...query, token_budget: 600 });
  const hit = result.results[0];
  assert.equal(hit.requires_read, true);
  assert.equal(hit.evidence, undefined);
  assert.equal(hit.next_read.arguments.mode, 'apply');
  assert.equal(hit.next_read.arguments.include_evidence, true);
});

test('summary candidates shrink to references before any candidate is dropped', async () => {
  const records = {}, hits = [];
  for (let i = 0; i < 5; i++) {
    records[`amp/m${i}.md`] = memory({ id: `memory-${i}`, claim: `起動 有効化 ${i}。` + '受付と処理完了は別の状態として確認する。'.repeat(10) });
    hits.push(`amp/m${i}.md`);
  }
  const { wiki } = fixture({ records, hits });
  const result = await searchAmp(wiki, { memory_format: "json", query: '起動 有効化', facts: query.facts, fallback: false, token_budget: 900 });
  assert.equal(result.results.length, 5);
  assert.equal(result.omitted_results, 0);
  assert.ok(result.results.every(r => r.requires_read && r.next_read.tool === 'orgbrain_wiki_amp_read'));
  assert.ok(result.degraded_results > 0);
  assert.ok(countWikiTokens(result) <= 900);
});

test('a summary shows the matching exception instead of only the claim prefix', async () => {
  const { wiki } = fixture({ hits: ['amp/status.md'] });
  const result = await searchAmp(wiki, { memory_format: "json", query: '削除', fallback: false });
  assert.equal(result.results[0].matched_on, 'exception');
  assert.match(result.results[0].matched_text, /削除された記憶は利用しない/);
});

test('full results carry answer material, not bookkeeping the caller already has', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { ...query, mode: 'explain', detail: 'memory' });
  const hit = result.results[0];
  assert.equal(hit.next_read, undefined);
  assert.deepEqual(hit.memory.evidence, ['source:source-one@1#L1-L2']);
  for (const field of ['protocol', 'kind', 'status', 'aliases', 'revision']) assert.equal(hit.memory[field], undefined);
  assert.equal(hit.hash, sha);
  assert.deepEqual(hit.memory.exceptions, memory().exceptions);
});

test('summary read arguments omit values that are already the defaults', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { memory_format: "json", query: query.query, fallback: false });
  assert.deepEqual(Object.keys(result.results[0].next_read.arguments).sort(), ['expected_hash', 'path']);
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

const minimal = (overrides = {}) => ({ protocol: 'amp/0.2', kind: 'memory', basis: 'implementation',
  claim: 'queued と worker.started だけでは有効化を示さない。', evidence: [{ ref: 'source:source-one@1#L1-L2' }], ...overrides });

test('amp/0.2 needs only basis, claim and evidence; path and claim supply identity and title', async () => {
  const { wiki } = fixture({ records: { 'amp/m.md': minimal() }, hits: ['amp/m.md'] });
  const result = await searchAmp(wiki, { memory_format: "json", query: '有効化', fallback: false, detail: 'evidence' });
  const hit = result.results[0];
  assert.equal(hit.memory.id, 'amp/m.md');
  assert.match(hit.memory.title, /queued/);
  assert.deepEqual([hit.memory.conditions, hit.memory.exceptions], [[], []]);
  assert.equal(hit.evidence[0].sha256, sha);
  assert.equal(hit.evidence[0].integrity, 'verified');
  assert.throws(() => parseAmpPage(page(minimal({ evidence: [] }))), /amp_invalid_document/);
  assert.throws(() => parseAmpPage(page(minimal({ revision: 1 }))), /amp_invalid_document/);
});

test('an amp/0.2 index links by path, so editing a memory does not hide it', async () => {
  const index02 = { protocol: 'amp/0.2', kind: 'index', title: '記憶はいつ使える？', question: '起動すれば使える？',
    entries: [{ question: '起動から有効化を調べる', path: 'amp/m.md' }] };
  const { wiki } = fixture({ records: { 'amp/index.md': index02, 'amp/m.md': minimal({ claim: '別の主張。' }) }, hits: ['amp/index.md'], read: { hash: 'b'.repeat(64) } });
  const result = await searchAmp(wiki, { memory_format: "json", query: '起動 有効化', fallback: false, detail: 'memory' });
  assert.equal(result.results[0].memory.claim, '別の主張。');
  assert.deepEqual(result.results[0].via, [{ path: 'amp/index.md', hash: 'b'.repeat(64) }]);
  assert.deepEqual(result.gaps, []);
});

const note03 = `---
amp: "0.3"
name: intake-status
description: 起動要求と有効化の区別
type: fact
basis: implementation
tags: ["queued", "worker.started"]
conditions: {"runtime": "local"}
sources: ["source:source-one@1#L1-L2"]
globs: "**/*.ts"
---
# 起動しても有効化ではない

queued と worker.started だけでは有効化を示さない。

## Exceptions
- {"deleted": true}: 削除された記憶は利用しない。
- 手動で再投入した場合は別に確認する。

## Limitations
- 実クライアントでの成功は未確認。
`;

test('canonical Markdown uses block metadata without JSON and preserves typed conditions and exceptions', async () => {
  let content;
  const { wiki: sources } = fixture();
  const wiki = { request: async input => input.op === 'put' ? (content = input.content, { hash: sha }) : sources.request(input) };
  const input = { title: '値を保持する', claim: '適用条件と例外を確認する。', basis: 'observed_execution',
    aliases: ['起動', '再確認'], conditions: [fact('text', 'false'), fact('enabled', false), fact('count', 0), fact('code', '001')],
    exceptions: [{ when: [fact('deleted', true), fact('runtime', 'local')], reason: '削除済みなら使わない。' }, { when: [], reason: '手動処理は別途確認。' }],
    event: { date: '2026-11-14', environment: 'test', outcome: 'local only' },
    evidence: [{ ref: 'source:source-one@1#L1-L2' }], procedure: ['確認する。'], limitations: ['本番未確認。'] };
  await amp.saveAmp(wiki, { memory: input });
  const doc = parseAmpPage(content);
  assert.equal(doc.protocol, 'amp/0.4');
  for (const field of ['conditions', 'exceptions', 'event', 'procedure', 'limitations', 'aliases']) assert.deepEqual(doc[field], input[field]);
  assert.equal(doc.evidence[0].sha256, sha);
  const metadata = content.split('---')[1];
  assert.doesNotMatch(metadata, /[{}\[\]]/);
  assert.equal(content.split('source:source-one@1#L1-L2').length - 1, 1);
  assert.equal(content.split('削除済みなら使わない。').length - 1, 1);
  const { wiki: savedWiki } = fixture({ records: { 'amp/typed.md': content }, hits: ['amp/typed.md'] });
  const explained = await searchAmp(savedWiki, { query: '適用', facts: { text: false, enabled: false, count: 0, code: '001' }, detail: 'memory', fallback: false });
  assert.equal(explained.results[0].applicability, 'not_applicable');
  assert.match(explained.results[0].memory, /deleted = true/);
  assert.doesNotMatch(explained.results[0].memory, /\{"(?:text|deleted)"/);
});

test('block YAML reads without losing conditions and rejects duplicate keys or aliases', () => {
  const note = '---\namp: 0.4\nconditions:\n  runtime: local\nexceptions:\n  - when:\n      deleted: true\n    reason: 使わない。\n---\n# 起動\n\n手順を確認する。\n';
  assert.deepEqual(parseAmpPage(note).conditions, [fact('runtime', 'local')]);
  assert.deepEqual(parseAmpPage(note).exceptions, [{ when: [fact('deleted', true)], reason: '使わない。' }]);
  for (const invalid of ['amp: 0.4\namp: 0.3', 'amp: 0.4\ntags: &tags [local]\naliases: *tags', 'amp: 0.4\nconditions: !!str invalid'])
    assert.throws(() => parseAmpPage(`---\n${invalid}\n---\nClaim.`), /amp_invalid/);
});

test('legacy plain scalar qualifications survive reading and migration to block YAML', async () => {
  const markdown = '---\namp: "0.3"\nreuse_when: Only for #critical incidents\ndescription: Rule: only in staging\n---\nClaim.\n';
  const before = parseAmpPage(markdown);
  assert.equal(before.reuse_when, 'Only for #critical incidents');
  assert.equal(before.description, 'Rule: only in staging');
  let content;
  await amp.saveAmp({ request: async input => { content = input.content; return { hash: sha }; } }, { markdown });
  const after = parseAmpPage(content);
  assert.equal(after.protocol, 'amp/0.4');
  assert.equal(after.reuse_when, before.reuse_when);
  assert.equal(after.description, before.description);
});

test('amp/0.3 is a plain Markdown note with frontmatter; unknown keys from other tools are ignored', async () => {
  const doc = parseAmpPage(note03);
  assert.equal(doc.protocol, 'amp/0.3');
  assert.equal(doc.claim, 'queued と worker.started だけでは有効化を示さない。');
  assert.deepEqual(doc.conditions, [{ key: 'runtime', equals: 'local' }]);
  assert.deepEqual(doc.exceptions, [{ when: [{ key: 'deleted', equals: true }], reason: '削除された記憶は利用しない。' }, { when: [], reason: '手動で再投入した場合は別に確認する。' }]);
  assert.deepEqual(doc.limitations, ['実クライアントでの成功は未確認。']);
  assert.deepEqual(doc.evidence, [{ ref: 'source:source-one@1#L1-L2' }]);
  assert.equal(doc.title, '起動しても有効化ではない');
  assert.throws(() => parseAmpPage('---\nname: x\n---\nbody\n'), /amp_no_block/);
});

test('amp/0.3 search: prose exceptions never auto-match, expired memories are withheld', async () => {
  const wiki = { async request(input) {
    if (input.op === 'search') return { hits: [{ kind: 'page', owner_id: 'amp/a.md' }, { kind: 'page', owner_id: 'amp/b.md' }] };
    if (input.op === 'read') return { page_id: input.page_id ?? input.path, path: input.page_id ?? input.path, project_id: 'p', hash: sha, truncated: false,
      content: (input.page_id ?? input.path) === 'amp/a.md' ? note03 : note03.replace('amp: "0.3"', 'amp: "0.3"\nvalid_until: "2020-01-01"').replace('name: intake-status', 'name: old-status') };
    if (input.op === 'source_read') return { source_id: 'source-one', version: 1, hash: sha, text: 'x\ny\n', start_line: 1, end_line: 2, truncated: false };
    throw Error(input.op);
  } };
  const result = await searchAmp(wiki, { memory_format: "json", query: '有効化', facts: { runtime: 'local', deleted: false }, fallback: false, detail: 'memory' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].applicability, 'matched');
  assert.equal(result.results[0].memory.description, '起動要求と有効化の区別');
  assert.ok(result.gaps.some(g => g.location === 'amp/b.md' && g.reason === 'memory_expired'));
});

test('memories are returned as compact Markdown by default, keeping every qualification', async () => {
  const { wiki } = fixture();
  const result = await searchAmp(wiki, { query: query.query, facts: { runtime: 'local', deleted: true }, fallback: false, detail: 'memory' });
  const hit = result.results[0];
  assert.equal(typeof hit.memory, 'string');
  for (const part of ['queued と worker.started だけでは有効化を示さない。', 'deleted = true: 削除された記憶は利用しない。',
    '実クライアントでの成功は未確認。', '保存されたIDと版を読む。', "Conditions: runtime = 'local'", 'source:source-one@1#L1-L2', 'Basis: implementation'])
    assert.ok(hit.memory.includes(part), part);
  assert.equal(hit.applicability, 'not_applicable');
  const json = await searchAmp(wiki, { memory_format: "json", query: query.query, fallback: false, detail: 'memory', memory_format: 'json' });
  assert.deepEqual(json.results[0].memory.exceptions, memory().exceptions);
  assert.ok(countWikiTokens(hit.memory) < countWikiTokens(json.results[0].memory));
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
    const viaRead = await callWikiTool({}, 'orgbrain_wiki_amp_read', { ...ampHit.next_read.arguments, memory_format: "json" }, { wiki });
    assert.equal(viaRead.results[0].memory.id, m.id);
    const cliRead = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-read', 'amp/status.md', '--expected-hash', saved.hash, '--facts-json', JSON.stringify(query.facts)], { env, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliRead.results[0].path, 'amp/status.md');
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
    assert.equal(fullOriginal.id, `source:${originalRead.source_id}@${originalRead.version}#L${originalRead.start_line}-L${originalRead.end_line}`);
    const filler = Array.from({ length: 60 }, (_, i) => `第${i}節の運用メモ。予約の再計算、記録の保存、確認の手順を順に記す。`);
    filler.splice(30, 0, '長い報告でも月次枠の残りは900、必要な予約は2800。呼び出しは0件で有効化も0件。');
    await wiki.request({ op: 'ingest', name: 'long-report.txt', text: filler.join('\n') + '\n' });
    const small = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 900 2800', detail: 'memory', token_budget: 1200 }, { wiki });
    assert.ok(small.results.some(r => r.kind === 'source' && !r.requires_read && r.text.includes('呼び出しは0件')));
    assert.ok(countWikiTokens(small) <= 1200);
    const onlyAmp = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488 2800', fallback: false }, { wiki });
    assert.equal(onlyAmp.results.length, 0);
    // Saving: one call with the minimal fields; ranges are read and source hashes pinned.
    const draft = { basis: 'implementation', claim: '月次枠の残りが1488で予約2800に足りないとき、新しい呼び出しは0件。', limitations: ['単一の報告。'],
      evidence: [{ ref: `source:${source.source_id}@${source.version}#L1-L1` }] };
    await assert.rejects(callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: { ...draft, evidence: [{ ref: `source:${source.source_id}@${source.version}#L1-L99` }] } }, { wiki }), /amp_evidence_range_invalid|invalid_line_range/);
    await assert.rejects(callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: { ...draft, extra: true } }, { wiki }), /amp_invalid_input/);
    const stored = await callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: draft, path: 'amp/memories/quota.md' }, { wiki });
    assert.equal(stored.writes_performed, true);
    assert.equal(stored.evidence[0].sha256, source.hash);
    const reused = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: '月次枠 1488', detail: 'evidence', memory_format: 'json' }, { wiki });
    const savedHit = reused.results.find(r => r.kind === 'amp');
    assert.equal(savedHit.memory.id, 'amp/memories/quota.md');
    assert.equal(savedHit.evidence[0].integrity, 'verified');
    const markdown = await wiki.request({ op: 'read', path: 'amp/memories/quota.md', max_chars: 64000 });
    assert.match(markdown.content, /## Limitations\n\n- 単一の報告。/);
    assert.match(markdown.content, /^---\namp: "0\.4"\n/);
    // A note written by another tool (Claude Code auto memory style) is imported as-is.
    const imported = await callWikiTool({}, 'orgbrain_wiki_amp_save', { markdown: '---\nname: prefer-pnpm\ndescription: このリポジトリではpnpmを使う\ntype: feedback\n---\nnpmではなくpnpmを使う。\n\n**Why:** ロックファイルを1つに保つため。\n' }, { wiki });
    assert.equal(imported.path, 'amp/memories/prefer-pnpm.md');
    const importedHit = (await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: 'pnpm', detail: 'memory', fallback: false, memory_format: 'json' }, { wiki })).results[0];
    assert.match(importedHit.memory.claim, /pnpmを使う/);
    const importedApply = await callWikiTool({}, 'orgbrain_wiki_amp_search', { query: 'pnpm', mode: 'apply', fallback: false }, { wiki });
    assert.ok(importedApply.gaps.some(g => g.reason === 'evidence_missing'));
    await assert.rejects(callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: draft, path: 'amp/memories/quota.md', expected_hash: 'c'.repeat(64) }, { wiki }));
    const updated = await callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: { ...draft, limitations: [] }, path: 'amp/memories/quota.md', expected_hash: stored.hash }, { wiki });
    assert.notEqual(updated.hash, stored.hash);
    // Agents naturally write refs as strings and a single step as a string; saving accepts both.
    const loose = await callWikiTool({}, 'orgbrain_wiki_amp_save', { memory: { ...draft, procedure: '予約を確認する。', evidence: [`source:${source.source_id}@${source.version}#L1-L1`] }, dry_run: true }, { wiki });
    assert.equal(loose.evidence[0].integrity, 'verified');
    const cliSaved = JSON.parse(execFileSync(process.execPath, ['packages/orgbrain-cli/src/local-memory.mjs', 'wiki', 'amp-save', '--memory-json', JSON.stringify(draft), '--dry-run'], { env, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliSaved.writes_performed, false);
    assert.match(cliSaved.path, /^amp\/memories\/m-[0-9a-f]{12}\.md$/);
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
