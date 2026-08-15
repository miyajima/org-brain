import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  autonomyPolicyHash,
  DEFAULT_AUTONOMY_POLICY,
  evaluateAutonomyConsensus,
  evaluateAutonomyCanary,
  evaluateAutonomyPostApply,
  normalizeAutonomyPolicy,
  advanceAutonomyMode,
  tuneAutonomyPolicy
} from "../../shared/src/autonomy-policy.mjs";
import { evaluateMemoryIngestionAutonomousQualification } from "../../shared/src/memory-quality-certifier.mjs";
import {
  loadWorkspaceConfig,
  normalizeWorkspaceRoot,
  saveWorkspaceConfig,
  autonomyPolicyFromWorkspaceEntry,
  autonomyPolicyFromWorkspaceConfig,
  workspacesFileFromEnv
} from "./lib/workspace-config.mjs";
import { DEFAULT_LOCAL_DB, LocalMemoryStore } from "./lib/local-memory-store.mjs";
import { TaskCommitmentStore } from "./lib/task-commitment-store.mjs";
import { runPersonalMaintenance } from "./personal-maintenance.mjs";
import { captureLocalMemories, loadEnvFallbacks } from "./hook-memory-bridge.mjs";
import {
  applyCodexSessionImportPlan,
  attachAutonomousConsensus,
  createCodexSessionImportReport,
  quarantineCodexSessionImportReport
} from "./codex-session-import.mjs";

const DEFAULT_AUTONOMY_STATE_DIR = path.join(os.homedir(), ".config", "org-brain", "autonomy");

function autonomyStateDirectory(env = process.env) {
  return path.resolve(env.ORGBRAIN_AUTONOMY_STATE_DIR?.trim() || DEFAULT_AUTONOMY_STATE_DIR);
}

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/(?:Users|home|private|var|tmp)\/[^/\s]+(?:\/[^\s`'"),:]+)+/gu, "[REDACTED_PATH]")
    .slice(0, 500);
}

function safeQualificationEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
    ? value.evidence
    : value;
  const safePrivacyKeys = new Set(["privacy", "raw_transcript_copied", "reasoning_persisted", "command_output_persisted", "absolute_source_paths_persisted"]);
  const project = (current, key = "") => {
    if (!safePrivacyKeys.has(key) && /(?:raw|transcript|reasoning|chain.of.thought|command_output|surface_text|selectedCases|gold|predictions|rows|messages?|reviewer|human[_-]?signature|manual[_-]?approval|adjudicator)/iu.test(key)) return undefined;
    if (typeof current === "string") {
      if (/sk-[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{20,}|Bearer\s+|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|\/(?:Users|home|private|var|tmp)\/[^/]+\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(current)) {
        throw new Error("qualification_evidence_privacy_violation");
      }
      return current;
    }
    if (Array.isArray(current)) return current.map((item) => project(item, key)).filter((item) => item !== undefined);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current)
      .map(([childKey, child]) => [childKey, project(child, childKey)])
      .filter(([, child]) => child !== undefined));
  };
  const projected = project(input);
  const serialized = JSON.stringify(projected);
  const privacyViolation = serialized.match(/raw_transcript[^:]*:\s*true|reasoning[^:]*:\s*true|command_output[^:]*:\s*true|chain.of.thought|"[^"\n]*(?:credential|password|secret|api[_-]?key|email|phone|ssn|address)[^"\n]*"\s*:\s*(?!false\b|null\b|0\b|""\s*[,}])[^,}]+|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{20,}|\/(?:Users|home|private|var|tmp)\/[^/]+\//iu);
  if (privacyViolation) {
    throw new Error(`qualification_evidence_privacy_violation:${privacyViolation[0].slice(0, 120)}`);
  }
  return JSON.parse(serialized);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writePrivateJson(file, value) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

async function loadAutonomyEvidence(stateDirectory, explicit = null) {
  const input = explicit ?? await readJson(path.join(stateDirectory, "qualification-evidence.json"), null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const machineReference = (input.machine_reference ?? input.autonomous_qualification) && typeof (input.machine_reference ?? input.autonomous_qualification) === "object"
    ? (input.machine_reference ?? input.autonomous_qualification)
    : {};
  const canary = input.canary && typeof input.canary === "object" ? input.canary : {};
  const outcomes = input.observed_outcomes && typeof input.observed_outcomes === "object"
    ? input.observed_outcomes
    : canary.observed_outcomes && typeof canary.observed_outcomes === "object"
      ? canary.observed_outcomes
      : {};
  const machineReferenceReport = machineReference.autonomous_qualification && typeof machineReference.autonomous_qualification === "object"
    ? machineReference.autonomous_qualification
    : machineReference;
  const machineReferenceQualified = evaluateMemoryIngestionAutonomousQualification(machineReferenceReport).pass === true;
  const canaryObservation = canary.observed_outcomes && typeof canary.observed_outcomes === "object" ? canary.observed_outcomes : canary;
  const canaryQualified = canary.passed === true && evaluateAutonomyCanary(canaryObservation).passed === true;
  const observedOutcomesQualified = outcomes.passed === true;
  const hardViolationCount = Number(canaryObservation.hard_violation_count ?? outcomes.hard_violation_count ?? 0);
  const disagreementCount = Number(canaryObservation.disagreement_count ?? outcomes.disagreement_count ?? 0);
  const scopeViolationCount = Number(canaryObservation.scope_violation_count ?? outcomes.scope_violation_count ?? 0);
  const privacyViolationCount = Number(canaryObservation.privacy_violation_count ?? outcomes.privacy_violation_count ?? 0);
  const retrievalCoverage = Number(canaryObservation.retrieval_coverage ?? outcomes.retrieval_coverage ?? 1);
  const qualityObservationReady = canary.passed === true || outcomes.passed === true || Number(canaryObservation.observed_days ?? outcomes.observed_days ?? 0) >= 7;
  return {
    machine_reference_qualified: machineReferenceQualified,
    canary_qualified: canaryQualified,
    observed_outcomes_qualified: observedOutcomesQualified,
    rollback_ready: input.rollback_ready === true || input.rollback?.ready === true,
    minimum_confidence_delta: Number.isFinite(Number(input.minimum_confidence_delta)) ? Number(input.minimum_confidence_delta) : 0,
    hard_violation_count: Number.isFinite(hardViolationCount) ? Math.max(0, hardViolationCount) : 0,
    disagreement_count: Number.isFinite(disagreementCount) ? Math.max(0, disagreementCount) : 0,
    scope_violation_count: Number.isFinite(scopeViolationCount) ? Math.max(0, scopeViolationCount) : 0,
    privacy_violation_count: Number.isFinite(privacyViolationCount) ? Math.max(0, privacyViolationCount) : 0,
    retrieval_coverage: Number.isFinite(retrievalCoverage) ? retrievalCoverage : 1,
    quality_observation_ready: qualityObservationReady,
    evidence_hash: hash(JSON.stringify({
      machine_reference_qualified: machineReferenceQualified,
      canary_qualified: canaryQualified,
      observed_outcomes_qualified: observedOutcomesQualified,
      rollback_ready: input.rollback_ready === true || input.rollback?.ready === true,
      minimum_confidence_delta: Number.isFinite(Number(input.minimum_confidence_delta)) ? Number(input.minimum_confidence_delta) : 0
    }))
  };
}

function autonomyScope(options = {}) {
  const scope = String(options.scope ?? "workspace").trim().toLowerCase();
  if (scope !== "workspace" && scope !== "tenant") throw new Error("autonomy scope must be workspace or tenant");
  return scope;
}

function stateFileFor(workspaceRoot, tenantId = "default", projectId = "global", env = process.env, scope = "workspace") {
  const normalizedScope = scope === "tenant" ? "tenant" : "workspace";
  const identity = normalizedScope === "tenant" ? `${tenantId}` : `${workspaceRoot}\0${tenantId}\0${projectId}`;
  const key = hash(`${normalizedScope}\0${identity}`).slice(7, 31);
  return path.join(autonomyStateDirectory(env), `${key}.json`);
}

async function workspaceEntry(workspaceRoot, env = process.env) {
  const normalized = normalizeWorkspaceRoot(workspaceRoot || process.cwd());
  const file = workspacesFileFromEnv(env);
  const config = await loadWorkspaceConfig(file);
  const existing = config.workspaces[normalized] ?? {
    tenant_id: env.ORGBRAIN_TENANT_ID?.trim() || null,
    project_id: path.basename(normalized) || null
  };
  return { normalized, file, config, existing };
}

function policyForEntry(entry) {
  return entry ? autonomyPolicyFromWorkspaceEntry(entry) : normalizeAutonomyPolicy(DEFAULT_AUTONOMY_POLICY);
}

function policyForScope(entry, config, scope) {
  return scope === "tenant"
    ? autonomyPolicyFromWorkspaceConfig(entry, config)
    : policyForEntry(entry);
}

export async function getAutonomyStatus(options = {}) {
  const { normalized, config, existing } = await workspaceEntry(options.workspaceRoot, options.env);
  const scope = autonomyScope(options);
  const policy = policyForScope(existing, config, scope);
  const stateFile = options.stateFile
    ? path.resolve(options.stateFile)
    : stateFileFor(normalized, existing.tenant_id ?? "default", existing.project_id ?? "global", options.env, scope);
  const state = await readJson(stateFile, null);
  return {
    ok: true,
    workspace: normalized,
    scope,
    tenant_id: existing.tenant_id ?? "default",
    project_id: existing.project_id ?? path.basename(normalized),
    policy,
    policy_hash: autonomyPolicyHash(policy),
    state_file: stateFile,
    state
  };
}

export async function configureAutonomy(options = {}) {
  const { normalized, file, config, existing } = await workspaceEntry(options.workspaceRoot, options.env);
  const scope = autonomyScope(options);
  const current = policyForScope(existing, config, scope);
  const next = normalizeAutonomyPolicy(options.policy ?? {
    ...current,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.autoAdvance === false ? { auto_advance: false } : {}),
    judge: { ...current.judge, ...(options.judgeExecution ? { execution: options.judgeExecution } : {}) }
  });
  if (scope === "tenant") {
    const tenantId = existing.tenant_id ?? options.env?.ORGBRAIN_TENANT_ID?.trim() ?? null;
    if (!tenantId) throw new Error("tenant autonomy scope requires a tenant mapping");
    config.tenants = { ...(config.tenants ?? {}), [tenantId]: { autonomy: next } };
  } else {
    config.workspaces[normalized] = { ...existing, autonomy: next };
  }
  if (!options.execute) {
    return { ok: true, dry_run: true, workspace: normalized, scope, policy: next, policy_hash: autonomyPolicyHash(next) };
  }
  await saveWorkspaceConfig(file, config);
  const status = await getAutonomyStatus({ workspaceRoot: normalized, scope, env: options.env });
  return { ...status, configured: true };
}

export async function freezeAutonomy(options = {}) {
  return configureAutonomy({ ...options, mode: "shadow", execute: options.execute === true, autoAdvance: false });
}

export async function runAutonomyMaintenance(options = {}) {
  await loadEnvFallbacks().catch(() => undefined);
  const status = await getAutonomyStatus(options);
  const stateFile = status.state_file;
  const stateDirectory = path.dirname(stateFile);
  const runId = hash(`${status.policy_hash}:${Date.now()}:${Math.random()}`).slice(7, 31);
  const startedAt = Date.now();
  const inspectOnly = options.dryRun === true;
  const shadowMode = status.policy.mode === "shadow";
  // Shadow suppresses active/semantic promotion, but it still persists
  // privacy-safe quarantine candidates so the automatic loop can retry them.
  // An explicit --dry-run remains completely non-mutating.
  const dryRun = inspectOnly || shadowMode;
  const previousRun = status.state?.last_run ?? null;
  const sessionScanSince = previousRun?.session_scan?.applied === true && Number.isFinite(Number(previousRun.finished_at))
    ? Number(previousRun.finished_at)
    : Number.NEGATIVE_INFINITY;
  let sessionReport = null;
  let sessionApplyFailed = false;
  let sessionScan = null;
  if (options.scanSessions === true) {
    try {
      sessionReport = await createCodexSessionImportReport({
        workspaceRoot: status.workspace,
        sessionsRoot: options.sessionsRoot,
        since: sessionScanSince,
        env: options.env
      });
      sessionScan = {
        plan_hash: sessionReport.plan_hash,
        summary: sessionReport.summary,
        applied: false,
        mode: dryRun ? "shadow" : "planned"
      };
    } catch (error) {
      sessionScan = { applied: false, mode: "quarantine", error: safeError(error) };
    }
  }
  let judgeConsensus = null;
  let judgeError = null;
  let judgeRunnerModule = null;
  const configuredJudgeRunner = options.judgeRunner
    ?? options.env?.ORGBRAIN_AUTONOMY_JUDGE_RUNNER
    ?? process.env.ORGBRAIN_AUTONOMY_JUDGE_RUNNER
    ?? null;
  if (options.judgeConsensus && Array.isArray(options.judgeConsensus.judgments)) {
    const supplied = options.judgeConsensus;
    judgeConsensus = evaluateAutonomyConsensus(supplied.judgments, {
      requiredJudges: status.policy.judge.active_consensus,
      minimumModelFamilies: status.policy.judge.minimum_model_families,
      minimumConfidence: status.policy.judge.minimum_confidence,
      requireSignatures: true
    });
  }
  if (!judgeConsensus && configuredJudgeRunner && status.policy.judge.execution !== "deny" && !inspectOnly && !shadowMode) {
    try {
      judgeRunnerModule = await import(pathToFileURL(path.resolve(configuredJudgeRunner)).href);
      if (typeof judgeRunnerModule.runAutonomyJudge !== "function") throw new Error("judge_runner_must_export_runAutonomyJudge");
      const judgments = await judgeRunnerModule.runAutonomyJudge({ action: "maintenance", policy: status.policy, workspace: status.workspace });
      judgeConsensus = evaluateAutonomyConsensus(judgments, {
        requiredJudges: status.policy.judge.active_consensus,
        minimumModelFamilies: status.policy.judge.minimum_model_families,
        minimumConfidence: status.policy.judge.minimum_confidence,
        requireSignatures: true
      });
    } catch (error) {
      judgeError = safeError(error);
      judgeConsensus = { status: "insufficient_evidence", pass: false, quarantine: true, judgments: [] };
    }
  }
  let sessionJudgeConsensus = null;
  let sessionJudgeError = null;
  if (sessionReport && sessionReport.summary.active_count > 0 && !inspectOnly && !shadowMode) {
    if (status.policy.judge.execution === "deny" || !judgeRunnerModule?.runAutonomyJudge) {
      sessionJudgeConsensus = { status: "insufficient_evidence", pass: false, quarantine: true, judgments: [] };
      sessionJudgeError = status.policy.judge.execution === "deny" ? "judge_execution_denied" : "session_judge_unavailable";
    } else {
      try {
        const candidateProjections = sessionReport.plan.batches.flatMap((batch) => batch.active).map((item) => ({
          candidate_hash: String(item.external_key ?? ""),
          lesson_type: item.learning?.lesson_type ?? null,
          verification_state: item.verification_state ?? item.verification?.state ?? null,
          evidence_count: Array.isArray(item.evidence) ? item.evidence.length : 0,
          capture_origin: item.capture_origin ?? null
        }));
        const judgments = await judgeRunnerModule.runAutonomyJudge({
          action: "session-import",
          policy: status.policy,
          workspace: status.workspace,
          plan_hash: sessionReport.plan_hash,
          candidates: candidateProjections
        });
        sessionJudgeConsensus = evaluateAutonomyConsensus(judgments, {
          requiredJudges: status.policy.judge.active_consensus,
          minimumModelFamilies: status.policy.judge.minimum_model_families,
          minimumConfidence: status.policy.judge.minimum_confidence,
          requireSignatures: true
        });
      } catch (error) {
        sessionJudgeError = safeError(error);
        sessionJudgeConsensus = { status: "insufficient_evidence", pass: false, quarantine: true, judgments: [] };
      }
    }
  }
  if (sessionReport && !inspectOnly && status.policy.maintenance.auto_apply) {
    const activeCount = Number(sessionReport.summary.active_count ?? 0);
    const councilPassed = sessionJudgeConsensus?.pass === true;
    const reportToApply = activeCount > 0 && !councilPassed
      ? quarantineCodexSessionImportReport(sessionReport, { reasonCodes: [sessionJudgeError ?? "ai_consensus_required"] })
      : attachAutonomousConsensus(sessionReport, sessionJudgeConsensus);
    try {
      const applied = await applyCodexSessionImportPlan(reportToApply, {
        expectedPlanHash: reportToApply.plan_hash,
        workspaceRoot: status.workspace,
        env: options.env,
        store: options.store,
        requireAutonomousConsensus: activeCount > 0,
        autonomyPolicy: status.policy,
        quarantineExpireAfterDays: status.policy.quarantine.expire_after_days
      });
      sessionScan = {
        ...sessionScan,
        plan_hash: reportToApply.plan_hash,
        summary: reportToApply.summary,
        applied: applied.ok,
        mode: activeCount > 0 && !councilPassed ? "quarantine" : "applied",
        memory_ids: applied.results.flatMap((item) => (item.active ?? []).map((memory) => memory.memory_id).filter(Boolean)),
        council: sessionJudgeConsensus
          ? { status: sessionJudgeConsensus.status, pass: sessionJudgeConsensus.pass, model_families: sessionJudgeConsensus.model_families }
          : null
      };
      sessionApplyFailed = !applied.ok;
    } catch (error) {
      sessionApplyFailed = true;
      sessionScan = {
        ...sessionScan,
        applied: false,
        mode: "quarantine",
        error: safeError(error),
        council: sessionJudgeConsensus
          ? { status: sessionJudgeConsensus.status, pass: sessionJudgeConsensus.pass, model_families: sessionJudgeConsensus.model_families }
          : null
      };
    }
  } else if (sessionScan && sessionJudgeConsensus) {
    sessionScan.council = {
      status: sessionJudgeConsensus.status,
      pass: sessionJudgeConsensus.pass,
      model_families: sessionJudgeConsensus.model_families
    };
  }
  let qualificationRun = null;
  let qualificationError = null;
  const configuredQualificationRunner = options.qualificationRunner
    ?? options.env?.ORGBRAIN_AUTONOMY_QUALIFICATION_RUNNER
    ?? process.env.ORGBRAIN_AUTONOMY_QUALIFICATION_RUNNER
    ?? null;
  const existingQualificationEvidence = await readJson(path.join(stateDirectory, "qualification-evidence.json"), null);
  if (!inspectOnly && status.policy.judge.execution !== "deny" && !existingQualificationEvidence && configuredQualificationRunner) {
    try {
      const runner = await import(pathToFileURL(path.resolve(configuredQualificationRunner)).href);
      if (typeof runner.runAutonomyQualification !== "function") throw new Error("qualification_runner_must_export_runAutonomyQualification");
      const returned = await runner.runAutonomyQualification({
        workspace: status.workspace,
        tenant_id: status.tenant_id,
        policy: status.policy,
        run_id: runId,
        state_directory: stateDirectory
      });
      const evidence = safeQualificationEvidence(returned);
      if (!evidence) throw new Error("qualification_evidence_missing");
      await writePrivateJson(path.join(stateDirectory, "qualification-evidence.json"), evidence);
      qualificationRun = { status: "completed", evidence_hash: hash(JSON.stringify(evidence)) };
    } catch (error) {
      qualificationError = safeError(error);
      qualificationRun = { status: "failed" };
    }
  } else if (existingQualificationEvidence) {
    qualificationRun = { status: "existing" };
  } else if (configuredQualificationRunner) {
    qualificationRun = { status: inspectOnly ? "deferred_dry_run" : "deferred_policy" };
  }
  const store = options.store ?? new LocalMemoryStore(options.dbPath ?? process.env.ORGBRAIN_LOCAL_DB ?? DEFAULT_LOCAL_DB);
  let result;
  try {
    if (inspectOnly) {
      const doctor = await store.doctor();
      result = {
        ok: doctor.ok,
        skipped: "dry-run",
        applied: false,
        apply_requested: false,
        planned: null,
        applied_counts: { synthesized: 0, suppressed: 0 },
        doctor
      };
    } else {
      result = await runPersonalMaintenance(store, {
        // Shadow suppresses semantic writes, but deterministic Tier-0 repairs
        // (doctor/index repair and expiry bookkeeping) remain safe to run.
        apply: status.policy.maintenance.auto_apply,
        tenantId: status.tenant_id,
        stateFile: options.maintenanceStateFile ?? path.join(stateDirectory, "maintenance-state.json"),
        lockFile: options.lockFile ?? path.join(stateDirectory, "maintenance.lock"),
        stdoutLog: options.stdoutLog ?? path.join(stateDirectory, "maintenance.log"),
        stderrLog: options.stderrLog ?? path.join(stateDirectory, "maintenance-errors.log"),
        autonomyPolicy: status.policy,
        autonomyPolicyHash: status.policy_hash,
        judgeConsensus
      });
    }
  } catch (error) {
    // A failed apply must still produce a durable run record so the automatic
    // circuit breaker can force shadow mode and the next scheduled cycle can
    // retry without operator intervention.
    result = { ok: false, error: safeError(error), applied: false, doctor: { ok: false, errors: [safeError(error)] } };
  }
  let quarantineEvaluator = null;
  let quarantineRunnerError = null;
  const configuredQuarantineRunner = options.quarantineRunner
    ?? options.env?.ORGBRAIN_AUTONOMY_QUARANTINE_RUNNER
    ?? process.env.ORGBRAIN_AUTONOMY_QUARANTINE_RUNNER
    ?? configuredJudgeRunner;
  if (configuredQuarantineRunner && !inspectOnly && !shadowMode && status.policy.judge.execution !== "deny") {
    const runner = await import(pathToFileURL(path.resolve(configuredQuarantineRunner)).href).catch((error) => {
      quarantineRunnerError = safeError(error);
      return null;
    });
    if (runner && typeof runner.runAutonomyJudge !== "function") {
      quarantineRunnerError = "quarantine_runner_must_export_runAutonomyJudge";
    }
    quarantineEvaluator = runner?.runAutonomyJudge ? async ({ candidate }) => {
      const source = candidate?.item && typeof candidate.item === "object" ? candidate.item : candidate;
      const deterministic = source?.deterministic_verification ?? source?.verification;
      if (deterministic?.state !== "verified" || !Array.isArray(source?.evidence) || source.evidence.length === 0) {
        return {
          route: "quarantine",
          verified: false,
          consensus_pass: false,
          reason_codes: ["deterministic_verification_required"]
        };
      }
      const judgments = await runner.runAutonomyJudge({
        action: "quarantine_re-evaluation",
        candidate,
        policy: status.policy,
        workspace: status.workspace
      });
      const consensus = evaluateAutonomyConsensus(judgments, {
        requiredJudges: status.policy.judge.active_consensus,
        minimumModelFamilies: status.policy.judge.minimum_model_families,
        minimumConfidence: status.policy.judge.minimum_confidence,
        requireSignatures: true
      });
      const route = consensus.pass ? "active" : consensus.rejected ? "excluded" : "quarantine";
      return {
        route,
        verified: consensus.pass,
        consensus_pass: consensus.pass,
        judge_consensus: consensus,
        reason_codes: consensus.pass ? [] : ["ai_consensus_required"]
      };
    } : null;
  }
  let candidateMaintenance;
  let candidateMaintenanceFailed = false;
  if (inspectOnly) {
    candidateMaintenance = { dry_run: true, normalized_to_quarantine: 0, expired: 0, reevaluated: 0, promoted: 0, rejected: 0 };
  } else {
    try {
      candidateMaintenance = await new TaskCommitmentStore(options.dbPath ?? options.store?.dbPath ?? process.env.ORGBRAIN_LOCAL_DB ?? DEFAULT_LOCAL_DB)
        .maintainLearningCandidates({
          tenantId: status.tenant_id,
          policyHash: status.policy_hash,
          expireAfterDays: status.policy.quarantine.expire_after_days,
          reevaluateIntervalHours: status.policy.quarantine.reevaluate_interval_hours,
          evaluate: quarantineEvaluator,
          promote: async ({ candidate, outcome }) => {
            const source = candidate?.item && typeof candidate.item === "object" ? candidate.item : candidate;
            const record = {
              ...(source && typeof source === "object" ? source : {}),
              externalKey: source?.externalKey ?? source?.external_key,
              captureOrigin: source?.captureOrigin ?? source?.capture_origin ?? "observed",
              verification: { state: "verified", verified_at: Date.now() },
              verification_state: "verified",
              ai_certification: "ai_consensus_certified",
              judge_consensus: outcome?.judge_consensus ?? null
            };
            const captured = await captureLocalMemories("codex", status.tenant_id, record, { store });
            return {
              ok: Array.isArray(captured),
              memory_count: Array.isArray(captured) ? captured.length : 0,
              memory_ids: Array.isArray(captured) ? captured.map((item) => item?.memory_id).filter(Boolean) : []
            };
          }
        });
    } catch (error) {
      candidateMaintenanceFailed = true;
      candidateMaintenance = { reevaluation_errors: 1, error: safeError(error) };
    }
  }
  const postApplyObservation = options.postApplyObservation && typeof options.postApplyObservation === "object"
    ? options.postApplyObservation
    : {};
  const runPostApply = evaluateAutonomyPostApply({
    hard_violations: postApplyObservation.hard_violations ?? result.autonomy?.hard_violation_count ?? 0,
    retrieval_coverage: postApplyObservation.retrieval_coverage ?? (result.skipped ? 1 : (result.doctor?.ok === true ? 1 : 0)),
    failed_operations: postApplyObservation.failed_operations ?? (result.ok === true && !candidateMaintenanceFailed && !sessionApplyFailed ? 0 : 1)
  }, status.policy);
  const run = {
    schema_version: 1,
    run_id: runId,
    workspace: status.workspace,
    tenant_id: status.tenant_id,
    project_id: status.project_id,
    policy_hash: status.policy_hash,
    input_hash: hash(JSON.stringify({
      session_plan_hash: sessionScan?.plan_hash ?? null,
      planned: result.planned ?? null,
      candidate_quarantine_count: candidateMaintenance?.quarantine_count ?? null
    })),
    mode: status.policy.mode,
    dry_run: dryRun,
    started_at: startedAt,
    finished_at: Date.now(),
    result,
    session_scan: sessionScan,
    candidate_maintenance: candidateMaintenance,
    post_apply: runPostApply,
    rollback_required: runPostApply.rollback_required || result.ok !== true,
    judge_consensus: judgeConsensus,
    judge_error: judgeError,
    session_judge_consensus: sessionJudgeConsensus,
    session_judge_error: sessionJudgeError,
    quarantine_evaluator: quarantineEvaluator ? "configured" : "deferred",
    quarantine_runner_error: quarantineRunnerError,
    qualification_runner: qualificationRun,
    qualification_error: qualificationError
  };
  const qualificationEvidence = await loadAutonomyEvidence(stateDirectory, options.evidence ?? null);
  const evidenceRollbackSignal = qualificationEvidence && (
    qualificationEvidence.hard_violation_count > 0 ||
    qualificationEvidence.disagreement_count > 0 ||
    qualificationEvidence.scope_violation_count > 0 ||
    qualificationEvidence.privacy_violation_count > 0 ||
    (qualificationEvidence.quality_observation_ready && qualificationEvidence.retrieval_coverage < status.policy.rollback.retrieval_coverage_minimum)
  );
  if (evidenceRollbackSignal) {
    run.post_apply = evaluateAutonomyPostApply({
      hard_violations: qualificationEvidence.hard_violation_count,
      retrieval_coverage: qualificationEvidence.retrieval_coverage,
      failed_operations: qualificationEvidence.disagreement_count > 0 || qualificationEvidence.scope_violation_count > 0 || qualificationEvidence.privacy_violation_count > 0 ? 1 : 0
    }, status.policy);
    run.rollback_required = run.post_apply.rollback_required || run.rollback_required;
    run.evidence_rollback_signal = true;
  }
  if (run.post_apply.passed && qualificationEvidence) {
    if (qualificationEvidence.minimum_confidence_delta !== 0 && status.policy.tuning.enabled) {
      const tuningHistory = Array.isArray(status.state?.tuning_history) ? status.state.tuning_history : [];
      const weeklyWindow = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const weeklyDeltaUsed = tuningHistory
        .filter((entry) => Number(entry?.at) >= weeklyWindow)
        .reduce((sum, entry) => sum + Math.abs(Number(entry?.delta) || 0), 0);
      const tuned = tuneAutonomyPolicy(status.policy, { ...qualificationEvidence, weekly_delta_used: weeklyDeltaUsed });
      if (tuned.changed) {
        run.policy_tuning = await configureAutonomy({
          workspaceRoot: status.workspace,
          scope: status.scope,
          env: options.env,
          policy: tuned.policy,
          execute: !inspectOnly
        });
      }
      run.policy_tuning = { ...(run.policy_tuning ?? {}), ...tuned, weekly_delta_used: weeklyDeltaUsed };
    }
    run.mode_transition = await advanceAutonomy({ workspaceRoot: status.workspace, scope: status.scope, env: options.env, execute: !inspectOnly }, qualificationEvidence);
    run.qualification_evidence = qualificationEvidence;
  }
  if (run.post_apply.rollback_required) {
    const promotedMemoryIds = Array.isArray(candidateMaintenance?.promoted_candidates)
      ? candidateMaintenance.promoted_candidates.flatMap((item) => item?.promotion?.memory_ids ?? []).filter(Boolean)
      : [];
    const rollbackResult = await rollbackAutonomy({
      workspaceRoot: status.workspace,
      env: options.env,
      execute: !inspectOnly,
      dbPath: options.dbPath,
      store,
      memoryIds: [...new Set([...(sessionScan?.memory_ids ?? []), ...promotedMemoryIds])]
    });
    run.rollback_applied = rollbackResult.rolled_back === true;
    run.rollback = { dry_run: rollbackResult.dry_run === true, suppressed_memory_count: rollbackResult.suppressed_memory_count ?? 0 };
  } else {
    run.rollback_applied = false;
  }
  const previous = (await readJson(stateFile, {})) ?? {};
  const previousTuningHistory = Array.isArray(previous.tuning_history) ? previous.tuning_history : [];
  const nextTuningHistory = [...previousTuningHistory, ...(run.policy_tuning?.changed
    ? [{ at: Date.now(), delta: Number(run.policy_tuning.delta ?? 0) }]
    : [])]
    .filter((entry) => Number(entry?.at) >= Date.now() - 7 * 24 * 60 * 60 * 1000)
    .slice(-64);
  if (!inspectOnly) {
    const runIsLastKnownGood = result.ok === true && run.post_apply?.passed === true && run.rollback_required !== true;
    await writePrivateJson(stateFile, {
      ...previous,
      last_run: run,
      last_good_policy: runIsLastKnownGood ? status.policy : (previous.last_good_policy ?? status.policy),
      tuning_history: nextTuningHistory
    });
  }
  return { ok: result.ok === true, ...run, state_file: stateFile };
}

export async function explainAutonomyRun(options = {}) {
  const status = await getAutonomyStatus(options);
  const state = await readJson(status.state_file, null);
  if (!state?.last_run) throw new Error("autonomy_run_not_found");
  if (options.runId && state.last_run.run_id !== options.runId) throw new Error("autonomy_run_not_found");
  return { ok: true, run: state.last_run, policy: status.policy, policy_hash: status.policy_hash };
}

export async function rollbackAutonomy(options = {}) {
  const { normalized, file, config, existing } = await workspaceEntry(options.workspaceRoot, options.env);
  const status = await getAutonomyStatus(options);
  const state = await readJson(status.state_file, null);
  if (options.runId && state?.last_run?.run_id !== options.runId) throw new Error("autonomy_run_not_found");
  const previous = normalizeAutonomyPolicy(state?.last_good_policy ?? DEFAULT_AUTONOMY_POLICY);
  const rolledBackPolicy = { ...previous, mode: "shadow", auto_advance: false };
  if (status.scope === "tenant") {
    const tenantId = existing.tenant_id ?? options.env?.ORGBRAIN_TENANT_ID?.trim() ?? null;
    if (!tenantId) throw new Error("tenant autonomy scope requires a tenant mapping");
    config.tenants = { ...(config.tenants ?? {}), [tenantId]: { autonomy: rolledBackPolicy } };
  } else {
    config.workspaces[normalized] = { ...existing, autonomy: rolledBackPolicy };
  }
  if (!options.execute) {
    return { ok: true, dry_run: true, workspace: normalized, scope: status.scope, policy: rolledBackPolicy };
  }
  await saveWorkspaceConfig(file, config);
  const memoryIds = Array.isArray(options.memoryIds)
    ? options.memoryIds.filter(Boolean)
    : Array.isArray(state?.last_run?.session_scan?.memory_ids)
      ? state.last_run.session_scan.memory_ids.filter(Boolean)
      : [];
  let suppressedMemoryCount = 0;
  if (memoryIds.length > 0) {
    const store = options.store ?? new LocalMemoryStore(options.dbPath ?? process.env.ORGBRAIN_LOCAL_DB ?? DEFAULT_LOCAL_DB);
    for (const memoryId of memoryIds) {
      try {
        await store.suppress(status.tenant_id, memoryId, "autonomous rollback", {
          actor_type: "system",
          actor_id: "orgbrain-autonomy"
        });
        suppressedMemoryCount += 1;
      } catch {
        // Rollback remains policy-safe even when an already-deduplicated ID is
        // no longer present locally.
      }
    }
  }
  return {
    ok: true,
    rolled_back: true,
    workspace: normalized,
    scope: status.scope,
    policy: rolledBackPolicy,
    suppressed_memory_count: suppressedMemoryCount
  };
}

export async function advanceAutonomy(options = {}, evidence = {}) {
  const { normalized, file, config, existing } = await workspaceEntry(options.workspaceRoot, options.env);
  const scope = autonomyScope(options);
  const current = policyForScope(existing, config, scope);
  const next = advanceAutonomyMode(current, evidence);
  if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, changed: false, policy: current };
  if (scope === "tenant") {
    const tenantId = existing.tenant_id ?? options.env?.ORGBRAIN_TENANT_ID?.trim() ?? null;
    if (!tenantId) throw new Error("tenant autonomy scope requires a tenant mapping");
    config.tenants = { ...(config.tenants ?? {}), [tenantId]: { autonomy: next } };
  } else {
    config.workspaces[normalized] = { ...existing, autonomy: next };
  }
  if (options.execute !== false) await saveWorkspaceConfig(file, config);
  return { ok: true, changed: true, scope, policy: next, policy_hash: autonomyPolicyHash(next) };
}

export async function runAutonomyCommand(action, args, options = {}) {
  const configuredStateDirectory = args.get("--state-dir");
  const commandEnv = configuredStateDirectory
    ? { ...(options.env ?? process.env), ORGBRAIN_AUTONOMY_STATE_DIR: path.resolve(configuredStateDirectory) }
    : (options.env ?? process.env);
  const common = {
    workspaceRoot: args.get("--workspace", process.cwd()),
    scope: args.get("--scope", "workspace"),
    env: commandEnv,
    profile: args.get("--profile"),
    mode: args.get("--mode"),
    judgeExecution: args.get("--judge-execution"),
    dbPath: args.get("--db"),
    stateFile: args.get("--state-file"),
    execute: args.flags.has("--execute")
  };
  if (action === "status") return getAutonomyStatus(common);
  if (action === "configure") return configureAutonomy(common);
  if (action === "freeze") return freezeAutonomy(common);
  if (action === "run") return runAutonomyMaintenance({
    ...common,
    dryRun: args.flags.has("--dry-run") || !args.flags.has("--execute"),
    dbPath: args.get("--db"),
    judgeRunner: args.get("--judge-runner"),
    quarantineRunner: args.get("--quarantine-runner"),
    qualificationRunner: args.get("--qualification-runner"),
    scanSessions: args.flags.has("--scan-sessions"),
    sessionsRoot: args.get("--sessions-root"),
    ...(args.get("--evidence") ? { evidence: await readJson(path.resolve(args.get("--evidence")), {}) } : {})
  });
  if (action === "explain") return explainAutonomyRun({ ...common, runId: args.get("--run", args.get("--run-id")) });
  if (action === "rollback") return rollbackAutonomy({ ...common, runId: args.get("--run", args.get("--run-id")) });
  throw new Error(`unknown autonomy command: ${action || "(missing)"}`);
}

export const autonomyInternals = { stateFileFor, policyForEntry, writePrivateJson };
