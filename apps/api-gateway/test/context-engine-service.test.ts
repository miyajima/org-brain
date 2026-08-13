import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillDecisionRetrievalUnits,
  confirmDecisionMemory,
  capAutoDecisionConfidence,
  createDecisionMemory,
  enrichContext,
  getDecisionMemoryContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  reviseDecisionMemory,
  searchDecisionMemories,
  upsertAutoDecisionMemory
} from "../src/context-engine-service";

type DecisionMemoryRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  business_category_id: string | null;
  work_type: string | null;
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
  origin_memory_id?: string | null;
  origin_source?: string | null;
  origin_external_key?: string | null;
  auto_generated?: number;
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
    if (this.sql.includes("INSERT INTO decision_memories(")) {
      const placeholders = this.sql.match(/\?/gu)?.length ?? 0;
      if (placeholders !== args.length) throw new Error(`decision insert bind mismatch: ${placeholders} != ${args.length}`);
    }
    this.args = args;
    return this;
  }

  async all<T>() {
    if (this.sql.includes("FROM memory_impact_events") && this.sql.includes("event_type = 'eligible'")) {
      const row = this.db.executionContexts.find((item) =>
        item.tenant_id === this.args[0] && item.external_run_id === this.args[1]
      );
      return { results: (row ? [row] : []) as T[] };
    }
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
      const jsonTableLookup = this.sql.includes("WITH requested_ids(resource_id)");
      const tenantId = String(this.args[jsonTableLookup ? 2 : 0]);
      const resourceType = String(this.args[jsonTableLookup ? 3 : 1]);
      const permission = "read";
      const resourceIdArgs = jsonTableLookup
        ? new Set(JSON.parse(String(this.args[0])) as string[])
        : new Set(this.args.slice(2).map(String));
      const subjects = jsonTableLookup
        ? JSON.parse(String(this.args[1])) as Array<[string, string]>
        : this.args.slice(2, -1).map((value, index, values) =>
          index % 2 === 0 ? [String(value), String(values[index + 1])] as [string, string] : null
        ).filter((value): value is [string, string] => Boolean(value));
      const rows = this.db.resourceAcl.filter((row) => {
        if (row.tenant_id !== tenantId || row.resource_type !== resourceType || row.permission !== permission) return false;
        if (!resourceIdArgs.has(row.resource_id)) return false;
        return subjects.some(([subjectType, subjectId]) =>
          subjectType === row.subject_type && subjectId === row.subject_id
        );
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
        .filter((row) => !this.sql.includes("status = 'active'") || row.status === "active")
        .filter((row) => !projectId || row.project_id === projectId || row.project_id === null)
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }
    return { results: [] as T[] };
  }

  async first<T>() {
    if (this.sql.includes("FROM business_categories")) {
      return { id: String(this.args[1]) } as T;
    }
    if (this.sql.includes("FROM decision_memories") && this.sql.includes("origin_source = ?")) {
      const row = this.db.decisionMemories.find((item) =>
        item.tenant_id === this.args[0] &&
        item.origin_source === this.args[1] &&
        item.origin_external_key === this.args[2] &&
        item.auto_generated === 1
      );
      return (row ? { id: row.id } : null) as T;
    }
    const result = await this.all<T>();
    return result.results[0] ?? null;
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
        business_category_id: this.args[25] === null ? null : String(this.args[25]),
        work_type: this.args[26] === null ? null : String(this.args[26]),
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
        updated_at: Number(this.args[24]),
        origin_memory_id: this.args[27] === null ? null : String(this.args[27]),
        origin_source: this.args[28] === null ? null : String(this.args[28]),
        origin_external_key: this.args[29] === null ? null : String(this.args[29]),
        auto_generated: Number(this.args[30] ?? 0)
      });
    } else if (this.sql.includes("UPDATE decision_memories")) {
      const tenantId = String(this.args[24]);
      const id = String(this.args[25]);
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
        row.business_category_id = this.args[22] === null ? null : String(this.args[22]);
        row.work_type = this.args[23] === null ? null : String(this.args[23]);
      }
    } else if (this.sql.includes("INSERT INTO memory_usage_events")) {
      this.db.usageEventBindings.push(this.args);
    }
    return { success: true };
  }
}

class FakeD1 {
  decisionMemories: DecisionMemoryRecord[] = [];
  decisionMemoryVersions: DecisionMemoryVersionRecord[] = [];
  groupMembers: GroupMemberRecord[] = [];
  resourceAcl: ResourceAclRecord[] = [];
  usageEventBindings: unknown[][] = [];
  executionContexts: Array<{
    tenant_id: string;
    external_run_id: string;
    project_id: string | null;
    task_id: string | null;
    trace_id: string | null;
  }> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class UsageRecordingFailureD1 extends FakeD1 {
  override prepare(sql: string) {
    if (sql.includes("FROM memory_usage_events")) {
      return {
        bind() {
          return {
            async all() {
              throw new Error("usage recording unavailable");
            }
          };
        }
      } as any;
    }
    return super.prepare(sql);
  }
}

function baseDecision(overrides: Partial<DecisionMemoryRecord>): DecisionMemoryRecord {
  const now = Date.now();
  return {
    id: "dm-base",
    tenant_id: "org_123",
    project_id: "proj_abc",
    business_category_id: "bc_auth",
    work_type: "implementation",
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes active decision conflicts to review instead of blocking", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({ id: "dm-active-a", decision: "legacy_authを使わない" }),
      baseDecision({ id: "dm-active-b", decision: "legacy_authを使う", status: "active" }),
      baseDecision({ id: "dm-old", decision: "legacy_authを使う", status: "deprecated" })
    ];

    const result = await preActionDecisionGate(
      { OPEN_BRAIN_DB: db } as any,
      {
        tenant_id: "org_123",
        project_id: "proj_abc",
        task: { title: "legacy_auth", description: "認証方式を変更する" }
      },
      { principal: "user:reviewer" }
    );

    expect(result.outcome).toBe("review");
    expect(result.allowed).toBe(false);
  });

  it("caps inferred decisions below 0.90 without durable evidence", () => {
    expect(capAutoDecisionConfidence({
      requested: 0.99,
      decision: "New code must use ORGBRAIN_API_URL.",
      rationale: "Avoid configuration drift.",
      projectId: "proj_abc",
      sources: []
    })).toBe(0.89);
    expect(capAutoDecisionConfidence({
      requested: 0.99,
      decision: "New code must use ORGBRAIN_API_URL.",
      rationale: "Avoid configuration drift.",
      projectId: "proj_abc",
      sources: [{ type: "command", id: "pnpm test", title: "exit_code=0" }]
    })).toBe(0.9);
    expect(capAutoDecisionConfidence({
      requested: 0.99,
      decision: "New code must use ORGBRAIN_API_URL.",
      rationale: "Avoid configuration drift.",
      projectId: "proj_abc",
      sources: [{ type: "commit", id: "abcdef1234567890" }]
    })).toBe(0.9);
    expect(capAutoDecisionConfidence({
      requested: 0.99,
      decision: "New code must use ORGBRAIN_API_URL.",
      rationale: "Avoid configuration drift.",
      projectId: "proj_abc",
      sources: [
        { type: "current_code", id: "apps/api-gateway/src/index.ts", title: "hash=abcdef1234567890" },
        { type: "commit", id: "abcdef1234567890" }
      ]
    })).toBe(0.9);
    expect(capAutoDecisionConfidence({
      requested: 0.99,
      decision: "New code must use ORGBRAIN_API_URL.",
      rationale: "Avoid configuration drift.",
      projectId: "proj_abc",
      sources: [
        { type: "command", id: "pnpm test", title: "exit_code=0" },
        { type: "adr", id: "ADR-014" }
      ]
    })).toBe(0.95);
  });

  it("atomically upserts one automatic decision for a source external key", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;
    const input = {
      tenantId: "org_123",
      memoryId: "memory-origin",
      source: "hook",
      externalKey: "evt-1:constraint",
      projectId: "proj_abc",
      businessCategoryId: "bc_auth",
      workType: "implementation" as const,
      kind: "constraint" as const,
      title: "Legacy auth prohibition",
      decision: "New code must not use legacy_auth.",
      rationale: "It creates duplicate authentication state.",
      evidence: [{
        evidence_type: "command",
        evidence_ref: "pnpm test",
        note: "exit_code=0"
      }],
      sourceReferences: [],
      validFrom: Date.now(),
      validUntil: null,
      confidence: 0.99,
      visibility: "project" as const,
      allowedPrincipals: [],
      principal: "user:reviewer"
    };

    const first = await upsertAutoDecisionMemory(env, input);
    const second = await upsertAutoDecisionMemory(env, input);
    expect(second.decisionMemory.id).toBe(first.decisionMemory.id);
    expect(db.decisionMemories).toHaveLength(1);
    expect(db.decisionMemories[0]).toMatchObject({
      origin_memory_id: "memory-origin",
      origin_source: "hook",
      origin_external_key: "evt-1:constraint",
      auto_generated: 1,
      confidence: 0.9
    });
  });

  it("allows an evidence-backed 0.90 inferred constraint to block only when enabled", async () => {
    const db = new FakeD1();
    db.decisionMemories = [baseDecision({
      id: "dm-auto-block",
      title: "Legacy auth prohibition",
      decision: "New code must not use legacy_auth.",
      rationale: "It creates duplicate authentication state.",
      confidence: 0.9,
      confirmation_state: "inferred_unconfirmed",
      source_refs_json: JSON.stringify([{
        type: "current_code",
        id: "apps/api-gateway/src/auth.ts",
        title: "hash=abcdef1234567890"
      }])
    })];

    const blocked = await preActionDecisionGate(
      {
        OPEN_BRAIN_DB: db,
        ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING: "on"
      } as any,
      {
        tenant_id: "org_123",
        project_id: "proj_abc",
        business_category_id: "bc_auth",
        minimum_confidence: 0.1,
        task: { title: "legacy_auth", description: "Add new authentication code" }
      },
      { principal: "user:reviewer" }
    );
    expect(blocked.outcome).toBe("block");
    expect(blocked.policy.inferred_unconfirmed_block_threshold).toBe(0.9);

    const disabled = await preActionDecisionGate(
      { OPEN_BRAIN_DB: db, ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING: "off" } as any,
      {
        tenant_id: "org_123",
        project_id: "proj_abc",
        business_category_id: "bc_auth",
        task: { title: "legacy_auth", description: "Add new authentication code" }
      },
      { principal: "user:reviewer" }
    );
    expect(disabled.outcome).not.toBe("block");
  });

  it("routes a 0.90 inferred constraint without an exact category scope to review", async () => {
    const db = new FakeD1();
    db.decisionMemories = [baseDecision({
      id: "dm-missing-request-scope",
      decision: "New code must not use legacy_auth.",
      confidence: 0.9,
      source_refs_json: JSON.stringify([{
        type: "current_code",
        id: "apps/api-gateway/src/auth.ts",
        title: "hash=abcdef1234567890"
      }])
    })];

    const result = await preActionDecisionGate(
      { OPEN_BRAIN_DB: db, ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING: "on" } as any,
      {
        tenant_id: "org_123",
        project_id: "proj_abc",
        task: { title: "legacy_auth", description: "Add new authentication code" }
      },
      { principal: "user:reviewer" }
    );

    expect(result.outcome).toBe("review");
    expect(result.context.review_decision_memory_ids).toContain("dm-missing-request-scope");
  });

  it("never blocks 0.89 or an evidence-free 0.90 inferred constraint", async () => {
    for (const fixture of [
      {
        id: "dm-089",
        confidence: 0.89,
        source_refs_json: JSON.stringify([{
          type: "current_code",
          id: "apps/api-gateway/src/auth.ts",
          title: "hash=abcdef1234567890"
        }])
      },
      {
        id: "dm-090-no-evidence",
        confidence: 0.9,
        source_refs_json: "[]"
      }
    ]) {
      const db = new FakeD1();
      db.decisionMemories = [baseDecision({
        ...fixture,
        decision: "New code must not use legacy_auth."
      })];
      const result = await preActionDecisionGate(
        { OPEN_BRAIN_DB: db, ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING: "on" } as any,
        {
          tenant_id: "org_123",
          project_id: "proj_abc",
          business_category_id: "bc_auth",
          task: { title: "legacy_auth", description: "Add new authentication code" }
        },
        { principal: "user:reviewer" }
      );
      expect(result.outcome).toBe("review");
      expect(result.context.blocking_decision_memory_ids).toEqual([]);
    }
  });

  it("builds a decision debt review queue", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.decisionMemories = [
      baseDecision({
        id: "dm-review",
        status: "uncertain",
        confirmation_state: "inferred_unconfirmed",
        valid_until: now + 5 * 24 * 60 * 60 * 1000
      }),
      baseDecision({
        id: "dm-clean",
        confirmation_state: "reviewed",
        confirmed_at: now,
        updated_at: now
      })
    ];

    const result = await getDecisionReviewQueue(
      { OPEN_BRAIN_DB: db } as any,
      { tenant_id: "org_123", project_id: "proj_abc", within_days: 30 },
      { principal: "user:reviewer" }
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.id === "dm-review")).toMatchObject({
      id: "dm-review",
      reasons: expect.arrayContaining(["unconfirmed", "uncertain", "expiring", "conflicting"])
    });
    expect(result.debt.uncertain).toBe(1);
  });

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
    expect(Number(created.decisionMemory.validUntil) - created.decisionMemory.createdAt).toBe(180 * 24 * 60 * 60 * 1000);
    const confirmed = await createDecisionMemory(env, {
      orgId: "org_123",
      projectId: "proj_abc",
      title: "Confirmed API policy",
      decision: "Use service APIs.",
      rationale: "The owner confirmed this policy.",
      confirmationState: "reviewed",
      validUntil: null
    });
    expect(confirmed.decisionMemory.validUntil).toBeNull();
    const search = await searchDecisionMemories(env, { orgId: "org_123", projectId: "proj_abc", q: "direct DB", userId: "user_001" });
    expect(search.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "API access policy", status: "active" })
    ]));
    const unfiltered = await searchDecisionMemories(env, {
      orgId: "org_123",
      projectId: "proj_abc",
      q: "",
      userId: "user_001"
    });
    expect(unfiltered.results).toHaveLength(2);
  });

  it("reprojects every active decision through a resumable cursor", async () => {
    const db = new FakeD1();
    db.decisionMemories = [
      baseDecision({ id: "dm-a" }),
      baseDecision({ id: "dm-b" }),
      baseDecision({ id: "dm-old", status: "deprecated" })
    ];
    const result = await backfillDecisionRetrievalUnits(
      { OPEN_BRAIN_DB: db } as any,
      { tenantId: "org_123", projectId: "proj_abc", cursor: "", limit: 10 }
    );

    expect(result).toMatchObject({
      processed_decisions: 2,
      total_processed_decisions: 2,
      done: true
    });
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

  it("keeps the context response when usage telemetry fails in best-effort mode", async () => {
    const db = new UsageRecordingFailureD1();
    db.decisionMemories = [baseDecision({ id: "dm-telemetry" })];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = (await enrichContext(
      { OPEN_BRAIN_DB: db } as any,
      {
        orgId: "org_123",
        projectId: "proj_abc",
        task: { title: "Resume the existing chat" }
      },
      { principal: "service:test", bestEffortUsage: true }
    )) as any;

    expect(result.decisionContext.map((item: any) => item.id)).toEqual(["dm-telemetry"]);
    expect(result.meta).toMatchObject({ usage_recorded: false });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith({
      event: "orgbrain.context.usage_recording_skipped",
      tenant_id: "org_123",
      project_id: "proj_abc",
      error_code: "unknown"
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("usage recording unavailable");
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

  it("propagates task and trace context into governance search usage", async () => {
    const db = new FakeD1();
    db.decisionMemories = [baseDecision({ id: "dm-context" })];

    await searchDecisionMemories({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      projectId: "proj_abc",
      q: "legacy_auth",
      task_id: "task-123",
      trace_id: "trace-456"
    });

    expect(db.usageEventBindings).toHaveLength(1);
    expect(db.usageEventBindings[0]?.[3]).toBe("task-123");
    expect(db.usageEventBindings[0]?.[4]).toBe("trace-456");
  });

  it("inherits omitted governance search context from an external run", async () => {
    const db = new FakeD1();
    db.decisionMemories = [baseDecision({ id: "dm-external-context" })];
    db.executionContexts = [{
      tenant_id: "org_123",
      external_run_id: "run-789",
      project_id: "proj_abc",
      task_id: "task-from-run",
      trace_id: "trace-from-run"
    }];

    await searchDecisionMemories({ OPEN_BRAIN_DB: db } as any, {
      orgId: "org_123",
      q: "legacy_auth",
      external_run_id: "run-789"
    });

    expect(db.usageEventBindings).toHaveLength(1);
    expect(db.usageEventBindings[0]?.slice(2, 6)).toEqual([
      "proj_abc",
      "task-from-run",
      "trace-from-run",
      "run-789"
    ]);
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
