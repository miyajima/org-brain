import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateIngestion } from "./memory-ingestion-evaluate.mjs";
import { disposeQualityRun, viewQualityRun } from "./memory-quality-run.mjs";

test("private mac run persists hashes only and disposes only marked run directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orgbrain-private-quality-"));
  const sessions = path.join(root, "sessions");
  const output = path.join(root, "runs", "run-safe");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "one.jsonl"), [
    { type: "session_meta", timestamp: "2026-08-16T00:00:00Z", payload: { id: "private-session", cwd: root, thread_source: "user" } },
    { type: "event_msg", timestamp: "2026-08-16T00:00:01Z", payload: { type: "agent_message", phase: "final_answer", message: "private@example.com used /Users/private/work" } }
  ].map(JSON.stringify).join("\n"));
  const { report } = await evaluateIngestion({ input: "mac", outputDir: output, sessionsRoot: sessions, runId: "run-safe", judgeMode: "local" });
  assert.equal(report.status, "insufficient_evidence");
  const persisted = await readFile(path.join(output, "report.json"), "utf8");
  assert.doesNotMatch(persisted, /private@example|\/Users\/private/u);
  assert.equal(viewQualityRun(["--run-id", "run-safe", "--quality-root", path.join(root, "runs")]).run_id, "run-safe");
  assert.equal(disposeQualityRun(["--dispose", "--run-id", "run-safe", "--quality-root", path.join(root, "runs")]).disposed, true);
});

test("generated run evaluates both parsers and records Wilson dimensions instead of blanket quarantine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orgbrain-generated-quality-"));
  const output = path.join(root, "runs", "generated");
  const { report } = await evaluateIngestion({ input: "generated", outputDir: output, runId: "generated", judgeMode: "local" });

  assert.equal(report.status, "insufficient_evidence");
  assert.equal(report.insufficiency_reason, "private_judge_unavailable");
  assert.equal(report.parity.mismatches, 0);
  assert.equal(report.parity.candidate_hashes_checked > 0, true);
  assert.equal(report.route_counts.quarantine > 0, true);
  assert.deepEqual(report.language_counts, { en: 519, ja: 518 });
  assert.equal(report.route_counts_by_language.en.active > 0, true);
  assert.equal(report.route_counts_by_language.ja.active > 0, true);
  assert.equal(report.semantic.cases_checked, 225);
  assert.equal(report.semantic.error_count, 0);
  assert.equal(report.semantic.by_lesson.decision.error_count, 0);
  assert.equal(report.semantic.by_lesson.failure.error_count, 0);
  assert.equal(report.semantic.by_language.en.error_count, 0);
  assert.equal(report.semantic.by_language.ja.error_count, 0);
  assert.equal(report.dimensions.semantic_completeness.denominator, report.counts.cases);
  assert.equal(report.dimensions.semantic_completeness.wilson_lower !== null, true);
  assert.equal(report.loopback.api.run_id, "generated");
  assert.equal(report.privacy.raw_transcript_persisted, false);
  assert.doesNotMatch(await readFile(path.join(output, "report.json"), "utf8"), /\/private\/tmp|\/Users\//u);
});
