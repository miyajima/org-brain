import { describe, expect, it } from "vitest";
import { getDecisionBriefing, getDecisionTrace } from "../src/decision-console-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { gzipSync } = runtime.getBuiltinModule("node:zlib") as {
  gzipSync: (input: string) => { byteLength: number };
};
const { readFileSync, readdirSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: URL, encoding: "utf8") => string;
  readdirSync: (path: URL) => string[];
};

const DECISION_COUNT = 100_000;
const SAMPLE_COUNT = 20;
const MAX_P95_MS = 500;
const MAX_GZIP_BYTES = 250 * 1024;
const TENANT = "tenant-decision-scale";
const PROJECT = "project-decision-scale";
const PRINCIPAL = "user:decision-scale";
const FOCUS = "decision-scale-000000";
const NOW = 1_800_000_000_000;

class Statement {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[] }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function applyMigrations(database: SqliteDatabase) {
  const directory = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
}

function seed(database: SqliteDatabase) {
  database.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; BEGIN IMMEDIATE");
  try {
    const decision = database.prepare(`
      INSERT INTO decision_memories(
        id, tenant_id, project_id, domain, title, decision, rationale,
        rejected_alternatives_json, constraints_json, known_pitfalls_json,
        source_refs_json, owner_refs_json, reviewer_refs_json, valid_from, valid_until,
        status, superseded_by, confidence, visibility, allowed_principals_json,
        confirmation_state, confirmation_note, confirmed_at, created_at, updated_at
      ) VALUES(?,?,?,'product',?,?,?,'[]','[]','[]','[]',?,'[]',NULL,NULL,'active',NULL,0.9,'tenant','[]','user_confirmed',NULL,?,?,?)
    `);
    const policy = database.prepare(`
      INSERT INTO resource_access_policies(
        id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
        group_ids_json, restricted_subjects_json, storage_location, policy_version,
        created_by_principal, created_at, updated_at
      ) VALUES(?,?,'decision_memory',?,'tenant',?,?,'[]','[]','d1',1,?,?,?)
    `);
    for (let index = 0; index < DECISION_COUNT; index += 1) {
      const id = `decision-scale-${String(index).padStart(6, "0")}`;
      decision.run(
        id, TENANT, PROJECT, `Decision ${index}`, `Adopt bounded projection ${index}`,
        `Reason ${index}`, JSON.stringify([{ type: "principal", id: PRINCIPAL }]),
        NOW - index, NOW - index, NOW - index
      );
      if (index < 300) {
        policy.run(`policy:${id}`, TENANT, id, PRINCIPAL, PROJECT, PRINCIPAL, NOW, NOW);
      }
    }
    database.prepare(`
      INSERT INTO decision_memory_versions(
        id, decision_memory_id, tenant_id, operation, snapshot_json,
        actor_refs_json, reviewer_refs_json, note, created_at
      ) VALUES('focus-version',?,?,'create',?,'[]','[]',NULL,?)
    `).run(FOCUS, TENANT, JSON.stringify({ decision: "Adopt bounded projection" }), NOW);

    const resource = database.prepare(`
      INSERT INTO knowledge_resources(
        id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system,
        media_type, visibility, permissions_json, current_version_id, lifecycle_state,
        created_by_principal, created_at, updated_at
      ) VALUES(?,?,?,'document',?,?, 'fixture','text/markdown','tenant','[]',NULL,'active',?,?,?)
    `);
    const resourcePolicy = database.prepare(`
      INSERT INTO resource_access_policies(
        id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
        group_ids_json, restricted_subjects_json, storage_location, policy_version,
        created_by_principal, created_at, updated_at
      ) VALUES(?,?,'knowledge_resource',?,'tenant',?,?,'[]','[]','d1_r2',1,?,?,?)
    `);
    const assertion = database.prepare(`
      INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, context_json, confidence, confirmation_state,
        idempotency_key, valid_from, valid_until, actor_principal, reviewed_by_principal,
        created_at, updated_at
      ) VALUES(?,?,?,'relation','decision_memory',?,'rationale_source','knowledge_resource',?,?,'{}',0.9,'confirmed',?,?,NULL,?,?,?,?)
    `);
    for (let index = 0; index < 160; index += 1) {
      const id = `scale-resource-${String(index).padStart(3, "0")}`;
      resource.run(id, TENANT, PROJECT, `https://example.test/${id}`, `Scale evidence ${index}`, PRINCIPAL, NOW, NOW);
      resourcePolicy.run(`policy:${id}`, TENANT, id, PRINCIPAL, PROJECT, PRINCIPAL, NOW, NOW);
      assertion.run(`assertion:${id}`, TENANT, PROJECT, FOCUS, id, id, `idem:${id}`, NOW, PRINCIPAL, PRINCIPAL, NOW, NOW);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function percentile(values: number[], percentileValue: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)] ?? 0;
}

async function measure<T>(operation: () => Promise<T>) {
  await operation();
  await operation();
  const timings: number[] = [];
  let result = await operation();
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    result = await operation();
    timings.push(performance.now() - startedAt);
  }
  return { result, p95Ms: percentile(timings, 95) };
}

describe("Decision Console local performance acceptance", () => {
  it("keeps briefing and trace bounded at 100k decisions", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      seed(database);
      const env = {
        OPEN_BRAIN_DB: { prepare: (sql: string) => new Statement(database, sql) },
        ACCESS_POLICY_SHADOW_MODE: "off"
      } as unknown as Env;
      expect(database.prepare("SELECT COUNT(*) AS count FROM decision_memories WHERE tenant_id = ?").get(TENANT))
        .toEqual({ count: DECISION_COUNT });

      const briefing = await measure(() => getDecisionBriefing(env, {
        tenantId: TENANT, principal: PRINCIPAL, projectId: PROJECT, limit: 50
      }));
      const trace = await measure(() => getDecisionTrace(env, {
        tenantId: TENANT, decisionId: FOCUS, principal: PRINCIPAL, projectId: PROJECT,
        includeInferred: false, nodeLimit: 150, edgeLimit: 300
      }));
      expect(briefing.result.items).toHaveLength(50);
      expect(trace.result.nodes).toHaveLength(150);
      expect(trace.result.edges.length).toBeLessThanOrEqual(300);
      expect(trace.result.truncated).toBe(true);

      const p95 = { briefing: briefing.p95Ms, trace: trace.p95Ms };
      for (const [surface, duration] of Object.entries(p95)) {
        expect(duration, `${surface} local p95 was ${duration.toFixed(2)}ms`).toBeLessThanOrEqual(MAX_P95_MS);
      }
      const gzipBytes = {
        briefing: gzipSync(JSON.stringify(briefing.result)).byteLength,
        trace: gzipSync(JSON.stringify(trace.result)).byteLength
      };
      for (const [surface, bytes] of Object.entries(gzipBytes)) {
        expect(bytes, `${surface} compressed response was ${bytes} bytes`).toBeLessThanOrEqual(MAX_GZIP_BYTES);
      }
      console.info("decision-console-performance", JSON.stringify({
        fixture_decisions: DECISION_COUNT,
        samples: SAMPLE_COUNT,
        p95_ms: Object.fromEntries(Object.entries(p95).map(([key, value]) => [key, Number(value.toFixed(3))])),
        gzip_bytes: gzipBytes
      }));
    } finally {
      database.close();
    }
  }, 120_000);
});
