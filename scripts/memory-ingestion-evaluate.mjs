#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildPrivateCorpusManifest, listCorpusSessions } from "./memory-learning-corpus.mjs";
import {
  buildMemoryIngestionRegressionCorpus,
  compileIngestionCase,
  emitIngestionRegressionSessions,
  semanticTraceErrors
} from "./memory-ingestion-regression.mjs";
import { prepareRegressionWorkspace } from "./memory-ingestion-storage-regression.mjs";
import {
  captureItemPayload,
  prepareMemoryRecordsV2,
  prepareObservedLearningRecords
} from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { codexSessionImportInternals, createCodexSessionImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { wilsonInterval } from "../packages/shared/src/memory-quality-certifier.mjs";
import { assessMemoryUsefulnessV1 } from "../packages/shared/src/memory-quality-runtime.mjs";

const markerName = "bundle-marker.json";
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function option(argv, name, fallback = null) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; }
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) { return JSON.stringify(stableValue(value)); }

function candidateHash(item) {
  const payload = captureItemPayload(item);
  delete payload.external_key;
  delete payload.capture_route;
  delete payload.capture_batch_id;
  payload.tags = (payload.tags ?? []).filter((tag) => ![
    "HistoricalImport",
    "QualityEvaluation",
    "codex-initial-import-v2"
  ].includes(tag) && !/^import-batch:/u.test(tag));
  payload.evidence = (payload.evidence ?? []).map((item) => ({
    evidence_type: item.evidence_type,
    evidence_ref: item.evidence_ref,
    relation: item.relation,
    weight_score: item.weight_score,
    ...(item.content_hash ? { content_hash: item.content_hash } : {}),
    ...(item.diff_hash ? { diff_hash: item.diff_hash } : {})
  }));
  if (payload.verification && typeof payload.verification === "object") {
    payload.verification = { state: payload.verification.state };
  }
  if (payload.learning?.contract_metadata && typeof payload.learning.contract_metadata === "object") {
    delete payload.learning.contract_metadata.session_id_hash;
    delete payload.learning.contract_metadata.turn_id_hash;
  }
  return hash(stableJson(payload));
}

function finalAnswer(rows) {
  for (const row of [...rows].reverse()) {
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : row;
    if (payload?.type === "agent_message" && payload?.phase === "final_answer" && typeof payload.message === "string") {
      return { text: payload.message.trim(), occurredAt: Date.parse(row.timestamp) };
    }
  }
  return null;
}

function hasObserve(rows) {
  return rows.some((row) => {
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : row;
    return payload?.name === "orgbrain_memory_observe" || payload?.invocation?.tool === "orgbrain_memory_observe";
  });
}

function parserContext(workspaceRoot) {
  return {
    tenantId: "default",
    projectId: "org-brain",
    workspaceRoot,
    businessCategoryId: null,
    workType: "other",
    sensitiveMemory: { mode: "deny", allowed_principals: [] }
  };
}

function routeFromResult(result) {
  const active = result.active ?? [];
  const quarantine = result.quarantine ?? result.review ?? [];
  return {
    route: active.length > 0 ? "active" : quarantine.length > 0 ? "quarantine" : "excluded",
    active,
    quarantine,
    excluded_reason_codes: result.excluded_reason_codes ?? result.excluded_reasons ?? []
  };
}

async function evaluateHookRoute(testCase, compiled, workspaceRoot) {
  const context = parserContext(workspaceRoot);
  const final = finalAnswer(compiled.realtimeRows);
  if (hasObserve(compiled.realtimeRows)) {
    const observed = await prepareObservedLearningRecords({
      sourceName: "codex",
      externalKey: `quality:${testCase.id}`,
      createdAt: final?.occurredAt || Date.parse("2026-08-16T00:00:04.000Z"),
      cwd: workspaceRoot,
      projectId: context.projectId,
      projectIdExplicit: true,
      businessCategoryId: context.businessCategoryId,
      workType: context.workType,
      eventType: "QualityEvaluation",
      metadata: { sessionId: testCase.session_hash, turnId: testCase.id }
    }, context, context.tenantId, { rows: compiled.realtimeRows, includeDeterministicReviewCandidates: false });
    return routeFromResult({
      active: observed.records.map(captureItemPayload).slice(0, 3),
      quarantine: (observed.reviewCandidates ?? []).slice(0, 3),
      excluded_reason_codes: observed.report.review_reason_codes
    });
  }
  if (!final?.text) return { route: "excluded", active: [], quarantine: [], excluded_reason_codes: ["final_answer_missing"] };
  const fallback = await prepareMemoryRecordsV2({
    sourceName: "codex",
    externalKey: `quality:${testCase.id}:fallback`,
    createdAt: final.occurredAt,
    cwd: workspaceRoot,
    projectId: context.projectId,
    projectIdExplicit: true,
    businessCategoryId: context.businessCategoryId,
    workType: context.workType,
    assistantText: final.text,
    eventType: "QualityEvaluation",
    metadata: { sessionHash: testCase.session_hash, turnHash: testCase.id }
  }, context, context.tenantId);
  return routeFromResult({
    active: [],
    quarantine: fallback.records.map((item) => ({ item: captureItemPayload({ ...item, captureRoute: "realtime_hook" }), reason_codes: ["fallback_unverified"] })).slice(0, 3),
    excluded_reason_codes: fallback.report.excluded_reasons
  });
}

async function evaluateInitialRoute(testCase, compiled, workspaceRoot) {
  const context = parserContext(workspaceRoot);
  const result = await codexSessionImportInternals.routeTurn({
    meta: {
      id: `quality-${testCase.id}`,
      cwd: workspaceRoot,
      threadSource: "user",
      startedAt: Date.parse("2026-08-16T00:00:00.000Z")
    },
    rows: compiled.initialRows,
    index: 0,
    context: {
      tenant_id: context.tenantId,
      project_id: context.projectId,
      workspace: context
    }
  });
  return routeFromResult(result);
}

function assessmentFor(item) {
  if (!item) return null;
  const value = item.item && typeof item.item === "object" ? item.item : item;
  return assessMemoryUsefulnessV1({
    content: value.content,
    summary: value.summary,
    rationale: value.rationale,
    reuse_rule: value.reuse_rule ?? value.reuseRule,
    learning: value.learning ?? value.observation,
    evidence: value.evidence,
    source_references: value.source_references,
    quality_dimensions: value.quality_dimensions,
    capture_origin: value.capture_origin ?? value.captureOrigin,
    verification_state: value.verification_state ?? value.verification?.state,
    verified_at: value.verified_at ?? value.verification?.verified_at,
    valid_until: value.valid_until,
    reason_codes: value.reason_codes,
    ai_certification: value.ai_certification,
    judge_consensus: value.judge_consensus
  });
}

function dimensionsReport(cases) {
  const axes = ["semantic_completeness", "evidence_support", "rationale_quality", "future_reuse", "scope_specificity", "freshness_validity", "atomicity"];
  return Object.fromEntries(axes.map((axis) => {
    const numerator = cases.filter((item) => Number(item.assessment?.quality_dimensions?.[axis]) >= 95).length;
    const denominator = cases.length;
    const interval = wilsonInterval(numerator, denominator);
    return [axis, {
      numerator,
      denominator,
      point_estimate: denominator > 0 ? numerator / denominator : null,
      wilson_lower: interval.lower,
      wilson_upper: interval.upper,
      hard_violation_count: cases.reduce((sum, item) => sum + (item.assessment?.hard_violations?.length ?? 0), 0)
    }];
  }));
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

function createDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS quality_runs (id TEXT PRIMARY KEY, input_source TEXT NOT NULL, status TEXT NOT NULL, manifest_hash TEXT NOT NULL, privacy_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quality_cases (case_hash TEXT PRIMARY KEY, session_hash TEXT, project_hash TEXT, split TEXT NOT NULL, capture_route TEXT NOT NULL, expected_route TEXT, actual_route TEXT NOT NULL, reason_codes_json TEXT NOT NULL, hard_violation_count INTEGER NOT NULL, parity_mismatch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quality_dimensions (axis TEXT PRIMARY KEY, numerator INTEGER NOT NULL, denominator INTEGER NOT NULL, point_estimate REAL, wilson_lower REAL, hard_violation_count INTEGER NOT NULL);`);
  return db;
}

function assertLocalOnly() {
  // This runner intentionally has no HTTP client. Cloud configuration is ignored and recorded as such.
  return { cloud_configuration_ignored: Boolean(process.env.ORGBRAIN_API_URL || process.env.ORGBRAIN_API_BASE), outbound_network: false };
}

export async function evaluateIngestion(options) {
  const output = path.resolve(options.outputDir);
  const runId = options.runId || path.basename(output);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  writePrivate(path.join(output, markerName), { schema_version: 1, kind: "orgbrain-memory-quality-private-run", run_id: runId });
  const network = assertLocalOnly();
  let manifest;
  let cases;
  let languageCounts = null;
  if (options.input === "generated") {
    const corpus = await buildMemoryIngestionRegressionCorpus();
    languageCounts = corpus.language_counts;
    const generatedRoot = path.join(output, "generated");
    const generatedManifest = await emitIngestionRegressionSessions(corpus, generatedRoot);
    manifest = { schema_version: 1, input: "generated", counts: { sessions: corpus.cases.length, projects: 1 }, privacy: corpus.privacy, generated: generatedManifest };
    const workspaceRoot = path.join(output, "generated", "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    await prepareRegressionWorkspace(workspaceRoot, corpus);
    cases = await mapConcurrent(corpus.cases, 8, async (item) => {
      const compiled = compileIngestionCase(item);
      const hook = await evaluateHookRoute(item, compiled, workspaceRoot);
      const initial = await evaluateInitialRoute(item, compiled, workspaceRoot);
      const candidates = [...hook.active, ...hook.quarantine];
      const actualCandidateHashes = candidates.map(candidateHash);
      const initialCandidateHashes = [...initial.active, ...initial.quarantine].map(candidateHash);
      const parityMismatch = item.input?.record_type === "learning_observation"
        ? JSON.stringify([...actualCandidateHashes].sort()) !== JSON.stringify([...initialCandidateHashes].sort())
        : false;
      const selected = candidates[0] ?? [...initial.active, ...initial.quarantine][0] ?? null;
      const assessment = assessmentFor(selected);
      const semanticErrors = semanticTraceErrors(item, selected ?? {});
      return {
        case_hash: hash(item.id),
        session_hash: item.session_hash,
        language: item.language,
        project_hash: hash("synthetic"),
        split: item.split,
        lesson_type: item.lesson_type ?? null,
        expected_route: item.expected_route ?? null,
        actual_route: hook.route,
        reason_codes: [...new Set([...hook.excluded_reason_codes, ...hook.quarantine.flatMap((candidate) => candidate.reason_codes ?? [])])],
        candidate_hash: actualCandidateHashes[0] ?? null,
        initial_candidate_hash: initialCandidateHashes[0] ?? null,
        parity_mismatch: parityMismatch,
        semantic_errors: item.semantic_expectation ? semanticErrors : null,
        assessment
      };
    });
  } else if (options.input === "mac") {
    const sessionsRoot = path.resolve(options.sessionsRoot || path.join(os.homedir(), ".codex", "sessions"));
    manifest = buildPrivateCorpusManifest(sessionsRoot);
    const sessions = listCorpusSessions(sessionsRoot);
    const sessionByHash = new Map(sessions.map((session) => [hash(session.id), session]));
    const projectGroups = new Map();
    for (const item of manifest.sessions) {
      const session = sessionByHash.get(item.session_hash);
      if (!session) continue;
      const group = projectGroups.get(item.project_hash) ?? { item, session };
      projectGroups.set(item.project_hash, group);
    }
    cases = [];
    for (const { item: groupItem, session: groupSession } of projectGroups.values()) {
      const imported = await createCodexSessionImportReport({
        workspaceRoot: groupSession.cwd,
        sessionsRoot,
        env: {
          ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
          ORGBRAIN_ENABLE_ORG_SHARING: "false",
          ORGBRAIN_TENANT_ID: "default",
          ORGBRAIN_WORKSPACES_FILE: path.join(output, "missing-workspaces.json"),
          ORGBRAIN_HOOK_ENV_FILES: path.join(output, "missing-hooks.env")
        }
      });
      for (const batch of imported.plan.batches) {
        const sessionMeta = manifest.sessions.find((entry) => entry.session_hash === batch.session_hash) ?? groupItem;
        const candidates = [...(batch.active ?? []), ...(batch.quarantine ?? batch.review ?? [])];
        const candidateHashes = candidates.map(candidateHash);
        const selected = candidates[0] ?? null;
        const assessment = assessmentFor(selected);
        cases.push({
          case_hash: hash(`${batch.session_hash}:${batch.turn_hash}`),
          session_hash: batch.session_hash,
          project_hash: sessionMeta.project_hash,
          split: sessionMeta.split,
          lesson_type: selected?.learning?.lesson_type ?? null,
          expected_route: null,
          actual_route: batch.active?.length ? "active" : candidates.length ? "quarantine" : "excluded",
          reason_codes: [...new Set([...(batch.excluded_reason_codes ?? []), ...candidates.flatMap((candidate) => candidate.reason_codes ?? [])])],
          candidate_hash: candidateHashes[0] ?? null,
          initial_candidate_hash: candidateHashes[0] ?? null,
          parity_mismatch: false,
          assessment
        });
      }
    }
    if (cases.length === 0) {
      cases = manifest.sessions.map((item, index) => ({ case_hash: hash(`${item.session_hash}:${item.source_path_hash}:${item.split}:${index}`), session_hash: item.session_hash, project_hash: item.project_hash, split: item.split, expected_route: null, actual_route: "excluded", reason_codes: [item.workspace_state === "missing" ? "workspace_missing" : "no_eligible_turn"], assessment: null }));
    }
  } else {
    throw new Error("--input must be generated or mac");
  }

  const denominator = cases.length;
  const dimensions = dimensionsReport(cases);
  const hardViolationCount = cases.reduce((sum, item) => sum + (item.assessment?.hard_violations?.length ?? 0), 0);
  const parityMismatches = cases.filter((item) => item.parity_mismatch).length;
  const semanticCases = cases.filter((item) => Array.isArray(item.semantic_errors));
  const semanticErrorCount = semanticCases.reduce((sum, item) => sum + item.semantic_errors.length, 0);
  const semanticByLesson = Object.fromEntries(
    [...new Set(semanticCases.map((item) => item.lesson_type).filter(Boolean))]
      .sort()
      .map((lessonType) => {
        const lessonCases = semanticCases.filter((item) => item.lesson_type === lessonType);
        return [lessonType, {
          cases: lessonCases.length,
          passed: lessonCases.filter((item) => item.semantic_errors.length === 0).length,
          error_count: lessonCases.reduce((sum, item) => sum + item.semantic_errors.length, 0)
        }];
      })
  );
  const semanticByLanguage = Object.fromEntries(
    [...new Set(semanticCases.map((item) => item.language).filter(Boolean))]
      .sort()
      .map((language) => {
        const languageCases = semanticCases.filter((item) => item.language === language);
        return [language, {
          cases: languageCases.length,
          passed: languageCases.filter((item) => item.semantic_errors.length === 0).length,
          error_count: languageCases.reduce((sum, item) => sum + item.semantic_errors.length, 0)
        }];
      })
  );
  const lessonTypeCounts = Object.fromEntries(
    [...new Set(cases.map((item) => item.lesson_type).filter(Boolean))]
      .map((type) => [type, cases.filter((item) => item.lesson_type === type).length])
  );
  const routeCountsByLanguage = Object.fromEntries(
    [...new Set(cases.map((item) => item.language).filter(Boolean))].sort().map((language) => [language, {
      active: cases.filter((item) => item.language === language && item.actual_route === "active").length,
      quarantine: cases.filter((item) => item.language === language && item.actual_route === "quarantine").length,
      excluded: cases.filter((item) => item.language === language && item.actual_route === "excluded").length
    }])
  );
  const localJudgeAvailable = options.judgeMode === "local" && process.env.ORGBRAIN_PRIVATE_JUDGE_AVAILABLE === "true";
  const status = denominator > 0 && localJudgeAvailable && parityMismatches === 0 && semanticErrorCount === 0 && hardViolationCount === 0 && Object.values(dimensions).every((metric) => metric.wilson_lower !== null && metric.wilson_lower >= 0.95)
    ? "passed"
    : "insufficient_evidence";
  const report = {
    schema_version: 1,
    run_id: runId,
    input_source: options.input === "mac" ? "real" : "synthetic",
    status,
    judge_mode: options.judgeMode || "local",
    ground_truth_basis: options.input === "generated" ? "independent_locked_oracle_required" : "held_out_query_pending",
    loopback: {
      database_file: "quality.sqlite",
      api: { host: "127.0.0.1", port: 8787, run_id: runId, mode: "run-scoped-read-only" },
      console: { host: "127.0.0.1", port: 4321, run_id: runId, mode: "run-scoped-read-only" }
    },
    dimensions,
    route_counts: Object.fromEntries(["active", "quarantine", "excluded"].map((route) => [route, cases.filter((item) => item.actual_route === route).length])),
    language_counts: languageCounts,
    route_counts_by_language: routeCountsByLanguage,
    lesson_type_counts: lessonTypeCounts,
    semantic: {
      contract: manifest.generated?.semantic_contract ?? null,
      scenario_counts: manifest.generated?.semantic_scenario_counts ?? null,
      cases_checked: semanticCases.length,
      passed: semanticCases.filter((item) => item.semantic_errors.length === 0).length,
      error_count: semanticErrorCount,
      by_lesson: semanticByLesson,
      by_language: semanticByLanguage
    },
    hard_violation_count: hardViolationCount,
    parity_mismatch_count: parityMismatches,
    parity: { candidate_hashes_checked: cases.filter((item) => item.initial_candidate_hash || item.candidate_hash).length, mismatches: parityMismatches },
    network,
    counts: { sessions: manifest.counts.sessions ?? denominator, projects: manifest.counts.projects ?? 1, cases: denominator },
    privacy: { raw_transcript_persisted: false, reasoning_persisted: false, absolute_path_persisted: false, credential_value_persisted: false },
    insufficiency_reason: denominator < 75
      ? "minimum_75_cases_not_met"
      : semanticErrorCount > 0
        ? "semantic_trace_verification_failed"
        : !localJudgeAvailable
          ? "private_judge_unavailable"
          : parityMismatches > 0
            ? "route_candidate_parity_mismatch"
            : "quality_gate_not_met"
  };
  const db = createDatabase(path.join(output, "quality.sqlite"));
  db.prepare("INSERT OR REPLACE INTO quality_runs VALUES (?, ?, ?, ?, ?, ?)").run(runId, report.input_source, status, hash(JSON.stringify(manifest)), JSON.stringify(report.privacy), Date.now());
  db.prepare("DELETE FROM quality_cases").run();
  const insert = db.prepare("INSERT OR REPLACE INTO quality_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of cases) insert.run(item.case_hash, item.session_hash, item.project_hash, item.split, options.input === "mac" ? "initial_import" : "realtime_hook", item.expected_route, item.actual_route, JSON.stringify(item.reason_codes), item.assessment?.hard_violations?.length ?? 0, item.parity_mismatch ? 1 : 0);
  for (const axis of ["semantic_completeness", "evidence_support", "rationale_quality", "future_reuse", "scope_specificity", "freshness_validity", "atomicity"]) {
    const metric = dimensions[axis];
    db.prepare("INSERT OR REPLACE INTO quality_dimensions VALUES (?, ?, ?, ?, ?, ?)").run(axis, metric.numerator, metric.denominator, metric.point_estimate, metric.wilson_lower, metric.hard_violation_count);
  }
  db.close();
  writePrivate(path.join(output, "manifest.json"), manifest);
  writePrivate(path.join(output, "report.json"), report);
  return { output, report };
}

export async function main(argv = process.argv.slice(2)) {
  const input = option(argv, "--input", "generated");
  const output = option(argv, "--output-dir");
  if (!output) throw new Error("--output-dir is required");
  const result = await evaluateIngestion({ input, outputDir: output, sessionsRoot: option(argv, "--sessions-root"), judgeMode: option(argv, "--judge-mode", "local") });
  process.stdout.write(`${JSON.stringify({ ok: true, output: result.output, report: result.report })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
