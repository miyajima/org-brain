import { describe, expect, it } from "vitest";
import {
  assignRetrievalGeneration,
  backfillRetrievalGeneration,
  createRetrievalRankingProfile,
  resolveRetrievalGenerationAssignment,
  transitionRetrievalGeneration
} from "../src/retrieval-generation-service";
import type { Env } from "../src/types";

type Assignment = {
  tenant_id: string;
  project_scope_key: string;
  active_generation_id: string;
  shadow_generation_id: string | null;
  shadow_sample_rate: number;
  updated_at: number;
};

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const { DatabaseSync } = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

class GenerationStatement {
  private args: unknown[] = [];
  constructor(
    private readonly sql: string,
    private readonly assignments: Assignment[],
    private readonly generations: Array<{ id: string; status: string }>,
    private readonly projection = { total_jobs: 1, completed_jobs: 1 }
  ) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() {
    if (this.sql.includes("shadow_generation_id") && this.sql.includes("missing_count")) {
      return { results: [{ missing_count: 0 }] as T[] };
    }
    if (this.sql.includes("FROM retrieval_evaluation_events")) {
      return { results: [{ sample_count: 10, first_sample_at: Date.now() - 8 * 86_400_000 }] as T[] };
    }
    if (this.sql.includes("FROM retrieval_generation_assignments")) {
      const [tenant, project] = this.args;
      const row = this.assignments.find((item) => item.tenant_id === tenant && item.project_scope_key === project) ??
        this.assignments.find((item) => item.tenant_id === tenant && item.project_scope_key === "*");
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.sql.includes("FROM retrieval_generations")) {
      return { results: this.generations.filter((row) => this.args.includes(row.id)) as T[] };
    }
    if (this.sql.includes("FROM retrieval_projection_jobs")) {
      if (this.sql.includes("SELECT id")) {
        return { results: (this.projection.completed_jobs > 0 ? [{ id: "projection" }] : []) as T[] };
      }
      return { results: [this.projection] as T[] };
    }
    return { results: [] as T[] };
  }
  async first<T>() { return (await this.all<T>()).results[0] ?? null; }
  async run() {
    if (this.sql.includes("UPDATE retrieval_generations")) {
      const row = this.generations.find((item) => item.id === this.args.at(-1));
      if (row) row.status = String(this.args[0]);
    }
    return { success: true };
  }
}

function env(
  assignments: Assignment[],
  generations: Array<{ id: string; status: string }>,
  projection = { total_jobs: 1, completed_jobs: 1 }
) {
  return {
    OPEN_BRAIN_DB: {
      prepare: (sql: string) => new GenerationStatement(sql, assignments, generations, projection)
    }
  } as unknown as Env;
}

class SqliteD1Statement {
  private args: unknown[] = [];
  constructor(private readonly statement: SqliteStatement) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.statement.all(...this.args) as T[] }; }
  async first<T>() { return (this.statement.get(...this.args) as T | undefined) ?? null; }
  async run() { this.statement.run(...this.args); return { success: true }; }
}

class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    this.db.exec(`
      CREATE TABLE retrieval_generations (
        id TEXT PRIMARY KEY, unit_schema_version INTEGER NOT NULL,
        extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
        baseline_generation_id TEXT, status TEXT NOT NULL
      );
      CREATE TABLE retrieval_projection_jobs (
        id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT, cursor TEXT NOT NULL DEFAULT '', processed_sources INTEGER NOT NULL DEFAULT 0,
        projected_units INTEGER NOT NULL DEFAULT 0, record_digest TEXT, unit_digest TEXT,
        state TEXT NOT NULL, started_at INTEGER, updated_at INTEGER NOT NULL,
        completed_at INTEGER, error_code TEXT
      );
      CREATE UNIQUE INDEX idx_retrieval_projection_jobs_scope
      ON retrieval_projection_jobs(generation_id, tenant_id, IFNULL(project_id, ''));
      CREATE TABLE retrieval_units (
        id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        business_category_id TEXT, work_type TEXT, unit_type TEXT NOT NULL, text TEXT NOT NULL,
        speaker TEXT, event_at INTEGER, valid_from INTEGER, valid_until INTEGER,
        source_ref_json TEXT, source_span_start INTEGER, source_span_end INTEGER,
        metadata_json TEXT, segment_id TEXT, content_hash TEXT NOT NULL,
        extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
        extraction_state TEXT NOT NULL, degraded_reason TEXT, created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE retrieval_units_fts USING fts5(
        unit_id UNINDEXED, generation_id UNINDEXED, tenant_id UNINDEXED, text
      );
      INSERT INTO retrieval_generations VALUES
        ('baseline', 1, 'retrieval-units', '1', NULL, 'fallback'),
        ('candidate', 1, 'retrieval-units', '1', 'baseline', 'building');
    `);
  }
  prepare(sql: string) { return new SqliteD1Statement(this.db.prepare(sql)); }
  async batch(statements: SqliteD1Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
  addUnit(id: string, sourceId: string, projectId: string | null, hash = `hash-${id}`) {
    this.db.prepare(`INSERT INTO retrieval_units VALUES(
      ?, 'baseline', 'tenant-a', ?, 'memory', ?, NULL, 'implementation', 'atomic', ?,
      NULL, 1, NULL, NULL, NULL, NULL, NULL, '{}', NULL, ?,
      'retrieval-units', '1', 'ready', NULL, 1
    )`).run(id, projectId, sourceId, `text-${id}`, hash);
    this.db.prepare("INSERT INTO retrieval_units_fts VALUES(?, 'baseline', 'tenant-a', ?)")
      .run(id, `text-${id}`);
  }
}

describe("retrieval generation assignment", () => {
  it("prefers project assignment and falls back to the tenant wildcard", async () => {
    const assignments: Assignment[] = [
      { tenant_id: "tenant-a", project_scope_key: "*", active_generation_id: "fallback", shadow_generation_id: null, shadow_sample_rate: 0, updated_at: 1 },
      { tenant_id: "tenant-a", project_scope_key: "project-a", active_generation_id: "active", shadow_generation_id: "shadow", shadow_sample_rate: 0.1, updated_at: 2 }
    ];
    const runtime = env(assignments, [
      { id: "fallback", status: "fallback" },
      { id: "active", status: "active" },
      { id: "shadow", status: "shadow" }
    ]);
    await expect(resolveRetrievalGenerationAssignment(runtime, "tenant-a", "project-a"))
      .resolves.toMatchObject({ project_scope_key: "project-a", active_generation_id: "active" });
    await expect(resolveRetrievalGenerationAssignment(runtime, "tenant-a", "project-b"))
      .resolves.toMatchObject({ project_scope_key: "*", active_generation_id: "fallback" });
  });

  it("fails closed for missing or unavailable active generations", async () => {
    await expect(resolveRetrievalGenerationAssignment(env([], []), "tenant-a", null))
      .rejects.toMatchObject({ code: "retrieval_assignment_missing" });
    const assignment: Assignment = {
      tenant_id: "tenant-a", project_scope_key: "*", active_generation_id: "retired",
      shadow_generation_id: null, shadow_sample_rate: 0, updated_at: 1
    };
    await expect(resolveRetrievalGenerationAssignment(env([assignment], [{ id: "retired", status: "retired" }]), "tenant-a", null))
      .rejects.toMatchObject({ code: "retrieval_assignment_invalid" });
  });

  it("requires complete verified promotion evidence before shadow becomes active", async () => {
    const generations = [{ id: "candidate", status: "shadow" }];
    const runtime = env([], generations);
    await expect(transitionRetrievalGeneration(runtime, "candidate", "active", {}))
      .rejects.toMatchObject({ code: "invalid_payload" });
    const promotion_evidence = {
        projection_coverage_percent: 100,
        digest_match: true,
        tenant_acl_category_violations: 0,
        offline_benchmark_non_degraded: true,
        candidate_empty_rate_delta_points: 0.2,
        error_rate_delta_points: 0.1,
        p95_latency_ratio: 1.1,
        critical_regressions: 0,
        shadow_observation_days: 7,
        verification_ref_id: "artifact:promotion-1"
    };
    await expect(transitionRetrievalGeneration(env([], [{ id: "incomplete", status: "shadow" }], {
      total_jobs: 1, completed_jobs: 0
    }), "incomplete", "active", { promotion_evidence }))
      .rejects.toMatchObject({ code: "retrieval_projection_incomplete" });
    await expect(transitionRetrievalGeneration(runtime, "candidate", "active", { promotion_evidence }))
      .resolves.toMatchObject({ previous_status: "shadow", status: "active" });
  });

  it("rejects unsupported ranking algorithms and config keys", async () => {
    const runtime = env([], []);
    await expect(createRetrievalRankingProfile(runtime, { name: "bad", algorithm: "opaque", config: {} }))
      .rejects.toMatchObject({ code: "unsupported_ranking_algorithm" });
    await expect(createRetrievalRankingProfile(runtime, {
      name: "bad-config", algorithm: "reciprocal_rank_fusion", config: { reranker_magic: 1 }
    })).rejects.toMatchObject({ code: "unsupported_ranking_config" });
  });

  it("requires projection and a seven-day shadow window for each new active assignment", async () => {
    const runtime = env([], [{ id: "active", status: "active" }], { total_jobs: 0, completed_jobs: 0 });
    await expect(assignRetrievalGeneration(runtime, "tenant-a", {
      project_scope_key: "project-a",
      active_generation_id: "active"
    })).rejects.toMatchObject({ code: "retrieval_assignment_projection_incomplete" });
  });

  it("backfills project and global units, maintains FTS, resumes, and requires reset after digest mismatch", async () => {
    const sqlite = new SqliteD1();
    sqlite.addUnit("global", "memory-global", null);
    sqlite.addUnit("project-a", "memory-a", "project-a");
    sqlite.addUnit("project-b", "memory-b", "project-b");
    const runtime = { OPEN_BRAIN_DB: sqlite } as unknown as Env;

    const completed = await backfillRetrievalGeneration(runtime, "tenant-a", "candidate", {
      project_id: "project-a",
      limit: 10
    });
    expect(completed).toMatchObject({ done: true, digest_match: true, projected_units: 2 });
    expect(sqlite.db.prepare("SELECT source_id FROM retrieval_units WHERE generation_id = 'candidate' ORDER BY source_id").all())
      .toEqual([{ source_id: "memory-a" }, { source_id: "memory-global" }]);
    expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM retrieval_units_fts WHERE generation_id = 'candidate'").get())
      .toEqual({ count: 2 });
    await expect(backfillRetrievalGeneration(runtime, "tenant-a", "candidate", {
      project_id: "project-a",
      limit: 10
    })).resolves.toMatchObject({ done: true, projected_units: 0, total_projected_units: 2 });

    sqlite.db.prepare("UPDATE retrieval_units SET content_hash = 'changed' WHERE id = 'global'").run();
    await expect(backfillRetrievalGeneration(runtime, "tenant-a", "candidate", {
      project_id: "project-a",
      limit: 10
    })).rejects.toMatchObject({ code: "retrieval_projection_digest_mismatch" });
    await expect(backfillRetrievalGeneration(runtime, "tenant-a", "candidate", {
      project_id: "project-a",
      limit: 10
    })).rejects.toMatchObject({ code: "retrieval_projection_reset_required" });
    await expect(backfillRetrievalGeneration(runtime, "tenant-a", "candidate", {
      project_id: "project-a",
      limit: 10,
      reset: true
    })).resolves.toMatchObject({ done: true, digest_match: true, total_projected_units: 2 });
  });

  it("treats NULL project projection jobs as one concurrent scope", () => {
    const sqlite = new SqliteD1();
    const insert = sqlite.db.prepare(
      `INSERT INTO retrieval_projection_jobs(
         id, generation_id, tenant_id, project_id, state, updated_at
       ) VALUES(?, 'candidate', 'tenant-a', NULL, 'running', 1)`
    );
    insert.run("global-job-1");
    expect(() => insert.run("global-job-2")).toThrow();
  });

});
