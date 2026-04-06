import { describe, expect, it } from "vitest";
import { planMemoryMaintenance, runScheduledMemoryMaintenance, runTenantMemoryMaintenance } from "../src/memory-maintenance";

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

type MemoryFtsRecord = {
  memory_id: string;
  tenant_id: string;
  content: string;
};

class FakeStatement {
  db: FakeD1;
  sql: string;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    if (this.sql.includes("SELECT DISTINCT tenant_id")) {
      const allowed = new Set(this.args.map((value) => String(value)));
      const tenantIds = [...new Set(this.db.memories.filter((row) => allowed.has(row.source)).map((row) => row.tenant_id))]
        .sort()
        .map((tenant_id) => ({ tenant_id }));
      return { results: tenantIds as T[] };
    }

    if (this.sql.includes("FROM memories") && this.sql.includes("ORDER BY created_at DESC")) {
      const tenantId = String(this.args[0]);
      const allowed = new Set(this.args.slice(1).map((value) => String(value)));
      const rows = this.db.memories
        .filter((row) => row.tenant_id === tenantId)
        .filter((row) => !String(row.tags_json ?? "").includes("\"compacted\""))
        .filter((row) => allowed.has(row.source))
        .sort((left, right) => right.created_at - left.created_at);
      return { results: rows as T[] };
    }

    if (this.sql.includes("SELECT id, external_key") && this.sql.includes("external_key IN")) {
      const tenantId = String(this.args[0]);
      const keys = new Set(this.args.slice(1).map((value) => String(value)));
      return {
        results: this.db.memories
          .filter((memory) => memory.tenant_id === tenantId && memory.external_key && keys.has(memory.external_key))
          .map((memory) => ({ id: memory.id, external_key: memory.external_key })) as T[]
      };
    }

    return { results: [] as T[] };
  }

  async run() {
    this.db.statements.push({ sql: this.sql, args: this.args });

    if (this.sql.startsWith("INSERT INTO memories(")) {
      this.db.memories.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        project_id: (this.args[2] as string | null) ?? null,
        content: String(this.args[3]),
        summary: (this.args[4] as string | null) ?? null,
        tags_json: (this.args[5] as string | null) ?? null,
        source: String(this.args[6]),
        external_key: (this.args[7] as string | null) ?? null,
        created_at: Number(this.args[8])
      });
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE memories SET project_id = ?")) {
      const row = this.db.memories.find(
        (memory) => memory.tenant_id === String(this.args[6]) && memory.id === String(this.args[7])
      );
      if (row) {
        row.project_id = (this.args[0] as string | null) ?? null;
        row.content = String(this.args[1]);
        row.summary = (this.args[2] as string | null) ?? null;
        row.tags_json = (this.args[3] as string | null) ?? null;
        row.source = String(this.args[4]);
        row.created_at = Number(this.args[5]);
      }
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE memories SET tags_json = ?")) {
      const row = this.db.memories.find(
        (memory) => memory.tenant_id === String(this.args[1]) && memory.id === String(this.args[2])
      );
      if (row) row.tags_json = String(this.args[0]);
      return { success: true };
    }

    if (this.sql.startsWith("INSERT INTO memories_fts")) {
      this.db.memoriesFts.push({
        memory_id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        content: String(this.args[2])
      });
      return { success: true };
    }

    if (this.sql.startsWith("DELETE FROM memories_fts")) {
      const memoryId = String(this.args[0]);
      const tenantId = String(this.args[1]);
      this.db.memoriesFts = this.db.memoriesFts.filter(
        (row) => !(row.memory_id === memoryId && row.tenant_id === tenantId)
      );
      return { success: true };
    }

    if (this.sql.startsWith("DELETE FROM retrieval_events")) {
      return { success: true };
    }

    return { success: true };
  }
}

class FakeD1 {
  memories: MemoryRecord[];
  memoriesFts: MemoryFtsRecord[];
  statements: Array<{ sql: string; args: unknown[] }> = [];

  constructor(memories: MemoryRecord[]) {
    this.memories = [...memories];
    this.memoriesFts = memories.map((memory) => ({
      memory_id: memory.id,
      tenant_id: memory.tenant_id,
      content: memory.content
    }));
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }
}

function baseRows(): MemoryRecord[] {
  return [
    {
      id: "raw-1",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | agent-turn-complete | implemented memory search endpoint",
      content: "implemented memory search endpoint",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "org-brain"]),
      external_key: "raw-1",
      created_at: Date.parse("2026-03-18T03:00:00.000Z")
    },
    {
      id: "raw-2",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | agent-turn-complete | implemented memory profile endpoint",
      content: "implemented memory profile endpoint",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "org-brain"]),
      external_key: "raw-2",
      created_at: Date.parse("2026-03-18T02:00:00.000Z")
    },
    {
      id: "raw-3",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | agent-turn-complete | added hybrid fallback",
      content: "added hybrid fallback",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "org-brain"]),
      external_key: "raw-3",
      created_at: Date.parse("2026-03-18T01:00:00.000Z")
    },
    {
      id: "raw-4",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | agent-turn-complete | added replay metrics comparison",
      content: "added replay metrics comparison",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "org-brain"]),
      external_key: "raw-4",
      created_at: Date.parse("2026-03-18T00:00:00.000Z")
    },
    {
      id: "dup-new",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | promoted-memory | deployment requires cap-runner and api-gateway",
      content: "deployment requires cap-runner and api-gateway",
      tags_json: JSON.stringify(["codex", "hook", "promoted", "policy", "org-brain"]),
      external_key: "dup-new",
      created_at: Date.parse("2026-03-10T00:00:00.000Z")
    },
    {
      id: "dup-old",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | promoted-memory | deployment requires cap-runner and api-gateway",
      content: "deployment requires cap-runner and api-gateway",
      tags_json: JSON.stringify(["codex", "hook", "promoted", "policy", "org-brain"]),
      external_key: "dup-old",
      created_at: Date.parse("2026-03-01T00:00:00.000Z")
    },
    {
      id: "policy-2",
      tenant_id: "default",
      project_id: "org-brain",
      source: "claude",
      summary: "org-brain | promoted-memory | use cap-runner cron for memory maintenance",
      content: "use cap-runner cron for memory maintenance",
      tags_json: JSON.stringify(["curated-memory", "policy", "org-brain"]),
      external_key: "policy-2",
      created_at: Date.parse("2026-03-08T00:00:00.000Z")
    },
    {
      id: "recent",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      summary: "org-brain | agent-turn-complete | very recent raw memory",
      content: "very recent raw memory",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "org-brain"]),
      external_key: "recent",
      created_at: Date.parse("2026-03-28T00:00:00.000Z")
    }
  ];
}

describe("memory maintenance", () => {
  it("builds digests for old raw hook memories and collapses older duplicates", () => {
    const now = Date.parse("2026-03-30T00:00:00.000Z");
    const rows = baseRows();

    const plan = planMemoryMaintenance(rows, {
      tenantId: "default",
      now
    });

    expect(plan.stats.canonical_group_count).toBe(1);
    expect(plan.stats.digest_group_count).toBe(1);
    expect(plan.stats.digested_memory_count).toBe(4);
    expect(plan.stats.duplicate_compaction_count).toBe(1);
    expect(plan.canonicals[0]?.external_key).toBe("org-brain:canonical-memory:default:org-brain:policy");
    expect(plan.canonicals[0]?.summary).toContain("canonical-memory");
    expect(plan.digests[0]?.external_key).toBe("org-brain:memory-digest:default:org-brain:codex:2026-03-18");
    expect(plan.digests[0]?.summary).toContain("memory-digest");
    expect(
      plan.compactions
        .filter((item) => item.reason === "digest")
        .map((item) => item.id)
        .sort()
    ).toEqual(["raw-1", "raw-2", "raw-3", "raw-4"]);
    expect(plan.compactions.find((item) => item.id === "dup-old")).toMatchObject({
      reason: "duplicate",
      next_tags: expect.arrayContaining(["compacted", "policy"])
    });
    expect(plan.compactions.find((item) => item.id === "recent")).toBeUndefined();
  });

  it("applies digest creation and compaction directly through D1", async () => {
    const db = new FakeD1(baseRows());
    const now = Date.parse("2026-03-30T00:00:00.000Z");

    const result = await runTenantMemoryMaintenance(db as unknown as D1Database, "default", now);

    expect(result.applied).toBe(true);
    expect(result.stats.canonical_memory_count).toBe(1);
    expect(result.stats.total_compaction_count).toBe(5);
    const canonical = db.memories.find((memory) => memory.external_key?.includes("canonical-memory"));
    const digest = db.memories.find((memory) => memory.external_key?.includes("memory-digest"));
    expect(canonical?.source).toBe("org-brain");
    expect(canonical?.tags_json).toContain("\"canonical-memory\"");
    expect(canonical?.content).toContain("Stable Guidance");
    expect(digest?.source).toBe("org-brain");
    expect(digest?.tags_json).toContain("\"memory-digest\"");
    expect(digest?.content).toContain("Representative Summaries");

    const raw1 = db.memories.find((memory) => memory.id === "raw-1");
    const duplicate = db.memories.find((memory) => memory.id === "dup-old");
    expect(raw1?.tags_json).toContain("\"compacted\"");
    expect(duplicate?.tags_json).toContain("\"compacted\"");

    expect(db.memoriesFts.some((row) => row.memory_id === "raw-1")).toBe(false);
    expect(db.memoriesFts.some((row) => row.memory_id === "dup-old")).toBe(false);
    expect(db.memoriesFts.some((row) => row.memory_id === canonical?.id)).toBe(true);
    expect(db.memoriesFts.some((row) => row.memory_id === digest?.id)).toBe(true);
  });

  it("can run maintenance across detected tenants", async () => {
    const rows = [
      ...baseRows(),
      {
        id: "tenant-b-1",
        tenant_id: "tenant-b",
        project_id: "proj-b",
        source: "claude",
        summary: "proj-b | agent-turn-complete | one",
        content: "one",
        tags_json: JSON.stringify(["claude", "hook", "agent-turn-complete", "proj-b"]),
        external_key: "tenant-b-1",
        created_at: Date.parse("2026-03-18T03:00:00.000Z")
      },
      {
        id: "tenant-b-2",
        tenant_id: "tenant-b",
        project_id: "proj-b",
        source: "claude",
        summary: "proj-b | agent-turn-complete | two",
        content: "two",
        tags_json: JSON.stringify(["claude", "hook", "agent-turn-complete", "proj-b"]),
        external_key: "tenant-b-2",
        created_at: Date.parse("2026-03-18T02:00:00.000Z")
      },
      {
        id: "tenant-b-3",
        tenant_id: "tenant-b",
        project_id: "proj-b",
        source: "claude",
        summary: "proj-b | agent-turn-complete | three",
        content: "three",
        tags_json: JSON.stringify(["claude", "hook", "agent-turn-complete", "proj-b"]),
        external_key: "tenant-b-3",
        created_at: Date.parse("2026-03-18T01:00:00.000Z")
      },
      {
        id: "tenant-b-4",
        tenant_id: "tenant-b",
        project_id: "proj-b",
        source: "claude",
        summary: "proj-b | agent-turn-complete | four",
        content: "four",
        tags_json: JSON.stringify(["claude", "hook", "agent-turn-complete", "proj-b"]),
        external_key: "tenant-b-4",
        created_at: Date.parse("2026-03-18T00:00:00.000Z")
      }
    ];
    const db = new FakeD1(rows);

    const results = await runScheduledMemoryMaintenance(
      db as unknown as D1Database,
      Date.parse("2026-03-30T00:00:00.000Z")
    );

    expect(results.map((item) => item.tenant_id).sort()).toEqual(["default", "tenant-b"]);
    expect(db.memories.filter((memory) => memory.external_key?.includes("canonical-memory"))).toHaveLength(1);
    expect(db.memories.filter((memory) => memory.external_key?.includes("memory-digest"))).toHaveLength(2);
  });
});
