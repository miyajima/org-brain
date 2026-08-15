import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCodexSessionImportPlan,
  buildCodexSessionImportPlan,
  codexSessionImportInternals,
  createCodexSessionImportReport,
  executeCodexSessionImportPlanFile,
  quarantineCodexSessionImportReport
} from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { observeMemoryContractV2Event, normalizeMemoryContractV2Event } from "../packages/shared/src/memory-contract-v2-runtime.mjs";
import {
  certifyMemoryContractQuality,
  evaluateMemoryContractMeasurement,
  validateMemoryContractCorpus
} from "../packages/shared/src/memory-quality-certifier.mjs";
import { buildMemoryIngestionRegressionCorpus } from "./memory-ingestion-regression.mjs";
import { qualifyMemoryIngestionOracle } from "./memory-ingestion-oracle.mjs";

const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function row(payload, second = 0) {
  return {
    timestamp: `2026-08-14T00:00:${String(second).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload
  };
}

function durableFinalAnswer(index = 1) {
  return [
    "## Conclusion",
    `Stop hookは既知のcapture toolを必ず一回だけ呼ぶ（方針${index}）。`,
    "",
    "## Rationale",
    "tool discoveryと複数送信を避けることで、停止処理の遅延と重複保存を防げるため。",
    "",
    "## Reuse",
    "新しいagent lifecycle hookを実装する場合は、候補を一つのbatch requestへまとめる。",
    "",
    "## Evidence",
    "packages/orgbrain-cli/src/hook-memory-bridge.mjs",
    "scripts/hook-memory-bridge.test.mjs"
  ].join("\n");
}

async function writeSession(sessionsRoot, id, cwd, rows, threadSource = "user") {
  const directory = path.join(sessionsRoot, "2026", "08", "14");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.jsonl`);
  const meta = {
    timestamp: "2026-08-14T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, thread_source: threadSource }
  };
  await writeFile(target, `${[meta, ...rows].map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return target;
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
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  execFileSync("git", ["add", "base.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
}

test("fixed-seed corpus satisfies every certification minimum without split leakage", async () => {
  const corpus = await buildMemoryIngestionRegressionCorpus();
  assert.equal(corpus.cases.length, 1_037);
  assert.equal(corpus.cases.filter((item) => item.expected_route === "active").length, 225);
  assert.equal(corpus.cases.filter((item) => item.expected_route === "review").length, 12);
  assert.equal(corpus.cases.filter((item) => item.expected_route === "excluded").length, 200);
  assert.equal(validateMemoryContractCorpus(corpus).passed, true);
  assert.equal(evaluateMemoryContractMeasurement({ axis: "verified_knowledge_correctness", successes: 75, total: 75 }).passed, true);
  assert.equal(evaluateMemoryContractMeasurement({
    axis: "decision_continuity",
    successes: 75,
    total: 75,
    reask_count: 0
  }).passed, true);

  const axes = [
    "verified_knowledge_correctness",
    "durable_knowledge_coverage",
    "decision_continuity",
    "decision_utility",
    "evidence_rationale_quality",
    "retrieval_reproducibility",
    "freshness_validity",
    "duplicate_conflict_control",
    "coverage_utility",
    "structure_metadata"
  ];
  const measurements = axes.map((axis) => ({
    axis,
    successes: 300,
    total: 300,
    ...(axis === "decision_continuity" ? { reask_count: 0 } : {})
  }));
  const oracleQualification = await qualifyMemoryIngestionOracle();
  assert.equal(oracleQualification.passed, true);
  const calibrationQualification = {
    // The certifier checks the lower-bound fields independently of the
    // producer's `passed` flag; this fixture represents a perfect locked set.
    schema_version: 1,
    dataset_id: "orgbrain-memory-ingestion-calibration-v1",
    dataset_sha256: `sha256:${"b".repeat(64)}`,
    case_hash: `sha256:${"1".repeat(64)}`,
    selected_case_hash: `sha256:${"2".repeat(64)}`,
    seed_hash: `sha256:${"c".repeat(64)}`,
    rubric_hash: `sha256:${"d".repeat(64)}`,
    contract_hash: `sha256:${"e".repeat(64)}`,
    prompt_hash: `sha256:${"f".repeat(64)}`,
    reason_code_hash: `sha256:${"0".repeat(64)}`,
    locked: true,
    passed: true,
    status: "qualified",
    selected_case_count: 900,
    route_counts: { active: 300, review: 300, excluded: 300 },
    reviewer_agreement: { route_agreement: 1, route_cohen_kappa: 1, reason_code_micro_f1: 1 },
    route_metrics: {
      active: { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 },
      review: { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 },
      excluded: { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 }
    },
    route_accuracy: { passed: true, point_estimate: 1, wilson_lower: 1 },
    reason_code_required: { passed: true },
    reason_code_forbidden: { passed: true },
    lesson_type_errors: 0,
    judge_metrics: { evidence_entailment: { passed: true }, durability_atomicity: { passed: true }, future_reuse_overgeneralization: { passed: true } },
    judge_class_counts: { evidence_entailment: { pass: 300, fail: 600 }, durability_atomicity: { pass: 300, fail: 600 }, future_reuse_overgeneralization: { pass: 300, fail: 600 } },
    judge_consensus_metrics: { passed: true },
    ai_judge_results_present: true,
    metamorphic: { pair_count: 90, violation_count: 0 },
    hard_guardrails: { unsupported_active: 0 },
    structural_errors: [],
    labels_static: true,
    labels_derived_from_runtime: false,
    privacy: { raw_transcript_copied: false, runtime_predictions_in_gold: false, real_credentials_or_pii: false }
  };
  const withoutConsensus = certifyMemoryContractQuality({ measurements, corpus, hard_violations: [], oracle_qualification: oracleQualification, calibration_qualification: calibrationQualification });
  assert.equal(withoutConsensus.certification, "not_certified");
  assert.equal(withoutConsensus.aggregate_score, null);
  assert.equal(withoutConsensus.measurements.every((item) => item.passed), true);
  assert.equal(withoutConsensus.hard_guardrails.every((item) => item.passed), true);

  const certified = certifyMemoryContractQuality({
    measurements,
    corpus,
    hard_violations: [],
    oracle_qualification: oracleQualification,
    calibration_qualification: calibrationQualification,
    judgments: [
      { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
      { judge_name: "durability", model_family: "family-b", verdict: "pass" },
      { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
    ]
  });
  assert.equal(certified.certification, "oracle_certified");

  const activeCases = corpus.cases.filter((item) => item.expected_route === "active");
  const normalized = await Promise.all(activeCases.map((item) => normalizeMemoryContractV2Event(item.input, {
    workspaceRoot: "/workspace/org-brain"
  })));
  assert.equal(normalized.every((item) => item.accepted), true);
});

test("dry-run keeps strict fallback as review and excludes transient, subagent, and reasoning data", async () => {
  const root = await temporaryRoot("orgbrain-import-review-");
  const workspace = path.join(root, "org-brain");
  const sessions = path.join(root, "sessions");
  const dbPath = path.join(root, "memory.sqlite");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  initializeGitWorkspace(workspace);

  const durable = durableFinalAnswer();
  await writeSession(sessions, "durable", workspace, [
    row({ type: "turn_context", turn_id: "turn-durable" }, 1),
    row({ type: "agent_reasoning", text: "PRIVATE_REASONING_MUST_NOT_PERSIST" }, 2),
    row({ type: "agent_message", phase: "final_answer", message: durable }, 3)
  ]);
  await writeSession(sessions, "transient", workspace, [
    row({ type: "turn_context", turn_id: "turn-transient" }, 1),
    row({ type: "agent_message", phase: "final_answer", message: "Implementation completed; commit, push, CI, and build succeeded." }, 2)
  ]);
  await writeSession(sessions, "subagent", workspace, [
    row({ type: "turn_context", turn_id: "turn-subagent" }, 1),
    row({ type: "agent_message", phase: "final_answer", message: durable }, 2)
  ], "subagent");

  const report = await createCodexSessionImportReport({
    workspaceRoot: workspace,
    sessionsRoot: sessions,
    env: localEnv(root, dbPath)
  });
  const repeated = await createCodexSessionImportReport({
    workspaceRoot: workspace,
    sessionsRoot: sessions,
    env: localEnv(root, dbPath)
  });
  assert.equal(repeated.plan_hash, report.plan_hash);
  assert.equal(report.summary.active_count, 0);
  assert.equal(report.summary.review_count, 1);
  assert.equal(report.summary.excluded_turn_count, 1);
  assert.equal(report.summary.scan_exclusion_counts.non_user_session, 1);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("PRIVATE_REASONING_MUST_NOT_PERSIST"), false);
  assert.equal(serialized.includes(sessions), false);
  assert.equal(report.plan.privacy.raw_transcript_persisted, false);

  const output = path.join(root, "private", "plan.json");
  await codexSessionImportInternals.writePrivateJson(output, report);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(output, "utf8")).plan_hash, report.plan_hash);

  const cloudEnv = {
    ...localEnv(root, dbPath),
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
    ORGBRAIN_API_URL: "https://api.example.invalid",
    ORGBRAIN_API_KEY: "fixture-api-key"
  };
  const cloudReport = await createCodexSessionImportReport({
    workspaceRoot: workspace,
    sessionsRoot: sessions,
    env: cloudEnv
  });
  const cloudReview = cloudReport.plan.batches.flatMap((batch) => batch.review)[0];
  const localReview = report.plan.batches.flatMap((batch) => batch.review)[0];
  assert.deepEqual(cloudReview.item, localReview.item);
  await assert.rejects(
    applyCodexSessionImportPlan(cloudReport, {
      expectedPlanHash: cloudReport.plan_hash,
      workspaceRoot: workspace,
      env: cloudEnv
    }),
    /cloud_review_import_requires_complete_mcp_configuration/u
  );
});

test("all 200 non-durable fixtures stay out of active and review routes", async () => {
  const root = await temporaryRoot("orgbrain-import-nondurable-");
  const workspace = path.join(root, "current", "org-brain");
  const otherWorkspace = path.join(root, "other", "org-brain");
  const sessions = path.join(root, "sessions");
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  initializeGitWorkspace(workspace);

  const corpus = await buildMemoryIngestionRegressionCorpus();
  const fixtures = corpus.cases.filter((item) => item.cohort === "non_durable_turn");
  for (const [index, fixture] of fixtures.entries()) {
    await writeSession(sessions, fixture.id, fixture.workspace_scope === "other" ? otherWorkspace : workspace, [
      row({ type: "turn_context", turn_id: `turn-${fixture.id}` }, 1),
      row({ type: "agent_message", phase: "final_answer", message: fixture.final_answer }, 2)
    ], fixture.thread_source);
    assert.equal(index < 200, true);
  }

  const report = await createCodexSessionImportReport({
    workspaceRoot: workspace,
    sessionsRoot: sessions,
    env: localEnv(root, path.join(root, "memory.sqlite"))
  });
  assert.equal(report.summary.active_count, 0);
  assert.equal(report.summary.review_count, 0);
  assert.equal(report.summary.excluded_turn_count, 150);
  assert.equal(report.summary.scan_exclusion_counts.non_user_session, 25);
  assert.equal(report.summary.scan_exclusion_counts.workspace_mismatch, 25);
});

test("autonomous council disagreement derives a new quarantine plan without mutating the active plan", () => {
  const report = {
    schema_version: 2,
    generated_at: 1,
    plan_hash: "original",
    summary: {},
    plan: {
      schema_version: 2,
      source: "codex-sessions",
      target: { target_fingerprint: "target" },
      import_batch_id: "batch",
      sources: [],
      scan_exclusion_hashes: [],
      batches: [{
        session_hash: "session",
        turn_hash: "turn",
        occurred_at: 1,
        task_key: "task",
        active: [{
          external_key: "codex-import:v2:session:turn:item",
          content: "A verified project rule",
          summary: "verified rule",
          verification: { state: "verified" },
          evidence: [{ type: "file", ref: "src/rule.mjs" }]
        }],
        quarantine: [],
        excluded_reason_codes: []
      }],
      privacy: { raw_transcript_persisted: false }
    }
  };
  const derived = quarantineCodexSessionImportReport(report, { reasonCodes: ["session_judge_unavailable"] });
  assert.notEqual(derived.plan_hash, report.plan_hash);
  assert.equal(report.plan.batches[0].active.length, 1);
  assert.equal(derived.plan.batches[0].active.length, 0);
  assert.equal(derived.plan.batches[0].quarantine.length, 1);
  assert.equal(derived.plan.batches[0].quarantine[0].verification_state, "unverified");
  assert.deepEqual(derived.plan.batches[0].quarantine[0].reason_codes, ["session_judge_unavailable"]);
  assert.throws(
    () => codexSessionImportInternals.requireAutonomousActiveEvidence(report.plan),
    /autonomous_active_consensus_missing:1/u
  );
  const strictJudgments = ["evidence", "durability", "reuse"].map((judge_name, index) => ({
    judge_name,
    model_family: `family-${index}`,
    model_version: `model-${index}`,
    prompt_hash: `sha256:${String(index + 1).repeat(64)}`,
    candidate_hash: `sha256:${String(index + 4).repeat(64)}`,
    verdict: "pass",
    confidence: 0.99,
    signature: `signature-${index}`,
    public_key_fingerprint: `key-${index}`,
    support_selector: [`evidence-${index}`]
  }));
  const certified = codexSessionImportInternals.attachAutonomousConsensus(report, {
    pass: true,
    judgments: strictJudgments
  });
  assert.equal(certified.plan.batches[0].active[0].ai_certification, "ai_consensus_certified");
  assert.doesNotThrow(() => codexSessionImportInternals.requireAutonomousActiveEvidence(certified.plan));
});

test("executing a private import plan leaves the content-addressed plan unchanged", async () => {
  const root = await temporaryRoot("orgbrain-import-plan-immutable-");
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  const dbPath = path.join(root, "memory.sqlite");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  initializeGitWorkspace(workspace);
  const env = localEnv(root, dbPath);
  const report = await createCodexSessionImportReport({ workspaceRoot: workspace, sessionsRoot: sessions, env });
  const planPath = path.join(root, "private", "plan.json");
  await codexSessionImportInternals.writePrivateJson(planPath, report);
  const before = await readFile(planPath, "utf8");
  const applied = await executeCodexSessionImportPlanFile({
    planPath,
    expectedPlanHash: report.plan_hash,
    workspaceRoot: workspace,
    env,
    store: new LocalMemoryStore(dbPath)
  });
  assert.equal(applied.plan, planPath);
  assert.equal(applied.output, `${planPath}.apply-report.json`);
  assert.equal(await readFile(planPath, "utf8"), before);
  const applyReport = JSON.parse(await readFile(applied.output, "utf8"));
  assert.equal(applyReport.mode, "applied");
  assert.equal(applyReport.plan_hash, report.plan_hash);
  assert.equal(applyReport.privacy.raw_transcript_persisted, false);
  assert.equal((await stat(applied.output)).mode & 0o777, 0o600);
});

test("same Git common directory includes worktrees and incomplete observe remains review-only", async () => {
  const root = await temporaryRoot("orgbrain-import-worktree-");
  const workspace = path.join(root, "main", "org-brain");
  const worktree = path.join(root, "linked", "org-brain-worktree");
  const sessions = path.join(root, "sessions");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  initializeGitWorkspace(workspace);
  await mkdir(path.dirname(worktree), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "fixture-worktree", worktree], { cwd: workspace, stdio: "ignore" });

  await writeSession(sessions, "main-session", workspace, [
    row({ type: "turn_context", turn_id: "turn-main" }, 1),
    row({ type: "agent_message", phase: "final_answer", message: durableFinalAnswer(1) }, 2)
  ]);
  const corpus = await buildMemoryIngestionRegressionCorpus();
  const observation = corpus.cases.find((item) => item.cohort === "success").input;
  await writeSession(sessions, "worktree-session", worktree, [
    row({ type: "turn_context", turn_id: "turn-worktree" }, 1),
    row({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: "observe-incomplete", input: observation }, 2),
    row({ type: "agent_message", phase: "final_answer", message: "Observe was submitted but not acknowledged." }, 3)
  ]);

  const report = await createCodexSessionImportReport({
    workspaceRoot: workspace,
    sessionsRoot: sessions,
    env: localEnv(root, path.join(root, "memory.sqlite"))
  });
  assert.equal(report.summary.sessions_scanned, 2);
  assert.equal(report.summary.active_count, 0);
  assert.equal(report.summary.review_count, 2);
  assert.equal(
    report.plan.batches.flatMap((batch) => batch.review).some((candidate) => candidate.reason_codes.includes("observe_not_accepted")),
    true
  );
});

test("verified success, decision, and failure become active and local replay is idempotent", async () => {
  const root = await temporaryRoot("orgbrain-import-active-");
  const workspace = path.join(root, "org-brain");
  const sessions = path.join(root, "sessions");
  const dbPath = path.join(root, "memory.sqlite");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "base.txt"), "base\n");
  initializeGitWorkspace(workspace);
  await writeFile(
    path.join(workspace, "src", "importer-regression.mjs"),
    "export const VERIFIED_IMPORT_SUCCESS_1 = true; // Use importer policy 1\n"
  );

  const corpus = await buildMemoryIngestionRegressionCorpus();
  const events = ["success", "decision", "failure"].map((cohort) =>
    corpus.cases.find((item) => item.cohort === cohort).input
  );
  const observations = await Promise.all(events.map((event) => observeMemoryContractV2Event(event, {
    workspaceRoot: workspace
  })));
  assert.equal(observations.every((item) => item.accepted), true);

  const commands = [
    ["success", events[0].evidence_selectors[1].ref, 0],
    ["failure-before", events[2].evidence_selectors[0].ref, 1],
    ["failure-after", events[2].evidence_selectors[1].ref, 0]
  ];
  const rows = [row({ type: "turn_context", turn_id: "turn-observed" }, 1)];
  rows.push(row({ type: "user_message", message: "Use importer policy 1" }, 2));
  for (const [callId, command, exitCode] of commands) {
    rows.push(row({ type: "custom_tool_call", name: "exec", call_id: callId, input: { cmd: command } }, 3));
    rows.push(row({ type: "custom_tool_call_output", call_id: callId, output: `Script completed; exit_code=${exitCode}` }, 4));
  }
  events.forEach((event, index) => {
    rows.push(row({
      type: "mcp_tool_call_end",
      invocation: { tool: "orgbrain_memory_observe", arguments: event },
      result: { Ok: { content: [{ type: "text", text: JSON.stringify(observations[index]) }] } }
    }, 5 + index));
  });
  rows.push(row({ type: "agent_message", phase: "final_answer", message: "The verified import observations were recorded." }, 9));
  await writeSession(sessions, "observed", workspace, rows);

  const env = localEnv(root, dbPath);
  const report = await createCodexSessionImportReport({ workspaceRoot: workspace, sessionsRoot: sessions, env });
  const repeatedReport = await createCodexSessionImportReport({ workspaceRoot: workspace, sessionsRoot: sessions, env });
  assert.equal(repeatedReport.plan_hash, report.plan_hash);
  assert.equal(report.summary.active_count, 3);
  assert.deepEqual(report.summary.lesson_type_counts, { decision: 1, failure: 1, success: 1 });
  assert.equal(report.summary.review_count, 0);

  const store = new LocalMemoryStore(dbPath);
  const first = await applyCodexSessionImportPlan(report, {
    expectedPlanHash: report.plan_hash,
    workspaceRoot: workspace,
    env,
    store
  });
  assert.equal(first.ok, true);
  assert.equal(first.results[0].active.filter((item) => item.created).length, 3);

  const second = await applyCodexSessionImportPlan(report, {
    expectedPlanHash: report.plan_hash,
    workspaceRoot: workspace,
    env,
    store
  });
  assert.equal(second.ok, true);
  assert.equal(second.results[0].active.filter((item) => item.created).length, 0);

  const memories = [];
  for await (const memory of store.export("default", "org-brain")) memories.push(memory);
  assert.equal(memories.length, 3);
  assert.equal(memories.every((item) => item.lifecycle_state === "active"), true);
  assert.equal(memories.every((item) => item.capture_origin === "observed"), true);
  assert.equal(memories.every((item) => item.verification_state === "verified"), true);

  const cloudEnv = {
    ...env,
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
    ORGBRAIN_MCP_URL: "https://mcp.example.invalid",
    ORGBRAIN_MCP_CLIENT_ID: "fixture-client",
    ORGBRAIN_MCP_CLIENT_SECRET: "fixture-secret",
    ORGBRAIN_CLIENT_INSTALLATION_ID: "installation-1"
  };
  const cloudReport = await createCodexSessionImportReport({ workspaceRoot: workspace, sessionsRoot: sessions, env: cloudEnv });
  assert.deepEqual(
    cloudReport.plan.batches.flatMap((batch) => batch.active).map((item) => item.external_key),
    report.plan.batches.flatMap((batch) => batch.active).map((item) => item.external_key)
  );
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "GET") {
      return new Response(JSON.stringify({ ok: true, data: { id: "installation-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "fixture",
      result: { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        results: [1, 2, 3].map((index) => ({ status: "created", memory_id: `memory-${index}` }))
      }) }] }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const cloudApplied = await applyCodexSessionImportPlan(cloudReport, {
      expectedPlanHash: cloudReport.plan_hash,
      workspaceRoot: workspace,
      env: cloudEnv
    });
    assert.equal(cloudApplied.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.arguments.items.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await assert.rejects(
    applyCodexSessionImportPlan(report, {
      expectedPlanHash: "0".repeat(64),
      workspaceRoot: workspace,
      env,
      store
    }),
    /plan_hash_mismatch/u
  );
});

test("workspace fingerprint rejects a different repository at apply time", async () => {
  const root = await temporaryRoot("orgbrain-import-scope-");
  const firstWorkspace = path.join(root, "first", "org-brain");
  const secondWorkspace = path.join(root, "second", "org-brain");
  const sessions = path.join(root, "sessions");
  await mkdir(firstWorkspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  await writeFile(path.join(firstWorkspace, "base.txt"), "first\n");
  await writeFile(path.join(secondWorkspace, "base.txt"), "second\n");
  initializeGitWorkspace(firstWorkspace);
  initializeGitWorkspace(secondWorkspace);
  await writeSession(sessions, "one", firstWorkspace, [
    row({ type: "turn_context", turn_id: "turn-one" }, 1),
    row({ type: "agent_message", phase: "final_answer", message: "Done." }, 2)
  ]);
  const env = localEnv(root, path.join(root, "memory.sqlite"));
  const report = await createCodexSessionImportReport({ workspaceRoot: firstWorkspace, sessionsRoot: sessions, env });
  await assert.rejects(
    applyCodexSessionImportPlan(report, {
      expectedPlanHash: report.plan_hash,
      workspaceRoot: secondWorkspace,
      env
    }),
    /import_target_changed/u
  );
});
