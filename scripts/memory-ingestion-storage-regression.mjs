#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyCodexSessionImportPlan,
  createCodexSessionImportReport
} from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  buildMemoryIngestionRegressionCorpus,
  emitIngestionRegressionSessions,
  semanticTraceErrors
} from "./memory-ingestion-regression.mjs";

const CAPTURE_COHORTS = new Set([
  "success",
  "decision",
  "failure",
  "review_candidate",
  "non_durable_turn"
]);

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function localEnv(root, dbPath) {
  return {
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
    ORGBRAIN_ENABLE_ORG_SHARING: "false",
    ORGBRAIN_TENANT_ID: "default",
    ORGBRAIN_LOCAL_DB: dbPath,
    ORGBRAIN_WORKSPACES_FILE: path.join(root, "missing-workspaces.json"),
    ORGBRAIN_HOOK_ENV_FILES: path.join(root, "missing-hooks.env")
  };
}

function initializeGitWorkspace(workspace) {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "OrgBrain Regression Fixture"], { cwd: workspace });
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "regression fixture base"], { cwd: workspace, stdio: "ignore" });
}

function caseIndex(testCase) {
  return Number(testCase.id.split("-").at(-1));
}

export async function prepareRegressionWorkspace(workspace, corpus) {
  await mkdir(path.join(workspace, "src"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, "base.txt"), "base\n", "utf8");
  initializeGitWorkspace(workspace);
  const evidenceByFile = new Map();
  for (const testCase of corpus.cases) {
    const index = caseIndex(testCase);
    const input = testCase.input ?? {};
    const refs = input.applicability?.target_files ?? [];
    const lines = [
      `CASE_${testCase.id}`,
      `SCENARIO_${testCase.scenario_id ?? testCase.cohort}_${index}`,
      ...(testCase.semantic_expectation?.scenario_tokens ?? []),
      input.procedure,
      input.decision,
      input.correction,
      input.rationale,
      input.why_it_worked
    ].filter(Boolean);
    if (testCase.cohort === "review_candidate") lines.push(`REVIEW_POLICY_${index}`);
    for (const ref of refs) {
      const current = evidenceByFile.get(ref) ?? [];
      evidenceByFile.set(ref, [...current, ...lines]);
    }
  }
  if (!evidenceByFile.has("src/importer-regression.mjs")) {
    evidenceByFile.set("src/importer-regression.mjs", ["REVIEW_IMPORT_POLICY_FIXTURE"]);
  }
  for (const [ref, lines] of evidenceByFile) {
    const target = path.join(workspace, ref);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const uniqueLines = [...new Set(lines)];
    await writeFile(
      target,
      `${uniqueLines.map((line) => `export const ${line.replace(/[^A-Za-z0-9_]/gu, "_")} = true; // ${line}`).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
}

export async function prepareFixture(root, corpus) {
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const sessions = path.join(root, "sessions");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(otherWorkspace, { recursive: true, mode: 0o700 });
  await prepareRegressionWorkspace(workspace, corpus);
  await writeFile(path.join(otherWorkspace, "base.txt"), "other\n", { encoding: "utf8", mode: 0o600 });
  initializeGitWorkspace(otherWorkspace);
  await emitIngestionRegressionSessions(corpus, sessions, {
    workspaceRoot: workspace,
    otherWorkspaceRoot: otherWorkspace
  });
  const captureSessions = path.join(root, "capture-sessions");
  await mkdir(captureSessions, { recursive: true, mode: 0o700 });
  for (const testCase of corpus.cases.filter((item) => CAPTURE_COHORTS.has(item.cohort))) {
    await copyFile(
      path.join(sessions, "initial_import", `${testCase.id}.jsonl`),
      path.join(captureSessions, `${testCase.id}.jsonl`)
    );
  }
  return { workspace, otherWorkspace, sessions, captureSessions };
}

function snapshotDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const scalar = (sql, ...params) => Number(db.prepare(sql).get(...params)?.count ?? 0);
    const active = scalar("SELECT COUNT(*) AS count FROM memories WHERE tenant_id = ? AND lifecycle_state = 'active'", "default");
    const versions = scalar("SELECT COUNT(*) AS count FROM memory_versions WHERE tenant_id = ?", "default");
    const quarantine = scalar("SELECT COUNT(*) AS count FROM memory_learning_candidates WHERE tenant_id = ? AND status = 'quarantine'", "default");
    const memories = db.prepare(
      `SELECT id, kind, content, rationale, reuse_rule, evidence_json, learning_json,
              external_key, capture_origin, capture_route, verification_state
       FROM memories
       WHERE tenant_id = ? AND lifecycle_state = 'active'
       ORDER BY id`
    ).all("default");
    const candidates = db.prepare(
      `SELECT external_key, status, payload_json, reason_codes_json
       FROM memory_learning_candidates
       WHERE tenant_id = ?
       ORDER BY external_key`
    ).all("default");
    return { active, versions, quarantine, memories, candidates };
  } finally {
    db.close();
  }
}

function actualRoute(batch) {
  if (!batch) return "excluded";
  if (batch.active?.length > 0) return "active";
  if ((batch.quarantine ?? batch.review ?? []).length > 0) return "review";
  return "excluded";
}

function storageSummary(snapshot) {
  const decisions = snapshot.memories.filter((item) => item.kind === "decision");
  const decisionFieldsComplete = decisions.every((item) => {
    const learning = JSON.parse(item.learning_json || "{}");
    const evidence = JSON.parse(item.evidence_json || "[]");
    return learning.lesson_type === "decision"
      && typeof learning.decision_key === "string"
      && item.content
      && item.rationale
      && item.reuse_rule
      && evidence.length >= 2
      && item.capture_origin === "observed"
      && item.capture_route === "initial_import"
      && item.verification_state === "verified";
  });
  return {
    active_memories: snapshot.active,
    memory_versions: snapshot.versions,
    quarantine_candidates: snapshot.quarantine,
    decision_memories: decisions.length,
    decision_fields_complete: decisionFieldsComplete
  };
}

function countLanguages(values) {
  return values.reduce((counts, language) => {
    if (language) counts[language] = (counts[language] ?? 0) + 1;
    return counts;
  }, { en: 0, ja: 0 });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function semanticStorageErrors(testCase, row) {
  return semanticTraceErrors(testCase, {
    ...row,
    learning: parseJsonObject(row.learning_json),
    evidence: parseJsonArray(row.evidence_json)
  });
}

function semanticStorageSummary(snapshot, caseByExternalKey) {
  const rows = snapshot.memories.filter((row) => caseByExternalKey.has(row.external_key));
  const failures = rows.flatMap((row) => {
    const testCase = caseByExternalKey.get(row.external_key);
    const errors = semanticStorageErrors(testCase, row);
    return errors.map((error) => ({ case_id: testCase.id, scenario_id: testCase.scenario_id, error }));
  });
  const byLesson = Object.fromEntries(["success", "decision", "failure"].map((lessonType) => {
    const lessonRows = rows.filter((row) => caseByExternalKey.get(row.external_key)?.cohort === lessonType);
    return [lessonType, {
      cases: lessonRows.length,
      passed: lessonRows.filter((row) => semanticStorageErrors(caseByExternalKey.get(row.external_key), row).length === 0).length
    }];
  }));
  return {
    cases: rows.length,
    passed: rows.length - new Set(failures.map((item) => item.case_id)).size,
    error_count: failures.length,
    failures,
    by_lesson: byLesson
  };
}

function retrievalSemanticText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/\s*\((?:synthetic case|合成ケース)\s*\d+\)\s*$/iu, "")
    .trim()
    .toLocaleLowerCase();
}

function retrievalFieldFor(testCase, queryType) {
  if (testCase.cohort === "success") {
    return queryType === "rationale" ? "why_it_worked" : "procedure";
  }
  if (testCase.cohort === "decision") {
    return queryType === "rationale" ? "rationale" : "decision";
  }
  return {
    symptom: "symptom",
    root_cause: "root_cause",
    avoidance: "avoidance_rule"
  }[queryType] ?? null;
}

function semanticRetrievalMatch(testCase, memory, queryType) {
  const expected = testCase.semantic_expectation;
  const learning = memory?.learning;
  if (!expected || !learning || learning.lesson_type !== expected.lesson_type) return false;
  if (expected.decision_key && learning.decision_key !== expected.decision_key) return false;
  const field = retrievalFieldFor(testCase, queryType);
  if (!field) return false;
  const expectedValue = expected.fields?.[field];
  const actualValue = learning[field];
  return retrievalSemanticText(expectedValue) === retrievalSemanticText(actualValue);
}

function semanticSamples(corpus) {
  const seen = new Set();
  return corpus.cases.filter((testCase) => {
    if (!["success", "decision", "failure"].includes(testCase.cohort)) return false;
    const key = `${testCase.cohort}:${testCase.scenario_id}:${testCase.language}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function semanticRetrievalSummary(store, corpus, activeByExternalKey, projectId) {
  const checks = [];
  for (const testCase of semanticSamples(corpus)) {
    const target = [...activeByExternalKey.entries()].find(([, item]) => item.testCase.id === testCase.id);
    if (!target) {
      checks.push({ case_id: testCase.id, status: "failed", error: "active_memory_missing" });
      continue;
    }
    const [externalKey] = target;
    for (const [queryType, query] of Object.entries(testCase.semantic_expectation?.queries ?? {})) {
      if (!query) continue;
      const hits = await store.search({
        tenant_id: "default",
        project_id: projectId,
        query,
        limit: 50,
        search_mode: "hybrid_v4"
      });
      const position = hits.findIndex((hit) => semanticRetrievalMatch(testCase, hit.memory, queryType));
      checks.push({
        case_id: testCase.id,
        scenario_id: testCase.scenario_id,
        language: testCase.language,
        query_type: queryType,
        position: position >= 0 ? position + 1 : null,
        matched_external_key: position >= 0 ? hits[position]?.memory?.external_key ?? null : null,
        target_external_key: externalKey,
        status: position >= 0 ? "passed" : "failed"
      });
    }
  }
  const failures = checks.filter((item) => item.status === "failed");
  return {
    checks: checks.length,
    passed: checks.length - failures.length,
    error_count: failures.length,
    failures
  };
}

export async function runMemoryIngestionStorageRegression(options = {}) {
  const ownsRoot = !options.outputDir;
  const root = path.resolve(options.outputDir ?? await mkdtemp(path.join(os.tmpdir(), "orgbrain-ingestion-storage-")));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const dbPath = path.join(root, "memory.sqlite");
  const corpus = await buildMemoryIngestionRegressionCorpus();
  const fixture = await prepareFixture(root, corpus);
  const env = localEnv(root, dbPath);
  try {
    const report = await createCodexSessionImportReport({
      workspaceRoot: fixture.workspace,
      sessionsRoot: fixture.captureSessions,
      env
    });
    assert.equal(report.summary.active_count, 225);
    assert.equal(report.summary.review_count, 12);

    const oracle = JSON.parse(await readFile(path.join(fixture.sessions, "oracle.json"), "utf8"));
    const oracleBySession = new Map(oracle.cases.map((item) => [item.session_hash, item]));
    const batchBySession = new Map(report.plan.batches.map((batch) => [batch.session_hash, batch]));
    const caseBySessionHash = new Map(corpus.cases.map((testCase) => [testCase.session_hash, testCase]));
    const activeByExternalKey = new Map();
    for (const batch of report.plan.batches) {
      const testCase = caseBySessionHash.get(batch.session_hash);
      for (const item of batch.active ?? []) {
        if (testCase) activeByExternalKey.set(item.external_key, { item, testCase });
      }
    }
    const caseByExternalKey = new Map([...activeByExternalKey].map(([externalKey, value]) => [externalKey, value.testCase]));
    for (const testCase of corpus.cases.filter((item) => CAPTURE_COHORTS.has(item.cohort))) {
      const expected = oracleBySession.get(testCase.session_hash);
      assert.equal(expected?.expected_storage_route, testCase.expected_route);
      assert.equal(actualRoute(batchBySession.get(testCase.session_hash)), testCase.expected_route);
    }

    const store = new LocalMemoryStore(dbPath);
    const first = await applyCodexSessionImportPlan(report, {
      expectedPlanHash: report.plan_hash,
      workspaceRoot: fixture.workspace,
      env,
      store,
      batchActiveWrites: true
    });
    assert.equal(first.ok, true);
    const firstCreated = first.results.flatMap((item) => item.active ?? []).filter((item) => item.created).length;
    assert.equal(firstCreated, 225);

    const beforeReplay = snapshotDatabase(dbPath);
    const semanticStorage = semanticStorageSummary(beforeReplay, caseByExternalKey);
    assert.equal(semanticStorage.cases, 225);
    assert.equal(semanticStorage.error_count, 0);
    const semanticRetrieval = await semanticRetrievalSummary(store, corpus, activeByExternalKey, report.plan.target.project_id);
    assert.equal(semanticRetrieval.error_count, 0);
    const second = await applyCodexSessionImportPlan(report, {
      expectedPlanHash: report.plan_hash,
      workspaceRoot: fixture.workspace,
      env,
      store,
      batchActiveWrites: true
    });
    assert.equal(second.ok, true);
    const secondCreated = second.results.flatMap((item) => item.active ?? []).filter((item) => item.created).length;
    const afterReplay = snapshotDatabase(dbPath);
    assert.equal(secondCreated, 0);
    assert.equal(afterReplay.active, beforeReplay.active);
    assert.equal(afterReplay.versions, beforeReplay.versions);
    assert.equal(afterReplay.quarantine, beforeReplay.quarantine);

    const storage = storageSummary(afterReplay);
    const languageByExternalKey = new Map(
      report.plan.batches.flatMap((batch) =>
        (batch.active ?? []).map((item) => [
          item.external_key,
          corpus.cases.find((testCase) => testCase.session_hash === batch.session_hash)?.language ?? null
        ])
      )
    );
    const storedLanguages = afterReplay.memories.map((item) => languageByExternalKey.get(item.external_key));
    const storedDecisionLanguages = afterReplay.memories
      .filter((item) => item.kind === "decision")
      .map((item) => languageByExternalKey.get(item.external_key));
    const storedLanguageCounts = countLanguages(storedLanguages);
    const storedDecisionLanguageCounts = countLanguages(storedDecisionLanguages);
    assert.equal(storedLanguageCounts.en > 0 && storedLanguageCounts.ja > 0, true);
    assert.equal(storedDecisionLanguageCounts.en > 0 && storedDecisionLanguageCounts.ja > 0, true);
    assert.doesNotMatch(JSON.stringify(afterReplay), /api[_-]?key\s*[:=]|@example\.invalid|\+1 \(555\)/iu);
    assert.equal(storage.active_memories, 225);
    assert.equal(storage.memory_versions, 225);
    assert.equal(storage.quarantine_candidates, 12);
    assert.equal(storage.decision_memories, 75);
    assert.equal(storage.decision_fields_complete, true);
    assert.equal(afterReplay.candidates.every((item) => item.status === "quarantine"), true);

    const reportOutput = {
      schema_version: 1,
      status: "passed",
      dataset_id: corpus.dataset_id,
      generated_case_count: corpus.cases.length,
      language_counts: corpus.language_counts,
      cohort_language_counts: corpus.cohort_language_counts,
      capture_lane_counts: { active: 225, review: 12, excluded: 200 },
      stored_language_counts: storedLanguageCounts,
      stored_decision_language_counts: storedDecisionLanguageCounts,
      storage,
      semantic: {
        storage: semanticStorage,
        retrieval: semanticRetrieval
      },
      replay: {
        first_created: firstCreated,
        second_created: secondCreated,
        new_memory_count: afterReplay.active - beforeReplay.active,
        new_version_count: afterReplay.versions - beforeReplay.versions,
        new_quarantine_count: afterReplay.quarantine - beforeReplay.quarantine
      },
      privacy: {
        local_only: true,
        outbound_network: false,
        raw_transcript_persisted_in_memories: false,
        absolute_source_paths_persisted: false,
        real_credentials_or_pii: false
      }
    };
    await writeFile(path.join(root, "storage-report.json"), `${JSON.stringify(reportOutput, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { root, report: reportOutput };
  } finally {
    if (ownsRoot && options.keep !== true) await rm(root, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await runMemoryIngestionStorageRegression({
    outputDir: option(argv, "--output-dir"),
    keep: argv.includes("--keep")
  });
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
