// Offline diagnostic only: synthetic data, no model calls or persistent user DB.
// Usage: node offline-probe.mjs <preserved-source-root> <new-output-directory>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const sourceRoot = resolve(process.argv[2]);
const outputDirectory = resolve(process.argv[3]);
await mkdir(outputDirectory); // Refuse an existing run directory.
process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY = '0';
process.env.MEMORY_CLASSIFICATION_MODE = 'optional';
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts += 1;
  throw new Error('Network is forbidden in this offline diagnostic');
};
const sourcePaths = {
  store: 'packages/orgbrain-cli/src/lib/local-memory-store.mjs',
  mcp: 'packages/orgbrain-cli/src/local-mcp.mjs',
  disposition: 'packages/shared/src/evidence-disposition.mjs',
  units: 'packages/orgbrain-cli/src/lib/retrieval-units.mjs',
  embedding: 'packages/orgbrain-cli/src/lib/local-embedding.mjs'
};
const { LocalMemoryStore } = await import(pathToFileURL(join(sourceRoot, sourcePaths.store)));
const { handleLocalMcpRequest } = await import(pathToFileURL(join(sourceRoot, sourcePaths.mcp)));
const require = createRequire(join(sourceRoot, 'packages/orgbrain-cli/package.json'));
const { getEncoding } = require('js-tiktoken');
const encoding = getEncoding('o200k_base');
const count = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { utf16_code_units: text.length, utf8_bytes: Buffer.byteLength(text), o200k_base_tokens: encoding.encode(text).length };
};
const write = (name, value) => writeFile(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'orgbrain-task-accel-diagnostic-'));
const started = performance.now();
const capturedAt = Date.now();
const fixtures = [];
const base = (key, project, content, extra = {}) => ({
  tenant_id: 'offline-evaluation', project_id: project, kind: 'decision',
  lifecycle_state: 'active', scope_type: 'project', scope_key: project,
  content, summary: content.split('\n')[0], tags: ['synthetic-diagnostic'],
  entities: [], source: 'offline-synthetic', external_key: key,
  actor_type: 'principal', actor_id: 'fixture-author',
  valid_from: null, valid_until: null, confidence_score: 0.95, utility_score: 0.9,
  rationale: '検証専用の合成記録。実プロジェクトの判断ではない。',
  reuse_rule: 'この合成検証内のみで使用する。現在のコードや環境の成功は証明しない。',
  source_references: [{ type: 'file', ref: `fixture://${key}`, captured_at: capturedAt }],
  evidence: [], conflicts: [], permissions: [], ...extra
});
fixtures.push(base('short-record', 'short', '決済バッチのDB接続枯渇は、worker数とpool上限の組み合わせを確認する。\n設定場所は架空のconfig/pool.ts。増設だけを先に試す方法は採用しなかった。'));
for (let i = 0; i < 20; i += 1) {
  const logs = Array.from({ length: 60 }, (_, j) => `警告 ${i}-${j}: 決済バッチの並列実行でDB接続待ちが発生。pool上限、worker数、接続解放のタイミングを記録する。`).join('\n');
  fixtures.push(base(`pool-log-${i}`, 'pool', `決済バッチのDB接続枯渇の調査記録 ${i}。\n過去の方針: worker数とpool上限を同時に確認する。\n${logs}`));
}
fixtures.push(base('acl-public', 'acl', '接続監視の公開手順。DB接続待ちの件数を確認する。'));
fixtures.push(base('acl-private', 'acl', '接続監視の制限手順。PRIVATE_FIXTURE_MARKER。DB接続待ちを確認する。', {
  permissions: [{ principal_type: 'principal', principal_id: 'different-reader', permissions: ['read'] }]
}));
fixtures.push(base('acl-expired', 'acl', '接続監視の期限切れ手順。EXPIRED_FIXTURE_MARKER。DB接続待ちを確認する。', {
  valid_until: capturedAt - 60000
}));
fixtures.push(base('old-success', 'freshness', 'worker.tsの旧版で、Node 22と設定Aを使ったテストは成功した。\nコード識別子はold-code。現在のNode 24と設定Bでの結果は未確認。', {
  reuse_rule: 'worker.tsの内容、Node 22、設定Aが同一のときだけ参考にする。',
  source_references: [{ type: 'file', ref: 'fixture://unavailable-old-test-log', captured_at: capturedAt - 86400000 }]
}));
await write('fixtures.json', fixtures);
const store = new LocalMemoryStore(join(temporaryDirectory, 'synthetic.sqlite'), { denseEmbeddingProvider: null });
const scenarios = [
  { id: 'short', project: 'short', query: '決済バッチを並列実行するとDB接続が枯渇する。設定場所と過去の対応方針を確認したい。' },
  { id: 'long-related', project: 'pool', query: '決済バッチを並列実行するとDB接続が枯渇する。poolとworkerの設定で過去に確認した点を調べたい。' },
  { id: 'irrelevant-new-task', project: 'pool', query: 'OpenTypeフォントの合字描画機能を新規実装したい。適用できる過去の判断はあるか。' },
  { id: 'acl-expiry', project: 'acl', query: '接続監視でDB接続待ちを確認する手順を知りたい。' },
  { id: 'changed-environment', project: 'freshness', query: 'worker.tsを変更してNode 24と設定Bに移した。過去のテスト成功をそのまま今回の確認に使えるか。' }
];
const observations = [];
try {
  await store.init();
  for (const fixture of fixtures) await store.capture(fixture);
  const fixtureSetupMs = performance.now() - started;
  for (const scenario of scenarios) {
    const input = {
      tenant_id: 'offline-evaluation', project_id: scenario.project,
      principal_id: 'reader', query: scenario.query,
      top_k: 3, token_budget: 1200, search_mode: 'hybrid_v4'
    };
    assert.equal(Object.hasOwn(input, 'single_record'), false);
    const callStarted = performance.now();
    const response = await handleLocalMcpRequest(store, {
      method: 'tools/call', params: { name: 'orgbrain_memory_retrieve_context', arguments: input }
    });
    const handlerElapsedMs = performance.now() - callStarted;
    assert.equal(Boolean(response.isError), false);
    const bodyText = response.content[0].text;
    const body = JSON.parse(bodyText);
    const bundle = body.evidence_bundle;
    await write(`${scenario.id}.json`, { input, response });
    observations.push({
      id: scenario.id, query: scenario.query, input,
      handler_elapsed_ms_single_observation: handlerElapsedMs,
      requested_top_k: input.top_k, returned_result_count: body.results.length,
      evidence_count: bundle.evidence.length,
      evidence_status: bundle.evidence_status, abstention_recommended: bundle.abstention_recommended,
      missing_evidence: bundle.missing_evidence, degraded_reasons: bundle.degraded_reasons,
      advertised_token_budget: bundle.token_budget,
      advertised_estimated_tokens: bundle.estimated_tokens,
      full_tool_text: count(bodyText),
      evidence_text_only: count(bundle.evidence.map((item) => item.text).join('\n')),
      evidence_bundle_json: count(bundle),
      results_json: count(body.results),
      current_state_json: count(bundle.current_state),
      summaries: body.results.slice(0, 3).map((item) => item.memory.summary),
      private_marker_returned: bodyText.includes('PRIVATE_FIXTURE_MARKER'),
      expired_marker_returned: bodyText.includes('EXPIRED_FIXTURE_MARKER'),
      source_reference_fields: bundle.evidence.map((item) => ({ ref: item.source_reference?.ref, span: item.source_span })),
      result_record_fields: Object.keys(body.results[0]?.memory ?? {})
    });
  }
  const hashes = {};
  for (const [name, relativePath] of Object.entries(sourcePaths)) {
    hashes[name] = { path: join(sourceRoot, relativePath), sha256: createHash('sha256').update(await readFile(join(sourceRoot, relativePath))).digest('hex') };
  }
  await write('observations.json', {
    kind: 'offline-synthetic-contract-diagnostic-not-agent-benchmark',
    source_root: sourceRoot, runtime: process.version, node_platform: process.platform,
    created_at: new Date().toISOString(), source_files: hashes,
    fixture_count: fixtures.length, fixture_setup_ms: fixtureSetupMs,
    model_calls: 0, live_orgbrain_api_calls: 0, fetch_attempts: fetchAttempts,
    mcp_transport_verified: false,
    model_usage_input_tokens: null, model_usage_output_tokens: null,
    tokenizer: 'js-tiktoken 1.0.21 / o200k_base',
    tokenizer_limit: 'Counts the emitted text under this encoding only. Not Codex/Claude model usage, billing, or a client truncation measurement.',
    timing_limit: 'One handler observation per distinct input, after fixture setup. Not latency distribution or task completion time.',
    observations
  });
  assert.equal(fetchAttempts, 0);
  console.log(JSON.stringify({ fixture_count: fixtures.length, observations: observations.map(({ id, returned_result_count, evidence_count, advertised_estimated_tokens, full_tool_text, evidence_text_only, evidence_bundle_json, evidence_status, abstention_recommended, private_marker_returned, expired_marker_returned }) => ({ id, returned_result_count, evidence_count, advertised_estimated_tokens, full_tool_text, evidence_text_only, evidence_bundle_json, evidence_status, abstention_recommended, private_marker_returned, expired_marker_returned })), outputDirectory }, null, 2));
} finally {
  // Remove only the fresh synthetic fixture directory allocated above.
  await rm(temporaryDirectory, { recursive: true, force: true });
}
