// Bounded, local-only retrieval comparison. Never changes the personal Wiki.
import { mkdtemp, mkdir, readFile, writeFile, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WikiService, setWikiFeature, countWikiTokens } from '../packages/orgbrain-cli/src/lib/wiki-service.mjs';
import { callWikiTool } from '../packages/orgbrain-cli/src/lib/wiki-mcp.mjs';
import { parseAmpPage } from '../packages/orgbrain-cli/src/lib/agent-memory-protocol.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const binary = resolve('packages/wiki-engine/target/debug/orgbrain-wiki-engine');
const mainPath = 'topics/orgbrain-memory-intake-and-availability.md';
const indexPath = 'amp/indexes/memory-intake.md';
const refs = text => [...text.matchAll(/source:([\w-]+)@([1-9]\d*)/g)].map(m => ({ source_id: m[1], version: Number(m[2]) }));
const resultUnits = result => result.results
  ? result.results.map(r => JSON.stringify({ memory: r.memory, evidence: r.evidence }))
  : (result.evidence ?? []).map(e => e.text);
const normalized = text => text.normalize('NFKC').replace(/\\n/g, ' ').replace(/\s+/g, ' ');

export function scoreResult(result, testCase) {
  const units = resultUnits(result).map(normalized);
  const hits = testCase.atoms.map(atom => ({ id: atom.id, type: atom.type, found: units.some(unit => atom.patterns.some(pattern => new RegExp(pattern, 'iu').test(unit))) }));
  const core = hits.filter(h => h.type === 'claim'), qualifiers = hits.filter(h => h.type === 'qualifier');
  const relevant = units.filter(unit => testCase.atoms.filter(a => a.type === 'claim').some(a => a.patterns.some(p => new RegExp(p, 'iu').test(unit)))).length;
  return { hits, any_claim: core.some(h => h.found), all_claims: core.every(h => h.found), complete: hits.every(h => h.found),
    qualifier_found: qualifiers.filter(h => h.found).length, qualifier_total: qualifiers.length,
    returned_units: units.length, relevant_units: relevant };
}

export async function prepare() {
  const out = await realpath(await mkdtemp(join(tmpdir(), 'orgbrain-amp-real-eval-')));
  const live = new WikiService({ root: join(process.env.HOME, '.org-brain/wiki/personal'), config: join(process.env.HOME, '.org-brain/features.json'), binary });
  const main = await live.request({ op: 'read', path: mainPath, max_chars: 64000 });
  const index = await live.request({ op: 'read', path: indexPath, max_chars: 64000 });
  if (main.truncated || index.truncated) throw Error('incomplete_page');
  const indexData = parseAmpPage(index.content), memories = [];
  for (const e of indexData.entries) {
    const m = await live.request({ op: 'read', path: e.memory.path, max_chars: 64000 });
    if (m.truncated || m.hash !== e.memory.hash) throw Error('stale_live_amp_pin');
    memories.push(m);
  }
  const selected = [...new Map([main, ...memories].flatMap(p => refs(p.content)).map(r => [`${r.source_id}@${r.version}`, r])).values()];
  const config = join(out, 'features.json'); await setWikiFeature(config, true);
  const base = new WikiService({ root: join(out, 'baseline'), config, binary });
  await base.request({ op: 'init' }); await mkdir(join(out, 'originals'));
  const sources = [], remap = new Map();
  for (const ref of selected) {
    const source = await live.request({ op: 'source_read', ...ref, raw: true, max_chars: 128 });
    const bytes = Buffer.from(source.base64, 'base64');
    if (bytes.length !== source.size || sha(bytes) !== source.hash) throw Error('incomplete_original_bytes');
    const file = join(out, 'originals', `${ref.source_id}-${ref.version}`);
    await writeFile(file, bytes);
    const cloned = await base.request({ op: 'ingest', file, name: source.name });
    if (cloned.hash !== source.hash) throw Error('clone_hash_changed');
    const item = { ...ref, hash: source.hash, name: source.name, size: source.size, cloned_id: cloned.source_id, cloned_version: cloned.version };
    sources.push(item); remap.set(`${ref.source_id}@${ref.version}`, `${cloned.source_id}@${cloned.version}`);
  }
  const remapText = text => text.replace(/source:([\w-]+@[1-9]\d*)/g, (_, key) => `source:${remap.get(key) ?? key}`);
  await base.request({ op: 'put', path: mainPath, title: main.title, content: remapText(main.content) });
  await cp(base.root, join(out, 'augmented'), { recursive: true });
  const augmented = new WikiService({ root: join(out, 'augmented'), config, binary });
  const memoryPages = [];
  for (const m of memories) {
    const saved = await augmented.request({ op: 'put', path: m.path, title: m.title, content: remapText(m.content) });
    const doc = parseAmpPage(m.content);
    memoryPages.push({ id: doc.id, path: m.path, live_hash: m.hash, snapshot_hash: saved.hash });
    indexData.entries.find(e => e.memory.id === doc.id).memory.hash = saved.hash;
  }
  const indexContent = index.content.replace(/^```amp\n[\s\S]*?^```/m, '```amp\n' + JSON.stringify(indexData, null, 2) + '\n```');
  await augmented.request({ op: 'put', path: indexPath, title: index.title, content: indexContent });
  const files = ['agent-memory-protocol.mjs', 'wiki-recall.mjs', 'wiki-recall-focus.mjs', 'wiki-mcp.mjs', 'wiki-service.mjs'];
  const implementation = {};
  for (const file of files) implementation[file] = sha(await readFile(`packages/orgbrain-cli/src/lib/${file}`));
  const manifest = { date: '2026-11-09', original_page: { path: main.path, hash: main.hash, content_hash: main.content_hash },
    amp_index: { path: index.path, hash: index.hash }, memoryPages, sources, implementation, engine_sha256: sha(await readFile(binary)),
    node: process.version, baseline_pages: 1, augmented_pages: 7, source_count: sources.length, raw_source_bytes: sources.reduce((n, s) => n + s.size, 0) };
  await writeFile(join(out, 'snapshot.json'), json(manifest));
  await writeFile(join(out, 'original-page.md'), main.content);
  console.log(json({ out, ...manifest }));
}

export async function run(out, caseFile) {
  const definition = JSON.parse(await readFile(caseFile, 'utf8'));
  const caseBytes = await readFile(caseFile);
  const snapshot = JSON.parse(await readFile(join(out, 'snapshot.json'), 'utf8'));
  for (const [file, expected] of Object.entries(snapshot.implementation))
    if (sha(await readFile(`packages/orgbrain-cli/src/lib/${file}`)) !== expected) throw Error('implementation_changed');
  await writeFile(join(out, 'frozen-cases.json'), caseBytes);
  const config = join(out, 'features.json');
  const methods = [
    { id: 'legacy', root: 'baseline', tool: 'orgbrain_wiki_recall' },
    { id: 'legacy_augmented', root: 'augmented', tool: 'orgbrain_wiki_recall' },
    { id: 'amp', root: 'augmented', tool: 'orgbrain_wiki_amp_search' },
  ];
  const rows = []; await mkdir(join(out, 'responses'), { recursive: true });
  for (const form of ['keywords', 'natural']) for (const budget of definition.budgets) for (const c of definition.cases) for (const m of methods) {
    const wiki = new WikiService({ root: join(out, m.root), config, binary });
    const input = { query: c[form], limit: 5, token_budget: budget, ...(m.id === 'amp' ? { facts: c.facts } : {}) };
    const started = performance.now();
    let result, error = null;
    try { result = await callWikiTool({}, m.tool, input, { wiki }); }
    catch (e) { error = e.message; result = { error }; }
    const elapsed_ms = performance.now() - started;
    const score = error ? null : scoreResult(result, c);
    const row = { case_id: c.id, form, budget, method: m.id, group: c.group, input_tokens: countWikiTokens(input), output_tokens: countWikiTokens(result),
      elapsed_ms, error, score, truncated: result.truncated ?? false, gaps: result.gaps ?? [],
      applicability: result.results?.map(r => ({ id: r.memory.id, state: r.applicability, missing_facts: r.missing_facts })) ?? [] };
    rows.push(row);
    await writeFile(join(out, 'responses', `${c.id}-${form}-${budget}-${m.id}.json`), json({ input, result, row }));
    if (rows.length % 12 === 0) console.log(JSON.stringify({ completed: rows.length, total: definition.cases.length * definition.budgets.length * 6 }));
  }
  const receipt = { schema: 'amp-real-data-evaluation/v1', cases_sha256: sha(caseBytes), snapshot, tokenizer: 'o200k_base',
    inference_model_calls: 0, paid_inference_cost: null, generation_quality_measured: false, rows };
  await writeFile(join(out, 'results.json'), json(receipt));
  console.log(JSON.stringify({ done: rows.length, errors: rows.filter(r => r.error).length, out }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, out, caseFile] = process.argv.slice(2);
  if (action === 'prepare') await prepare();
  else if (action === 'run') await run(out, caseFile);
  else throw Error('usage: prepare | run SNAPSHOT_DIR CASES_JSON');
}
