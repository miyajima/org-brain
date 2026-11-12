// Regression replay on the frozen 2026-11-09 corpus, not an unseen accuracy benchmark.
import { readFile, writeFile, mkdtemp, realpath, cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { WikiService, countWikiTokens } from '../packages/orgbrain-cli/src/lib/wiki-service.mjs';
import { callWikiTool } from '../packages/orgbrain-cli/src/lib/wiki-mcp.mjs';
import { scoreResult } from './amp-real-data-evaluation.mjs';
import { auditedCases, aggregate } from './amp-real-data-summary.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');

export function scoreRetrieved(responses, testCase) {
  const units = responses.flatMap(response => response.results
    ? response.results.filter(r => !r.requires_read).map(r => r.memory ? JSON.stringify({ memory: r.memory, evidence: r.evidence }) : r.text ?? '')
    : response.text ? [response.text] : response.content ? [response.content] : []);
  return scoreResult({ evidence: units.filter(Boolean).map(text => ({ text })) }, testCase);
}

async function evaluate(snapshotRoot, date = '2026-11-11') {
  const out = await realpath(await mkdtemp(join(tmpdir(), 'amp-improved-eval-')));
  const snapshot = JSON.parse(await readFile(join(snapshotRoot, 'snapshot.json')));
  const binary = resolve('packages/wiki-engine/target/debug/orgbrain-wiki-engine');
  // A rebuilt engine is only acceptable for an A/B replay where both arms use the same binary; it is recorded.
  const engine_sha256_actual = sha(await readFile(binary));
  if (engine_sha256_actual !== snapshot.engine_sha256 && process.env.AMP_EVAL_ALLOW_ENGINE_CHANGE !== '1') throw Error('engine_changed_since_baseline');
  for (const file of ['wiki-recall.mjs', 'wiki-recall-focus.mjs', 'wiki-service.mjs'])
    if (sha(await readFile(`packages/orgbrain-cli/src/lib/${file}`)) !== snapshot.implementation[file]) throw Error('baseline_dependency_changed:' + file);
  const caseBytes = await readFile(join(snapshotRoot, 'frozen-cases.json'));
  const old = JSON.parse(await readFile('docs/agent-memory-protocol/evaluation-20261109-results.json'));
  if (sha(caseBytes) !== old.cases_sha256) throw Error('cases_changed');
  for (const source of snapshot.sources) {
    if (sha(await readFile(join(snapshotRoot, 'originals', `${source.source_id}-${source.version}`))) !== source.hash) throw Error('source_changed');
  }
  await cp(join(snapshotRoot, 'augmented'), join(out, 'wiki'), { recursive: true });
  await cp(join(snapshotRoot, 'features.json'), join(out, 'features.json'));
  await mkdir(join(out, 'responses'));
  const wiki = new WikiService({ root: join(out, 'wiki'), config: join(out, 'features.json'), binary });
  for (const m of snapshot.memoryPages) {
    const page = await wiki.request({ op: 'read', path: m.path, max_chars: 64 });
    if (page.hash !== m.snapshot_hash) throw Error('amp_memory_changed');
  }
  const implementation = {};
  for (const file of ['agent-memory-protocol.mjs', 'wiki-mcp.mjs', 'wiki-cli.mjs']) implementation[file] = sha(await readFile(`packages/orgbrain-cli/src/lib/${file}`));
  const cases = await auditedCases(JSON.parse(caseBytes)), rows = [], hashes = {};
  for (const form of ['keywords', 'natural']) for (const budget of [1200, 4000]) for (const c of cases) {
    const input = { query: c[form], facts: c.facts, limit: 5, token_budget: budget, detail: 'memory' };
    let result, error = null;
    try { result = await callWikiTool({}, 'orgbrain_wiki_amp_search', input, { wiki }); }
    catch (e) { error = e.message; result = { error }; }
    const row = { case_id: c.id, group: c.group, form, budget, method: 'amp_hybrid_memory', error,
      input_tokens: countWikiTokens(input), output_tokens: countWikiTokens(result),
      score: error ? null : scoreRetrieved([result], c), kinds: result.results?.map(r => r.kind) ?? [],
      truncated: result.truncated ?? false, gaps: result.gaps ?? [] };
    const name = `${c.id}-${form}-${budget}-memory.json`, bytes = JSON.stringify({ input, result, row }, null, 2) + '\n';
    await writeFile(join(out, 'responses', name), bytes); hashes[name] = sha(bytes); rows.push(row);
    if (rows.length % 16 === 0) console.log(JSON.stringify({ completed: rows.length, total: 80 }));
  }
  // One fixed, non-oracle staged reader: 1000-token search, then read candidates in returned order,
  // at most five, within 4000 total response tokens. Summary text never counts as answer evidence.
  for (const c of cases) {
    const input = { query: c.keywords, facts: c.facts, limit: 5, token_budget: 1000 };
    const calls = [], evidence = [];
    let error = null, remaining = 4000;
    try {
      const found = await callWikiTool({}, 'orgbrain_wiki_amp_search', input, { wiki });
      calls.push({ tool: 'orgbrain_wiki_amp_search', input, result: found });
      remaining -= countWikiTokens(found);
      for (const hit of found.results) {
        if (!hit.next_read || remaining < 256) break;
        const request = { ...hit.next_read.arguments, token_budget: Math.min(remaining, 16000) };
        const read = await callWikiTool({}, hit.next_read.tool, request, { wiki });
        if (hit.expected_source_hash && read.hash !== hit.expected_source_hash) throw Error('staged_source_changed');
        calls.push({ tool: hit.next_read.tool, input: request, result: read });
        remaining -= countWikiTokens(read); evidence.push(read);
      }
    } catch (e) { error = e.message; }
    const row = { case_id: c.id, group: c.group, form: 'keywords', budget: 4000, method: 'amp_staged', error,
      input_tokens: calls.reduce((n, v) => n + countWikiTokens(v.input), 0),
      output_tokens: calls.reduce((n, v) => n + countWikiTokens(v.result), 0), calls: calls.length,
      score: scoreRetrieved(evidence, c) };
    const name = `${c.id}-keywords-4000-staged.json`, bytes = JSON.stringify({ calls, row }, null, 2) + '\n';
    await writeFile(join(out, 'responses', name), bytes); hashes[name] = sha(bytes); rows.push(row);
  }
  const qualifierTotal = cases.flatMap(c => c.atoms).filter(a => a.type === 'qualifier').length;
  const aggregates = [];
  for (const form of ['keywords', 'natural']) for (const budget of [1200, 4000]) {
    const selected = rows.filter(r => r.form === form && r.budget === budget && r.method === 'amp_hybrid_memory');
    aggregates.push({ form, budget, method: 'amp_hybrid_memory', ...aggregate(selected, qualifierTotal) });
  }
  aggregates.push({ form: 'keywords', budget: 4000, method: 'amp_staged', ...aggregate(rows.filter(r => r.method === 'amp_staged'), qualifierTotal) });
  for (const [file, hash] of Object.entries(implementation))
    if (sha(await readFile(`packages/orgbrain-cli/src/lib/${file}`)) !== hash) throw Error('implementation_changed_during_run');
  const result = { schema: 'amp-improved-evaluation/v1', date, out,
    cases_sha256: old.cases_sha256, audit_sha256: old.audit_sha256, baseline_receipt_sha256: old.receipt_sha256,
    engine_sha256: snapshot.engine_sha256, engine_sha256_actual, engine_matches_baseline: engine_sha256_actual === snapshot.engine_sha256, implementation, tokenizer: 'o200k_base', inference_model_calls: 0,
    unseen_evaluation: false, generation_quality_measured: false, aggregates, rows, response_sha256: hashes };
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ out, aggregates }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await evaluate(process.argv[2], process.argv[3]);
