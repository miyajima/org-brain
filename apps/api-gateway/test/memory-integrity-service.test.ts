import { describe, expect, it, vi } from "vitest";
vi.mock("../src/rbac-service", () => ({ assertPermission: vi.fn(async () => undefined) }));
vi.mock("../src/memory-lifecycle-service", () => ({ suppressMemory: vi.fn(async () => ({ version: 2 })) }));
import { suppressMemory } from "../src/memory-lifecycle-service";
import { annotateMemorySearchIntegrity, proposeMemoryRelation, reportMemoryFeedback, reviewMemoryFeedback, reviewMemoryRelation } from "../src/memory-integrity-service";

class Statement {
  args: unknown[] = [];
  constructor(private db: FakeDb, private sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes("FROM memories")) return this.db.memories.find((row) => row.tenant_id === this.args[0] && row.id === this.args[1]) as T | null;
    if (this.sql.includes("FROM memory_quality_feedback")) return this.db.feedback as T | null;
    if (this.sql.includes("FROM memory_integrity_relations")) return this.db.relation as T | null;
    return null;
  }
  async all<T>() { return { results: this.db.memories.filter((row) => row.tenant_id === this.args[0] && [this.args[1], this.args[2]].includes(row.id)) as T[] }; }
  async run() { this.db.statements.push({ sql: this.sql, args: this.args }); return { success: true }; }
}
class FakeDb {
  memories = [
    { id: "a", tenant_id: "tenant-a", project_id: "p", current_version: 1, owner_principal: "owner", kind: "fact" },
    { id: "b", tenant_id: "tenant-a", project_id: "p", current_version: 1, owner_principal: "owner", kind: "fact" }
  ];
  relation: Record<string, unknown> | null = null;
  feedback: Record<string, unknown> | null = null;
  statements: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string) { return new Statement(this, sql); }
}

describe("memory integrity service", () => {
  it("adds an explanation only for a confirmed contradiction on the returned version", async () => {
    const calls: unknown[][] = [];
    const env = { OPEN_BRAIN_DB: { prepare: () => ({ bind: (...args: unknown[]) => {
      calls.push(args);
      return { first: async () => args[1] === "a" && args[2] === 1 ? { found: 1 } : null };
    } }) } } as any;
    const rows = await annotateMemorySearchIntegrity(env, "tenant-a", ([
      { kind: "memory", id: "a", current_version: 1 }, { kind: "memory", id: "b", current_version: 2 }
    ] as Array<{ kind: string; id: string; current_version: number; integrity_warnings?: string[] }>));
    expect(rows[0].integrity_warnings).toEqual(["unresolved_contradiction"]);
    expect(rows[1].integrity_warnings).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
  it("records version-scoped feedback without suppressing memory on report", async () => {
    const db = new FakeDb();
    const env = { OPEN_BRAIN_DB: db } as any;
    const result = await reportMemoryFeedback(env, "tenant-a", { memory_id: "a", memory_version: 1,
      kind: "wrong", reason: "source changed", evidence: [{ type: "file", ref: "docs/SPEC.md" }] }, "reader");
    expect(result.status).toBe("reported");
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].sql).toContain("INSERT INTO memory_quality_feedback");
  });

  it("rejects a credential in report text before persistence", async () => {
    const db = new FakeDb();
    await expect(reportMemoryFeedback({ OPEN_BRAIN_DB: db } as any, "tenant-a", {
      memory_id: "a", memory_version: 1, kind: "wrong", reason: "api_key=secret-value-that-must-not-appear",
      evidence: [{ type: "file", ref: "docs/SPEC.md" }]
    }, "reader")).rejects.toThrow();
    expect(db.statements).toHaveLength(0);
  });

  it("suppresses a confirmed wrong version without marking it as compacted", async () => {
    const db = new FakeDb();
    db.feedback = { id: "report", memory_id: "a", memory_version: 1, kind: "wrong", status: "reported" };
    await reviewMemoryFeedback({ OPEN_BRAIN_DB: db } as any, "tenant-a", "report", "confirm", "owner");
    expect(suppressMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      memoryId: "a", expectedVersion: 1, markCompacted: false
    }));
  });

  it("rejects a cross-tenant relation and requires an owner review", async () => {
    const db = new FakeDb();
    const env = { OPEN_BRAIN_DB: db } as any;
    await expect(proposeMemoryRelation(env, "other", { from_memory_id: "a", from_version: 1,
      to_memory_id: "b", to_version: 1, relation: "contradicts", evidence: [{ type: "file", ref: "docs/SPEC.md" }] }, "reader"))
      .rejects.toThrow();
    db.memories[0].kind = "decision";
    db.relation = { id: "edge-1", tenant_id: "tenant-a", from_memory_id: "a", from_version: 1, to_memory_id: "b", to_version: 1,
      status: "proposed", relation: "contradicts" };
    await expect(reviewMemoryRelation(env, "tenant-a", "edge-1", "confirm", "reader")).rejects.toThrow();
    const reviewed = await reviewMemoryRelation(env, "tenant-a", "edge-1", "confirm", "owner");
    expect(reviewed.status).toBe("confirmed");
  });
});
