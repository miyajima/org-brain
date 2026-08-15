import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureAutonomy, getAutonomyStatus, rollbackAutonomy, runAutonomyMaintenance } from "../packages/orgbrain-cli/src/autonomy.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

function qualifiedAutonomyEvidence() {
  const digest = `sha256:${"a".repeat(64)}`;
  const metric = { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 };
  return {
    machine_reference: {
      schema_version: 1,
      dataset_id: "orgbrain-memory-ingestion-machine-reference-v1",
      dataset_sha256: digest,
      case_hash: digest,
      selected_case_hash: digest,
      seed_hash: digest,
      rubric_hash: digest,
      contract_hash: digest,
      prompt_hash: digest,
      reason_code_hash: digest,
      locked: true,
      passed: true,
      status: "qualified",
      selected_case_count: 900,
      route_counts: { active: 300, quarantine: 300, excluded: 300 },
      route_metrics: { active: metric, quarantine: metric, excluded: metric },
      route_accuracy: { passed: true, point_estimate: 1, wilson_lower: 1 },
      judge_metrics: {
        evidence_entailment: metric,
        durability_atomicity: metric,
        future_reuse_overgeneralization: metric,
        adversarial_critic: metric,
        policy_consistency: metric
      },
      consensus_metrics: metric,
      council_stability: { point_estimate: 1 },
      hard_guardrails: {
        unsupported_active: 0,
        credential_or_pii_active: 0,
        scope_violation_active: 0,
        self_attestation_active: 0,
        unsafe_active: 0,
        lesson_type_misclassification: 0
      },
      metamorphic: { pair_count: 90, violation_count: 0 },
      observed_outcomes: { passed: true },
      council_signature: "signed",
      council_key_fingerprints: ["key-a", "key-b", "key-c"],
      ground_truth_basis: "machine_reference",
      human_grounded: false,
      labels_derived_from_runtime: false,
      council_results_present: true,
      privacy: { raw_transcript_copied: false, reasoning_persisted: false, real_credentials_or_pii: false },
      structural_errors: []
    },
    canary: {
      passed: true,
      observed_outcomes: {
        turns_scanned: 200,
        active_candidates: 1,
        active_deterministic_verified_count: 1,
        active_profile_agreement_count: 1,
        active_two_model_family_count: 1,
        quarantine_audit_samples: 50,
        excluded_audit_samples: 50,
        observed_days: 7,
        reask_rate: 0.01,
        retrieval_coverage: 0.99,
        contradiction_count: 0,
        hard_violation_count: 0,
        disagreement_count: 0,
        scope_violation_count: 0,
        privacy_violation_count: 0
      }
    },
    rollback_ready: true,
    minimum_confidence_delta: -0.5
  };
}

test("autonomy configuration is private, versioned, and rollbackable without human approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-cli-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    await mkdir(workspace, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    const dry = await configureAutonomy({ workspaceRoot: workspace, env, profile: "conservative", mode: "autonomous", execute: false });
    assert.equal(dry.dry_run, true);
    const applied = await configureAutonomy({ workspaceRoot: workspace, env, profile: "conservative", mode: "autonomous", execute: true });
    assert.equal(applied.configured, true);
    const status = await getAutonomyStatus({ workspaceRoot: workspace, env });
    assert.equal(status.policy.mode, "autonomous");
    assert.equal(status.policy.profile, "conservative");
    const rolled = await rollbackAutonomy({ workspaceRoot: workspace, env, execute: true });
    assert.equal(rolled.rolled_back, true);
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env })).policy.mode, "shadow");
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.ok((await readFile(config, "utf8")).includes("autonomy"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed autonomous apply records a run and trips the automatic shadow rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-failure-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    await mkdir(workspace, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "autonomous", execute: true });
    const store = new LocalMemoryStore(db);
    await store.init();
    store.doctor = async () => ({ ok: false, errors: ["injected"] });
    store.rebuildIndex = async () => undefined;
    const run = await runAutonomyMaintenance({ workspaceRoot: workspace, env, dbPath: db, store, dryRun: false });
    assert.equal(run.ok, false);
    assert.equal(run.rollback_applied, true);
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env })).policy.mode, "shadow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval coverage below the rollback floor triggers the same automatic rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-retrieval-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    await mkdir(workspace, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "autonomous", execute: true });
    const run = await runAutonomyMaintenance({
      workspaceRoot: workspace,
      env,
      dbPath: db,
      dryRun: false,
      postApplyObservation: { retrieval_coverage: 0.5 }
    });
    assert.equal(run.rollback_required, true);
    assert.equal(run.post_apply.checks.retrieval_coverage, false);
    assert.equal(run.rollback_applied, true);
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env })).policy.mode, "shadow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled runs advance mode from private qualification evidence without an approval action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-evidence-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    await mkdir(workspace, { recursive: true });
    await mkdir(state, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "shadow", execute: true });
    await writeFile(path.join(state, "qualification-evidence.json"), JSON.stringify(qualifiedAutonomyEvidence()), { mode: 0o600 });
    const run = await runAutonomyMaintenance({ workspaceRoot: workspace, env, dbPath: db, dryRun: true });
    assert.equal(run.mode_transition.changed, true);
    assert.equal(run.mode_transition.policy.mode, "guarded");
    assert.equal(run.policy_tuning.policy.judge.minimum_confidence, 0.97);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status-only qualification claims cannot advance the autonomy mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-unverified-evidence-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    await mkdir(workspace, { recursive: true });
    await mkdir(state, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "shadow", execute: true });
    await writeFile(path.join(state, "qualification-evidence.json"), JSON.stringify({
      machine_reference: { status: "qualified" },
      canary: { status: "qualified" },
      rollback_ready: true
    }), { mode: 0o600 });
    const run = await runAutonomyMaintenance({ workspaceRoot: workspace, env, dbPath: db, dryRun: true });
    assert.equal(run.mode_transition.changed, false);
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env })).policy.mode, "shadow");
    await assert.rejects(stat((await getAutonomyStatus({ workspaceRoot: workspace, env })).state_file), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured qualification adapter runs automatically and stores only private evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-qualification-runner-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    const runner = path.join(root, "qualification-runner.mjs");
    await mkdir(workspace, { recursive: true });
    const evidence = qualifiedAutonomyEvidence();
    await writeFile(runner, `export async function runAutonomyQualification() { return ${JSON.stringify(evidence)}; }\n`, { mode: 0o600 });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "shadow", execute: true });
    const run = await runAutonomyMaintenance({ workspaceRoot: workspace, env, dbPath: db, dryRun: false, qualificationRunner: runner });
    assert.equal(run.qualification_runner.status, "completed", run.qualification_error ?? "qualification runner failed");
    assert.equal(run.mode_transition.policy.mode, "guarded");
    const persisted = JSON.parse(await readFile(path.join(state, "qualification-evidence.json"), "utf8"));
    assert.equal(persisted.machine_reference.human_grounded, false);
    assert.equal(persisted.machine_reference.privacy.raw_transcript_copied, false);
    assert.equal(JSON.stringify(persisted).includes("PRIVATE"), false);
    assert.equal((await stat(path.join(state, "qualification-evidence.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a canary hard violation trips automatic rollback without an approval action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-canary-rollback-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    const db = path.join(root, "memory.sqlite");
    await mkdir(workspace, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "default" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "autonomous", execute: true });
    const evidence = qualifiedAutonomyEvidence();
    evidence.canary.observed_outcomes.hard_violation_count = 1;
    const run = await runAutonomyMaintenance({ workspaceRoot: workspace, env, dbPath: db, dryRun: false, evidence });
    assert.equal(run.evidence_rollback_signal, true);
    assert.equal(run.rollback_applied, true);
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env })).policy.mode, "shadow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant-scoped policy is shared by workspaces without rewriting workspace policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-autonomy-tenant-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "workspaces.json");
    const state = path.join(root, "state");
    await mkdir(workspace, { recursive: true });
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_TENANT_ID: "tenant-a" };
    await configureAutonomy({ workspaceRoot: workspace, env, mode: "shadow", execute: true });
    const configured = await configureAutonomy({ workspaceRoot: workspace, env, scope: "tenant", profile: "conservative", mode: "guarded", execute: true });
    assert.equal(configured.scope, "tenant");
    assert.equal(configured.policy.mode, "guarded");
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env, scope: "workspace" })).policy.mode, "shadow");
    assert.equal((await getAutonomyStatus({ workspaceRoot: workspace, env, scope: "tenant" })).policy.mode, "guarded");
    const saved = JSON.parse(await readFile(config, "utf8"));
    assert.equal(saved.tenants["tenant-a"].autonomy.profile, "conservative");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
