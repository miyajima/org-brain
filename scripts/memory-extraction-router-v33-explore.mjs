import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {hash, POLICY, featureRows, summarize, routeMetrics, selectThresholds, v2Result, compareEvidence, pairedBootstrap} from './memory-extraction-router-v33-core.mjs';
import {collect} from './memory-extraction-router-v33-rereview.mjs';
import {fitScaler, applyScaler} from './memory-extraction-router-v32.mjs';
import {fitWeightedLogistic, scoreRows} from './memory-extraction-router-calibrate.mjs';

export const EXPLORE_POLICY = Object.freeze({
  contract: 'router-v33-exploration/v1', configuration: 'rules', recall_targets: [0.8, 0.9, 0.95, 1],
  candidate_rate_is_gate: false, reference_cap: 0.47, iterations: 4000, learning_rate: 0.12,
  l2: POLICY.l2, outer_folds: 5, inner_folds: 4, bootstrap_repetitions: 2000,
  production_eligible: false, evaluation_kind: 'exploratory_ai_assisted_grouped_oof',
});
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const seal = body => ({...body, content_hash: hash(body)});
const verify = value => {const {content_hash, ...body} = value; if (hash(body) !== content_hash) throw Error('content_hash_mismatch'); return value;};
const save = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const semantic = r => r.review_status === 'accepted' && r.usefulness !== 'excluded';
const sampled = r => r.cohort === 'sampled_development';
const publicRow = ({features: _features, ...row}) => row;
const routes = (rows, d, o) => rows.map(r => ({...r, route: r.hard_excluded ? 'hard_excluded' : r.durable_probability >= d ? 'llm_candidate' : r.operational_probability >= o ? 'operational_history' : 'discard'}));

export function recallThresholds(rows, target) {
  if (!(target > 0 && target <= 1)) throw Error('invalid_recall_target');
  const sample = rows.filter(sampled), sem = sample.filter(semantic);
  if (!sem.some(r => r.usefulness === 'durable_memory') || !sem.some(r => r.usefulness === 'operational_history_only')) throw Error('insufficient_cv_support');
  // Highest feasible threshold minimizes call volume without using outer-fold labels.
  const choices = [...new Set([0, 1 + Number.EPSILON, ...sample.map(r => r.durable_probability)])].sort((a, b) => b - a);
  const durable = choices.find(t => routeMetrics(routes(sem, t, 2)).durable.recall >= target);
  if (durable === undefined) throw Error('inner_recall_target_unreachable');
  const ops = [...new Set([0, 1 + Number.EPSILON, ...sample.map(r => r.operational_probability)])].map(t => {
    const routed = routes(sem, durable, t);
    return {t, metric: routeMetrics(routed).operational, rate: routed.filter(r => r.route === 'operational_history').length / sem.length};
  }).sort((a, b) => (b.metric.f1 ?? 0) - (a.metric.f1 ?? 0) || (b.metric.recall ?? 0) - (a.metric.recall ?? 0) || (b.metric.precision ?? 0) - (a.metric.precision ?? 0) || a.rate - b.rate || b.t - a.t);
  return {durable, operational: ops[0].t};
}

function fit(rows, names, label, l2, iterations) {
  const training = rows.filter(r => semantic(r) && !r.hard_excluded);
  if (!training.some(r => r.usefulness === label) || !training.some(r => r.usefulness !== label)) throw Error('insufficient_cv_support');
  const scaler = fitScaler(training, names);
  const model = fitWeightedLogistic(applyScaler(training, scaler).map(r => ({...r, label: r.usefulness === label})), names, {l2, iterations, learning_rate: EXPLORE_POLICY.learning_rate});
  return {scaler, model, l2, training_group_hash: hash([...new Set(training.map(r => r.group_id))].sort()), training_data_hash: hash(training)};
}
const predict = (rows, names, binary) => scoreRows(applyScaler(rows, binary.scaler), names, binary.model).map(r => r.probability);

function chooseBinary(rows, names, label, assignments, options) {
  const candidates = options.l2.map(l2 => {
    const oof = [];
    for (let fold = 0; fold < 4; fold++) {
      const train = rows.filter(r => assignments[r.group_id] !== fold), validation = rows.filter(r => assignments[r.group_id] === fold);
      if (!validation.length) throw Error('insufficient_cv_support');
      const model = fit(train, names, label, l2, options.iterations), p = predict(validation, names, model);
      oof.push(...validation.map((r, i) => ({...r, probability: p[i]})));
    }
    const evaluated = oof.filter(r => sampled(r) && semantic(r));
    if (!evaluated.length) throw Error('insufficient_cv_support');
    const loss = evaluated.reduce((sum, r) => {
      const p = Math.max(1e-12, Math.min(1 - 1e-12, r.probability));
      return sum - (r.usefulness === label ? Math.log(p) : Math.log(1 - p));
    }, 0) / evaluated.length;
    return {l2, loss, oof};
  }).sort((a, b) => a.loss - b.loss || b.l2 - a.l2);
  return candidates[0];
}

export function trainExploration(cases, annotations, folds, {iterations = EXPLORE_POLICY.iterations, l2 = EXPLORE_POLICY.l2, onFold = () => {}} = {}) {
  const rows = featureRows(cases, annotations, {}, 'rules');
  for (const r of rows) {
    if (!Number.isInteger(folds.outer[r.group_id]) || folds.outer[r.group_id] < 0 || folds.outer[r.group_id] >= 5) throw Error('fold_binding_mismatch');
    for (let f = 0; f < 5; f++) if (folds.outer[r.group_id] !== f && (!Number.isInteger(folds.inner[f]?.[r.group_id]) || folds.inner[f][r.group_id] < 0 || folds.inner[f][r.group_id] >= 4)) throw Error('fold_binding_mismatch');
  }
  const names = Object.keys(rows[0].features).sort(), artifacts = [], all = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = rows.filter(r => folds.outer[r.group_id] !== fold), validation = rows.filter(r => folds.outer[r.group_id] === fold);
    if (!validation.length) throw Error('insufficient_cv_support');
    const d = chooseBinary(training, names, 'durable_memory', folds.inner[fold], {iterations, l2});
    const o = chooseBinary(training, names, 'operational_history_only', folds.inner[fold], {iterations, l2});
    const dp = new Map(d.oof.map(r => [r.case_id, r.probability])), op = new Map(o.oof.map(r => [r.case_id, r.probability]));
    const inner = training.map(r => ({...r, durable_probability: dp.get(r.case_id), operational_probability: op.get(r.case_id)}));
    const model = {feature_names: names, durable: fit(training, names, 'durable_memory', d.l2, iterations), operational: fit(training, names, 'operational_history_only', o.l2, iterations)};
    const thresholds = {reference_cap47: selectThresholds(inner)};
    for (const target of EXPLORE_POLICY.recall_targets) thresholds[`recall${Math.round(target * 100)}`] = recallThresholds(inner, target);
    const p = predict(validation, names, model.durable), q = predict(validation, names, model.operational);
    const scored = validation.map((r, i) => ({...r, durable_probability: p[i], operational_probability: q[i], fold, model_hash: hash(model), training_group_hash: model.durable.training_group_hash}));
    const predictions = Object.fromEntries(Object.entries(thresholds).map(([id, t]) => [id, routes(scored, t.durable, t.operational).map(r => publicRow({...r, thresholds: t}))]));
    artifacts.push({fold, model, model_hash: hash(model), thresholds, inner_loss: {durable: d.loss, operational: o.loss}, inner_metrics: Object.fromEntries(Object.entries(thresholds).map(([id, t]) => [id, summarize(routes(inner.filter(sampled), t.durable, t.operational))]))});
    all.push(predictions); onFold(fold);
  }
  const byPolicy = Object.fromEntries(Object.keys(all[0]).map(id => [id, all.flatMap(f => f[id])]));
  for (const prediction of Object.values(byPolicy)) if (prediction.length !== cases.length || new Set(prediction.map(r => r.case_id)).size !== cases.length) throw Error('incomplete_oof');
  return {policy: {...EXPLORE_POLICY, iterations, l2}, fold_artifacts: artifacts, by_policy: byPolicy, final_model_created: false};
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['scripts/memory-extraction-router-v33-explore.mjs', 'scripts/memory-extraction-router-v33-rereview.mjs', 'scripts/memory-extraction-router-v33-core.mjs', 'scripts/memory-extraction-router-v32.mjs', 'scripts/memory-extraction-router-calibrate.mjs', 'packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs', 'packages/orgbrain-cli/src/lib/memory-extraction-router-model-v2.mjs'];
function reviewed(manifest) {
  const r = collect(manifest), p = path.join(r.root, 'final', 'labels.json'), labels = verify(read(p));
  if (r.missing.length || r.summary.remaining_format_repairs || labels.manifest_hash !== r.n.content_hash || hash(labels.annotations) !== hash(r.annotations)) throw Error('final_review_binding_mismatch');
  return {...r, labels, label_path: p};
}
export function prepareExploration(reviewManifest, out) {
  const r = reviewed(reviewManifest);
  const manifest = seal({contract: EXPLORE_POLICY.contract, created_at: new Date().toISOString(), policy: EXPLORE_POLICY,
    review_manifest: path.resolve(reviewManifest), review_manifest_hash: r.n.content_hash, labels_hash: r.labels.content_hash,
    source_manifest_hash: r.m.manifest_hash, input_hash: r.m.input_hash, folds_hash: hash(r.m.folds), support: r.summary.support,
    configurations_not_run: {embedding_mean: 'no_saved_cloud_vectors; external_calls_not_authorized', combined_mean: 'no_saved_cloud_vectors; external_calls_not_authorized', combined_role: 'no_saved_cloud_vectors; external_calls_not_authorized'},
    source_files: Object.fromEntries(sources.map(p => [path.join(rootDir, p), hash(fs.readFileSync(path.join(rootDir, p), 'utf8'))])),
    production_eligible: false, old_gate_status: r.summary.status, writes: 'new_run_only'});
  fs.mkdirSync(out, {mode: 0o700}); save(path.join(out, 'manifest.json'), manifest);
  return {manifest: path.join(out, 'manifest.json')};
}

function render(summary) {
  const percent = n => n === null ? '未定義' : (100 * n).toFixed(1) + '%';
  const table = cohort => Object.entries(summary.metrics).map(([id, m]) => {
    const s = m[cohort]; return `| ${id} | ${percent(s.semantic.durable.recall)} | ${percent(s.semantic.operational.f1)} | ${percent(s.all_case_call_rate)} | ${percent(s.semantic.call_rate)} | ${percent(s.conservative.durable_recall)} | ${percent(s.conservative.operational_f1)} |`;
  }).join('\n');
  const header = '| 設定 | 耐久Recall | 運用F1 | 全件候補率 | semantic候補率 | 保留込みRecall下限 | 保留込み運用F1下限 |\n|---|---:|---:|---:|---:|---:|---:|';
  return `# Router v3.3 探索比較\n\n状態: exploratory_complete。正式な品質ゲート通過ではない。\n\n## 対象と方法\n\n同じ120件、固定group/fold、新revisionの確定ラベルだけを学習に使用。sampled developmentは80件中67確定（semantic 66）、13保留。challengeは40件中31確定。旧72件支持条件は未達のまま保持。\n\n既存rules特徴量・weighted logistic、外側5-fold／内側4-fold。L2選択・標準化・閾値は学習側のみ。閾値選択の主対象は内側sampled development OOF。運用F1は耐久への誤送信をFNに数える。recall95等の名前は内側目標で、外側の達成保証ではない。外側結果で設定を選び直さず、事前固定した全設定を掲載する。v2は同じ本文・新ラベルで再計算した凍結済みの参照モデルであり、未閲覧の独立baselineではない。\n\n## 追加80件\n\n${header}\n${table('sampled')}\n\n## challenge 40件（主指標と混ぜない）\n\n${header}\n${table('challenge')}\n\n## 解釈と限界\n\n候補率47%は探索側の合否条件から外し、参照設定として残した。旧計画・旧結果・通常Routerの閾値は変更していない。保留例も全件候補率の分母に含める。semanticはacceptedかつ非excluded。率の小さい分母に注意し、AI補助開発評価を人手独立評価や本番品質の保証と呼ばない。\n\n各設定のv2差のgroup単位paired bootstrap 2,000回・95%区間はsummary.jsonに保存。固定OOF予測の条件付き不確実性であり、再学習のばらつきや複数設定比較を補正しない。根拠評価は同一入力でpacker単体と経路全体を分離しevidence.jsonへ保存。LLM出力の根拠検証ではない。\n\n埋め込み3構成は保存済みvectorがなく未実施。外部API、ローカル埋め込み生成、LLM抽出は0。token量・費用・Safetyの再測定は未実施。所要時間 ${summary.elapsed_ms} msは今回のローカル探索処理のみ。\n\n既定v2・UI回答・旧成果物・DB・本番は変更なし。最終配備モデルは作らない。成果物は非公開ローカル領域へ保存。\n`;
}
export function runExploration(manifestPath, onFold) {
  const n = verify(read(manifestPath));
  if (n.contract !== EXPLORE_POLICY.contract || hash(n.policy) !== hash(EXPLORE_POLICY) || n.production_eligible !== false) throw Error('exploration_contract_mismatch');
  const r = reviewed(n.review_manifest);
  if (n.review_manifest_hash !== r.n.content_hash || n.labels_hash !== r.labels.content_hash || n.source_manifest_hash !== r.m.manifest_hash || n.input_hash !== r.m.input_hash || n.folds_hash !== hash(r.m.folds)) throw Error('exploration_source_changed');
  for (const [p, h] of Object.entries(n.source_files)) if (hash(fs.readFileSync(p, 'utf8')) !== h) throw Error('exploration_code_changed');
  const out = path.join(path.dirname(path.resolve(manifestPath)), 'result');
  fs.mkdirSync(out, {mode: 0o700}); // Exclusive execution claim. Never replace a completed or failed run.
  const started = performance.now();
  try {
    const training = trainExploration(r.m.cases, r.labels.annotations, r.m.folds, {onFold});
    const baseFeatures = featureRows(r.m.cases, r.labels.annotations, {}, 'rules');
    const baseline = baseFeatures.map((row, i) => publicRow({...row, route: v2Result(r.m.cases[i]).route}));
    const policies = {v2_reference: baseline, ...training.by_policy};
    const metrics = Object.fromEntries(Object.entries(policies).map(([id, rows]) => [id, {sampled: summarize(rows.filter(sampled)), challenge: summarize(rows.filter(r => !sampled(r)))}]));
    const bootstrap = Object.fromEntries(Object.entries(training.by_policy).map(([id, rows]) => [id, pairedBootstrap(rows.filter(sampled), baseline.filter(sampled), EXPLORE_POLICY.bootstrap_repetitions)]));
    const evidence = Object.fromEntries(Object.entries(training.by_policy).map(([id, rows]) => [id, compareEvidence(r.m.cases.filter(sampled), r.labels.annotations, rows.filter(sampled))]));
    const summary = {status: 'exploratory_complete', old_support_gate_passed: r.summary.support.pass, support: r.summary.support, metrics, bootstrap, elapsed_ms: Math.round(performance.now() - started), policy: EXPLORE_POLICY, configurations_not_run: n.configurations_not_run, external_calls: 0, production_eligible: false, final_model_created: false};
    save(path.join(out, 'training.json'), seal(training)); save(path.join(out, 'v2-reference.json'), seal({rows: baseline}));
    save(path.join(out, 'evidence.json'), seal(evidence)); save(path.join(out, 'summary.json'), seal(summary));
    fs.writeFileSync(path.join(out, 'report.md'), render(summary), {flag: 'wx', mode: 0o600});
    return {output: out, metrics, elapsed_ms: summary.elapsed_ms};
  } catch (e) {save(path.join(out, 'error.json'), {status: 'exploration_failed', reason: e.message}); throw e;}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {values: v, positionals: [cmd]} = parseArgs({allowPositionals: true, options: {manifest: {type: 'string'}, out: {type: 'string'}}});
    if (!v.manifest) throw Error('manifest_required');
    if (cmd === 'prepare' && v.out) console.log(JSON.stringify(prepareExploration(v.manifest, v.out)));
    else if (cmd === 'run') console.log(JSON.stringify(runExploration(v.manifest, fold => console.error(JSON.stringify({completed_outer_fold: fold})))));
    else throw Error('invalid_command');
  } catch (e) {console.error(JSON.stringify({error: e.code ?? e.message})); process.exitCode = 1;}
}
