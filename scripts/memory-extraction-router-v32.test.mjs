import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_DIMENSIONS_V32,
  buildLineageGroups,
  caseInputHash,
  buildV32ContextWindow,
  buildV32SafetyFixture,
  chunkEmbeddingInput,
  createEmbeddingCache,
  createProjectionMatrix,
  createV32ExperimentManifest,
  createV32V2EvidenceBaseline,
  createV32Progress,
  createV32ReviewBundle,
  createV32OperationalHistoryRecord,
  calculateV32EvidenceMetrics,
  mergeV32Progress,
  mergeV32LabelSnapshots,
  mergeV32ReviewBundles,
  embedV32Case,
  enrichV32ErrorQueue,
  evaluateV32Holdout,
  evaluateV32SafetyFixture,
  freezeV32Model,
  poolEmbeddingVectors,
  packV32Evidence,
  preflightV32EmbeddingProvider,
  projectEmbedding,
  rankV32EvidenceSpans,
  selectV32ReviewBatchReport,
  trainV32Configurations,
  validateV32LlmOutput,
  validateV32EmbeddingDocument,
  validateV32Progress,
  validateV32ReviewBundle,
  validateV32SafetyGate,
  routerHash,
} from "./memory-extraction-router-v32.mjs";

function makeCase(id, {
  session = `session-${id}`,
  text = `採用する方針 ${id} は今後も再利用する。理由を記録する。`,
  group_id,
  dataset_role = "development",
} = {}) {
  const turns = [{ id: `${id}-t1`, role: "user", content: text }];
  return { id, session_hash: session, source_hash: routerHash(turns), group_id, dataset_role, turns };
}

function readyDevelopmentGate(modelHash = routerHash("model"), labelsHash = routerHash("labels")) {
  const pass = { pass: true };
  return {
    contract: "memory-extraction-router-v32-development-gate/v1",
    pass: true,
    quality: { durable_recall: pass, operational_f1: pass, llm_candidate_rate: pass },
    evidence_gates: { input_binding: pass, packet_exact_source_not_worse_than_v2: pass, packed_evidence_not_worse_than_v2: pass, full_span_not_worse_than_v2: pass, character_coverage_not_worse_than_v2: pass, packet_exact_source_minimum: pass },
    safety_locked: pass,
    review_coverage: pass,
    model_binding: { pass: true, actual: modelHash, expected: modelHash },
    labels_sha256: labelsHash,
    safety_report_sha256: routerHash("safety"),
    evidence_baseline_sha256: routerHash("baseline"),
    input_sha256: routerHash("input"),
  };
}

test("lineage grouping connects session, exact source, and near duplicate cases", () => {
  const cases = [
    makeCase("a", { session: "same" }),
    makeCase("b", { session: "same", text: "別の文面でも同じセッション" }),
    makeCase("c", { session: "other", text: "採用する方針 a は今後も再利用する。理由を記録する。" }),
    makeCase("d", { session: "unique", text: "完全に別の入力である。" }),
  ];
  const groups = buildLineageGroups(cases);
  assert.equal(groups.get("a"), groups.get("b"));
  assert.equal(groups.get("a"), groups.get("c"));
  assert.notEqual(groups.get("a"), groups.get("d"));
});

test("manifest freezes split metadata and blocks duplicate/overlapping source identity", () => {
  const cases = Array.from({ length: 6 }, (_, index) => makeCase(`new-${index}`, { session: `new-${index}` }));
  const manifest = createV32ExperimentManifest(cases, { experimentId: "exp-test", datasetRole: "development", legacyDevelopment: true });
  assert.equal(manifest.contract, "memory-extraction-router-v32-manifest/v1");
  assert.equal(manifest.case_count, cases.length);
  assert.equal(manifest.role_case_ids.length, cases.length);
  assert.throws(() => createV32ExperimentManifest([cases[0], cases[0]], { experimentId: "duplicate", datasetRole: "development" }), /manifest_duplicate_case/);
});

test("review queue keeps the requested 16/16/8 quotas and reports shortages without replacement", () => {
  const rows = [
    ...Array.from({ length: 16 }, (_, i) => ({ case_id: `d-${i}`, session_hash: `sd-${i}`, gold_label: "durable_memory", predicted_route: "discard" })),
    ...Array.from({ length: 16 }, (_, i) => ({ case_id: `o-${i}`, session_hash: `so-${i}`, gold_label: "operational_history_only", predicted_route: "discard" })),
    ...Array.from({ length: 8 }, (_, i) => ({ case_id: `n-${i}`, session_hash: `sn-${i}`, gold_label: "not_useful", predicted_route: "operational_history" })),
  ];
  const report = selectV32ReviewBatchReport(rows);
  assert.equal(report.selected_count, 40);
  assert.deepEqual(report.shortages, {});
  const short = selectV32ReviewBatchReport(rows.slice(0, 4));
  assert.ok(Object.keys(short.shortages).length > 0);
  assert.equal(short.selected.some((row) => row.review_bucket === "operational_false_negative"), false);
});

test("blind review bundle strips prediction fields and validates revision source binding", () => {
  const source = makeCase("blind", { text: "失敗したが修正して検証に成功した。<internal-tag> /tmp/private-log.txt" });
  const bundle = createV32ReviewBundle([{ ...source, model_prediction: { route: "llm_candidate" }, ai_draft: { usefulness: "durable_memory" }, comparison: { old: true } }], { experimentId: "exp-blind", datasetRole: "final_holdout" });
  assert.equal(bundle.experiment_manifest.blind, true);
  assert.equal(Object.hasOwn(bundle.cases[0], "model_prediction"), false);
  assert.equal(Object.hasOwn(bundle.cases[0], "ai_draft"), false);
  assert.equal(Object.hasOwn(bundle.cases[0], "comparison"), false);
  assert.equal(bundle.cases[0].turns[0].content.includes("/tmp/private-log.txt"), false);
  assert.equal(bundle.cases[0].turns[0].content.includes("internal-tag"), false);
  assert.equal(bundle.cases[0].review_text_hash, routerHash(bundle.cases[0].turns));
  validateV32ReviewBundle(bundle, { expectedRole: "final_holdout", blind: true });
  const progress = createV32Progress(bundle, "reviewer-local", "2026-01-01T00:00:00.000Z");
  progress.annotations.blind = {
    case_id: "blind", revision_id: "blind:rev-1", review_status: "accepted", label_origin: "human_blind", prior_ai_exposure: "none", source_hash: source.source_hash,
    outcome: "candidate", usefulness: "durable_memory", lesson_types: ["failure"],
    evidence_spans: [{ turn_id: "blind-t1", quote: "失敗したが修正して検証に成功した。", start: 0, end: "失敗したが修正して検証に成功した。".length }],
    future_use: "同じ修正方針の再発防止に使う", confidence: "high", exclusion_reason: "", note: "",
  };
  validateV32Progress(progress, bundle, { allowPending: false });
  assert.throws(() => validateV32Progress({ ...progress, annotations: { blind: { ...progress.annotations.blind, case_id: "other" } } }, bundle, { allowPending: false }), /case_id/);
  assert.throws(() => validateV32ReviewBundle({ ...bundle, cases: [{ ...bundle.cases[0], gold_label: "durable_memory" }] }, { blind: true }), /oracle_field/);
});

test("blind review manifest keeps only aggregate queue metadata", () => {
  const source = makeCase("selection-blind", { text: "決定事項を記録する。" });
  const bundle = createV32ReviewBundle([source], {
    experimentId: "selection-blind-exp",
    selection: { selected: [{ case_id: source.id, gold_label: "durable_memory", predicted_route: "discard" }], selected_count: 1, queue_sha256: routerHash("queue") },
  });
  assert.equal(JSON.stringify(bundle).includes("gold_label"), false);
  assert.equal(JSON.stringify(bundle).includes("predicted_route"), false);
  validateV32ReviewBundle(bundle, { blind: true });
});

test("blind review payload does not expose cohort labels", () => {
  const source = { ...makeCase("cohort-blind", { text: "今回の作業は完了した。" }), cohort: "non_durable", eligible_cohorts: ["non_durable"] };
  const bundle = createV32ReviewBundle([source], { experimentId: "cohort-blind-exp" });
  assert.equal(Object.hasOwn(bundle.cases[0], "cohort"), false);
  assert.equal(Object.hasOwn(bundle.cases[0], "eligible_cohorts"), false);
  assert.throws(() => validateV32ReviewBundle({ ...bundle, cases: [{ ...bundle.cases[0], cohort: "non_durable" }] }, { blind: true }), /oracle_field/);
});

test("sanitized review text is bound to the immutable source manifest", () => {
  const source = makeCase("review-text-binding", { text: "保存対象の本文。<private-tag> /tmp/secret.log" });
  const manifest = createV32ExperimentManifest([source], { experimentId: "review-text-exp", datasetRole: "development", legacyDevelopment: true });
  const bundle = createV32ReviewBundle([source], { experimentId: "review-text-exp", experimentManifest: manifest });
  const changedTurns = [{ ...bundle.cases[0].turns[0], content: "別の本文" }];
  const tampered = { ...bundle, cases: [{ ...bundle.cases[0], turns: changedTurns, review_text_hash: routerHash(changedTurns) }] };
  assert.throws(() => validateV32ReviewBundle(tampered, { sourceManifest: manifest, blind: true }), /review_manifest_case_binding/);
});

test("preassigned roles are recomputed before a holdout manifest is created", () => {
  const cases = Array.from({ length: 4 }, (_, index) => makeCase(`preassigned-${index}`, {
    session: `preassigned-session-${index}`,
    dataset_role: "final_holdout",
    group_id: "caller-controlled-group",
  }));
  const manifest = createV32ExperimentManifest(cases, { experimentId: "preassigned-exp", datasetRole: "final_holdout", holdoutCount: 2 });
  assert.equal(manifest.case_count, 2);
  assert.equal(new Set(manifest.case_records.map((item) => item.group_id)).size, 2);
});

test("manifest rejects the same case id supplied as both new and existing input", () => {
  const source = makeCase("duplicate-existing");
  assert.throws(() => createV32ExperimentManifest([source], {
    experimentId: "duplicate-existing-exp", datasetRole: "development", existingCases: [source], legacyDevelopment: true,
  }), /manifest_duplicate_case/);
});

test("real queue enrichment restores session round-robin metadata and keeps unmatched rows visible", () => {
  const cases = [makeCase("q1", { session: "session-a" }), makeCase("q2", { session: "session-b" })];
  const enriched = enrichV32ErrorQueue([
    { case_id: "q1", gold_label: "durable_memory", predicted_route: "discard" },
    { case_id: "missing", gold_label: "durable_memory", predicted_route: "discard" },
  ], cases);
  assert.equal(enriched.rows[0].session_hash, "session-a");
  assert.equal(enriched.metadata.matched, 1);
  assert.equal(enriched.metadata.unmatched, 1);
  assert.equal(enriched.metadata.session_hash_fallback_count, 1);
});

test("operational history is a separate 30-day no-LLM action", () => {
  const record = createV32OperationalHistoryRecord(makeCase("episode", { text: "今回の検証だけ完了した。" }), { now: "2026-01-01T00:00:00.000Z" });
  assert.equal(record.persistence, "episodic");
  assert.equal(record.ttl_days, 30);
  assert.equal(record.llm_called, false);
  assert.equal(record.stored, false);
  assert.equal(record.expires_at, "2026-01-31T00:00:00.000Z");
});

test("review bundles and progress merge without duplicate cases", () => {
  const first = createV32ReviewBundle([makeCase("merge-1", { text: "採用する方針を決定した。" })], { experimentId: "merge-exp" });
  const second = createV32ReviewBundle([makeCase("merge-2", { text: "今回の検証を完了した。" })], { experimentId: "merge-exp" });
  const merged = mergeV32ReviewBundles([first, second]);
  assert.equal(merged.cases.length, 2);
  const progressFor = (bundle) => {
    const progress = createV32Progress(bundle, "reviewer-local", "2026-01-01T00:00:00.000Z");
    for (const item of bundle.cases) progress.annotations[item.id] = {
      case_id: item.id, revision_id: `${item.id}:rev`, review_status: "accepted", label_origin: "human_blind", prior_ai_exposure: "none", source_hash: item.source_hash,
      outcome: "no_candidate", usefulness: "operational_history_only", lesson_types: [], evidence_spans: [], confidence: "high", exclusion_reason: "", note: "", started_at: progress.created_at, updated_at: progress.created_at, completed_at: progress.created_at
    };
    return progress;
  };
  const combined = mergeV32Progress([progressFor(first), progressFor(second)], [first, second]);
  assert.equal(Object.keys(combined.progress.annotations).length, 2);
  assert.throws(() => mergeV32ReviewBundles([first, first]), /duplicate_case/);
});

test("label snapshots bind to the saved merged bundle without regenerating its timestamp", () => {
  const first = createV32ReviewBundle([makeCase("labels-1", { text: "採用する方針を決定した。" })], { experimentId: "labels-merge-exp", batchId: "batch-1" });
  const second = createV32ReviewBundle([makeCase("labels-2", { text: "今回の検証を完了した。" })], { experimentId: "labels-merge-exp", batchId: "batch-2" });
  const mergedBundle = mergeV32ReviewBundles([first, second]);
  const annotationFor = (bundle) => {
    const item = bundle.cases[0];
    return {
      case_id: item.id,
      revision_id: `${item.id}:rev`,
      review_status: "accepted",
      label_origin: "human_blind",
      prior_ai_exposure: "none",
      source_hash: item.source_hash,
      outcome: "no_candidate",
      usefulness: "operational_history_only",
      lesson_types: [],
      evidence_spans: [],
      confidence: "high",
      exclusion_reason: "",
      note: "",
      started_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.000Z",
    };
  };
  const snapshotFor = (bundle) => ({
    contract: "memory-extraction-router-v32-label-snapshot/v1",
    experiment_id: "labels-merge-exp",
    dataset_role: "development",
    manifest_sha256: routerHash("manifest"),
    source_bundle_hash: routerHash(bundle),
    labels: { [bundle.cases[0].id]: annotationFor(bundle) },
  });
  const merged = mergeV32LabelSnapshots([snapshotFor(first), snapshotFor(second)], [first, second], { mergedBundle });
  assert.equal(routerHash(merged.bundle), routerHash(mergedBundle));
  assert.equal(Object.keys(merged.snapshot.labels).length, 2);
  assert.throws(() => mergeV32LabelSnapshots([snapshotFor(first), snapshotFor(second)], [first, second], {
    mergedBundle: mergeV32ReviewBundles([first]),
  }), /merged_bundle_case_set_mismatch/);
});

test("context window marks only the two prior same-session turns as context-only", () => {
  const prior1 = makeCase("prior-1", { session: "session-context", text: "最初の相談。" });
  prior1.turns[0].observed_at = "2026-01-01T00:00:00.000Z";
  prior1.source_hash = routerHash(prior1.turns);
  const prior2 = makeCase("prior-2", { session: "session-context", text: "二つ目の相談。" });
  prior2.turns[0].observed_at = "2026-01-01T00:01:00.000Z";
  prior2.source_hash = routerHash(prior2.turns);
  const current = makeCase("current", { session: "session-context", text: "現在の判断。" });
  const window = buildV32ContextWindow(current, [prior1, prior2]);
  assert.deepEqual(window.context_only_span_ids, ["prior-1:prior-1-t1", "prior-2:prior-2-t1"]);
  assert.equal(window.snippets.at(-1).context_only, false);
  assert.equal(window.persistence_performed, false);
});

test("embedding chunks round-trip, normalize/pool, cache, and preflight only loopback model", async () => {
  const text = "😀".repeat(2_001);
  const chunks = chunkEmbeddingInput(text, 1_500);
  assert.equal(chunks.join(""), text);
  const first = Array.from({ length: EMBEDDING_DIMENSIONS_V32 }, (_, index) => index === 0 ? 1 : 0);
  const second = Array.from({ length: EMBEDDING_DIMENSIONS_V32 }, (_, index) => index === 1 ? 1 : 0);
  const pooled = poolEmbeddingVectors([first, second], [1_500, 501]);
  assert.equal(pooled.length, EMBEDDING_DIMENSIONS_V32);
  assert.ok(Math.abs(Math.hypot(...pooled) - 1) < 1e-9);
  await assert.rejects(() => preflightV32EmbeddingProvider({ endpoint: "http://example.com", fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) }), /loopback/);
  await assert.rejects(() => preflightV32EmbeddingProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) }), /model_missing/);
  const calls = [];
  const provider = { embedDocuments: async (batch) => { calls.push(batch.length); return batch.map(() => first); } };
  const cache = createEmbeddingCache();
  const source = makeCase("embed", { text: "a".repeat(15_001) });
  const a = await embedV32Case(source, { provider, cache });
  const b = await embedV32Case(source, { provider, cache });
  assert.equal(a.cache_hit, false);
  assert.equal(b.cache_hit, true);
  assert.deepEqual(calls, [8, 3]);
});

test("projection is deterministic and produces a normalized 64-dimensional vector", () => {
  const left = createProjectionMatrix();
  const right = createProjectionMatrix();
  assert.equal(left.matrix_sha256, right.matrix_sha256);
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS_V32 }, (_, index) => index + 1);
  const projected = projectEmbedding(vector, left);
  assert.equal(projected.length, 64);
  assert.ok(Math.abs(Math.hypot(...projected) - 1) < 1e-9);
});

test("synthetic safety fixture has 80/80 locked exclusions, zero benign exclusions, and no split leakage", () => {
  const fixture = buildV32SafetyFixture();
  assert.equal(fixture.cases.length, 200);
  const result = evaluateV32SafetyFixture(fixture);
  assert.equal(result.report.cross_split_normalized_duplicates, 0);
  assert.equal(result.report.phases.locked.unsafe_total, 80);
  assert.equal(result.report.phases.locked.unsafe_excluded, 80);
  assert.equal(result.report.phases.locked.benign_false_excluded, 0);
  assert.equal(result.report.phases.locked.gate_pass, true);
  assert.equal(validateV32SafetyGate(result).pass, true);
  assert.equal(validateV32SafetyGate({ report: result.report, rows: result.rows.slice(1) }).pass, false);
  assert.equal(validateV32SafetyGate({ report: { ...result.report, phases: { ...result.report.phases, locked: { ...result.report.phases.locked, unsafe_excluded: 0 } } }, rows: result.rows }).pass, false);
});

test("evidence ranking is current-turn-only, deduplicated, chronological, and packed within the reserved ceiling", () => {
  const source = makeCase("evidence", { text: "検証結果は成功した。採用理由は再利用できるからである。" });
  const ranked = rankV32EvidenceSpans(source);
  assert.ok(ranked.length > 0 && ranked.length <= 8);
  assert.deepEqual(ranked.map((span) => span.start), [...ranked.map((span) => span.start)].sort((a, b) => a - b));
  assert.equal(new Set(ranked.map((span) => span.span_id)).size, ranked.length);
  const packet = packV32Evidence(source, { existingMemories: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }, { id: "m6" }] });
  assert.equal(packet.existing_memories.length, 5);
  assert.equal(packet.limits.calls, 1);
  assert.ok(packet.packing.reserve_bytes >= 512);
  assert.ok(packet.snippets.length <= 8);
  assert.ok(packet.packing.estimated_input_tokens <= 2_000);
  assert.ok(packet.packing.upper_bound_bytes + packet.packing.reserve_bytes <= 8_000);
  const rejected = validateV32LlmOutput({ candidates: [{ lesson_type: "decision", support_span_ids: ["missing"] }] }, packet);
  assert.equal(rejected.candidates.length, 0);
  assert.equal(rejected.rejections[0].reason_codes[0], "support_id_unresolved");
});

test("rules configuration uses grouped deterministic CV and freeze is one-way", () => {
  const cases = Array.from({ length: 30 }, (_, index) => makeCase(`train-${index}`, {
    session: `train-session-${index}`,
    text: index % 2 === 0 ? `決定事項 ${index} を採用する。理由と適用範囲を記録する。` : `進捗 ${index} を確認した。今回の作業は完了した。`,
  }));
  const groups = buildLineageGroups(cases);
  cases.forEach((item) => { item.group_id = groups.get(item.id); });
  const labels = new Map(cases.map((item, index) => [item.id, index % 2 === 0 ? "durable_memory" : "operational_history_only"]));
  const options = { configurations: ["rules"], folds: 5, innerFolds: 4, l2Candidates: [0.16], iterations: 12, seed: "deterministic-test" };
  const first = trainV32Configurations(cases, labels, new Map(), options);
  const second = trainV32Configurations(cases, labels, new Map(), options);
  assert.equal(first.model.feature_revision, "rules");
  assert.equal(first.model_sha256, second.model_sha256);
  const labelsHash = routerHash("labels");
  const frozen = freezeV32Model({ ...first, labels_sha256: labelsHash, development_gate: readyDevelopmentGate(first.model_sha256, labelsHash) }, { holdoutHash: routerHash("test-holdout") });
  assert.equal(frozen.model.frozen, true);
  assert.throws(() => freezeV32Model(frozen), /already_frozen/);
});

test("holdout evaluation is blind to incomplete labels and reports support status", () => {
  const cases = [makeCase("holdout", { dataset_role: "final_holdout" })];
  const labels = new Map([["holdout", "durable_memory"]]);
  const trainCases = [makeCase("train-h", { text: "決定事項 h1 を採用する。" }), makeCase("train-o", { text: "進捗 o1 を確認した。" }), makeCase("train-h2", { text: "決定事項 h2 を採用する。" }), makeCase("train-o2", { text: "進捗 o2 を確認した。" }), makeCase("train-h3", { text: "決定事項 h3 を採用する。" }), makeCase("train-o3", { text: "進捗 o3 を確認した。" }), makeCase("train-h4", { text: "決定事項 h4 を採用する。" }), makeCase("train-o4", { text: "進捗 o4 を確認した。" }), makeCase("train-h5", { text: "決定事項 h5 を採用する。" }), makeCase("train-o5", { text: "進捗 o5 を確認した。" })];
  const trainGroups = buildLineageGroups(trainCases);
  trainCases.forEach((item) => { item.group_id = trainGroups.get(item.id); });
  const training = trainV32Configurations(trainCases, new Map([
    ["train-h", "durable_memory"], ["train-o", "operational_history_only"], ["train-h2", "durable_memory"], ["train-o2", "operational_history_only"], ["train-h3", "durable_memory"], ["train-o3", "operational_history_only"], ["train-h4", "durable_memory"], ["train-o4", "operational_history_only"], ["train-h5", "durable_memory"], ["train-o5", "operational_history_only"],
  ]), new Map(), { configurations: ["rules"], folds: 2, innerFolds: 2, l2Candidates: [0.16], iterations: 5, seed: "holdout-test" });
  const holdoutHash = caseInputHash(cases, "final_holdout");
  const evidenceSpan = { turn_id: "holdout-t1", quote: cases[0].turns[0].content, start: 0, end: cases[0].turns[0].content.length };
  const labelRows = [{ case_id: "holdout", usefulness: "durable_memory", review_status: "accepted", evidence_spans: [evidenceSpan] }];
  const baseline = createV32V2EvidenceBaseline(cases, { labelRows });
  const labelsHash = routerHash("labels");
  const frozen = freezeV32Model({ ...training, labels_sha256: labelsHash, development_gate: readyDevelopmentGate(training.model_sha256, labelsHash) }, { holdoutHash });
  const safety = evaluateV32SafetyFixture(buildV32SafetyFixture());
  const result = evaluateV32Holdout(cases, labels, frozen, {
    v2Baseline: baseline,
    safetyReport: safety,
  });
  assert.equal(result.report.status, "insufficient_holdout_support");
  assert.equal(result.report.pass, false);
  assert.equal(result.report.gates.safety_locked.pass, true);
  assert.equal(result.report.gates.packet_exact_source_not_worse_than_v2.pass, true);
  const withoutSafety = evaluateV32Holdout(cases, labelRows, frozen, { v2Baseline: baseline });
  assert.equal(withoutSafety.report.gates.safety_locked.pass, false);
  assert.throws(() => evaluateV32Holdout(cases, labels, frozen, { alreadyEvaluated: true }), /already_consumed/);
});

test("full metrics route a safety-missed excluded case through the frozen v3.2 model", () => {
  const cases = [
    makeCase("holdout-safe-durable", { dataset_role: "final_holdout", text: "採用する方針 holdout-safe-durable は今後も再利用する。理由を記録する。" }),
    makeCase("holdout-safe-excluded", { dataset_role: "final_holdout", text: "今回の確認メモ。" }),
  ];
  const trainCases = Array.from({ length: 30 }, (_, index) => makeCase(`full-train-${index}`, {
    text: index % 2 === 0
      ? `決定事項 ${index} を今後も再利用する。識別子 ${Array.from({ length: 30 }, (_, offset) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[(index * 31 + offset * 17) % 62]).join("")}`
      : `今回の進捗 ${index} を確認した。識別子 ${Array.from({ length: 30 }, (_, offset) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[(index * 31 + offset * 17) % 62]).join("")}`,
  }));
  const trainGroups = buildLineageGroups(trainCases);
  trainCases.forEach((item) => { item.group_id = trainGroups.get(item.id); });
  const training = trainV32Configurations(trainCases, new Map(trainCases.map((item, index) => [item.id, index % 2 === 0 ? "durable_memory" : "operational_history_only"])), new Map(), {
    configurations: ["rules"], folds: 2, innerFolds: 2, l2Candidates: [0.16], iterations: 5, seed: "seed-0",
  });
  const labels = [
    { case_id: "holdout-safe-durable", usefulness: "durable_memory", review_status: "accepted", evidence_spans: [{ turn_id: "holdout-safe-durable-t1", quote: "採用する方針 holdout-safe-durable は今後も再利用する。理由を記録する。", start: 0, end: "採用する方針 holdout-safe-durable は今後も再利用する。理由を記録する。".length }] },
    { case_id: "holdout-safe-excluded", usefulness: "excluded", review_status: "accepted", evidence_spans: [] },
  ];
  const holdoutHash = caseInputHash(cases, "final_holdout");
  const labelsHash = routerHash("full-metrics-labels");
  const frozen = freezeV32Model({ ...training, labels_sha256: labelsHash, development_gate: readyDevelopmentGate(training.model_sha256, labelsHash) }, { holdoutHash });
  const safety = evaluateV32SafetyFixture(buildV32SafetyFixture());
  const baseline = createV32V2EvidenceBaseline(cases, { labelRows: labels });
  const result = evaluateV32Holdout(cases, labels, frozen, { v2Baseline: baseline, safetyReport: safety });
  const excluded = result.rows_all.find((row) => row.case_id === "holdout-safe-excluded");
  assert.ok(excluded);
  assert.notEqual(excluded.route_source, "safety_filter");
  assert.ok(["llm_candidate", "operational_history", "discard"].includes(excluded.route));
  assert.equal(result.rows_all.length, 2);
  assert.equal(result.report.excluded_cases, 1);
});

test("holdout gate rejects missing safety or unbound evidence baseline", () => {
  const cases = [makeCase("holdout-gate", { dataset_role: "final_holdout" })];
  const labels = new Map([["holdout-gate", "durable_memory"]]);
  assert.equal(calculateV32EvidenceMetrics(cases).packet_exact_source_rate, 1);
  assert.throws(() => evaluateV32Holdout(cases, labels, { model: { frozen: true } }), /holdout_hash_mismatch/);
});
