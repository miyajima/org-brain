import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildTenantMemoryProfileMock } = vi.hoisted(() => ({
  buildTenantMemoryProfileMock: vi.fn()
}));

vi.mock("@org-brain/shared", async () => {
  const actual = await vi.importActual<typeof import("@org-brain/shared")>("@org-brain/shared");
  return {
    ...actual,
    buildTenantMemoryProfile: buildTenantMemoryProfileMock
  };
});

import { runCapability } from "../src/capabilities/runtime";

type MockOptions = {
  failRetrievalInsert?: boolean;
};

function createDbMock(options: MockOptions = {}) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];

  return {
    statements,
    prepare(sql: string) {
      const state = { sql, args: [] as unknown[] };
      return {
        bind: (...args: unknown[]) => {
          state.args = args;
          return {
            first: async () => {
              if (state.sql.startsWith("SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?")) {
                return null;
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (state.sql.startsWith("INSERT INTO retrieval_events") && options.failRetrievalInsert) {
                throw new Error("retrieval insert failed");
              }
              statements.push({ sql: state.sql, args: state.args });
              return { success: true };
            }
          };
        }
      };
    },
    async batch(batchStatements: Array<{ run: () => Promise<unknown> }>) {
      for (const stmt of batchStatements) {
        await stmt.run();
      }
      return [];
    }
  };
}

function defaultProfile(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: "default",
    project_id: "proj1",
    durable: [{ id: "dur-1", project_id: "proj1", summary: "stable policy", content_preview: "stable policy", source: "claude", created_at: 1, tags: ["policy"] }],
    recent: [{ id: "rec-1", project_id: "proj1", summary: "recent debugging work", content_preview: "recent debugging work", source: "codex", created_at: 2, tags: ["diagnosis"] }],
    search_results: [{ kind: "memory", id: "mem-1", summary: "matching memory", content_preview: "matching memory", score: 0.8, source: "claude", created_at: 3 }],
    meta: {
      durable_count: 1,
      recent_count: 1,
      search: {
        search_strategy: "bm25_rewrite_v1",
        matched_count: 3,
        returned_count: 1,
        fallback_used: false,
        variant_count: 4,
        lexical_result_count: 3,
        doc_result_count: 0,
        history_result_count: 0,
        top_result_ids: ["mem-1"],
        top_result_ranks: [-1.25]
      }
    },
    ...overrides
  };
}

describe("runCapability", () => {
  beforeEach(() => {
    buildTenantMemoryProfileMock.mockReset();
    buildTenantMemoryProfileMock.mockResolvedValue(defaultProfile());
  });

  it("writes artifact to R2 and persists memory summary", async () => {
    const db = createDbMock();
    const puts: Array<{ key: string; value: string }> = [];

    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {
        put: async (key: string, value: string) => {
          puts.push({ key, value });
        },
        get: async () => null
      }
    } as any;

    const result = await runCapability({
      env,
      tenantId: "default",
      projectId: "proj1",
      taskId: "task1",
      capability: "plan_writer",
      inputRef: "spec text"
    });

    expect(result.outputRef).toContain("r2://tenants/default/projects/proj1/tasks/task1/plan.md");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.value).toContain("## Durable Context");
    expect(puts[0]?.value).toContain("stable policy");
    expect(puts[0]?.value).toContain("recent debugging work");
    expect(puts[0]?.value).toContain("[memory] matching memory");
    expect(db.statements.some((statement) => statement.sql.startsWith("INSERT INTO memories("))).toBe(true);
  });

  it("records retrieval telemetry using the shared profile search metadata", async () => {
    const db = createDbMock();
    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {
        put: async () => undefined,
        get: async () => null
      }
    } as any;

    await runCapability({
      env,
      tenantId: "default",
      projectId: "proj1",
      taskId: "task-bm25",
      capability: "plan_writer",
      inputRef: "retrieval ranking needs relevant memory hints"
    });

    const retrievalInsert = db.statements.find((statement) => statement.sql.startsWith("INSERT INTO retrieval_events"));
    expect(retrievalInsert?.args[5]).toBe("bm25_rewrite_v1");
    expect(retrievalInsert?.args[8]).toBe(3);
    expect(retrievalInsert?.args[9]).toBe(1);
    expect(JSON.parse(String(retrievalInsert?.args[12]))).toEqual(["mem-1"]);
    expect(JSON.parse(String(retrievalInsert?.args[13]))).toEqual([-1.25]);

    const taskEventInsert = db.statements.find(
      (statement) => statement.sql.startsWith("INSERT INTO task_events") && statement.args[3] === "memory.search"
    );
    expect(taskEventInsert).toBeTruthy();
    expect(JSON.parse(String(taskEventInsert?.args[4]))).toMatchObject({
      strategy: "bm25_rewrite_v1",
      matched_count: 3,
      returned_count: 1,
      fallback_used: false
    });
  });

  it("records hybrid retrieval telemetry when doc fallback is used", async () => {
    buildTenantMemoryProfileMock.mockResolvedValue(
      defaultProfile({
        search_results: [{ kind: "doc", id: "doc-1", summary: "knowledge doc", content_preview: "knowledge doc", score: 0.6, source: "knowledge-doc", created_at: 4 }],
        meta: {
          durable_count: 1,
          recent_count: 1,
          search: {
            search_strategy: "hybrid_memory_docs_v1",
            matched_count: 1,
            returned_count: 1,
            fallback_used: false,
            variant_count: 4,
            lexical_result_count: 1,
            doc_result_count: 1,
            history_result_count: 0,
            top_result_ids: ["doc-1"],
            top_result_ranks: [null]
          }
        }
      })
    );

    const db = createDbMock();
    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {
        put: async () => undefined,
        get: async () => null
      }
    } as any;

    const result = await runCapability({
      env,
      tenantId: "default",
      projectId: "proj1",
      taskId: "task-hybrid",
      capability: "plan_writer",
      inputRef: "x"
    });

    expect(result.summary).toContain("Related Search Results: knowledge doc");
    const retrievalInsert = db.statements.find((statement) => statement.sql.startsWith("INSERT INTO retrieval_events"));
    expect(retrievalInsert?.args[5]).toBe("hybrid_memory_docs_v1");
    expect(retrievalInsert?.args[8]).toBe(1);
    expect(retrievalInsert?.args[10]).toBe(0);
    expect(JSON.parse(String(retrievalInsert?.args[12]))).toEqual(["doc-1"]);
    expect(JSON.parse(String(retrievalInsert?.args[13]))).toEqual([null]);
  });

  it("records fallback retrieval telemetry when search returns no hits", async () => {
    buildTenantMemoryProfileMock.mockResolvedValue(
      defaultProfile({
        search_results: [],
        meta: {
          durable_count: 1,
          recent_count: 1,
          search: {
            search_strategy: "fallback_recent_v1",
            matched_count: 0,
            returned_count: 0,
            fallback_used: true,
            variant_count: 1,
            lexical_result_count: 0,
            doc_result_count: 0,
            history_result_count: 0,
            top_result_ids: [],
            top_result_ranks: []
          }
        }
      })
    );

    const db = createDbMock();
    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {
        put: async () => undefined,
        get: async () => null
      }
    } as any;

    await runCapability({
      env,
      tenantId: "default",
      projectId: "proj1",
      taskId: "task-fallback",
      capability: "plan_writer",
      inputRef: "x"
    });

    const retrievalInsert = db.statements.find((statement) => statement.sql.startsWith("INSERT INTO retrieval_events"));
    expect(retrievalInsert?.args[5]).toBe("fallback_recent_v1");
    expect(retrievalInsert?.args[8]).toBe(0);
    expect(retrievalInsert?.args[9]).toBe(0);
    expect(retrievalInsert?.args[10]).toBe(1);
    expect(JSON.parse(String(retrievalInsert?.args[12]))).toEqual([]);
    expect(JSON.parse(String(retrievalInsert?.args[13]))).toEqual([]);
  });

  it("keeps task execution alive when retrieval telemetry persistence fails", async () => {
    const db = createDbMock({ failRetrievalInsert: true });
    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {
        put: async () => undefined,
        get: async () => null
      }
    } as any;

    const result = await runCapability({
      env,
      tenantId: "default",
      projectId: "proj1",
      taskId: "task-telemetry-fail",
      capability: "plan_writer",
      inputRef: "retrieval ranking needs relevant memory hints"
    });

    expect(result.outputRef).toContain("task-telemetry-fail/plan.md");
    expect(db.statements.some((statement) => statement.sql.startsWith("INSERT INTO task_events"))).toBe(true);
    expect(db.statements.some((statement) => statement.sql.startsWith("INSERT INTO memories("))).toBe(true);
  });
});
