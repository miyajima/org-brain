import { describe, expect, it } from "vitest";
import { canonicalJson } from "@org-brain/core";
import { sha256 } from "@org-brain/shared";
import {
  completeKnowledgePackOnboarding,
  createKnowledgePackOnboarding,
  getKnowledgePackOnboarding,
  planKnowledgePackOnboarding,
  updateKnowledgePackOnboardingStep
} from "../src/knowledge-pack-onboarding-service";
import type { Env } from "../src/types";
import {
  closeRetrospective,
  createImprovementAction,
  createRetrospective,
  createRetrospectiveSchedule,
  enqueueMetricImport,
  getMetricImportRun,
  getOrganizationDashboard,
  getRetrospective,
  listImprovementActions,
  listRetrospectives,
  listMetricConnections,
  materializeDueRetrospectives,
  putRetrospectiveResponse,
  recordKnowledgePackGoalSnapshot,
  updateImprovementAction,
  verifyImprovementAction
} from "../src/knowledge-measurement-service";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as {
  process: { cwd: () => string; getBuiltinModule: (name: string) => unknown };
}).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { readFileSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: string, encoding: string) => string;
};

class D1StatementAdapter {
  private args: unknown[] = [];
  constructor(private database: SqliteDatabase, private sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
  async run() { return this.runSync(); }
}

function runtimeEnv(mode: "preview" | "on" = "on") {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const migration of [
    "0005_knowledge_docs.sql",
    "0007_rationale_confirmation.sql",
    "0010_context_engine_mvp.sql",
    "0011_decision_memory_editor.sql",
    "0012_login_groups_acl.sql",
    "0034_domain_pack_platform.sql",
    "0035_domain_pack_workspaces.sql",
    "0038_knowledge_pack_onboarding.sql",
    "0039_knowledge_measurement_loop.sql"
  ]) {
    database.exec(readFileSync(`${runtime.cwd()}/../../migrations/${migration}`, "utf8"));
  }
  database.exec(`CREATE TABLE IF NOT EXISTS resource_access_policies (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    scope TEXT NOT NULL, owner_principal TEXT NOT NULL, project_id TEXT, group_ids_json TEXT NOT NULL DEFAULT '[]',
    restricted_subjects_json TEXT NOT NULL DEFAULT '[]', storage_location TEXT NOT NULL DEFAULT 'd1',
    policy_version INTEGER NOT NULL DEFAULT 1, created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(tenant_id, resource_type, resource_id)
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS principal_role_assignments (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, principal TEXT NOT NULL, role TEXT NOT NULL,
    created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  database.exec(readFileSync(`${runtime.cwd()}/../../migrations/0042_knowledge_loop_pilot.sql`, "utf8"));
  database.exec("ALTER TABLE decision_memories ADD COLUMN business_category_id TEXT;");
  database.exec("ALTER TABLE decision_memories ADD COLUMN work_type TEXT;");
  database.exec("ALTER TABLE decision_memory_versions ADD COLUMN business_category_id TEXT;");
  database.exec("ALTER TABLE decision_memory_versions ADD COLUMN work_type TEXT;");
  const db = {
    prepare: (sql: string) => new D1StatementAdapter(database, sql),
    batch: async (statements: D1StatementAdapter[]) => {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.runSync());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return {
    database,
    env: {
      OPEN_BRAIN_DB: db,
      DOMAIN_PACKS_MODE: "install",
      DOMAIN_METRICS_MODE: "on",
      DOMAIN_WORKSPACES_MODE: "on",
      KNOWLEDGE_PACK_ONBOARDING_MODE: mode,
      ORGANIZATION_DASHBOARD_MODE: "on",
      METRIC_IMPORT_MODE: "on",
      GITHUB_METRIC_CONNECTIONS_JSON: JSON.stringify({
        primary: { tenant_id: "tenant-a", token: "test-only-token", owner: "example", repo: "org-brain", label: "Test GitHub" },
        other: { tenant_id: "tenant-b", token: "other-test-token", owner: "other", repo: "private" }
      }),
      RETROSPECTIVE_MODE: "on",
      IMPROVEMENT_ACTIONS_MODE: "on"
    } as unknown as Env
  };
}

async function saveStep(
  env: Env,
  session: { id: string; revision: number; project_id?: string | null },
  step: string,
  answer: unknown
) {
  return updateKnowledgePackOnboardingStep(env, "tenant-a", session.id, step, {
    tenant_id: "tenant-a",
    project_id: session.project_id ?? null,
    revision: session.revision,
    answer
  });
}

async function buildReadySession(
  env: Env,
  source: Record<string, unknown>,
  createIdempotencyKey = "create-build-reliability",
  projectId: string | null = "project-a"
) {
  let session = await createKnowledgePackOnboarding(
    env,
    "tenant-a",
    "user:admin",
    createIdempotencyKey,
    { tenant_id: "tenant-a", project_id: projectId }
  );
  session = await saveStep(env, session, "purpose", {
    name: "Build reliability",
    objective: "Raise build success without loading fixture data"
  });
  session = await saveStep(env, session, "template", {
    pack_ids: ["function.build-engineering"]
  });
  session = await saveStep(env, session, "scope", {
    project_id: projectId,
    scope_type: projectId ? "project" : "tenant"
  });
  session = await saveStep(env, session, "goals", {
    goals: [{
      metric_key: "build_success_rate",
      direction: "increase",
      target_value: 98,
      due_at: Date.now() + 86_400_000,
      reason: "Keep the main branch healthy"
    }]
  });
  session = await saveStep(env, session, "data_sources", {
    sources: [{ metric_key: "build_success_rate", ...source }]
  });
  return session;
}

describe("Knowledge Pack onboarding", () => {
  it("resumes, plans, and idempotently completes a Knowledge Pack with a manual baseline", async () => {
    const { database, env } = runtimeEnv();
    let session = await buildReadySession(env, {
      mode: "manual",
      initial_value: 91,
      observed_at: Date.now(),
      evidence_ref: "evidence://build/baseline"
    });
    const resumed = await createKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      "another-create-request",
      { tenant_id: "tenant-a", project_id: "project-a" }
    );
    expect(resumed.id).toBe(session.id);

    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: session.revision
    });
    session = planned.onboarding;
    expect(planned.plan.knowledge_pack.manifest).toMatchObject({
      classification: "organization_overlay",
      example_refs: [],
      dependencies: [{ pack_id: "function.build-engineering", version: expect.any(String) }]
    });
    expect(planned.plan.installation.examples_loaded).toBe(false);

    await expect(completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "wrong-digest-request",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: "a".repeat(64) }
    )).rejects.toMatchObject({ code: "knowledge_pack_plan_changed" });
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_releases WHERE classification='organization_overlay'"
    ).get()?.count).toBe(0);

    const completed = await completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "complete-build-reliability",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    expect(completed).toMatchObject({ state: "completed", current_step: "completed" });
    expect(completed.completion?.targets).toHaveLength(1);
    expect(completed.completion?.snapshots).toHaveLength(1);
    expect(completed.completion?.sources).toEqual([{
      metric_key: "build_success_rate",
      source_binding_id: null,
      state: "measured"
    }]);
    expect(completed.completion?.workspace_href).toBe("/domain-workspaces/function.build-engineering");

    const repeated = await completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "repeat-completion-request",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    expect(repeated.completion).toEqual(completed.completion);
    expect(database.prepare("SELECT count(*) AS count FROM metric_targets").get()?.count).toBe(1);
    expect(database.prepare("SELECT count(*) AS count FROM metric_snapshots").get()?.count).toBe(1);
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_installations WHERE state='installed'"
    ).get()?.count).toBe(2);
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_releases WHERE classification='organization_overlay'"
    ).get()?.count).toBe(1);
    expect(database.prepare(
      "SELECT metric_key, scope_type, scope_id FROM knowledge_pack_goal_links"
    ).get()).toEqual({ metric_key: "build_success_rate", scope_type: "project", scope_id: "project-a" });

    const secondSession = await buildReadySession(env, { mode: "unknown" }, "create-second-knowledge-pack");
    const secondPlan = await planKnowledgePackOnboarding(env, "tenant-a", secondSession.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: secondSession.revision
    });
    await expect(completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      secondSession.id,
      "complete-build-reliability",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: secondPlan.plan.plan_digest }
    )).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_releases WHERE classification='organization_overlay'"
    ).get()?.count).toBe(1);
  });

  it("stores only a non-secret Connector reference and leaves the initial value unknown", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, {
      mode: "connector",
      connection_ref: "connection:github-actions:primary"
    });
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: session.revision
    });
    const completed = await completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "complete-connector-session",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    expect(completed.completion?.snapshots).toEqual([]);
    expect(completed.completion?.sources[0]).toMatchObject({ state: "configured" });
    expect(database.prepare(
      "SELECT connection_ref, status FROM metric_source_bindings WHERE binding_key LIKE 'knowledge:%'"
    ).get()).toEqual({
      connection_ref: "connection:github-actions:primary",
      status: "configured"
    });
    expect(await listMetricConnections(env, "tenant-a")).toEqual([expect.objectContaining({
      connection_ref: "connection:github-actions:primary",
      repository: "example/org-brain"
    })]);
    expect(await listMetricConnections(env, "tenant-b")).toEqual([expect.objectContaining({
      connection_ref: "connection:github-actions:other",
      repository: "other/private"
    })]);
    const dashboard = await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", includeAll: true });
    expect(dashboard.goals[0]?.current).toMatchObject({ state: "unknown", value: null });
    await expect(createImprovementAction(env, "tenant-a", "user:admin", {
      title: "Do not optimize an unknown baseline",
      goal_link_id: dashboard.goals[0]!.link.id,
      owner_principal: "user:admin"
    })).rejects.toMatchObject({ code: "fresh_baseline_required" });
    const jobs: unknown[] = [];
    env.METRIC_IMPORT_QUEUE = { send: async (job: unknown) => { jobs.push(job); } } as unknown as Env["METRIC_IMPORT_QUEUE"];
    const binding = database.prepare("SELECT id FROM metric_source_bindings WHERE binding_key LIKE 'knowledge:%'").get()!;
    const run = await enqueueMetricImport(env, "tenant-a", "user:admin", String(binding.id), "import-build-success");
    const repeated = await enqueueMetricImport(env, "tenant-a", "user:admin", String(binding.id), "import-build-success");
    expect(repeated.id).toBe(run.id);
    expect(jobs).toHaveLength(1);
    expect(await getMetricImportRun(env, "tenant-a", run.id)).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("backfills only exact canonical goal references and quarantines cross-tenant targets", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, {
      mode: "manual",
      initial_value: 91,
      observed_at: Date.now(),
      evidence_ref: "evidence://build/backfill"
    }, "create-backfill-session");
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a", project_id: "project-a", revision: session.revision
    });
    await completeKnowledgePackOnboarding(
      env, "tenant-a", "user:admin", session.id, "complete-backfill-session",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    const migration = readFileSync(`${runtime.cwd()}/../../migrations/0039_knowledge_measurement_loop.sql`, "utf8");
    database.prepare("DELETE FROM knowledge_pack_goal_links WHERE onboarding_id=?").run(session.id);
    database.prepare("DELETE FROM knowledge_pack_goal_reconciliations WHERE onboarding_id=?").run(session.id);
    database.exec(migration);
    expect(database.prepare(
      "SELECT status, expected_count, linked_count FROM knowledge_pack_goal_reconciliations WHERE onboarding_id=?"
    ).get(session.id)).toEqual({ status: "clean", expected_count: 1, linked_count: 1 });

    const stored = database.prepare(
      "SELECT completion_json FROM knowledge_pack_onboarding_sessions WHERE id=?"
    ).get(session.id)!;
    const completion = JSON.parse(String(stored.completion_json)) as { targets: Array<{ target_id: string }> };
    const definition = database.prepare(
      "SELECT metric_definition_id FROM metric_targets WHERE id=?"
    ).get(completion.targets[0]!.target_id)!;
    database.prepare(
      `INSERT INTO metric_targets(
         id, tenant_id, metric_definition_id, binding_id, target_value, target_min, target_max,
         direction, effective_from, effective_to, reason, set_by, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("cross-tenant-target", "tenant-b", definition.metric_definition_id, null, 99, null, null,
      "increase", Date.now(), null, "invalid cross-tenant reference", "user:other", Date.now());
    completion.targets[0]!.target_id = "cross-tenant-target";
    database.prepare("UPDATE knowledge_pack_onboarding_sessions SET completion_json=? WHERE id=?")
      .run(JSON.stringify(completion), session.id);
    database.prepare("DELETE FROM knowledge_pack_goal_links WHERE onboarding_id=?").run(session.id);
    database.prepare("DELETE FROM knowledge_pack_goal_reconciliations WHERE onboarding_id=?").run(session.id);
    database.exec(migration);
    expect(database.prepare(
      "SELECT status, error_code, linked_count FROM knowledge_pack_goal_reconciliations WHERE onboarding_id=?"
    ).get(session.id)).toEqual({ status: "error", error_code: "goal_link_reconciliation_incomplete", linked_count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM knowledge_pack_goal_links WHERE onboarding_id=?").get(session.id)?.count).toBe(0);
  });

  it("runs the dashboard, improvement, remeasurement, and retrospective loop", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, {
      mode: "manual",
      initial_value: 90,
      observed_at: Date.now(),
      evidence_ref: "evidence://build/baseline"
    }, "create-measurement-loop");
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a", project_id: "project-a", revision: session.revision
    });
    const completed = await completeKnowledgePackOnboarding(
      env, "tenant-a", "user:admin", session.id, "complete-measurement-loop",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    await expect(getOrganizationDashboard(env, "tenant-a", { principal: "user:outsider", projectId: "project-a" }))
      .rejects.toMatchObject({ code: "project_access_required" });
    database.prepare(
      `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role, created_by_principal, created_at, updated_at)
       VALUES('role-project-reader', 'tenant-a', 'project-a', 'user:reader', 'reader', 'user:admin', 1, 1)`
    ).run();
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:reader", projectId: "project-a" })).goals)
      .toHaveLength(1);
    const dashboard = await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", includeAll: true });
    expect(dashboard.goals[0]).toMatchObject({
      metric_label: "Build成功率",
      current: { value: 90, state: "measured" },
      target: { direction: "increase", value: 98 },
      comparison: { target_state: "off_track", distance_to_target: 8, previous_value: null, trend: "unknown" }
    });
    expect(dashboard.summary).toMatchObject({ installed_packs: 2, open_retrospectives: 0 });
    const link = dashboard.goals[0]!.link;
    const action = await createImprovementAction(env, "tenant-a", "user:admin", {
      title: "Stabilize CI",
      goal_link_id: link.id,
      owner_principal: "user:admin"
    });
    const readerAction = await createImprovementAction(env, "tenant-a", "user:admin", {
      title: "Reader action", goal_link_id: link.id, owner_principal: "user:reader"
    });
    expect((await listImprovementActions(env, "tenant-a", { principal: "user:reader" }))[0]?.measurement?.current.value).toBe(90);
    database.prepare("DELETE FROM principal_role_assignments WHERE id='role-project-reader'").run();
    expect(await listImprovementActions(env, "tenant-a", { principal: "user:reader" }))
      .toMatchObject([{ id: readerAction.id, measurement: null }]);
    await expect(getOrganizationDashboard(env, "tenant-a", { principal: "user:reader", projectId: "project-a" }))
      .rejects.toMatchObject({ code: "project_access_required" });
    database.prepare("DELETE FROM improvement_actions WHERE id=?").run(readerAction.id);
    await updateImprovementAction(env, "tenant-a", action.id, "user:admin", true, { status: "in_progress" });
    const awaiting = await updateImprovementAction(env, "tenant-a", action.id, "user:admin", true, { status: "awaiting_verification" });
    expect((await listImprovementActions(env, "tenant-a", { principal: "user:admin", includeAll: true }))[0])
      .toMatchObject({ measurement: { pack_title: "Build reliability", baseline: { value: 90 }, current: { value: 90 }, verification_state: "waiting_for_measurement" } });
    const remeasurementBody = { value: 96, observed_at: Number(awaiting.implementation_completed_at) + 1, evidence_ref: "evidence://build/after" };
    const remeasurement = await recordKnowledgePackGoalSnapshot(
      env, "tenant-a", "user:admin", completed.completion!.knowledge_pack.installation_id, link.id,
      "remeasure-ci", remeasurementBody
    );
    expect((await recordKnowledgePackGoalSnapshot(
      env, "tenant-a", "user:admin", completed.completion!.knowledge_pack.installation_id, link.id,
      "remeasure-ci", remeasurementBody
    ) as { id: string }).id).toBe((remeasurement as { id: string }).id);
    expect((await listImprovementActions(env, "tenant-a", { principal: "user:admin", includeAll: true }))[0])
      .toMatchObject({ measurement: { current: { value: 96, state: "measured" }, verification_state: "ready" } });
    await expect(recordKnowledgePackGoalSnapshot(
      env, "tenant-a", "user:admin", completed.completion!.knowledge_pack.installation_id, link.id,
      "remeasure-ci", { ...remeasurementBody, value: 97 }
    )).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    const verified = await verifyImprovementAction(env, "tenant-a", action.id, "user:admin", true);
    expect(verified).toMatchObject({ status: "completed", comparator_version: "metric-improvement/v1", verification_outcome: "improved" });

    const now = Date.now();
    database.prepare(
      `INSERT INTO decision_memories(
         id, tenant_id, project_id, domain, title, decision, rationale, source_refs_json,
         owner_refs_json, status, confidence, visibility, allowed_principals_json,
         created_at, updated_at, reviewer_refs_json, confirmation_state
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("dm-retro", "tenant-a", "project-a", "engineering", "CI retry rule", "Retry only infrastructure failures",
      "Product failures must remain visible", "[]", "[]", "active", 0.8, "tenant", "[]", now, now, "[]", "inferred_unconfirmed");
    const retro = await createRetrospective(env, "tenant-a", "user:admin", {
      project_id: "project-a", title: "CI decision review", participant_principals: ["user:admin"]
    });
    expect(retro.items).toHaveLength(1);
    await putRetrospectiveResponse(env, "tenant-a", retro.id, retro.items[0]!.id, "user:admin", { decision: "do_not_adopt" });
    const closed = await closeRetrospective(env, "tenant-a", retro.id, "user:admin", "close-ci-review", {
      items: [{ item_id: retro.items[0]!.id, decision: "not_adopted" }]
    });
    expect(closed.results[0]).toMatchObject({ decision: "not_adopted" });
    expect(((await closeRetrospective(env, "tenant-a", retro.id, "user:admin", "close-ci-review", {
      items: [{ item_id: retro.items[0]!.id, decision: "not_adopted" }]
    })).results[0] as { id: string } | undefined)?.id).toBe((closed.results[0] as { id: string } | undefined)?.id);
    expect(database.prepare("SELECT confirmation_state FROM decision_memories WHERE id='dm-retro'").get())
      .toEqual({ confirmation_state: "inferred_unconfirmed" });
  });

  it("materializes a due 7-day retrospective schedule exactly once", async () => {
    const { database, env } = runtimeEnv();
    const dueAt = Date.now() - 1;
    database.prepare(
      `INSERT INTO decision_memories(
         id, tenant_id, project_id, domain, title, decision, rationale, source_refs_json,
         owner_refs_json, status, confidence, visibility, allowed_principals_json,
         created_at, updated_at, reviewer_refs_json, confirmation_state
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("dm-scheduled", "tenant-a", "project-a", "engineering", "Scheduled review", "Review the current rule",
      "Keep the decision current", "[]", "[]", "active", 0.8, "tenant", "[]", dueAt, dueAt, "[]", "inferred_unconfirmed");
    const schedule = await createRetrospectiveSchedule(env, "tenant-a", "user:admin", {
      project_id: "project-a", cadence_days: 7, next_run_at: dueAt
    });
    expect(await materializeDueRetrospectives(env, Date.now())).toMatchObject({ created: 1, skipped: false });
    expect(await materializeDueRetrospectives(env, Date.now())).toMatchObject({ created: 0, skipped: false });
    expect(database.prepare("SELECT COUNT(*) AS count FROM retrospective_sessions WHERE schedule_id=?").get(schedule.id)?.count).toBe(1);
  });

  it("snapshots Group members, preserves the session after membership changes, and rechecks ACL on close", async () => {
    const { database, env } = runtimeEnv();
    const now = Date.now();
    database.prepare(
      "INSERT INTO groups(id, tenant_id, slug, name, created_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?)"
    ).run("group-a", "tenant-a", "reviewers", "Reviewers", "user:admin", now, now);
    database.prepare(
      "INSERT INTO group_members(tenant_id, group_id, principal, role, created_at, updated_at) VALUES(?,?,?,?,?,?)"
    ).run("tenant-a", "group-a", "user:alice", "member", now, now);
    database.prepare(
      `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role, created_by_principal, created_at, updated_at)
       VALUES('role-alice-project', 'tenant-a', 'project-a', 'user:alice', 'reader', 'user:admin', ?, ?)`
    ).run(now, now);
    database.prepare(
      `INSERT INTO decision_memories(
         id, tenant_id, project_id, domain, title, decision, rationale, source_refs_json,
         owner_refs_json, status, confidence, visibility, allowed_principals_json,
         created_at, updated_at, reviewer_refs_json, confirmation_state
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("dm-group", "tenant-a", "project-a", "engineering", "Release rule", "Require a green build",
      "Protect the release branch", "[]", "[]", "active", 0.8, "tenant", "[]", now, now, "[]", "inferred_unconfirmed");

    const retro = await createRetrospective(env, "tenant-a", "user:admin", {
      project_id: "project-a", participant_group_id: "group-a", title: "Group review"
    });
    expect(retro.progress).toMatchObject({ participants: 2, eligible_responses: 2, unanswered_responses: 2 });
    database.prepare("DELETE FROM group_members WHERE tenant_id=? AND group_id=? AND principal=?")
      .run("tenant-a", "group-a", "user:alice");
    expect((await getRetrospective(env, "tenant-a", retro.id, "user:alice")).items).toHaveLength(1);
    await putRetrospectiveResponse(env, "tenant-a", retro.id, retro.items[0]!.id, "user:admin", { decision: "adopt" });
    await putRetrospectiveResponse(env, "tenant-a", retro.id, retro.items[0]!.id, "user:alice", { decision: "adopt" });

    database.prepare("UPDATE decision_memories SET visibility='restricted', allowed_principals_json=? WHERE tenant_id=? AND id=?")
      .run(JSON.stringify(["user:admin"]), "tenant-a", "dm-group");
    expect(await getRetrospective(env, "tenant-a", retro.id, "user:alice"))
      .toMatchObject({ items: [], progress: { participants: 0, eligible_responses: 0, received_responses: 0 } });
    expect(await listRetrospectives(env, "tenant-a", "user:alice"))
      .toMatchObject([{ item_count: 0, participant_count: 0, eligible_response_count: 0, received_response_count: 0 }]);
    await expect(closeRetrospective(env, "tenant-a", retro.id, "user:admin", "close-group-review", {
      items: [{ item_id: retro.items[0]!.id, decision: "adopted" }]
    })).rejects.toMatchObject({ code: "retrospective_eligibility_changed" });

    database.prepare("UPDATE decision_memories SET visibility='tenant', allowed_principals_json='[]' WHERE tenant_id=? AND id=?")
      .run("tenant-a", "dm-group");
    await closeRetrospective(env, "tenant-a", retro.id, "user:admin", "close-group-review", {
      items: [{ item_id: retro.items[0]!.id, decision: "adopted" }]
    });
    expect((await getRetrospective(env, "tenant-a", retro.id, "user:admin", true)).close_summary)
      .toEqual({ participant_count: 2, unanswered_response_count: 0 });
    database.prepare("UPDATE decision_memories SET visibility='restricted', allowed_principals_json=? WHERE id='dm-group'")
      .run(JSON.stringify(["user:admin"]));
    expect((await getRetrospective(env, "tenant-a", retro.id, "user:alice")).close_summary).toBeNull();
  });

  it("counts only visible items in a mixed-ACL group and disables close in preview", async () => {
    const { database, env } = runtimeEnv();
    database.exec(`
      INSERT INTO groups(id,tenant_id,slug,name,created_by_principal,created_at,updated_at)
        VALUES('mixed','tenant-a','mixed','Mixed','user:admin',1,1);
      INSERT INTO group_members(tenant_id,group_id,principal,role,created_at,updated_at)
        VALUES('tenant-a','mixed','user:alice','member',1,1),('tenant-a','mixed','user:bob','member',1,1);
      INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at)
        VALUES('alice','tenant-a','project-a','user:alice','reader','user:admin',1,1),
              ('bob','tenant-a','project-a','user:bob','reader','user:admin',1,1);
    `);
    for (const [id, allowed] of [["visible", ["user:admin", "user:alice"]], ["hidden", ["user:admin", "user:bob"]]] as const) {
      database.prepare(`INSERT INTO decision_memories(id,tenant_id,project_id,domain,title,decision,rationale,
        source_refs_json,owner_refs_json,status,confidence,visibility,allowed_principals_json,created_at,updated_at,reviewer_refs_json,confirmation_state)
        VALUES(?, 'tenant-a','project-a','engineering',?,?,'Reason','[]','[]','active',0.8,'restricted',?,1,1,'[]','inferred_unconfirmed')`)
        .run(id, id, id, JSON.stringify(allowed));
    }
    const retro = await createRetrospective(env, "tenant-a", "user:admin", { project_id: "project-a", participant_group_id: "mixed", title: "Mixed ACL" });
    const hidden = retro.items.find((item) => item.source_id === "hidden")!;
    await putRetrospectiveResponse(env, "tenant-a", retro.id, hidden.id, "user:bob", { decision: "adopt" });
    const visible = await getRetrospective(env, "tenant-a", retro.id, "user:alice");
    expect(visible.items.map((item) => item.source_id)).toEqual(["visible"]);
    expect(visible.progress).toEqual({ participants: 2, completed_participants: 0, pending_participants: 2,
      eligible_responses: 2, received_responses: 0, unanswered_responses: 2 });
    expect((await listRetrospectives(env, "tenant-a", "user:alice"))[0])
      .toMatchObject({ item_count: 1, participant_count: 2, eligible_response_count: 2, received_response_count: 0 });
    env.RETROSPECTIVE_MODE = "preview";
    env.KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON = "[]";
    expect((await getRetrospective(env, "tenant-a", retro.id, "user:admin", true)).viewer?.can_close).toBe(false);
  });

  it("uses the latest published result for the exact Rule digest and returns edited Rules to pending", async () => {
    const { database, env } = runtimeEnv();
    const now = Date.now();
    database.prepare(
      `INSERT INTO decision_memories(
         id, tenant_id, project_id, domain, title, decision, rationale, constraints_json, source_refs_json,
         owner_refs_json, status, confidence, visibility, allowed_principals_json,
         created_at, updated_at, reviewer_refs_json, confirmation_state
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("dm-rule", "tenant-a", "project-a", "engineering", "Retry policy", "Retry infrastructure failures",
      "Keep product failures visible", JSON.stringify(["Never retry product failures"]), "[]", "[]", "active", 0.9,
      "tenant", "[]", now, now, "[]", "user_confirmed");
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:outsider" })).knowledge)
      .toMatchObject({ decisions: 0, rules: 0, rationales: 0 });
    const retro = await createRetrospective(env, "tenant-a", "user:admin", {
      project_id: "project-a", title: "Rule publication"
    });
    const originalBatch = env.OPEN_BRAIN_DB.batch.bind(env.OPEN_BRAIN_DB);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    env.OPEN_BRAIN_DB.batch = async (statements) => {
      if (++arrivals === 2) release();
      await barrier;
      return originalBatch(statements);
    };
    const closeBody = {
      acknowledge_unanswered: true,
      items: retro.items.map((item) => ({ item_id: item.id, decision: "adopted" }))
    };
    const [firstClose, replay] = await Promise.all([
      closeRetrospective(env, "tenant-a", retro.id, "user:admin", "publish-rule", closeBody),
      closeRetrospective(env, "tenant-a", retro.id, "user:admin", "publish-rule", closeBody)
    ]);
    env.OPEN_BRAIN_DB.batch = originalBatch;
    expect(replay).toEqual(firstClose);
    expect(database.prepare("SELECT COUNT(*) AS count FROM decision_memory_versions WHERE decision_memory_id='dm-rule' AND operation='confirm'").get())
      .toEqual({ count: 1 });
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", projectId: "project-a", includeAll: true })).knowledge_status?.rules)
      .toMatchObject({ total: 1, adopted: 1, pending: 0 });

    // Published pre-pilot rows carry version-bearing digests; normalize their immutable content too.
    const publishedRule = retro.items.find((item) => item.source_type === "projected_rule")!;
    const legacyDigest = await sha256(canonicalJson({ source_type: publishedRule.source_type,
      source_id: publishedRule.source_id, version: publishedRule.source_version, title: publishedRule.title,
      statement: publishedRule.statement, rationale: publishedRule.rationale, evidence: publishedRule.evidence }));
    database.prepare("UPDATE retrospective_items SET source_digest=? WHERE id=?").run(legacyDigest, publishedRule.id);
    database.prepare("UPDATE retrospective_results SET source_digest=? WHERE item_id=?").run(legacyDigest, publishedRule.id);
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", includeAll: true })).knowledge_status?.rules)
      .toMatchObject({ adopted: 1, pending: 0 });

    const reconsidered = await createRetrospective(env, "tenant-a", "user:admin", {
      project_id: "project-a", title: "Rule reconsideration"
    });
    const reconsideredRule = reconsidered.items.find((item) => item.source_type === "projected_rule")!;
    await closeRetrospective(env, "tenant-a", reconsidered.id, "user:admin", "reject-rule", {
      acknowledge_unanswered: true,
      items: reconsidered.items.map((item) => ({ item_id: item.id, decision: item.id === reconsideredRule.id ? "not_adopted" : "deferred" }))
    });
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", projectId: "project-a", includeAll: true })).knowledge_status?.rules)
      .toMatchObject({ total: 1, adopted: 0, pending: 1 });

    database.prepare("UPDATE decision_memories SET constraints_json=?, updated_at=? WHERE tenant_id=? AND id=?")
      .run(JSON.stringify(["Retry only explicitly classified infrastructure failures"]), now + 1, "tenant-a", "dm-rule");
    expect((await getOrganizationDashboard(env, "tenant-a", { principal: "user:admin", projectId: "project-a", includeAll: true })).knowledge_status?.rules)
      .toMatchObject({ total: 1, adopted: 0, pending: 1 });
  });

  it("completes a tenant-scoped goal without creating a project binding or fabricated value", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, { mode: "unknown" }, "create-tenant-knowledge-pack", null);
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: null,
      revision: session.revision
    });
    const completed = await completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "complete-tenant-knowledge-pack",
      { tenant_id: "tenant-a", project_id: null, plan_digest: planned.plan.plan_digest }
    );
    expect(completed.completion?.sources).toEqual([{
      metric_key: "build_success_rate",
      source_binding_id: null,
      state: "unknown"
    }]);
    expect(database.prepare("SELECT binding_id FROM metric_targets").get()?.binding_id).toBeNull();
    expect(database.prepare("SELECT count(*) AS count FROM metric_snapshots").get()?.count).toBe(0);
  });

  it("deduplicates concurrent completion retries that use the same key", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, {
      mode: "manual",
      initial_value: 91,
      observed_at: Date.now(),
      evidence_ref: "evidence://build/concurrent-baseline"
    }, "create-concurrent-knowledge-pack");
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: session.revision
    });
    const complete = () => completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "complete-concurrent-knowledge-pack",
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    const concurrent = await Promise.allSettled([complete(), complete()]);
    const completed = concurrent.find((result) => result.status === "fulfilled");
    const inProgress = concurrent.find((result) => result.status === "rejected");
    expect(completed?.status).toBe("fulfilled");
    if (inProgress?.status === "rejected") {
      expect(inProgress.reason).toMatchObject({ code: "knowledge_pack_completion_in_progress" });
    }
    const replayed = await complete();
    if (completed?.status === "fulfilled") expect(replayed.completion).toEqual(completed.value.completion);
    expect(database.prepare("SELECT count(*) AS count FROM metric_targets").get()?.count).toBe(1);
    expect(database.prepare("SELECT count(*) AS count FROM metric_snapshots").get()?.count).toBe(1);
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_releases WHERE classification='organization_overlay'"
    ).get()?.count).toBe(1);
  });

  it("retries a failed post-claim completion only with its original key", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, { mode: "unknown" }, "create-retryable-knowledge-pack");
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: session.revision
    });
    const d1 = env.OPEN_BRAIN_DB as unknown as { prepare: (sql: string) => D1StatementAdapter };
    const prepare = d1.prepare.bind(d1);
    let failPublishOnce = true;
    d1.prepare = (sql: string) => {
      if (failPublishOnce && sql.includes("INSERT OR IGNORE INTO domain_pack_releases")) {
        failPublishOnce = false;
        throw new Error("injected post-claim publish failure");
      }
      return prepare(sql);
    };
    const complete = (key: string) => completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      key,
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    await expect(complete("complete-retryable-knowledge-pack")).rejects.toThrow("injected post-claim publish failure");
    const completed = await complete("complete-retryable-knowledge-pack");
    expect(completed.state).toBe("completed");
    expect((await complete("different-completion-key")).completion).toEqual(completed.completion);
    expect(database.prepare(
      "SELECT count(*) AS count FROM domain_pack_releases WHERE classification='organization_overlay'"
    ).get()?.count).toBe(1);
  });

  it("rejects a different completion key while the original claim is active", async () => {
    const { database, env } = runtimeEnv();
    const session = await buildReadySession(env, { mode: "unknown" }, "create-contended-knowledge-pack");
    const planned = await planKnowledgePackOnboarding(env, "tenant-a", session.id, {
      tenant_id: "tenant-a",
      project_id: "project-a",
      revision: session.revision
    });
    const complete = (key: string) => completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      key,
      { tenant_id: "tenant-a", project_id: "project-a", plan_digest: planned.plan.plan_digest }
    );
    database.prepare(
      `UPDATE knowledge_pack_onboarding_sessions
       SET completion_idempotency_key = ?, completion_claimed_at = ?
       WHERE id = ?`
    ).run("complete-contended-primary", Date.now(), session.id);
    await expect(complete("complete-contended-secondary")).rejects.toMatchObject({
      code: "idempotency_key_conflict"
    });
    database.prepare(
      "UPDATE knowledge_pack_onboarding_sessions SET completion_claimed_at = 0 WHERE id = ?"
    ).run(session.id);
    expect((await complete("complete-contended-primary")).state).toBe("completed");
  });

  it("keeps preview mode non-installing and enforces tenant and step boundaries", async () => {
    const { database, env } = runtimeEnv("preview");
    const session = await createKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      "preview-session",
      { tenant_id: "tenant-a", project_id: null }
    );
    await expect(getKnowledgePackOnboarding(env, "tenant-b", session.id)).rejects.toMatchObject({
      code: "knowledge_pack_onboarding_not_found"
    });
    await expect(getKnowledgePackOnboarding(env, "tenant-a", session.id, "project-a")).rejects.toMatchObject({
      code: "knowledge_pack_onboarding_not_found"
    });
    await expect(saveStep(env, session, "template", {
      pack_ids: ["function.build-engineering"]
    })).rejects.toMatchObject({ code: "knowledge_pack_step_out_of_order" });
    await expect(completeKnowledgePackOnboarding(
      env,
      "tenant-a",
      "user:admin",
      session.id,
      "preview-completion",
      { tenant_id: "tenant-a", plan_digest: "a".repeat(64) }
    )).rejects.toMatchObject({ code: "feature_preview" });
    expect(database.prepare("SELECT count(*) AS count FROM domain_pack_installations").get()?.count).toBe(0);
  });
});
