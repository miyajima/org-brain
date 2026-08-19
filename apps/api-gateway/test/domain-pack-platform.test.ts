import { describe, expect, it } from "vitest";
import {
  createDecisionDomainLink,
  createManagedObject,
  createManagedObjectType,
  createMetricBinding,
  createMetricDefinition,
  createMetricSnapshot,
  getDomainContext,
  listMetricSourceBindings,
  queryMetricSnapshots,
  queryMetrics,
  setMetricTarget,
  upsertDomainDashboard
} from "../src/domain-metric-service";
import { installDomainPacks, planDomainPackInstallation } from "../src/domain-pack-service";
import { getDomainPackWorkspace } from "../src/domain-workspace-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { cwd: () => string; getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
const { readFileSync } = runtime.getBuiltinModule("node:fs") as { readFileSync: (path: string, encoding: string) => string };

class D1StatementAdapter {
  private args: unknown[] = [];
  constructor(private database: SqliteDatabase, private sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function runtimeEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`CREATE TABLE knowledge_assertions(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, assertion_type TEXT NOT NULL,
    subject_type TEXT NOT NULL, subject_ref TEXT NOT NULL, predicate TEXT NOT NULL,
    object_type TEXT, object_ref TEXT, resource_id TEXT, object_value TEXT,
    context_json TEXT NOT NULL, confidence REAL NOT NULL, confirmation_state TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, valid_from INTEGER NOT NULL, valid_until INTEGER,
    actor_principal TEXT NOT NULL, reviewed_by_principal TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  database.exec(`CREATE TABLE decision_memories(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL,
    rejected_alternatives_json TEXT NOT NULL DEFAULT '[]', constraints_json TEXT NOT NULL DEFAULT '[]',
    source_refs_json TEXT NOT NULL DEFAULT '[]', confirmation_state TEXT NOT NULL DEFAULT 'inferred_unconfirmed'
  );`);
  database.exec(`CREATE TABLE decision_rationales(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conclusion TEXT NOT NULL,
    reason_summary TEXT NOT NULL, confirmation_state TEXT NOT NULL
  );`);
  database.exec(`CREATE TABLE knowledge_resources(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, resource_kind TEXT NOT NULL,
    source_system TEXT NOT NULL, lifecycle_state TEXT NOT NULL, updated_at INTEGER NOT NULL,
    canonical_uri TEXT NOT NULL
  );`);
  database.exec(readFileSync(`${runtime.cwd()}/../../migrations/0034_domain_pack_platform.sql`, "utf8"));
  database.exec(readFileSync(`${runtime.cwd()}/../../migrations/0035_domain_pack_workspaces.sql`, "utf8"));
  const db = {
    prepare: (sql: string) => new D1StatementAdapter(database, sql),
    batch: async (statements: D1StatementAdapter[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return {
    database,
    env: {
      OPEN_BRAIN_DB: db,
      DOMAIN_PACKS_MODE: "install",
      DOMAIN_METRICS_MODE: "on",
      DOMAIN_WORKSPACES_MODE: "on"
    } as unknown as Env
  };
}

const manualMetric = (key: string) => ({
  key, label: key, origin_type: "custom", scope_type: "tenant", source_type: "manual",
  unit: "count", aggregation_window: "P7D", freshness_seconds: 86_400, target_direction: "increase"
});

describe("Domain Pack Platform", () => {
  it("previews and idempotently installs all four Packs without example objects", async () => {
    const { database, env } = runtimeEnv();
    const pack_ids = ["function.build-engineering", "function.sre", "function.sales", "function.pdm-b2c-marketplace"];
    const plan = await planDomainPackInstallation(env, "tenant-a", { pack_ids });
    expect(plan.packs).toHaveLength(4);
    expect(plan.examples_loaded).toBe(false);
    const installed = await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids, plan_digest: plan.plan_digest });
    expect(installed.installations).toHaveLength(4);
    expect(database.prepare("SELECT count(*) AS count FROM managed_objects").get()?.count).toBe(0);
    const repeated = await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids });
    expect(repeated.installations.every((item) => item.action === "unchanged")).toBe(true);
  });

  it("keeps Manifest-external custom metrics and lets dashboards reference them", async () => {
    const { database, env } = runtimeEnv();
    const created = await createMetricDefinition(env, "tenant-a", "user:pdm", {
      tenant_id: "tenant-a",
      key: "quality_adjusted_activation_rate", label: "Quality adjusted activation",
      origin_type: "custom", scope_type: "tenant", source_type: "derived", unit: "ratio",
      aggregation_window: "P7D", freshness_seconds: 86_400, target_direction: "increase",
      formula: { operation: "ratio", metric_keys: ["qualified_activated_users", "new_users"] }
    });
    expect(created.origin_type).toBe("custom");
    await upsertDomainDashboard(env, "tenant-a", "user:pdm", {
      key: "pdm-custom", title: "PdM Custom", widgets: [{
        key: "quality-activation", kind: "metric", title: "Quality activation",
        metric_keys: ["quality_adjusted_activation_rate"], layout: { x: 0, y: 0, w: 6, h: 3 }
      }]
    });
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.pdm-b2c-marketplace"] });
    expect(database.prepare("SELECT origin_type FROM metric_definitions WHERE metric_key='quality_adjusted_activation_rate'").get()?.origin_type).toBe("custom");
    expect(database.prepare("SELECT origin_type FROM domain_dashboards WHERE dashboard_key='pdm-custom'").get()?.origin_type).toBe("custom");
  });

  it("computes only allow-listed derived formulas and never renders expired values as zero", async () => {
    const { env } = runtimeEnv();
    await createMetricDefinition(env, "tenant-a", "user:pdm", manualMetric("qualified_activated_users"));
    await createMetricDefinition(env, "tenant-a", "user:pdm", manualMetric("new_users"));
    const now = Date.now();
    await createMetricSnapshot(env, "tenant-a", "user:pdm", {
      metric_key: "qualified_activated_users", scope_type: "tenant", value: 54, state: "measured",
      observed_at: now - 2_000, expires_at: now - 1_000, idempotency_key: "qualified-expired"
    });
    await createMetricSnapshot(env, "tenant-a", "user:pdm", {
      metric_key: "new_users", scope_type: "tenant", value: 100, state: "measured",
      observed_at: now, expires_at: now + 86_400_000, idempotency_key: "new-users"
    });
    await createMetricDefinition(env, "tenant-a", "user:pdm", {
      key: "quality_adjusted_activation_rate", label: "Quality adjusted activation",
      origin_type: "custom", scope_type: "tenant", source_type: "derived", unit: "ratio",
      aggregation_window: "P7D", freshness_seconds: 86_400, target_direction: "increase",
      formula: { operation: "ratio", metric_keys: ["qualified_activated_users", "new_users"] }
    });
    const derived = await createMetricSnapshot(env, "tenant-a", "user:pdm", {
      metric_key: "quality_adjusted_activation_rate", scope_type: "tenant",
      observed_at: now, expires_at: now + 86_400_000, idempotency_key: "derived-unknown"
    });
    expect(derived).toMatchObject({ state: "unknown", value: null });
    const queried = await queryMetrics(env, "tenant-a", { metricKeys: ["qualified_activated_users"] });
    expect(queried[0]?.latest).toMatchObject({ state: "stale", value: null });
  });

  it("traces Decisions to managed objects and custom metrics through canonical assertions", async () => {
    const { env } = runtimeEnv();
    await createManagedObjectType(env, "tenant-a", "user:pdm", { key: "experiment", label: "Experiment" });
    await createManagedObject(env, "tenant-a", "user:pdm", {
      id: "EXP-PERSONALIZED-DISCOVERY-01", object_type_key: "experiment", name: "Personalized discovery"
    });
    const metric = await createMetricDefinition(env, "tenant-a", "user:pdm", manualMetric("quality_adjusted_activation_rate"));
    await createDecisionDomainLink(env, "tenant-a", "user:pdm", {
      decision_source_type: "decision_memory", decision_source_id: "DEC-PDM-01",
      relation: "about_object", object_type: "managed_object", object_id: "EXP-PERSONALIZED-DISCOVERY-01",
      confirmation_state: "confirmed"
    });
    await createDecisionDomainLink(env, "tenant-a", "user:pdm", {
      decision_source_type: "decision_memory", decision_source_id: "DEC-PDM-01",
      relation: "triggered_by_metric", object_type: "metric_definition", object_id: metric.id,
      confirmation_state: "confirmed"
    });
    const context = await getDomainContext(env, "tenant-a", { objectId: "EXP-PERSONALIZED-DISCOVERY-01", decisionId: "DEC-PDM-01" });
    expect((context.object as Record<string, unknown>)?.type_key).toBe("experiment");
    expect(context.assertions.map((item) => item.predicate)).toEqual(expect.arrayContaining(["about_object", "triggered_by_metric"]));
  });

  it("creates connector placeholders and exposes immutable Snapshot history", async () => {
    const { env } = runtimeEnv();
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.build-engineering"] });
    const sources = await listMetricSourceBindings(env, "tenant-a", {});
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((item) => item.status === "unconfigured" && item.connection_ref === null)).toBe(true);

    const now = Date.now();
    const source = sources.find((item) => item.metric_key === "build_success_rate")!;
    await createMetricSnapshot(env, "tenant-a", "collector:github", {
      metric_key: "build_success_rate", scope_type: "tenant", value: 91, state: "measured",
      observed_at: now - 10_000, expires_at: now + 60_000, source_binding_id: source.id,
      idempotency_key: "build-success-baseline"
    });
    await createMetricSnapshot(env, "tenant-a", "collector:github", {
      metric_key: "build_success_rate", scope_type: "tenant", value: 98.6, state: "measured",
      observed_at: now, expires_at: now + 60_000, source_binding_id: source.id,
      idempotency_key: "build-success-after"
    });
    const history = await queryMetricSnapshots(env, "tenant-a", { metricKeys: ["build_success_rate"] });
    expect(history.map((item) => item.value)).toEqual([91, 98.6]);
    expect(history.every((item) => item.source_binding_id === source.id)).toBe(true);
  });

  it("selects Decision-linked baseline and verified outcome in the Workspace", async () => {
    const { database, env } = runtimeEnv();
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.build-engineering"] });
    database.prepare(
      `INSERT INTO decision_memories(
         id, tenant_id, decision, rationale, rejected_alternatives_json,
         constraints_json, source_refs_json, confirmation_state
       ) VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      "DEC-BUILD-01", "tenant-a", "runner poolを2台増やす", "runner待ちが支配的",
      '[{"alternative":"testを削除","reasonRejected":"品質を失う"}]', "[]", "[]", "confirmed"
    );
    const now = Date.now();
    const baseline = await createMetricSnapshot(env, "tenant-a", "collector:github", {
      metric_key: "build_duration_p95", scope_type: "tenant", value: 18.4, state: "measured",
      observed_at: now - 20_000, expires_at: now + 60_000, idempotency_key: "duration-before"
    });
    const outcome = await createMetricSnapshot(env, "tenant-a", "collector:github", {
      metric_key: "build_duration_p95", scope_type: "tenant", value: 9.7, state: "measured",
      observed_at: now, expires_at: now + 60_000, idempotency_key: "duration-after"
    });
    await createDecisionDomainLink(env, "tenant-a", "user:lead", {
      decision_source_type: "decision_memory", decision_source_id: "DEC-BUILD-01",
      relation: "triggered_by_metric", object_type: "metric_snapshot", object_id: baseline.id,
      confirmation_state: "confirmed"
    });
    await createDecisionDomainLink(env, "tenant-a", "user:lead", {
      decision_source_type: "decision_memory", decision_source_id: "DEC-BUILD-01",
      relation: "verified_by_metric", object_type: "metric_snapshot", object_id: outcome.id,
      confirmation_state: "confirmed"
    });
    const workspace = await getDomainPackWorkspace(env, "tenant-a", "function.build-engineering", {});
    const metric = workspace.metric_groups.flatMap((group) => group.metrics)
      .find((item) => item.metric_key === "build_duration_p95");
    expect(workspace.decision).toMatchObject({ id: "DEC-BUILD-01", confirmation_state: "confirmed" });
    expect(metric?.baseline?.value).toBe(18.4);
    expect(metric?.outcome?.value).toBe(9.7);
    expect(metric?.current?.value).toBe(9.7);
  });

  it("keeps a Pack-linked custom metric in the Workspace across Pack upgrades", async () => {
    const { env } = runtimeEnv();
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.pdm-b2c-marketplace"] });
    await createManagedObject(env, "tenant-a", "user:pdm", {
      id: "EXP-QUALITY-ACTIVATION", object_type_key: "experiment", name: "Quality adjusted activation"
    });
    const definition = await createMetricDefinition(env, "tenant-a", "user:pdm", manualMetric("quality_adjusted_activation_rate"));
    const binding = await createMetricBinding(env, "tenant-a", "user:pdm", definition.id, {
      scope_type: "managed_object", scope_id: "EXP-QUALITY-ACTIVATION", dimensions: {}
    });
    const now = Date.now();
    await createMetricSnapshot(env, "tenant-a", "user:pdm", {
      metric_key: "quality_adjusted_activation_rate", binding_id: binding.id,
      scope_type: "managed_object", value: 42, state: "measured",
      observed_at: now, expires_at: now + 86_400_000, idempotency_key: "quality-activation-after"
    });

    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.pdm-b2c-marketplace"] });
    const workspace = await getDomainPackWorkspace(env, "tenant-a", "function.pdm-b2c-marketplace", {
      scopeId: "EXP-QUALITY-ACTIVATION"
    });
    const metric = workspace.metric_groups.flatMap((group) => group.metrics)
      .find((item) => item.metric_key === "quality_adjusted_activation_rate");
    expect(metric).toMatchObject({ origin_type: "custom", current: { value: 42 } });
  });

  it("rejects source bindings and Workspace data across tenant boundaries", async () => {
    const { env } = runtimeEnv();
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.sre"] });
    await installDomainPacks(env, "tenant-b", "user:admin", { pack_ids: ["function.sre"] });
    const sourceA = (await listMetricSourceBindings(env, "tenant-a", {}))
      .find((item) => item.metric_key === "availability")!;
    const now = Date.now();
    await expect(createMetricSnapshot(env, "tenant-b", "collector:datadog", {
      metric_key: "availability", scope_type: "tenant", value: 99.97, state: "measured",
      source_binding_id: sourceA.id, observed_at: now, expires_at: now + 60_000,
      idempotency_key: "cross-tenant-source"
    })).rejects.toMatchObject({ code: "metric_source_binding_not_found" });
    expect((await listMetricSourceBindings(env, "tenant-b", {})).some((item) => item.id === sourceA.id)).toBe(false);
  });

  it("selects the target that was effective when the current Snapshot was observed", async () => {
    const { env } = runtimeEnv();
    await installDomainPacks(env, "tenant-a", "user:admin", { pack_ids: ["function.build-engineering"] });
    const metric = (await queryMetrics(env, "tenant-a", { metricKeys: ["build_duration_p95"] }))[0]!;
    const now = Date.now();
    await setMetricTarget(env, "tenant-a", "user:lead", String(metric.id), {
      direction: "decrease", target_value: 10,
      effective_from: now - 20_000, effective_to: now - 5_000,
      reason: "Decision当時のtarget"
    });
    await setMetricTarget(env, "tenant-a", "user:lead", String(metric.id), {
      direction: "decrease", target_value: 8,
      effective_from: now - 4_000, effective_to: null,
      reason: "後から引き上げたtarget"
    });
    await createMetricSnapshot(env, "tenant-a", "collector:github", {
      metric_key: "build_duration_p95", scope_type: "tenant", value: 9.7, state: "measured",
      observed_at: now - 6_000, expires_at: now + 60_000, idempotency_key: "target-at-observation"
    });
    const workspace = await getDomainPackWorkspace(env, "tenant-a", "function.build-engineering", {});
    const duration = workspace.metric_groups.flatMap((group) => group.metrics)
      .find((item) => item.metric_key === "build_duration_p95");
    expect(duration?.target).toMatchObject({ value: 10, reason: "Decision当時のtarget" });
    expect(duration?.status).toBe("achieved");
  });
});
