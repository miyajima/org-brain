import { describe, expect, it } from "vitest";
import { getActivityDashboard } from "../src/activity-dashboard-service";
import { getKnowledgeGraph } from "../src/knowledge-graph-service";
import { getMemoryStrata, getMemoryStrataDetail } from "../src/memory-strata-service";
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

const runtime = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process;

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

const MEMORY_COUNT = 100_000;
const DENSE_ACTIVITY_COUNT_PER_VISIBILITY = 20_000;
const DENSE_ACTIVITY_AGENT_COUNT = 12;
const SERVICE_SAMPLE_COUNT = 20;
const MAX_SERVICE_P95_MS = 500;
const MAX_COMPRESSED_BYTES = 250 * 1024;
const TENANT_ID = "tenant-dashboard-scale";
const PROJECT_ID = "project-dashboard-scale";
const DETAIL_MEMORY_ID = "memory-000000";
const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const HIDDEN_MEMORY_START = 50_000;
const HIDDEN_MEMORY_END = HIDDEN_MEMORY_START + DENSE_ACTIVITY_COUNT_PER_VISIBILITY;
const HIDDEN_MEMORY_PERMISSIONS = JSON.stringify([{
  principal_type: "principal",
  principal_id: "user:hidden-reader",
  permissions: ["read"]
}]);

class D1StatementAdapter {
  private args: unknown[] = [];

  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.args) as T[],
      success: true
    };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

type TimedResult<T> = {
  result: T;
  p95Ms: number;
};

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return ordered[index] ?? 0;
}

async function measureAsync<T>(operation: () => Promise<T>): Promise<TimedResult<T>> {
  await operation();
  await operation();
  const samples: number[] = [];
  let result = await operation();
  for (let index = 0; index < SERVICE_SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    result = await operation();
    samples.push(performance.now() - startedAt);
  }
  return { result, p95Ms: percentile(samples, 95) };
}

function applyMigrations(database: SqliteDatabase): void {
  const migrationDirectory = new URL("../../../migrations/", import.meta.url);
  const files = readdirSync(migrationDirectory)
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort();
  for (const file of files) {
    database.exec(readFileSync(new URL(file, migrationDirectory), "utf8"));
  }
}

function deterministicText(seed: number, length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = (seed + 1) * 2_654_435_761;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    result += alphabet[state % alphabet.length];
  }
  return result;
}

function memoryId(index: number): string {
  return `memory-${String(index).padStart(6, "0")}`;
}

function seedScaleFixture(database: SqliteDatabase): void {
  database.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;");
  const sourceRefs = JSON.stringify(Array.from({ length: 51 }, (_, index) => ({
    type: "url",
    id: `https://example.test/source/${index}`,
    title: `Scale evidence ${index} ${deterministicText(index, 48)}`
  })));
  const insertMemory = database.prepare(
    `INSERT INTO memories(
       id, tenant_id, project_id, content, summary, tags_json, created_at,
       kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id,
       confidence_score, utility_score, canonical_key, current_version,
       last_accessed_at, source, source_refs_json, updated_at, valid_from,
       content_hash, evidence_json, conflicts_json, permissions_json
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < MEMORY_COUNT; index += 1) {
      const id = memoryId(index);
      const isDormant = index % 1_000 === 0;
      const isHiddenActivityMemory = index >= HIDDEN_MEMORY_START && index < HIDDEN_MEMORY_END;
      insertMemory.run(
        id,
        TENANT_ID,
        PROJECT_ID,
        `Scale memory ${index}: ${deterministicText(index, 72)}`,
        `Scale summary ${index} ${deterministicText(index + MEMORY_COUNT, 44)}`,
        index % 10 === 0 ? '["canonical-memory"]' : "[]",
        NOW - index,
        index % 5 === 0 ? "semantic" : "episodic",
        index % 10 === 0 ? "promoted" : "active",
        "project",
        PROJECT_ID,
        "agent",
        `agent:scale-${index % DENSE_ACTIVITY_AGENT_COUNT}`,
        0.82,
        isDormant ? 0.95 : 0.5,
        index % 10 === 0 ? `canonical:scale:${index}` : null,
        index === 0 ? 101 : 1,
        isDormant ? NOW - 31 * DAY_MS - index : NOW - index,
        "dashboard-scale-fixture",
        index === 0 ? sourceRefs : "[]",
        NOW - index,
        NOW - 60 * DAY_MS,
        `hash-${index}`,
        "[]",
        "[]",
        isHiddenActivityMemory ? HIDDEN_MEMORY_PERMISSIONS : "[]"
      );
    }

    const insertEdge = database.prepare(
      "INSERT INTO memory_edges(id, tenant_id, from_memory_id, to_memory_id, relation, created_at) VALUES(?,?,?,?,?,?)"
    );
    for (let index = 0; index < 320; index += 1) {
      insertEdge.run(
        `scale-edge-near-${index}`,
        TENANT_ID,
        memoryId(index % 145),
        memoryId((index + 1) % 145),
        "supports",
        NOW - index
      );
      insertEdge.run(
        `scale-edge-cross-${index}`,
        TENANT_ID,
        memoryId(index % 145),
        memoryId((index + 17) % 145),
        "relates_to",
        NOW - 1_000 - index
      );
    }

    const insertVersion = database.prepare(
      `INSERT INTO memory_versions(
         id, memory_id, tenant_id, version, operation, content, summary, tags_json,
         kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id,
         confidence_score, utility_score, canonical_key, created_at, snapshot_json,
         content_hash
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (let version = 1; version <= 101; version += 1) {
      const revisionText = deterministicText(version + 200_000, 6_000);
      insertVersion.run(
        `scale-version-${version}`,
        DETAIL_MEMORY_ID,
        TENANT_ID,
        version,
        version === 1 ? "capture" : "revise",
        revisionText,
        `Scale revision ${version}`,
        "[]",
        "semantic",
        version === 101 ? "promoted" : "active",
        "project",
        PROJECT_ID,
        "agent",
        `agent:scale-${version % 12}`,
        0.82,
        0.95,
        version === 101 ? "canonical:scale:0" : null,
        NOW - 10 * DAY_MS - version,
        JSON.stringify({
          content: revisionText,
          summary: `Scale revision ${version}`,
          kind: "semantic",
          lifecycle_state: version === 101 ? "promoted" : "active",
          rationale: deterministicText(version + 300_000, 2_000)
        }),
        `version-hash-${version}`
      );
    }

    const insertUsageEvent = database.prepare(
      `INSERT INTO memory_usage_events(
         id, tenant_id, project_id, capability, access_path, request_source,
         created_at, actor_principal
       ) VALUES(?,?,?,?,?,?,?,?)`
    );
    const insertUsageItem = database.prepare(
      `INSERT INTO memory_usage_items(
         id, usage_event_id, tenant_id, source_type, source_id,
         reference_type, used_state, created_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    );
    for (let index = 0; index < DENSE_ACTIVITY_COUNT_PER_VISIBILITY; index += 1) {
      const visibleMemoryId = memoryId(index + 1);
      const hiddenMemoryId = memoryId(HIDDEN_MEMORY_START + index);
      const visibleAt = NOW - index * 2;
      const hiddenAt = visibleAt - 1;
      const visibleAgent = `agent:scale-${index % DENSE_ACTIVITY_AGENT_COUNT}`;
      const hiddenAgent = `agent:hidden-${index % DENSE_ACTIVITY_AGENT_COUNT}`;

      insertVersion.run(
        `dense-visible-version-${index}`,
        visibleMemoryId,
        TENANT_ID,
        2,
        "revise",
        `Dense visible revision ${index}`,
        `Dense visible summary ${index}`,
        "[]",
        "semantic",
        "active",
        "project",
        PROJECT_ID,
        "agent",
        visibleAgent,
        0.82,
        0.5,
        null,
        visibleAt,
        null,
        `dense-visible-version-hash-${index}`
      );
      insertVersion.run(
        `dense-hidden-version-${index}`,
        hiddenMemoryId,
        TENANT_ID,
        2,
        "revise",
        `Dense hidden revision ${index}`,
        `Dense hidden summary ${index}`,
        "[]",
        "semantic",
        "active",
        "project",
        PROJECT_ID,
        "agent",
        hiddenAgent,
        0.82,
        0.5,
        null,
        hiddenAt,
        null,
        `dense-hidden-version-hash-${index}`
      );

      const visibleUsageId = `dense-visible-usage-${index}`;
      const hiddenUsageId = `dense-hidden-usage-${index}`;
      insertUsageEvent.run(
        visibleUsageId,
        TENANT_ID,
        PROJECT_ID,
        "memory.search",
        "search",
        "api",
        visibleAt,
        visibleAgent
      );
      insertUsageItem.run(
        `dense-visible-item-${index}`,
        visibleUsageId,
        TENANT_ID,
        "memory",
        visibleMemoryId,
        "returned",
        "used",
        visibleAt
      );
      insertUsageEvent.run(
        hiddenUsageId,
        TENANT_ID,
        PROJECT_ID,
        "memory.search",
        "search",
        "api",
        hiddenAt,
        hiddenAgent
      );
      insertUsageItem.run(
        `dense-hidden-item-${index}`,
        hiddenUsageId,
        TENANT_ID,
        "memory",
        hiddenMemoryId,
        "returned",
        "used",
        hiddenAt
      );
    }

    const insertTask = database.prepare(
      `INSERT INTO tasks(
         id, tenant_id, project_id, capability, status, priority, trace_id,
         created_at, updated_at, created_by_principal
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    );
    const insertTaskEvent = database.prepare(
      "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
    );
    for (let index = 0; index < 300; index += 1) {
      const taskId = `scale-task-${String(index).padStart(3, "0")}`;
      const occurredAt = NOW - index * 1_000;
      insertTask.run(
        taskId,
        TENANT_ID,
        PROJECT_ID,
        `dashboard.measure.${index}.${deterministicText(index + 400_000, 80)}`,
        "succeeded",
        index % 5,
        `scale-trace-${index}`,
        occurredAt - 100,
        NOW - 2 * DAY_MS - index,
        `agent:scale-${index % DENSE_ACTIVITY_AGENT_COUNT}`
      );
      insertTaskEvent.run(
        `scale-task-event-${String(index).padStart(3, "0")}`,
        TENANT_ID,
        taskId,
        "completed",
        null,
        occurredAt
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function compressedBytes(value: unknown): number {
  return gzipSync(JSON.stringify(value)).byteLength;
}

describe("dashboard local performance acceptance", () => {
  it("keeps bounded dashboard projections responsive at 100k memories", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      seedScaleFixture(database);
      const env = {
        OPEN_BRAIN_DB: {
          prepare: (sql: string) => new D1StatementAdapter(database, sql)
        }
      } as unknown as Env;

      expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toMatchObject({
        count: MEMORY_COUNT
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM memory_usage_events").get()).toMatchObject({
        count: DENSE_ACTIVITY_COUNT_PER_VISIBILITY * 2
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM memory_versions").get()).toMatchObject({
        count: DENSE_ACTIVITY_COUNT_PER_VISIBILITY * 2 + 101
      });

      const activity = await measureAsync(() => getActivityDashboard(env, TENANT_ID, {
        projectId: PROJECT_ID,
        from: NOW - DAY_MS,
        to: NOW,
        limit: 250,
        principal: "user:scale-reader",
        now: NOW
      }));
      const graph = await measureAsync(() => getKnowledgeGraph(env, TENANT_ID, {
        project_id: PROJECT_ID,
        depth: 2,
        node_limit: 150,
        edge_limit: 300,
        principal: "user:scale-reader",
        now: NOW
      }));
      const strata = await measureAsync(() => getMemoryStrata(env, TENANT_ID, {
        project_id: PROJECT_ID,
        limit: 100,
        principal: "user:scale-reader",
        now: NOW
      }));
      const strataDetail = await measureAsync(() => getMemoryStrataDetail(
        env,
        TENANT_ID,
        "memory",
        DETAIL_MEMORY_ID,
        {
          project_id: PROJECT_ID,
          revision_limit: 100,
          source_limit: 50,
          principal: "user:scale-reader",
          now: NOW
        }
      ));

      expect(activity.result.events).toHaveLength(250);
      expect(activity.result.observed_agents).toHaveLength(DENSE_ACTIVITY_AGENT_COUNT);
      expect(activity.result.observed_agents.reduce((sum, agent) => sum + agent.read_count, 0))
        .toBe(DENSE_ACTIVITY_COUNT_PER_VISIBILITY);
      expect(activity.result.observed_agents.reduce((sum, agent) => sum + agent.write_count, 0))
        .toBe(DENSE_ACTIVITY_COUNT_PER_VISIBILITY);
      expect(activity.result.observed_agents.some((agent) => agent.id.startsWith("agent:hidden-")))
        .toBe(false);
      expect(JSON.stringify(activity.result)).not.toContain("Dense hidden");
      expect(JSON.stringify(activity.result)).not.toContain("agent:hidden-");
      expect(graph.result.nodes).toHaveLength(150);
      expect(graph.result.edges.length).toBeGreaterThan(250);
      expect(strata.result.chains).toHaveLength(100);
      expect(strataDetail.result.chain.revisions).toHaveLength(100);
      expect(strataDetail.result.chain.sources).toHaveLength(50);
      expect(strataDetail.result.truncated).toEqual({ revisions: true, sources: true });

      const serviceP95 = {
        activity: activity.p95Ms,
        knowledge_graph: graph.p95Ms,
        strata: strata.p95Ms,
        strata_detail: strataDetail.p95Ms
      };
      for (const [surface, p95Ms] of Object.entries(serviceP95)) {
        expect(p95Ms, `${surface} local service p95 was ${p95Ms.toFixed(2)}ms`).toBeLessThanOrEqual(MAX_SERVICE_P95_MS);
      }
      const compressed = {
        activity: compressedBytes(activity.result),
        knowledge_graph: compressedBytes(graph.result),
        strata: compressedBytes(strata.result),
        strata_detail: compressedBytes(strataDetail.result)
      };
      for (const [surface, bytes] of Object.entries(compressed)) {
        expect(bytes, `${surface} compressed response was ${bytes} bytes`).toBeLessThanOrEqual(MAX_COMPRESSED_BYTES);
      }

      // This reports reproducible local service/helper evidence. Network, Worker
      // scheduling, and remote D1 latency remain staging rollout measurements.
      console.info("dashboard-performance", JSON.stringify({
        fixture_memories: MEMORY_COUNT,
        fixture_activity_rows: DENSE_ACTIVITY_COUNT_PER_VISIBILITY * 4,
        samples: { service: SERVICE_SAMPLE_COUNT },
        p95_ms: Object.fromEntries(Object.entries(serviceP95)
          .map(([key, value]) => [key, Number(value.toFixed(3))])),
        gzip_bytes: compressed
      }));
    } finally {
      database.close();
    }
  }, 120_000);
});
