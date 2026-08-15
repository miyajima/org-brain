#!/usr/bin/env node

import { mkdir, chmod, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexSessionImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { evaluateAutonomyCanary } from "../packages/shared/src/autonomy-policy.mjs";

async function writePrivateJson(file, value) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

export async function runCalibrationCanary(args, options) {
  const workspaceRoot = args.get("--workspace", process.cwd());
  const sessionsRoot = args.get("--sessions-root");
  const output = args.get("--output");
  if (!sessionsRoot || !output) throw new Error("canary_requires_sessions_root_and_output");
  const since = args.get("--since") ? Date.parse(args.get("--since")) : Number.NEGATIVE_INFINITY;
  const until = args.get("--until") ? Date.parse(args.get("--until")) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(since) && since !== Number.NEGATIVE_INFINITY) throw new Error("since_must_be_iso_8601");
  if (!Number.isFinite(until) && until !== Number.POSITIVE_INFINITY) throw new Error("until_must_be_iso_8601");
  if (since > until) throw new Error("since_must_not_be_after_until");
  const report = await createCodexSessionImportReport({ workspaceRoot, sessionsRoot, since, until });
  const minimumTurns = Number(args.get("--min-turns", 200));
  const minimumAuditSamples = Number(args.get("--min-audit-samples", 50));
  const active = report.plan.batches.flatMap((batch) => batch.active);
  const quarantineFor = (batch) => batch.quarantine ?? batch.review ?? [];
  const review = report.plan.batches.flatMap(quarantineFor);
  const excluded = report.plan.batches.filter((batch) => batch.active.length === 0 && quarantineFor(batch).length === 0);
  const sampleKey = (item) => item?.turn_hash ?? item?.external_key ?? item?.candidate_hash ?? JSON.stringify(item);
  const deterministicSample = (items, key) => [...items]
    .sort((left, right) => hash(`${key}:${sampleKey(left)}`).localeCompare(hash(`${key}:${sampleKey(right)}`)))
    .slice(0, minimumAuditSamples);
  const reviewAuditHashes = deterministicSample(review, "review").map((item) => hash(item.turn_hash ?? JSON.stringify(item)));
  const excludedAuditHashes = deterministicSample(excluded, "excluded").map((item) => hash(item.turn_hash ?? JSON.stringify(item)));
  const enoughTurns = report.summary.turns_scanned >= minimumTurns;
  const enoughAuditSamples = reviewAuditHashes.length >= minimumAuditSamples && excludedAuditHashes.length >= minimumAuditSamples;
  const runnerPath = args.get("--judge-runner");
  let aiAudit = { status: "not_run", complete: false, disagreement_count: 0, route_mismatch_count: 0, active_rejected_count: 0, results: [] };
  if (runnerPath && enoughTurns && enoughAuditSamples) {
    const runner = await import(pathToFileURL(path.resolve(runnerPath)).href);
    if (typeof runner.runCanaryJudge !== "function") throw new Error("judge_runner_must_export_runCanaryJudge");
    const auditCandidates = [
      ...active.map((candidate) => ({ candidate, expected: "active" })),
      ...deterministicSample(review, "review").map((candidate) => ({ candidate, expected: "quarantine" })),
      ...deterministicSample(excluded, "excluded").map((candidate) => ({ candidate, expected: "excluded" }))
    ];
    for (const item of auditCandidates) {
      // Never disclose the deterministic expected route to the judge.  The
      // canary compares the returned route after the blind council run.
      const judgments = await runner.runCanaryJudge({ candidate: item.candidate });
      const verdicts = Array.isArray(judgments) ? judgments : [];
      const families = new Set(verdicts.map((judgment) => judgment?.model_family).filter(Boolean));
      const correct = verdicts.length >= 3 && families.size >= 2 && verdicts.every((judgment) => {
        if (judgment?.route !== undefined) return judgment.route === item.expected;
        return item.expected === "active" ? judgment?.verdict === "pass" : judgment?.verdict === "fail";
      });
      const pass = correct;
      const disagreement = verdicts.length < 3 || families.size < 2 || new Set(verdicts.map((judgment) => `${judgment?.verdict}:${judgment?.route ?? ""}`)).size > 1;
      const routeMismatch = verdicts.some((judgment) => judgment?.route !== undefined
        ? judgment.route !== item.expected
        : item.expected === "active" ? judgment?.verdict !== "pass" : judgment?.verdict !== "fail");
      aiAudit.results.push({ candidate_hash: hash(item.candidate.turn_hash ?? JSON.stringify(item.candidate)), expected_route: item.expected, pass, disagreement, route_mismatch: routeMismatch });
      if (disagreement) aiAudit.disagreement_count += 1;
      if (routeMismatch) aiAudit.route_mismatch_count += 1;
      if (item.expected === "active" && !pass) aiAudit.active_rejected_count += 1;
    }
    aiAudit.complete = true;
    aiAudit.status = aiAudit.disagreement_count === 0 && aiAudit.route_mismatch_count === 0 && aiAudit.active_rejected_count === 0 ? "complete" : "failed";
  }
  const hardViolationCount = active.filter((item) => (item.reason_codes ?? []).some((code) => /credential|pii|scope|unsafe|self_attest|transient/iu.test(code))).length;
  const observedOutcomes = evaluateAutonomyCanary({
    turns_scanned: report.summary.turns_scanned,
    active_candidates: active.length,
    active_deterministic_verified_count: aiAudit.complete ? active.length - aiAudit.active_rejected_count : 0,
    active_profile_agreement_count: aiAudit.complete && aiAudit.disagreement_count === 0 && aiAudit.route_mismatch_count === 0 ? active.length : 0,
    active_two_model_family_count: aiAudit.complete && aiAudit.disagreement_count === 0 && aiAudit.route_mismatch_count === 0 ? active.length : 0,
    quarantine_audit_samples: reviewAuditHashes.length,
    excluded_audit_samples: excludedAuditHashes.length,
    observed_days: Number(args.get("--observed-days", 0)),
    reask_rate: Number(args.get("--reask-rate", 1)),
    retrieval_coverage: Number(args.get("--retrieval-coverage", 0.0)),
    contradiction_count: Number(args.get("--contradictions", 0)),
    hard_violation_count: hardViolationCount,
    disagreement_count: aiAudit.disagreement_count + aiAudit.route_mismatch_count,
    scope_violation_count: 0,
    privacy_violation_count: 0
  });
  const result = {
    schema_version: options.schemaVersion,
    dataset_id: `${options.datasetId}-real-canary`,
    status: !enoughTurns || !enoughAuditSamples ? "insufficient_evidence" : !aiAudit.complete ? "requires_ai_audit" : observedOutcomes.passed ? "qualified" : "not_qualified",
    passed: aiAudit.complete && observedOutcomes.passed,
    turns_scanned: report.summary.turns_scanned,
    minimum_turns: minimumTurns,
    active_candidates: active.length,
    quarantine_candidates: review.length,
    review_candidates: review.length,
    excluded_turns: report.summary.excluded_turn_count,
    human_review_required: false,
    active_human_review_count: 0,
    active_ai_review_count: aiAudit.complete ? active.length : 0,
    ai_audit: { status: aiAudit.status, complete: aiAudit.complete, disagreement_count: aiAudit.disagreement_count, route_mismatch_count: aiAudit.route_mismatch_count, active_rejected_count: aiAudit.active_rejected_count },
    observed_outcomes: observedOutcomes,
    hard_violation_count: hardViolationCount,
    audit_samples: { review: reviewAuditHashes, excluded: excludedAuditHashes },
    audit_sample_minimum: minimumAuditSamples,
    audit_samples_complete: enoughAuditSamples,
    privacy: {
      raw_transcript_copied: false,
      reasoning_read: false,
      absolute_source_paths_persisted: false,
      command_output_persisted: false
    }
  };
  await writePrivateJson(output, result);
  process.stdout.write(`${JSON.stringify({ ok: result.passed, status: result.status, output: path.resolve(output) })}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}
