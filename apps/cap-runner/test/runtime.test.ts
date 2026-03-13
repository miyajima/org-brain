import { describe, expect, it } from "vitest";
import { runCapability } from "../src/capabilities/runtime";

type MockOptions = {
  matchedResults?: Array<{ id: string; summary: string | null; content: string; lexical_score?: number | null }>;
  fallbackResults?: Array<{ id: string; summary: string | null; content: string }>;
  matchedCount?: number;
  failRetrievalInsert?: boolean;
};

function createDbMock(options: MockOptions = {}) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const matchedResults = options.matchedResults ?? [{ id: "m1", summary: "prior memory", content: "knowledge", lexical_score: -0.5 }];
  const fallbackResults = options.fallbackResults ?? [{ id: "m9", summary: "recent memory", content: "fallback knowledge" }];
  const matchedCount = options.matchedCount ?? matchedResults.length;

  return {
    statements,
    queries,
    prepare(sql: string) {
      const state = { sql, args: [] as unknown[] };
      return {
        bind: (...args: unknown[]) => {
          state.args = args;
          return {
            first: async () => {
              queries.push({ sql: state.sql, args: state.args });
              if (state.sql.startsWith("SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?")) {
                return null;
              }
              if (state.sql.includes("COUNT(*) AS matched_count")) {
                return { matched_count: matchedCount };
              }
              return null;
            },
            all: async () => {
              queries.push({ sql: state.sql, args: state.args });
              if (state.sql.includes("FROM memories_fts")) {
                return { results: matchedResults };
              }
              if (state.sql.includes("FROM memories m") && state.sql.includes("ORDER BY m.created_at DESC")) {
                return { results: fallbackResults };
              }
              return {
                results: []
              };
            },
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

describe("runCapability", () => {
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
    expect(db.statements.some((s) => s.sql.includes("INSERT INTO memories"))).toBe(true);
  });

  it("ranks memory search results with BM25 before recency fallback", async () => {
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
      taskId: "task2",
      capability: "plan_writer",
      inputRef: "retrieval ranking needs relevant memory hints"
    });

    const searchQuery = db.queries.find((query) => query.sql.includes("ORDER BY bm25(memories_fts)"));
    expect(searchQuery?.sql).toContain("ORDER BY bm25(memories_fts) ASC, m.created_at DESC");
  });

  it("records BM25 retrieval telemetry and a lightweight memory.search task event", async () => {
    const db = createDbMock({
      matchedResults: [{ id: "m1", summary: "prior memory", content: "knowledge", lexical_score: -1.25 }],
      matchedCount: 4
    });
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
    expect(retrievalInsert?.args[5]).toBe("bm25_v1");
    expect(retrievalInsert?.args[8]).toBe(4);
    expect(retrievalInsert?.args[9]).toBe(1);
    expect(JSON.parse(String(retrievalInsert?.args[12]))).toEqual(["m1"]);
    expect(JSON.parse(String(retrievalInsert?.args[13]))).toEqual([-1.25]);

    const taskEventInsert = db.statements.find(
      (statement) => statement.sql.startsWith("INSERT INTO task_events") && statement.args[3] === "memory.search"
    );
    expect(taskEventInsert).toBeTruthy();
    expect(String(taskEventInsert?.args[4])).not.toContain("query");
    expect(JSON.parse(String(taskEventInsert?.args[4]))).toMatchObject({
      strategy: "bm25_v1",
      matched_count: 4,
      returned_count: 1,
      fallback_used: false
    });
  });

  it("records fallback retrieval telemetry when the lexical query misses", async () => {
    const db = createDbMock({
      matchedResults: [],
      matchedCount: 0,
      fallbackResults: [{ id: "m9", summary: "recent memory", content: "fallback knowledge" }]
    });
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
    expect(retrievalInsert?.args[10]).toBe(1);
    expect(JSON.parse(String(retrievalInsert?.args[12]))).toEqual(["m9"]);
    expect(retrievalInsert?.args[13]).toBeNull();
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
