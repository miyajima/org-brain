import { describe, expect, it } from "vitest";
import { confirmDecisionMemory, createDecisionMemory, enrichContext, getDecisionMemoryContext, reviseDecisionMemory, searchDecisionMemories } from "../src/context-engine-service";

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
  reviewer_refs_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  status: string;
  superseded_by: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  confirmation_state: string | null;
  confirmation_note: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
};

type DecisionMemoryVersionRecord = {
  id: string;
  decision_memory_id: string;
  tenant_id: string;
  operation: string;
  snapshot_json: string;
  actor_refs_json: string | null;
  reviewer_refs_json: string | null;
  note: string | null;
  created_at: number;
};

type GroupMemberRecord = {
  tenant_id: string;
  group_id: string;
  principal: string;
  role: string;
};

type ResourceAclRecord = {
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  subject_type: string;
  subject_id: string;
  permission: string;
};

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
    if (this.sql.includes("FROM group_members") && this.sql.includes("principal = ?")) {
      const tenantId = String(this.args[0]);
      const principal = String(this.args[1]);
      return {
        results: this.db.groupMembers
          .filter((row) => row.tenant_id === tenantId && row.principal === principal)
          .map((row) => ({ group_id: row.group_id })) as T[]
      };
    }
    if (this.sql.includes("FROM resource_acl")) {
      const tenantId = String(this.args[0]);
      const resourceType = String(this.args[1]);
      const permission = "read";
      const rows = this.db.resourceAcl.filter((row) => {
        if (row.tenant_id !== tenantId || row.resource_type !== resourceType || row.permission !== permission) return false;
        const resourceIdArgs = new Set(this.args.slice(2).map(String));
        if (!resourceIdArgs.has(row.resource_id)) return false;
        for (let index = 2; index < this.args.length - 1; index += 1) {
          if (String(this.args[index]) === row.subject_type && String(this.args[index + 1]) === row.subject_id) return true;
        }
        return false;
      });
      return { results: rows.map((row) => ({ resource_id: row.resource_id })) as T[] };
    }
    if (this.sql.includes("FROM decision_memory_versions")) {
      const tenantId = String(this.args[0]);
      const decisionMemoryId = String(this.args[1]);
      const rows = this.db.decisionMemoryVersions
        .filter((row) => row.tenant_id === tenantId && row.decision_memory_id === decisionMemoryId)
        .sort((left, right) => right.created_at - left.created_at);
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM decision_memories") && this.sql.includes("WHERE tenant_id = ? AND id = ?")) {
      const tenantId = String(this.args[0]);
      const id = String(this.args[1]);
      return { results: this.db.decisionMemories.filter((row) => row.tenant_id === tenantId && row.id === id).slice(0, 1) as T[] };
    }
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
    if (this.sql.includes("INSERT INTO decision_memory_versions(")) {
      this.db.decisionMemoryVersions.push({
        id: String(this.args[0]),
        decision_memory_id: String(this.args[1]),
        tenant_id: String(this.args[2]),
        operation: String(this.args[3]),
        snapshot_json: String(this.args[4]),
        actor_refs_json: this.args[5] === null ? null : String(this.args[5]),
        reviewer_refs_json: this.args[6] === null ? null : String(this.args[6]),
        note: this.args[7] === null ? null : String(this.args[7]),
        created_at: Number(this.args[8])
      });
    } else if (this.sql.includes("INSERT INTO decision_memories(")) {
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
        reviewer_refs_json: String(this.args[12]),
        valid_from: this.args[13] === null ? null : Number(this.args[13]),
        valid_until: this.args[14] === null ? null : Number(this.args[14]),
        status: String(this.args[15]),
        superseded_by: this.args[16] === null ? null : String(this.args[16]),
        confidence: Number(this.args[17]),
        visibility: String(this.args[18]),
        allowed_principals_json: String(this.args[19]),
        confirmation_state: String(this.args[20]),
        confirmation_note: this.args[21] === null ? null : String(this.args[21]),
        confirmed_at: this.args[22] === null ? null : Number(this.args[22]),
        created_at: Number(this.args[23]),
        updated_at: Number(this.args[24])
      });
    } else if (this.sql.includes("UPDATE decision_memories")) {
      const tenantId = String(this.args[22]);
      const id = String(this.args[23]);
      const row = this.db.decisionMemories.find((item) => item.tenant_id === tenantId && item.id === id);
      if (row) {
        row.project_id = this.args[0] === null ? null : String(this.args[0]);
        row.domain = String(this.args[1]);
        row.title = String(this.args[2]);
        row.decision = String(this.args[3]);
        row.rationale = String(this.args[4]);
        row.rejected_alternatives_json = String(this.args[5]);
        row.constraints_json = String(this.args[6]);
        row.known_pitfalls_json = String(this.args[7]);
        row.source_refs_json = String(this.args[8]);
        row.owner_refs_json = String(this.args[9]);
        row.reviewer_refs_json = String(this.args[10]);
        row.valid_from = this.args[11] === null ? null : Number(this.args[11]);
        row.valid_until = this.args[12] === null ? null : Number(this.args[12]);
        row.status = String(this.args[13]);
        row.superseded_by = this.args[14] === null ? null : String(this.args[14]);
        row.confidence = Number(this.args[15]);
        row.visibility = String(this.args[16]);
        row.allowed_principals_json = String(this.args[17]);
        row.confirmation_state = String(this.args[18]);
        row.confirmation_note = this.args[19] === null ? null : String(this.args[19]);
        row.confirmed_at = this.args[20] === null ? null : Number(this.args[20]);
        row.updated_at = Number(this.args[21]);
      }
    }
    return { success: true };
  }
}

class FakeD1 {
  decisionMemories: DecisionMemoryRecord[] = [];
  decisionMemoryVersions: DecisionMemoryVersionRecord[] = [];
  groupMembers: GroupMemberRecord[] = [];
  resourceAcl: ResourceAclRecord[] = [];

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
    reviewer_refs_json: "[]",
    valid_from: null,
    valid_until: null,
    status: "active",
    superseded_by: null,
    confidence: 0.88,
    visibility: "tenant",
    allowed_principals_json: "[]",
    confirmation_state: "inferred_unconfirmed",
    confirmation_note: null,
    confirmed_at: null,
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

  it("uses the authenticated principal for restricted decision memory reads when user_id is omitted", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-alice-only",
        visibility: "restricted",
        allowed_principals_json: JSON.stringify(["user:alice@example.com"])
      })
    ];

    const result = (await enrichContext(
      { OPEN_BRAIN_DB: db } as any,
      {
        orgId: "org_123",
        projectId: "proj_abc",
        task: { title: "legacy_auth", description: "new_auth_providerへ寄せる" }
      },
      { principal: "user:alice@example.com" }
    )) as any;

    expect(result.decisionContext.map((item: any) => item.id)).toEqual(["dm-alice-only"]);
  });

  it("does not allow a request body user_id to impersonate another principal", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-alice-only",
        visibility: "restricted",
        allowed_principals_json: JSON.stringify(["user:alice@example.com"])
      })
    ];

    const result = (await searchDecisionMemories(
      { OPEN_BRAIN_DB: db } as any,
      {
        orgId: "org_123",
        projectId: "proj_abc",
        q: "legacy_auth",
        userId: "user:alice@example.com"
      },
      { principal: "user:bob@example.com" }
    )) as any;

    expect(result.results).toEqual([]);
  });

  it("allows restricted decision memories through group ACL membership", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-group-only",
        visibility: "restricted",
        allowed_principals_json: "[]"
      })
    ];
    db.groupMembers = [
      { tenant_id: "org_123", group_id: "grp-platform", principal: "user:alice", role: "member" }
    ];
    db.resourceAcl = [
      {
        tenant_id: "org_123",
        resource_type: "decision_memory",
        resource_id: "dm-group-only",
        subject_type: "group",
        subject_id: "grp-platform",
        permission: "read"
      }
    ];

    const alice = (await searchDecisionMemories(
      { OPEN_BRAIN_DB: db } as any,
      { orgId: "org_123", projectId: "proj_abc", q: "legacy_auth" },
      { principal: "user:alice" }
    )) as any;
    const bob = (await searchDecisionMemories(
      { OPEN_BRAIN_DB: db } as any,
      { orgId: "org_123", projectId: "proj_abc", q: "legacy_auth" },
      { principal: "user:bob" }
    )) as any;

    expect(alice.results.map((item: any) => item.id)).toEqual(["dm-group-only"]);
    expect(bob.results).toEqual([]);
  });

  it("keeps provenance out of enrich results unless explicitly requested", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-trust",
        owner_refs_json: JSON.stringify([{ type: "user", id: "sre-lead", name: "SRE Lead" }]),
        reviewer_refs_json: JSON.stringify([{ type: "user", id: "arch", name: "Architect" }]),
        confirmation_state: "reviewed",
        confirmed_at: Date.now()
      })
    ];

    const base = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      task: { title: "legacy_auth", description: "new_auth_providerへ寄せる" }
    })) as any;
    expect(base.decisionContext[0].provenance).toBeUndefined();
    expect(base.decisionContext[0].trustSignals).toBeUndefined();

    const rich = (await enrichContext({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      userId: "user_001",
      includeProvenance: true,
      authorityScoring: true,
      task: { title: "legacy_auth", description: "new_auth_providerへ寄せる" }
    })) as any;
    expect(rich.decisionContext[0].provenance.decidedBy[0]).toMatchObject({ id: "sre-lead" });
    expect(rich.decisionContext[0].trustSignals).toMatchObject({ confirmationState: "reviewed", humanConfirmed: true });
  });

  it("returns a trust context with versions and conflicts", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.decisionMemories = [
      baseDecision({
        id: "dm-context",
        owner_refs_json: JSON.stringify([{ type: "user", id: "lead", name: "Lead" }]),
        reviewer_refs_json: JSON.stringify([{ type: "user", id: "reviewer", name: "Reviewer" }]),
        confirmation_state: "user_confirmed",
        confirmation_note: "Reviewed during architecture sync",
        confirmed_at: now
      }),
      baseDecision({ id: "dm-context-old", status: "deprecated", decision: "legacy_authを使う" })
    ];
    db.decisionMemoryVersions = [
      {
        id: "ver-1",
        decision_memory_id: "dm-context",
        tenant_id: "org_123",
        operation: "create",
        snapshot_json: JSON.stringify({ title: "新規認証処理はnew_auth_providerへ統一" }),
        actor_refs_json: "[]",
        reviewer_refs_json: "[]",
        note: null,
        created_at: now - 1000
      }
    ];

    const result = await getDecisionMemoryContext({ OPEN_BRAIN_DB: db } as any, {
      tenantId: "org_123",
      id: "dm-context",
      userId: "user_001"
    }) as any;

    expect(result.whyTrustThis.trustSignals).toMatchObject({ humanConfirmed: true, reviewerCount: 1 });
    expect(result.whyTrustThis.provenance.decidedBy[0]).toMatchObject({ id: "lead" });
    expect(result.whyTrustThis.versions).toHaveLength(1);
    expect(result.whyTrustThis.conflicts).toHaveLength(1);
  });

  it("revises and confirms decision memories with version history", async () => {
    const db = new FakeD1();
    db.decisionMemories = [baseDecision({ id: "dm-edit", title: "Old title" })];

    const revised = await reviseDecisionMemory({ OPEN_BRAIN_DB: db } as any, "org_123", "dm-edit", {
      title: "Updated policy",
      decision: "new_auth_provider is required",
      note: "Clarified wording",
      actorRefs: [{ type: "user", id: "editor", name: "Editor" }]
    }) as any;
    expect(revised.decisionMemory).toMatchObject({ title: "Updated policy", decision: "new_auth_provider is required" });

    const confirmed = await confirmDecisionMemory({ OPEN_BRAIN_DB: db } as any, "org_123", "dm-edit", {
      reviewerRefs: [{ type: "user", id: "architect", name: "Architect" }],
      confirmationState: "reviewed",
      confirmationNote: "Architectural decision confirmed",
      confidenceDelta: 0.05
    }) as any;

    expect(confirmed.decisionMemory).toMatchObject({ confirmationState: "reviewed", confirmationNote: "Architectural decision confirmed" });
    expect(confirmed.decisionMemory.reviewerRefs[0]).toMatchObject({ id: "architect" });
    expect(db.decisionMemoryVersions.map((version) => version.operation)).toEqual(["revise", "confirm"]);
  });

  it("filters decision search by reviewer and confirmation state with opt-in trust signals", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({
        id: "dm-reviewed",
        reviewer_refs_json: JSON.stringify([{ type: "user", id: "architect", name: "Architect" }]),
        confirmation_state: "reviewed"
      }),
      baseDecision({ id: "dm-unconfirmed", confirmation_state: "inferred_unconfirmed" })
    ];

    const result = await searchDecisionMemories({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      q: "legacy_auth",
      reviewerId: "architect",
      confirmationState: "reviewed",
      authorityScoring: true
    }) as any;

    expect(result.results.map((item: any) => item.id)).toEqual(["dm-reviewed"]);
    expect(result.results[0].trustSignals).toMatchObject({ confirmationState: "reviewed" });
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
