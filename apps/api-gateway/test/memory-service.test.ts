import { describe, expect, it } from "vitest";
import { listMemories, upsertMemories } from "../src/memory-service";

type MemoryRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
};

class FakeStatement {
  sql: string;
  db: FakeD1;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.startsWith("SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?")) {
      const tenantId = this.args[0] as string;
      const externalKey = this.args[1] as string;
      const row = this.db.memories.find((m) => m.tenant_id === tenantId && m.external_key === externalKey);
      return (row ? { id: row.id } : null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("FROM memories") && this.sql.includes("WHERE tenant_id = ? AND source = ?")) {
      const tenantId = this.args[0] as string;
      const source = this.args[1] as string;
      const limit = this.args[2] as number;
      const rows = this.db.memories
        .filter((m) => m.tenant_id === tenantId && m.source === source)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM memories") && this.sql.includes("WHERE tenant_id = ?")) {
      const tenantId = this.args[0] as string;
      const limit = this.args[1] as number;
      const rows = this.db.memories
        .filter((m) => m.tenant_id === tenantId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO memories(")) {
      this.db.memories.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        project_id: this.args[2] as string | null,
        content: this.args[3] as string,
        summary: this.args[4] as string | null,
        tags_json: this.args[5] as string | null,
        source: this.args[6] as string,
        external_key: this.args[7] as string | null,
        created_at: this.args[8] as number
      });
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE memories SET")) {
      const projectId = this.args[0] as string | null;
      const content = this.args[1] as string;
      const summary = this.args[2] as string | null;
      const tagsJson = this.args[3] as string;
      const source = this.args[4] as string;
      const createdAt = this.args[5] as number;
      const tenantId = this.args[6] as string;
      const id = this.args[7] as string;
      const row = this.db.memories.find((m) => m.tenant_id === tenantId && m.id === id);
      if (row) {
        row.project_id = projectId;
        row.content = content;
        row.summary = summary;
        row.tags_json = tagsJson;
        row.source = source;
        row.created_at = createdAt;
      }
      return { success: true };
    }

    return { success: true };
  }
}

class FakeD1 {
  memories: MemoryRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const stmt of statements) {
      await stmt.run();
    }
    return [];
  }
}

describe("memory-service", () => {
  it("upserts memories by external_key and lists by source", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;

    const first = await upsertMemories(env, {
      tenant_id: "default",
      source: "openclaw",
      items: [
        {
          external_key: "openclaw:c1",
          content: "first content",
          summary: "first",
          tags: ["openclaw", "chunk"],
          created_at: 1000
        }
      ]
    });
    expect(first).toMatchObject({ inserted: 1, updated: 0 });

    const second = await upsertMemories(env, {
      tenant_id: "default",
      source: "openclaw",
      items: [
        {
          external_key: "openclaw:c1",
          content: "updated content",
          summary: "second",
          tags: ["openclaw", "chunk"],
          created_at: 2000
        }
      ]
    });
    expect(second).toMatchObject({ inserted: 0, updated: 1 });

    const listed = await listMemories(env, "default", 10, "openclaw");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      external_key: "openclaw:c1",
      content: "updated content",
      summary: "second",
      source: "openclaw"
    });
  });
});
