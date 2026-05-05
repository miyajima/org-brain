import { describe, expect, it } from "vitest";
import { createDecisionMemory, enrichContext, searchDecisionMemories } from "../src/context-engine-service";

type DecisionMemoryRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  domain: string;
  title: string;
  decision: string;
  rationale: string;
  rejected_alternatives_json: string | null;
  constraints_json: string | null;
  known_pitfalls_json: string | null;
  source_refs_json: string | null;
  owner_refs_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  status: string;
  superseded_by: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  created_at: number;
  updated_at: number;
};

function matchesQuery(row: DecisionMemoryRecord, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = `${row.title} ${row.decision} ${row.rationale} ${row.constraints_json ?? ""} ${row.known_pitfalls_json ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => haystack.includes(token));
}

class FakeStatement {
  args: unknown[] = [];

  constructor(
    private db: FakeD1,
    private sql: string
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    if (this.sql.includes("FROM decision_memories")) {
      const tenantId = String(this.args[0]);
      const projectId = this.args[1] === null ? null : String(this.args[1]);
      const limit = Number(this.args[this.args.length - 1]);
      const rows = this.db.decisionMemories
        .filter((row) => row.tenant_id === tenantId)
        .filter((row) => !projectId || row.project_id === projectId || row.project_id === null)
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes("INSERT INTO decision_memories(")) {
      this.db.decisionMemories.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        project_id: this.args[2] === null ? null : String(this.args[2]),
        domain: String(this.args[3]),
        title: String(this.args[4]),
        decision: String(this.args[5]),
        rationale: String(this.args[6]),
        rejected_alternatives_json: String(this.args[7]),
        constraints_json: String(this.args[8]),
        known_pitfalls_json: String(this.args[9]),
        source_refs_json: String(this.args[10]),
        owner_refs_json: String(this.args[11]),
        valid_from: this.args[12] === null ? null : Number(this.args[12]),
        valid_until: this.args[13] === null ? null : Number(this.args[13]),
        status: String(this.args[14]),
        superseded_by: this.args[15] === null ? null : String(this.args[15]),
        confidence: Number(this.args[16]),
        visibility: String(this.args[17]),
        allowed_principals_json: String(this.args[18]),
        created_at: Number(this.args[19]),
        updated_at: Number(this.args[20])
      });
    }
    return { success: true };
  }
}

class FakeD1 {
  decisionMemories: DecisionMemoryRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

function baseDecision(overrides: Partial<DecisionMemoryRecord>): DecisionMemoryRecord {
  const now = Date.now();
  return {
    id: "dm-base",
    tenant_id: "org_123",
    project_id: "proj_abc",
    domain: "engineering",
    title: "新規認証処理はnew_auth_providerへ統一",
    decision: "legacy_authは新規実装で使わない",
    rationale: "移行中の二重管理を避けるため",
    rejected_alternatives_json: "[]",
    constraints_json: JSON.stringify(["auth_serviceを経由すること"]),
    known_pitfalls_json: JSON.stringify(["READMEの認証セクションは古い可能性がある"]),
    source_refs_json: JSON.stringify([{ type: "adr", id: "ADR-014", title: "Auth Provider Migration", updatedAt: "2026-03-12" }]),
    owner_refs_json: "[]",
    valid_from: null,
    valid_until: null,
    status: "active",
    superseded_by: null,
    confidence: 0.88,
    visibility: "tenant",
    allowed_principals_json: "[]",
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe("context-engine-service", () => {
  it("creates and searches decision memories", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;

    const created = await createDecisionMemory(env, {
      orgId: "org_123",
      projectId: "proj_abc",
      domain: "engineering",
      title: "API access policy",
      decision: "direct DB access is not allowed",
      rationale: "service boundaries must stay auditable",
      constraints: ["Use service APIs"],
      sourceRefs: [{ type: "adr", id: "ADR-021" }],
      confidence: 0.8
    });

    expect(created.decisionMemory.title).toBe("API access policy");
    const search = await searchDecisionMemories(env, { orgId: "org_123", projectId: "proj_abc", q: "direct DB", userId: "user_001" });
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({ title: "API access policy", status: "active" });
  });

  it("prioritizes a recent active ADR decision over an old README memory", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.decisionMemories = [
      baseDecision({
        id: "dm-readme",
        decision: "legacy_auth can be used for auth API changes",
        source_refs_json: JSON.stringify([{ type: "old_readme", id: "README.md" }]),
        confidence: 0.6,
        updated_at: now - 500 * 24 * 60 * 60 * 1000
      }),
      baseDecision({
        id: "dm-adr",
        source_refs_json: JSON.stringify([{ type: "adr", id: "ADR-014" }, { type: "merged_pr", id: "PR#182" }]),
        updated_at: now - 10 * 24 * 60 * 60 * 1000
      })
    ];

    const result = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      agentId: "codex",
      userId: "user_001",
      taskType: "implementation",
      task: {
        title: "認証APIのリファクタリング",
        description: "legacy_authを整理し、new_auth_providerに寄せたい",
        targetFiles: ["src/auth/provider.ts"]
      }
    })) as any;

    expect(result.decisionContext[0]).toMatchObject({ id: "dm-adr" });
    expect(result.summary).toContain("new_auth_provider");
  });

  it("penalizes deprecated memory below active memory", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.decisionMemories = [
      baseDecision({
        id: "dm-deprecated",
        status: "deprecated",
        decision: "legacy_auth is allowed",
        source_refs_json: JSON.stringify([{ type: "merged_pr", id: "PR#100" }]),
        updated_at: now
      }),
      baseDecision({
        id: "dm-active",
        updated_at: now - 1000
      })
    ];

    const result = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      task: { title: "legacy_auth new_auth_provider", description: "認証APIを更新する" }
    })) as any;

    expect(result.decisionContext.map((item: any) => item.id).slice(0, 2)).toEqual(["dm-active", "dm-deprecated"]);
  });

  it("detects active/deprecated conflicts on the same topic", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({ id: "dm-active" }),
      baseDecision({ id: "dm-old", status: "deprecated", decision: "legacy_authを使う", confidence: 0.4 })
    ];

    const result = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      includeConflicts: true,
      task: { title: "legacy_auth", description: "認証方針を確認する" }
    })) as any;

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      preferredMemoryId: "dm-active",
      conflictingMemoryIds: ["dm-old"]
    });
  });

  it("filters out unauthorized memories and unauthorized source refs", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-restricted-memory",
        visibility: "restricted",
        allowed_principals_json: JSON.stringify(["user:other"])
      }),
      baseDecision({
        id: "dm-visible",
        source_refs_json: JSON.stringify([
          { type: "adr", id: "ADR-014" },
          { type: "slack_thread", id: "S-1", allowedPrincipals: ["user:other"] }
        ])
      })
    ];

    const result = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      agentId: "codex",
      task: { title: "legacy_auth", description: "new_auth_providerへ寄せる" },
      includeSources: true
    })) as any;

    expect(result.decisionContext.map((item: any) => item.id)).toEqual(["dm-visible"]);
    expect(result.decisionContext[0].sources.map((source: any) => source.id)).toEqual(["ADR-014"]);
  });

  it("compresses response below maxTokens", async () => {
    const db = new FakeD1();
    db.decisionMemories = Array.from({ length: 8 }, (_, index) =>
      baseDecision({
        id: `dm-${index}`,
        title: `auth decision ${index}`,
        constraints_json: JSON.stringify(Array.from({ length: 8 }, (__, item) => `constraint ${index}-${item} `.repeat(10))),
        known_pitfalls_json: JSON.stringify(Array.from({ length: 8 }, (__, item) => `pitfall ${index}-${item} `.repeat(10))),
        updated_at: Date.now() - index
      })
    );

    const result = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      task: { title: "auth decision", description: "implementation" },
      maxTokens: 500
    })) as any;

    expect(result.meta.estimatedTokens).toBeLessThanOrEqual(500);
  });
});
