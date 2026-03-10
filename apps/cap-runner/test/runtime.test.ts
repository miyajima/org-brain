import { describe, expect, it } from "vitest";
import { runCapability } from "../src/capabilities/runtime";

function createDbMock() {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const queries: Array<{ sql: string; args: unknown[] }> = [];

  return {
    statements,
    queries,
    prepare(sql: string) {
      const state = { sql, args: [] as unknown[] };
      return {
        bind: (...args: unknown[]) => {
          state.args = args;
          return {
            first: async () => null,
            all: async () => {
              queries.push({ sql: state.sql, args: state.args });
              return {
                results: [
                  { id: "m1", summary: "prior memory", content: "knowledge" }
                ]
              };
            },
            run: async () => {
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

    const searchQuery = db.queries.find((query) => query.sql.includes("FROM memories_fts"));
    expect(searchQuery?.sql).toContain("ORDER BY bm25(memories_fts) ASC, m.created_at DESC");
  });
});
