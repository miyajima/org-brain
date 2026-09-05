import {
  routerHash, sha256, buildLineageGroups, fitScaler, applyScaler,
  calculateV32EvidenceMetrics, packV32Evidence, rankV32EvidenceSpans,
} from './memory-extraction-router-v32.mjs';
import { fitWeightedLogistic, scoreRows } from './memory-extraction-router-calibrate.mjs';
import {
  extractMemoryRouterFeatures, routeTurnEvidence, routeTurnEvidenceV3,
  buildLearningExtractionPacket,
} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import { MEMORY_EXTRACTION_ROUTER_MODEL_V2 } from '../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v2.mjs';
import { sanitizeMemoryExtractionReviewCase, MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT } from '../packages/shared/src/memory-extraction-review-text-runtime.mjs';

export const CONFIGURATIONS = ['rules', 'embedding_mean', 'combined_mean', 'combined_role'];
export const POLICY = Object.freeze({ seed: 'router-v33-cv-v1', sample_seed: 'router-v33-sample-v1', outer_folds: 5, inner_folds: 4, call_cap: 0.47, iterations: 4000, learning_rate: 0.12, l2: [0.04, 0.08, 0.16, 0.32, 1, 4] });
export const MANIFEST_CONTRACT = 'memory-extraction-router-v33-manifest/v1';
export const hash = routerHash;
const semantic = row => row.review_status === 'accepted' && row.usefulness !== 'excluded';
const sampled = row => row.cohort === 'sampled_development';
const ratio = (a, b) => b ? a / b : null;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function evidenceFor(item) {
  return { schema: 'turn-evidence/v1', snippets: item.turns.map(t => ({ span_id: t.id, role: t.role, text: t.content })), events: [], session_hash: item.session_hash, turn_hash: item.source_hash };
}
export function safetyFor(item) { return routeTurnEvidenceV3(evidenceFor(item)); }
export function safetySplitAudit(fixture) {
  const families = new Map(), texts = new Map();
  for (const row of fixture.cases) {
    const text = row.text.normalize('NFKC').toLowerCase().replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();
    for (const [map, key] of [[families, row.family], [texts, text]]) {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(row.phase);
    }
  }
  const family_overlap = [...families.values()].filter(s => s.size > 1).length;
  const masked_text_overlap = [...texts.values()].filter(s => s.size > 1).length;
  if (family_overlap || masked_text_overlap) throw new Error('safety_split_overlap');
  return { family_overlap, masked_text_overlap };
}

export function foldsFor(cases, count, seed) {
  const groups = [...new Set(cases.map(c => c.group_id))];
  if (groups.some(g => !g) || groups.length < count) throw new Error('insufficient_cv_support');
  groups.sort((a, b) => cmp(sha256(`${seed}:${a}`), sha256(`${seed}:${b}`)) || cmp(a, b));
  return Object.fromEntries(groups.map((g, i) => [g, i % count]));
}

export function prepareCases(sourceCases, challengeBundle, legacyManifest) {
  if (legacyManifest.dataset_role !== 'development' || legacyManifest.case_count !== 500 || sourceCases.length !== 500) throw new Error('development_source_500_required');
  if (new Set(sourceCases.map(c => c.id)).size !== 500 || challengeBundle.cases?.length !== 40 || new Set(challengeBundle.cases.map(c => c.id)).size !== 40) throw new Error('case_count_or_duplicate');
  const records = new Map(legacyManifest.case_records.map(r => [r.id, r]));
  const groups = buildLineageGroups(sourceCases);
  for (const c of sourceCases) {
    const r = records.get(c.id);
    if (c.dataset_role === 'final_holdout' || !r || r.dataset_role !== 'development') throw new Error('holdout_or_unknown_source');
    if (hash(c.turns) !== c.source_hash || r.source_hash !== c.source_hash || r.group_id !== groups.get(c.id)) throw new Error('source_or_group_hash_mismatch');
    if (r.review_text_hash !== hash(sanitizeMemoryExtractionReviewCase(c).turns)) throw new Error('sanitizer_hash_mismatch');
  }
  const challengeIds = new Set(challengeBundle.cases.map(c => c.id));
  for (const c of challengeBundle.cases) {
    const r = records.get(c.id);
    if (!r || c.source_hash !== r.source_hash || hash(c.turns) !== r.review_text_hash || c.group_id !== r.group_id) throw new Error('challenge_source_mismatch');
  }
  const challengeGroups = new Set([...challengeIds].map(id => groups.get(id)));
  const eligible = sourceCases.filter(c => !challengeGroups.has(groups.get(c.id)))
    .sort((a, b) => cmp(sha256(`${POLICY.sample_seed}:${a.id}`), sha256(`${POLICY.sample_seed}:${b.id}`)) || cmp(a.id, b.id));
  const counts = new Map();
  const added = [];
  for (const c of eligible) {
    const g = groups.get(c.id);
    if ((counts.get(g) ?? 0) >= 2) continue;
    added.push(c); counts.set(g, (counts.get(g) ?? 0) + 1);
    if (added.length === 80) break;
  }
  if (added.length !== 80) throw new Error(`insufficient_sample_groups:${added.length}/80`);
  const all = [...sourceCases.filter(c => challengeIds.has(c.id)).sort((a, b) => cmp(a.id, b.id)), ...added];
  return all.map(c => {
    const clean = sanitizeMemoryExtractionReviewCase(c);
    const safety = safetyFor(c);
    return {
      id: c.id, source_hash: c.source_hash, review_text_hash: hash(clean.turns),
      sanitizer: MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT, turns: clean.turns,
      group_id: groups.get(c.id), session_hash: c.session_hash ?? null,
      dataset_role: 'development', cohort: challengeIds.has(c.id) ? 'challenge' : 'sampled_development',
      prior_ai_exposure: challengeBundle.cases.find(x => x.id === c.id)?.prior_ai_exposure ?? c.prior_ai_exposure ?? (c.model_prediction ? 'ai_assisted' : 'unknown'),
      legacy_exposure_preserved: true,
      hard_excluded: safety.primary_route === 'hard_excluded' || safetyFor(clean).primary_route === 'hard_excluded',
      safety_reason_codes: [...new Set([...(safety.reason_codes ?? []), ...(safetyFor(clean).reason_codes ?? [])])],
    };
  });
}

export function createManifest(cases, { experimentId, sources, fixtureHash }) {
  if (!experimentId || cases.length !== 120) throw new Error('experiment_identity');
  const outer = foldsFor(cases, 5, POLICY.seed);
  const inner = {};
  for (let i = 0; i < 5; i++) inner[i] = foldsFor(cases.filter(c => outer[c.group_id] !== i), 4, `${POLICY.seed}:inner:${i}`);
  inner.final = foldsFor(cases, 4, `${POLICY.seed}:inner:final`);
  const m = { contract: MANIFEST_CONTRACT, experiment_id: experimentId, dataset_role: 'development', evaluation_kind: 'ai_assisted_development', production_eligible: false, sources, cases, input_hash: hash(cases), policy: POLICY, folds: { outer, inner }, fixture_hash: fixtureHash };
  return { ...m, manifest_hash: hash(m) };
}
export function validateManifest(m) {
  if (m?.contract !== MANIFEST_CONTRACT || m.dataset_role !== 'development' || m.production_eligible !== false) throw new Error('development_manifest_required');
  const { manifest_hash, ...body } = m;
  if (hash(body) !== manifest_hash || hash(m.cases) !== m.input_hash || hash(m.policy) !== hash(POLICY)) throw new Error('manifest_hash_mismatch');
  if (m.cases.length !== 120 || new Set(m.cases.map(c => c.id)).size !== 120 || m.cases.filter(sampled).length !== 80) throw new Error('manifest_case_count');
  for (const c of m.cases) {
    if (c.dataset_role !== 'development' || hash(c.turns) !== c.review_text_hash) throw new Error('case_input_mismatch');
  }
  const challengeGroups = new Set(m.cases.filter(c => c.cohort === 'challenge').map(c => c.group_id));
  const counts = new Map();
  for (const c of m.cases.filter(sampled)) {
    if (challengeGroups.has(c.group_id)) throw new Error('cohort_group_overlap');
    counts.set(c.group_id, (counts.get(c.group_id) ?? 0) + 1);
  }
  if ([...counts.values()].some(n => n > 2)) throw new Error('sample_group_limit');
  const reconstructed = createManifest(m.cases, { experimentId: m.experiment_id, sources: m.sources, fixtureHash: m.fixture_hash });
  if (hash(reconstructed.folds) !== hash(m.folds)) throw new Error('fold_binding_mismatch');
  return m;
}

export function consensus(item, sol, luna) {
  const agree = sol?.review_status === 'accepted' && luna?.review_status === 'accepted' && sol.usefulness === luna.usefulness;
  return {
    ...(agree ? sol : { usefulness: null, evidence_spans: [], future_use: '', lesson_types: [] }),
    case_id: item.id, source_hash: item.source_hash, review_text_hash: item.review_text_hash,
    revision_id: `${item.id}:v33:${hash({ sol, luna }).slice(7, 23)}`,
    review_status: agree ? 'accepted' : 'uncertain', label_origin: 'ai_assisted',
    prior_ai_exposure: item.prior_ai_exposure, review_models: ['gpt-5.6-sol/high', 'gpt-5.6-luna/max'],
    review_hashes: { sol: hash(sol ?? null), luna: hash(luna ?? null) },
    reason: agree ? 'two_valid_agree' : 'disagreement_or_invalid_review',
  };
}

export function supportSummary(cases, annotations) {
  const rows = cases.filter(sampled).map(c => ({ ...c, ...annotations[c.id] }));
  const accepted = rows.filter(r => r.review_status === 'accepted');
  const durable = accepted.filter(r => r.usefulness === 'durable_memory').length;
  const operational = accepted.filter(r => r.usefulness === 'operational_history_only').length;
  const groups = new Set(accepted.map(r => r.group_id)).size;
  const semanticCount = accepted.filter(r => r.usefulness !== 'excluded').length;
  return { accepted: accepted.length, total: rows.length, durable, operational, groups, semantic_cases: semanticCount, maximum_durable_recall_at_cap: ratio(Math.min(durable, Math.floor(POLICY.call_cap * semanticCount)), durable), pass: rows.length === 80 && accepted.length >= 72 && durable >= 20 && operational >= 20 && groups >= 30 };
}

const projectionCache = new Map();
export function projection(channel, dimensions) {
  const key = `${channel}:${dimensions}`;
  if (!projectionCache.has(key)) {
    const matrix = Array.from({ length: dimensions }, (_, j) => Array.from({ length: 1024 }, (_, i) => (parseInt(sha256(`router-v33-projection-v1:${channel}:${i}:${j}`).slice(7, 9), 16) & 1 ? 1 : -1) / Math.sqrt(dimensions)));
    projectionCache.set(key, { matrix, hash: hash(matrix) });
  }
  return projectionCache.get(key);
}
function projected(vector, channel, n) {
  if (!Array.isArray(vector) || vector.length !== 1024 || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) throw new Error('embedding_vector_invalid');
  return Object.fromEntries(projection(channel, n).matrix.map((row, j) => [`${channel}_${j}`, row.reduce((s, v, i) => s + v * vector[i], 0)]));
}
export function channelText(item, role = null) {
  return item.turns.filter(t => role === null || t.role === role).map(t => `[${t.role}]\n${t.content}`).join('\n\n');
}
export function featureRows(cases, annotations, embeddings, config) {
  if (!CONFIGURATIONS.includes(config)) throw new Error('unknown_configuration');
  return cases.map(item => {
    if (item.dataset_role !== 'development') throw new Error('holdout_training_forbidden');
    const a = annotations[item.id];
    if (!a || a.case_id !== item.id || a.review_text_hash !== item.review_text_hash || a.source_hash !== item.source_hash || a.label_origin !== 'ai_assisted') throw new Error('annotation_binding_mismatch');
    const rules = extractMemoryRouterFeatures(evidenceFor(item), { version: 'v3' });
    const features = config === 'embedding_mean' ? {} : { ...rules };
    if (config !== 'rules') {
      for (const channel of config === 'combined_role' ? ['user', 'assistant'] : ['all']) {
        const n = channel === 'all' ? 64 : 32;
        const text = channelText(item, channel === 'all' ? null : channel);
        const present = Boolean(text.trim());
        if (channel !== 'all') features[`has_${channel}`] = Number(present);
        if (!present || item.hard_excluded) {
          for (let i = 0; i < n; i++) features[`${channel}_${i}`] = 0;
          continue;
        }
        const e = embeddings[item.id]?.[channel];
        if (!e || e.input_hash !== hash(text) || e.vector_hash !== hash(e.vector) || e.model !== 'text-embedding-3-large' || e.dimensions !== 1024) throw new Error('embedding_binding_mismatch');
        Object.assign(features, projected(e.vector, channel, n));
      }
    }
    return { case_id: item.id, group_id: item.group_id, cohort: item.cohort, dataset_role: item.dataset_role, prior_ai_exposure: item.prior_ai_exposure, source_hash: item.source_hash, review_text_hash: item.review_text_hash, revision_id: a.revision_id, review_status: a.review_status, usefulness: a.usefulness, hard_excluded: item.hard_excluded, features };
  });
}

export function routeMetrics(rows) {
  function confusion(label, route) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
      if (r.usefulness === label) { if (r.route === route) tp++; else fn++; }
      else if (r.route === route) fp++; else tn++;
    }
    return { tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn) };
  }
  return { cases: rows.length, durable: confusion('durable_memory', 'llm_candidate'), operational: confusion('operational_history_only', 'operational_history'), call_rate: ratio(rows.filter(r => r.route === 'llm_candidate').length, rows.length) };
}
export function summarize(rows) {
  const accepted = rows.filter(r => r.review_status === 'accepted');
  const metrics = routeMetrics(rows.filter(semantic));
  const u = rows.filter(r => r.review_status !== 'accepted');
  const d = metrics.durable, o = metrics.operational;
  return { all: routeMetrics(accepted), semantic: metrics, total_cases: rows.length, uncertain: u.length, all_case_call_rate: ratio(rows.filter(r => r.route === 'llm_candidate').length, rows.length), conservative: { durable_recall: ratio(d.tp, d.tp + d.fn + u.filter(r => r.route !== 'llm_candidate').length), operational_f1: ratio(2 * o.tp, 2 * o.tp + o.fp + o.fn + u.length) } };
}
const callFeasible = rows => {
  const m = summarize(rows);
  return m.all_case_call_rate !== null && m.semantic.call_rate !== null && m.all_case_call_rate <= POLICY.call_cap && m.semantic.call_rate <= POLICY.call_cap;
};
function routeScored(rows, durable, operational) {
  return rows.map(r => ({ ...r, route: r.hard_excluded ? 'hard_excluded' : r.durable_probability >= durable ? 'llm_candidate' : r.operational_probability >= operational ? 'operational_history' : 'discard' }));
}
export function selectThresholds(rows) {
  const target = rows.filter(sampled);
  if (!target.filter(semantic).some(r => r.usefulness === 'durable_memory') || !target.filter(semantic).some(r => r.usefulness === 'operational_history_only')) throw new Error('insufficient_cv_support');
  const choices = [...new Set([0, 1 + Number.EPSILON, ...target.map(r => r.durable_probability)])].map(threshold => {
    const routed = routeScored(target, threshold, 1 + Number.EPSILON);
    return { threshold, rows: routed, metrics: routeMetrics(routed.filter(semantic)).durable };
  }).filter(c => callFeasible(c.rows)).sort((a, b) => (b.metrics.recall ?? 0) - (a.metrics.recall ?? 0) || (b.metrics.f1 ?? 0) - (a.metrics.f1 ?? 0) || (b.metrics.precision ?? 0) - (a.metrics.precision ?? 0) || b.threshold - a.threshold);
  if (!choices.length) throw new Error('no_feasible_configuration');
  const durable = choices[0].threshold;
  const operationalChoices = [...new Set([0, 1 + Number.EPSILON, ...target.map(r => r.operational_probability)])].map(threshold => {
    const routed = routeScored(target, durable, threshold);
    const sem = routed.filter(semantic);
    return { threshold, metrics: routeMetrics(sem).operational, output_rate: sem.filter(r => r.route === 'operational_history').length / sem.length };
  }).sort((a, b) => (b.metrics.f1 ?? 0) - (a.metrics.f1 ?? 0) || (b.metrics.recall ?? 0) - (a.metrics.recall ?? 0) || (b.metrics.precision ?? 0) - (a.metrics.precision ?? 0) || a.output_rate - b.output_rate || b.threshold - a.threshold);
  return { durable, operational: operationalChoices[0].threshold };
}

function binaryFit(rows, featureNames, label, l2, options) {
  const training = rows.filter(r => semantic(r) && !r.hard_excluded);
  if (!training.some(r => r.usefulness === label) || !training.some(r => r.usefulness !== label)) throw new Error('insufficient_cv_support');
  const scaler = fitScaler(training, featureNames);
  const model = fitWeightedLogistic(applyScaler(training, scaler).map(r => ({ ...r, label: r.usefulness === label })), featureNames, { l2, iterations: options.iterations, learning_rate: POLICY.learning_rate });
  return { scaler, model, l2, training_groups_hash: hash([...new Set(training.map(r => r.group_id))].sort()), training_data_hash: hash(training) };
}
function binaryPredict(rows, names, binary) { return scoreRows(applyScaler(rows, binary.scaler), names, binary.model).map(r => r.probability); }
function logLoss(rows, label) {
  const evalRows = rows.filter(r => sampled(r) && semantic(r));
  if (!evalRows.length) throw new Error('insufficient_cv_support');
  return evalRows.reduce((sum, r) => { const p = Math.max(1e-12, Math.min(1 - 1e-12, r.probability)); return sum - (r.usefulness === label ? Math.log(p) : Math.log(1 - p)); }, 0) / evalRows.length;
}
function chooseBinary(rows, names, label, assignments, options) {
  const choices = options.l2.map(l2 => {
    const oof = [];
    for (let f = 0; f < 4; f++) {
      const training = rows.filter(r => assignments[r.group_id] !== f);
      const validation = rows.filter(r => assignments[r.group_id] === f);
      if (!validation.length) throw new Error('insufficient_cv_support');
      const binary = binaryFit(training, names, label, l2, options);
      const p = binaryPredict(validation, names, binary);
      oof.push(...validation.map((r, i) => ({ ...r, probability: p[i] })));
    }
    return { l2, oof, loss: logLoss(oof, label) };
  }).sort((a, b) => a.loss - b.loss || b.l2 - a.l2);
  return choices[0];
}
function fitConfiguration(rows, config, assignments, options) {
  const names = Object.keys(rows[0].features).sort();
  const d = chooseBinary(rows, names, 'durable_memory', assignments, options);
  const o = chooseBinary(rows, names, 'operational_history_only', assignments, options);
  const dp = new Map(d.oof.map(r => [r.case_id, r.probability])), op = new Map(o.oof.map(r => [r.case_id, r.probability]));
  const inner = rows.map(r => ({ ...r, durable_probability: dp.get(r.case_id), operational_probability: op.get(r.case_id) }));
  const thresholds = selectThresholds(inner);
  const model = { config, feature_names: names, thresholds, durable: binaryFit(rows, names, 'durable_memory', d.l2, options), operational: binaryFit(rows, names, 'operational_history_only', o.l2, options) };
  return { config, model, selection: summarize(routeScored(inner.filter(sampled), thresholds.durable, thresholds.operational)), inner_l2_losses: { durable: d.loss, operational: o.loss } };
}
export function selectConfiguration(candidates) {
  const feasible = candidates.filter(c => c.selection.all_case_call_rate <= POLICY.call_cap && c.selection.semantic.call_rate <= POLICY.call_cap);
  if (!feasible.length) throw new Error('no_feasible_configuration');
  return [...feasible].sort((a, b) => {
    const am = a.selection.semantic, bm = b.selection.semantic;
    return (bm.durable.recall ?? 0) - (am.durable.recall ?? 0) || (bm.operational.f1 ?? 0) - (am.operational.f1 ?? 0) || (bm.durable.precision ?? 0) - (am.durable.precision ?? 0) || (bm.operational.precision ?? 0) - (am.operational.precision ?? 0) || a.selection.all_case_call_rate - b.selection.all_case_call_rate || a.model.feature_names.length - b.model.feature_names.length || cmp(a.config, b.config);
  })[0];
}
export function predictModel(rows, model) {
  const d = binaryPredict(rows, model.feature_names, model.durable), o = binaryPredict(rows, model.feature_names, model.operational);
  return routeScored(rows.map((r, i) => ({ ...r, durable_probability: d[i], operational_probability: o[i] })), model.thresholds.durable, model.thresholds.operational);
}
const publicRow = ({ features: _features, ...row }) => row;
export function trainNested(cases, annotations, embeddings, folds, { iterations = POLICY.iterations, l2 = POLICY.l2, configurations = CONFIGURATIONS } = {}) {
  if (cases.some(c => c.dataset_role !== 'development')) throw new Error('holdout_training_forbidden');
  const options = { iterations, l2 };
  const byConfig = Object.fromEntries(configurations.map(c => [c, featureRows(cases, annotations, embeddings, c)]));
  const outerRows = [], artifacts = [], diagnostic = Object.fromEntries(configurations.map(c => [c, []]));
  for (let fold = 0; fold < 5; fold++) {
    const candidates = configurations.map(config => fitConfiguration(byConfig[config].filter(r => folds.outer[r.group_id] !== fold), config, folds.inner[fold], options));
    const choice = selectConfiguration(candidates);
    for (const c of candidates) {
      const validation = byConfig[c.config].filter(r => folds.outer[r.group_id] === fold);
      if (!validation.length) throw new Error('insufficient_cv_support');
      const rows = predictModel(validation, c.model).map(r => publicRow({ ...r, fold, config: c.config, thresholds: c.model.thresholds, training_group_hash: c.model.durable.training_groups_hash, model_hash: hash(c.model) }));
      diagnostic[c.config].push(...rows);
      if (c.config === choice.config) outerRows.push(...rows);
    }
    artifacts.push({ fold, selected: choice.config, model: choice.model, model_hash: hash(choice.model), inner_comparison: candidates.map(c => ({ config: c.config, selection: c.selection, inner_l2_losses: c.inner_l2_losses })) });
  }
  if (outerRows.length !== cases.length || new Set(outerRows.map(r => r.case_id)).size !== cases.length) throw new Error('incomplete_outer_oof');
  const finalChoices = configurations.map(c => fitConfiguration(byConfig[c], c, folds.inner.final, options));
  const selected = selectConfiguration(finalChoices);
  return { contract: 'memory-extraction-router-v33-training/v1', evaluation_kind: 'nested_selection_procedure_oof', production_eligible: false, outer_rows: outerRows, fold_artifacts: artifacts, diagnostic_configuration_oof: diagnostic, diagnostic_note: 'Configuration-specific results are exploratory; no outer-OOF winner gate.', sampled: summarize(outerRows.filter(sampled)), challenge: summarize(outerRows.filter(r => !sampled(r))), final_model: selected.model, final_model_hash: hash(selected.model), final_selection: finalChoices.map(c => ({ config: c.config, selection: c.selection })), training_data_hash: hash({ cases, annotations, embeddings }), settings: { ...POLICY, iterations, l2, configurations }, projection_hashes: Object.fromEntries([['all', 64], ['user', 32], ['assistant', 32]].map(([c, n]) => [c, projection(c, n).hash])) };
}

export function v2Result(item, force = false) {
  const evidence = evidenceFor(item);
  const routing = routeTurnEvidence(evidence, { model: MEMORY_EXTRACTION_ROUTER_MODEL_V2 });
  const route = item.hard_excluded ? 'hard_excluded' : routing.llm_recommended ? 'llm_candidate' : routing.operational_history_recommended ? 'operational_history' : 'discard';
  return { route, packet: (force || route === 'llm_candidate') && !item.hard_excluded ? buildLearningExtractionPacket(evidence, { routing, review_drafts: [] }) : null };
}
export function compareEvidence(cases, annotations, oof) {
  const ids = new Map(oof.map(r => [r.case_id, r.route]));
  const rows = cases.filter(c => annotations[c.id]?.review_status === 'accepted' && annotations[c.id]?.usefulness !== 'excluded');
  if (!rows.length) return null;
  const labels = new Map(Object.entries(annotations));
  const calculate = packetForCase => calculateV32EvidenceMetrics(rows, labels, { packetForCase });
  const causes = rows.filter(c => annotations[c.id].evidence_spans?.length).map(c => {
    const route = ids.get(c.id);
    const packed = packV32Evidence(c);
    const metric = calculateV32EvidenceMetrics([c], labels, { packetForCase: () => packed });
    let reason = 'selected';
    if (route !== 'llm_candidate') reason = 'route';
    else if (metric.full_span_recall !== 1) {
      const ranked = rankV32EvidenceSpans(c);
      const missing = annotations[c.id].evidence_spans.filter(g => !packed.snippets.some(s => s.parent_span_id === g.turn_id && s.start <= g.start && s.end >= g.end));
      if (missing.some(g => ranked.some(s => s.parent_span_id === g.turn_id && s.start <= g.start && s.end >= g.end && packed.packing.omitted_span_ids.includes(s.span_id)))) reason = 'budget';
      else if (metric.packed_evidence_coverage === 1) reason = 'span_boundary';
      else reason = 'rank';
    }
    return { case_id: c.id, reason };
  });
  return {
    input_hash: hash(rows.map(c => ({ id: c.id, review_text_hash: c.review_text_hash }))),
    packer_only: { v2: calculate(c => v2Result(c, true).packet), v33: calculate(c => c.hard_excluded ? null : packV32Evidence(c)) },
    end_to_end: { v2: calculate(c => v2Result(c).packet), v33: calculate(c => ids.get(c.id) === 'llm_candidate' ? packV32Evidence(c) : null) },
    causes, provider_output_grounding_measured: false,
  };
}

export function pairedBootstrap(rows, baseline, repetitions = 2000) {
  const groups = [...new Set(rows.map(r => r.group_id))].sort();
  const base = new Map(baseline.map(r => [r.case_id, r]));
  if (!groups.length || rows.some(r => !base.has(r.case_id))) throw new Error('bootstrap_pair_mismatch');
  const deltas = { durable_recall: [], operational_f1: [], call_rate: [] };
  for (let b = 0; b < repetitions; b++) {
    const sample = [];
    for (let i = 0; i < groups.length; i++) {
      const ix = parseInt(sha256(`router-v33-bootstrap-v1:${b}:${i}`).slice(7, 15), 16) % groups.length;
      sample.push(...rows.filter(r => r.group_id === groups[ix]));
    }
    const a = summarize(sample), v = summarize(sample.map(r => base.get(r.case_id)));
    for (const [key, left, right] of [['durable_recall', a.semantic.durable.recall, v.semantic.durable.recall], ['operational_f1', a.semantic.operational.f1, v.semantic.operational.f1], ['call_rate', a.all_case_call_rate, v.all_case_call_rate]]) if (left !== null && right !== null) deltas[key].push(left - right);
  }
  return { repetitions, unit: 'group', confidence: 0.95, delta_v33_minus_v2: Object.fromEntries(Object.entries(deltas).map(([k, values]) => {
    values.sort((a, b) => a - b);
    return [k, { lower: values.length ? values[Math.floor((values.length - 1) * 0.025)] : null, upper: values.length ? values[Math.ceil((values.length - 1) * 0.975)] : null, valid_replicates: values.length }];
  })) };
}

export function developmentGate(summary, evidence, safety) {
  const ge = (value, target) => typeof value === 'number' && value >= target;
  const exactKeys = ['packet_exact_source_rate', 'packed_evidence_coverage', 'full_span_recall', 'character_coverage'];
  const gates = {
    durable_recall: ge(summary.semantic.durable.recall, 0.95), operational_f1: ge(summary.semantic.operational.f1, 0.75),
    conservative_durable: ge(summary.conservative.durable_recall, 0.95), conservative_operational: ge(summary.conservative.operational_f1, 0.75),
    call_rate: summary.all_case_call_rate !== null && summary.all_case_call_rate <= 0.47 && summary.semantic.call_rate !== null && summary.semantic.call_rate <= 0.47,
    safety: safety?.report?.phases?.locked?.unsafe_excluded === 80 && safety?.report?.phases?.locked?.benign_false_excluded === 0 && safety?.report?.cross_split_normalized_duplicates === 0,
    evidence: Boolean(evidence) && exactKeys.every(k => typeof evidence.end_to_end.v2[k] === 'number' && ge(evidence.end_to_end.v33[k], evidence.end_to_end.v2[k])),
  };
  const pass = Object.values(gates).every(Boolean);
  return { pass, gates, status: pass ? 'ai_assisted_development_gates_passed' : gates.durable_recall && gates.operational_f1 && (!gates.conservative_durable || !gates.conservative_operational) ? 'insufficient_ai_review_support' : 'development_gate_failed', production_eligible: false };
}
