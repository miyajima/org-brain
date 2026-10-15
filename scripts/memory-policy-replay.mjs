#!/usr/bin/env node
// Offline component replay. Never executes a task, discovers transcripts, or contacts a provider.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { policyCases, replayScope, replayTime } from './fixtures/memory-policy-replay.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureHash = sha(await readFile(new URL('./fixtures/memory-policy-replay.mjs', import.meta.url)));
const policy = Object.freeze({ top_k: 3, token_budget: 1800, context_format: 'compact', work_type: 'implementation',
  usage_purpose: 'test', include_domain_recall: false, include_wiki: false });
const runtimeFiles = ['packages/orgbrain-cli/src/lib/local-memory-store.mjs', 'packages/orgbrain-cli/src/local-mcp.mjs',
  'packages/orgbrain-cli/src/lib/compact-memory-context.mjs', 'packages/shared/src/memory-retrieval.ts',
  'packages/shared/src/retrieval-units-core.mjs', 'packages/shared/src/attempt-history-runtime.mjs'];
export function snapshotEvents(events, at = replayTime) {
  if (!Number.isSafeInteger(at) || events.some(event => !Number.isSafeInteger(event.at))) throw new Error('invalid_replay_time');
  return events.filter(event => event.at <= at).sort((a, b) => a.at - b.at);
}
export function assessPolicyCase(fixture, observed) {
  const oracle = fixture.oracle, keys = observed.delivered.map(item => item.fixture_key), failures = [];
  for (const key of oracle.required ?? []) if (!keys.includes(key)) failures.push(`missing:${key}`);
  for (const key of oracle.forbidden ?? []) if (keys.includes(key)) failures.push(`forbidden:${key}`);
  for (const [key, version] of Object.entries(oracle.versions ?? {}))
    if (observed.delivered.find(item => item.fixture_key === key)?.source_version !== version) failures.push(`version:${key}`);
  if (oracle.preferred && (keys.indexOf(oracle.preferred) < 0 || (keys.includes(oracle.over)
    && keys.indexOf(oracle.preferred) > keys.indexOf(oracle.over)))) failures.push('source_priority');
  for (const text of oracle.required_text ?? []) if (!observed.context_text.includes(text)) failures.push('missing_condition');
  for (const text of oracle.forbidden_text ?? []) if (observed.context_text.includes(text)) failures.push('stale_or_future_text');
  if (oracle.decision && observed.preflight?.decision !== oracle.decision) failures.push(`decision:${oracle.decision}`);
  return { passed: failures.length === 0, failures };
}
async function worker(root, variant) {
  if (!['no-memory', 'current', 'improved'].includes(variant)) throw new Error('invalid_replay_variant');
  const directory = await mkdtemp(join(tmpdir(), 'orgbrain-policy-replay-'));
  const oldNow = Date.now, previousFetch = globalThis.fetch;
  const overrides = { ORGBRAIN_WORKSPACES_FILE: join(directory, 'workspaces.json'), ORGBRAIN_FEATURES_FILE: join(directory, 'features.json'),
    ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false', ORGBRAIN_USE_SYNC: 'off',
    ORGBRAIN_USE_CONTEXT: 'off', ORGBRAIN_USE_RANKING: 'off', ORGBRAIN_USE_COLLECT: 'off', ORGBRAIN_USE_PRINCIPAL: replayScope.principal_id };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let networkCalls = 0;
  try {
    Date.now = () => replayTime;
    await writeFile(overrides.ORGBRAIN_WORKSPACES_FILE, '{"version":3,"workspaces":{}}');
    await writeFile(overrides.ORGBRAIN_FEATURES_FILE, '{"features":{"llm_wiki":{"enabled":false,"epoch":0}}}');
    Object.assign(process.env, overrides);
    globalThis.fetch = async () => { networkCalls++; throw new Error('replay_network_forbidden'); };
    const load = file => import(pathToFileURL(join(root, file)).href);
    const { LocalMemoryStore } = await load('packages/orgbrain-cli/src/lib/local-memory-store.mjs');
    const { handleLocalMcpRequest } = await load('packages/orgbrain-cli/src/local-mcp.mjs');
    const { countContextTokens } = await load('packages/orgbrain-cli/src/lib/compact-memory-context.mjs');
    const off = async () => ({ mode: 'off', status: 'disabled', applied: false, decisions: [] });
    const cases = [];
    for (const fixture of policyCases) {
      const store = new LocalMemoryStore(join(directory, `${fixture.id}.sqlite`), { env: {}, denseEmbeddingProvider: null, memoryJudge: off, contextSearchJudge: off });
      await store.init();
      const ids = new Map(), keys = new Map(), events = snapshotEvents(fixture.events);
      // Every condition starts from its own empty DB. No-memory does not seed prior memories or attempts.
      if (variant !== 'no-memory') for (const event of events) {
        if (event.kind === 'capture') {
          const saved = await store.capture({ ...replayScope, source: 'synthetic-policy-fixture', external_key: event.key,
            created_at: event.at, updated_at: event.at, ...event.fields });
          ids.set(event.key, saved.memory_id); keys.set(saved.memory_id, event.key);
        } else if (event.kind === 'revise') await store.revise(replayScope.tenant_id, ids.get(event.key), { ...event.fields, updated_at: event.at });
        else if (event.kind === 'suppress') await store.suppress(replayScope.tenant_id, ids.get(event.key), event.reason);
        else if (event.kind === 'attempt') await store.recordAttempt(replayScope.tenant_id, event.fields, { trusted: event.trusted });
        else throw new Error('unknown_replay_event');
      }
      const result = await handleLocalMcpRequest(store, { method: 'tools/call', params: { name: 'orgbrain_context_enrich',
        arguments: { ...replayScope, ...policy, task_id: `fixture:${fixture.id}`, query: fixture.query } } });
      if (result.isError) throw new Error('policy_retrieval_failed');
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), context = JSON.parse(text);
      const evidenceIds = new Set((context.evidence_bundle?.evidence ?? []).map(item => item.memory_id));
      const delivered = (context.meta?.usage_items ?? []).map(item => ({ ...item, fixture_key: keys.get(item.source_id) ?? 'unknown' }));
      const db = store.open();
      let receiptRows, receiptScope;
      try {
        receiptScope = db.prepare('SELECT tenant_id,project_id,task_id,actor_principal,usage_purpose FROM memory_usage_events WHERE id=?').get(context.meta.usage_id);
        receiptRows = db.prepare(`SELECT i.id,i.source_id,i.source_version,e.task_id,e.project_id,e.usage_purpose FROM memory_usage_items i
          JOIN memory_usage_events e ON e.tenant_id=i.tenant_id AND e.id=i.usage_event_id WHERE e.id=?`).all(context.meta.usage_id);
      }
      finally { db.close(); }
      if (!receiptScope || receiptScope.tenant_id !== replayScope.tenant_id || receiptScope.project_id !== replayScope.project_id
        || receiptScope.actor_principal !== replayScope.principal_id || receiptScope.task_id !== `fixture:${fixture.id}` || receiptScope.usage_purpose !== 'test'
        || receiptRows.length !== delivered.length || delivered.some(item => !evidenceIds.has(item.source_id)
        || !receiptRows.some(row => row.id === item.usage_item_id && row.source_id === item.source_id && row.source_version === item.source_version
          && row.task_id === `fixture:${fixture.id}` && row.project_id === replayScope.project_id && row.usage_purpose === 'test'))) throw new Error('replay_receipt_mismatch');
      const preflight = fixture.action ? await store.preflightAction(replayScope.tenant_id, fixture.action) : null;
      const observed = { id: fixture.id, query_sha256: sha(fixture.query), snapshot_sha256: sha(JSON.stringify(events)),
        applied_event_count: variant === 'no-memory' ? 0 : events.length, excluded_future_events: fixture.events.length - events.length,
        delivered, usage_id: context.meta.usage_id, receipt_scope: receiptScope, context_sha256: sha(text), context_text: text,
        response_tokens: countContextTokens(text), within_budget: countContextTokens(text) <= policy.token_budget,
        preflight: preflight ? { decision: preflight.decision, reason: preflight.reason } : null,
        adopted: { count: null, basis: 'not_observed' }, verified_outcomes: null, actual_task_tokens: null,
        actual_task_time_ms: null, actual_provider_cost: null };
      cases.push({ ...observed, assessment: assessPolicyCase(fixture, observed) });
    }
    const sourceHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, sha(await readFile(join(root, file)))])));
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim());
    return { variant, git_head: gitHead, tracked_dirty: dirty, source_hashes: sourceHashes, fixture_sha256: fixtureHash,
      scope: replayScope, as_of: replayTime, policy, network_calls: networkCalls, provider_calls: 0, cases };
  } finally {
    Date.now = oldNow; globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
}
export async function evaluatePolicyReplay({ currentRoot, improvedRoot }) {
  const variants = {};
  for (const [variant, root] of [['no-memory', currentRoot], ['current', currentRoot], ['improved', improvedRoot]]) {
    variants[variant] = JSON.parse(execFileSync(process.execPath, [import.meta.filename, '--worker', resolve(root), variant],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 2097152 }));
  }
  return { schema: 'memory-policy-replay/v1', session_kind: 'synthetic', fixture_sha256: fixtureHash, node: process.version,
    controls: ['Identical as-of time, query, principal, project, top_k and full-payload token budget.',
      'Independent process and database per variant; independent database per case.',
      'Future source changes and outcomes never enter the replay snapshot.', 'No provider, action execution, transcript discovery, or persistent user configuration.'],
    limitations: ['Invented component fixtures; not actual sessions, held-out quality or measured task success.',
      'Oracle checks measure returned guidance and preflight decisions, not execution, adoption or causal benefit.',
      'No-memory absence of prior guidance is retained as a comparison result, not a task failure.',
      'Synthetic trusted attempt records only test existing verification gates; no real event was authenticated.'],
    actual_task_tokens: null, actual_task_time_ms: null, actual_provider_cost: null, variants };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--worker') console.log(JSON.stringify(await worker(resolve(process.argv[3]), process.argv[4])));
    else {
      const args = process.argv.slice(2), options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--current-root', '--improved-root', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('invalid_arguments');
        options[args[i]] = args[i + 1];
      }
      if (!options['--current-root'] || !options['--improved-root'] || !options['--output']) throw new Error('explicit_roots_and_output_required');
      const report = await evaluatePolicyReplay({ currentRoot: options['--current-root'], improvedRoot: options['--improved-root'] });
      await writeFile(resolve(options['--output']), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ schema: report.schema, session_kind: report.session_kind, fixture_sha256: report.fixture_sha256,
        assessments: Object.fromEntries(Object.entries(report.variants).map(([key, value]) => [key, value.cases.map(item => ({ id: item.id, ...item.assessment }))])), actual_task_benefit: 'unknown' }));
    }
  } catch { console.error(JSON.stringify({ error: 'policy_replay_failed' })); process.exitCode = 1; }
}
