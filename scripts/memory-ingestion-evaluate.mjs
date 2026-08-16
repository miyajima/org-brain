#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildPrivateCorpusManifest } from "./memory-learning-corpus.mjs";
import { buildMemoryIngestionRegressionCorpus, emitIngestionRegressionSessions } from "./memory-ingestion-regression.mjs";

const markerName = "bundle-marker.json";
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function option(argv, name, fallback = null) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; }
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
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
  if (options.input === "generated") {
    const corpus = await buildMemoryIngestionRegressionCorpus();
    const generatedRoot = path.join(output, "generated");
    const generatedManifest = await emitIngestionRegressionSessions(corpus, generatedRoot);
    manifest = { schema_version: 1, input: "generated", counts: { sessions: corpus.cases.length, projects: 1 }, privacy: corpus.privacy, generated: generatedManifest };
    cases = corpus.cases.map((item) => ({ case_hash: hash(item.id), session_hash: item.session_hash, project_hash: hash("synthetic"), split: item.split, expected_route: item.expected_route, actual_route: "quarantine", reason_codes: ["requires_independent_locked_oracle"] }));
  } else if (options.input === "mac") {
    manifest = buildPrivateCorpusManifest(path.resolve(options.sessionsRoot || path.join(os.homedir(), ".codex", "sessions")));
    cases = manifest.sessions.map((item, index) => ({ case_hash: hash(`${item.session_hash}:${item.source_path_hash}:${item.split}:${index}`), session_hash: item.session_hash, project_hash: item.project_hash, split: item.split, expected_route: null, actual_route: "quarantine", reason_codes: [item.workspace_state === "missing" ? "workspace_missing" : "requires_private_judge"] }));
  } else {
    throw new Error("--input must be generated or mac");
  }

  const denominator = cases.length;
  const status = "insufficient_evidence";
  const report = {
    schema_version: 1,
    run_id: runId,
    input_source: options.input === "mac" ? "real" : "synthetic",
    status,
    judge_mode: options.judgeMode || "local",
    ground_truth_basis: options.input === "generated" ? "independent_locked_oracle_required" : "held_out_query_pending",
    network,
    counts: { sessions: manifest.counts.sessions ?? denominator, projects: manifest.counts.projects ?? 1, cases: denominator },
    privacy: { raw_transcript_persisted: false, reasoning_persisted: false, absolute_path_persisted: false, credential_value_persisted: false },
    insufficiency_reason: denominator < 75 ? "minimum_75_cases_not_met" : "private_judge_or_locked_oracle_required"
  };
  const db = createDatabase(path.join(output, "quality.sqlite"));
  db.prepare("INSERT OR REPLACE INTO quality_runs VALUES (?, ?, ?, ?, ?, ?)").run(runId, report.input_source, status, hash(JSON.stringify(manifest)), JSON.stringify(report.privacy), Date.now());
  db.prepare("DELETE FROM quality_cases").run();
  const insert = db.prepare("INSERT OR REPLACE INTO quality_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of cases) insert.run(item.case_hash, item.session_hash, item.project_hash, item.split, options.input === "mac" ? "initial_import" : "realtime_hook", item.expected_route, item.actual_route, JSON.stringify(item.reason_codes), 0, 0);
  for (const axis of ["semantic_completeness", "evidence_support", "rationale_quality", "future_reuse", "scope_specificity", "freshness_validity", "atomicity"]) {
    db.prepare("INSERT OR REPLACE INTO quality_dimensions VALUES (?, ?, ?, NULL, NULL, 0)").run(axis, 0, denominator);
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
