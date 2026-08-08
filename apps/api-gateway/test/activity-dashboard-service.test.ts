import { dashboardActivityResponseSchema } from "@org-brain/contracts";
import { describe, expect, it } from "vitest";
import {
  encodeActivityCursor,
  getActivityDashboard,
  type ActivityEvent
} from "../src/activity-dashboard-service";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

class ActivityStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: ActivityD1,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]) {
    expect(args).toHaveLength((this.sql.match(/\?/gu) ?? []).length);
    this.args = args;
    return this;
  }

  async all<T>() {
    let rows: Row[];
    const eventQuery = [
      "activity:task-events",
      "activity:memory-usage",
      "activity:memory-versions",
      "activity:decision-versions",
      "activity:impact-events",
      "activity:effect-events",
      "activity:negative-effect-attention",
      "activity:retrieval-events",
      "activity:retrieval-attention",
      "activity:agent-messages"
    ].some((marker) => this.sql.includes(marker));
    if (this.sql.includes("activity:task-events")) rows = this.db.taskEvents;
    else if (this.sql.includes("activity:memory-usage")) {
      rows = this.db.usageEvents.map((row) => ({
        ...row,
        memory_exists: row.memory_exists ?? (row.source_type === "memory" ? 1 : 0),
        decision_exists: row.decision_exists ?? (row.source_type === "decision_memory" ? 1 : 0)
      }));
    }
    else if (this.sql.includes("activity:memory-versions")) rows = this.db.memoryVersions;
    else if (this.sql.includes("activity:decision-versions")) rows = this.db.decisionVersions;
    else if (this.sql.includes("activity:impact-events")) rows = this.db.impactEvents;
    else if (this.sql.includes("activity:effect-events")) rows = this.db.effectEvents;
    else if (this.sql.includes("activity:negative-effect-attention")) {
      rows = this.db.effectEvents.filter((row) => row.effect_outcome === "negative");
    }
    else if (this.sql.includes("activity:effect-acl-items")) {
      const requestedIds = JSON.parse(String(this.args[0])) as string[];
      this.db.effectAclMaxRequestedIds = Math.max(
        this.db.effectAclMaxRequestedIds,
        requestedIds.length
      );
      this.db.effectAclBindCount = this.args.length;
      this.db.effectAclSql = this.sql;
      const usageEventIds = new Set(requestedIds);
      rows = this.db.effectAclItems
        .filter((row) => usageEventIds.has(String(row.usage_event_id)))
        .map((row) => ({
          ...row,
          memory_exists: row.memory_exists ?? (row.source_type === "memory" ? 1 : 0),
          decision_exists: row.decision_exists ?? (row.source_type === "decision_memory" ? 1 : 0)
        }));
    }
    else if (this.sql.includes("activity:retrieval-events")) rows = this.db.retrievalEvents;
    else if (this.sql.includes("activity:retrieval-attention")) {
      rows = this.db.retrievalEvents.filter((row) =>
        Number(row.matched_count) === 0 || row.fallback_used === 1
      );
    }
    else if (this.sql.includes("activity:agent-messages")) rows = this.db.messageEvents;
    else if (this.sql.includes("FROM group_members")) {
      rows = this.db.groupIds.map((groupId) => ({ group_id: groupId }));
    }
    else if (this.sql.includes("activity:observed-agents")) {
      this.db.observedAgentSql = this.sql;
      this.db.observedAgentBindCount = this.args.length;
      this.db.observedAgentSubjects = JSON.parse(String(this.args[5])) as Array<{
        subject_type: string;
        subject_id: string;
      }>;
      rows = this.db.observedAgents;
    }
    else if (this.sql.includes("FROM resource_acl")) {
      rows = this.db.readableDecisionAclIds.map((resourceId) => ({ resource_id: resourceId }));
    }
    else if (this.sql.includes("activity:task-attention")) rows = this.db.taskAttention;
    else if (this.sql.includes("activity:message-attention")) rows = this.db.messageAttention;
    else if (this.sql.includes("activity:impact-attention")) rows = this.db.impactAttention;
    else if (this.sql.includes("activity:dormant-memories")) {
      const limit = Number(this.args[this.args.length - 1]);
      this.db.dormantMemoryMaxBatch = Math.max(this.db.dormantMemoryMaxBatch, limit);
      rows = [...this.db.dormantMemories].sort((left, right) =>
        Number(right.utility_score) - Number(left.utility_score)
        || Number(left.last_activity_at) - Number(right.last_activity_at)
        || String(left.id).localeCompare(String(right.id))
      );
      if (this.sql.includes("activity:dormant-cursor")) {
        const [utilityScore, , lastActivityAt, , id] = this.args.slice(-6, -1) as [number, number, number, number, string];
        rows = rows.filter((row) =>
          Number(row.utility_score) < Number(utilityScore)
          || (Number(row.utility_score) === Number(utilityScore) && (
            Number(row.last_activity_at) > Number(lastActivityAt)
            || (Number(row.last_activity_at) === Number(lastActivityAt) && String(row.id) > String(id))
          ))
        );
      }
      rows = rows.slice(0, limit);
    }
    else if (this.sql.includes("activity:expired-memories")) {
      const limit = Number(this.args[this.args.length - 1]);
      this.db.expiredMemoryMaxBatch = Math.max(this.db.expiredMemoryMaxBatch, limit);
      rows = [...this.db.expiredMemories].sort((left, right) =>
        Number(right.valid_until) - Number(left.valid_until)
        || String(left.id).localeCompare(String(right.id))
      );
      if (this.sql.includes("activity:expired-cursor")) {
        const [validUntil, , id] = this.args.slice(-4, -1) as [number, number, string];
        rows = rows.filter((row) =>
          Number(row.valid_until) < Number(validUntil)
          || (Number(row.valid_until) === Number(validUntil) && String(row.id) > String(id))
        );
      }
      rows = rows.slice(0, limit);
    }
    else if (this.sql.includes("activity:decision-conflicts")) {
      const tenantId = String(this.args[0]);
      const projectId = this.sql.includes("AND (project_id = ? OR project_id IS NULL)")
        ? String(this.args[1])
        : null;
      const limit = Number(this.args[this.args.length - 1]);
      this.db.decisionConflictScanLimit = Math.max(this.db.decisionConflictScanLimit, limit);
      rows = this.db.decisionConflicts.filter((row) =>
        row.tenant_id === tenantId && (!projectId || row.project_id === projectId || row.project_id === null)
      ).sort((left, right) =>
        Number(right.updated_at) - Number(left.updated_at)
        || String(right.id).localeCompare(String(left.id))
      );
      if (this.sql.includes("activity:decision-conflict-cursor")) {
        const [updatedAt, , id] = this.args.slice(-4, -1) as [number, number, string];
        rows = rows.filter((row) =>
          Number(row.updated_at) < Number(updatedAt)
          || (Number(row.updated_at) === Number(updatedAt) && String(row.id) < String(id))
        );
      }
      rows = rows.slice(0, limit);
    }
    else rows = [];
    if (eventQuery) {
      const after = this.sql.includes(" > ? OR (");
      const before = this.sql.includes(" < ? OR (");
      if (after || before) {
        const cursorAt = Number(this.args[this.args.length - 4]);
        const cursorKey = String(this.args[this.args.length - 2]);
        rows = rows.filter((row) => {
          const comparison = Number(row.occurred_at) - cursorAt || String(row.event_key).localeCompare(cursorKey);
          return after ? comparison > 0 : comparison < 0;
        });
      }
      const ascending = this.sql.includes("ORDER BY occurred_at ASC");
      rows = [...rows]
        .sort((left, right) => {
          const comparison = Number(left.occurred_at) - Number(right.occurred_at)
            || String(left.event_key).localeCompare(String(right.event_key));
          return ascending ? comparison : -comparison;
        })
        .slice(0, Number(this.args[this.args.length - 1]));
    }
    return { results: rows as T[] };
  }
}

class ActivityD1 {
  taskEvents: Row[] = [];
  usageEvents: Row[] = [];
  memoryVersions: Row[] = [];
  decisionVersions: Row[] = [];
  impactEvents: Row[] = [];
  effectEvents: Row[] = [];
  effectAclItems: Row[] = [];
  retrievalEvents: Row[] = [];
  messageEvents: Row[] = [];
  observedAgents: Row[] = [];
  taskAttention: Row[] = [];
  messageAttention: Row[] = [];
  impactAttention: Row[] = [];
  dormantMemories: Row[] = [];
  expiredMemories: Row[] = [];
  decisionConflicts: Row[] = [];
  readableDecisionAclIds: string[] = [];
  groupIds: string[] = [];
  observedAgentSql = "";
  observedAgentBindCount = 0;
  observedAgentSubjects: Array<{ subject_type: string; subject_id: string }> = [];
  effectAclMaxRequestedIds = 0;
  effectAclBindCount = 0;
  effectAclSql = "";
  dormantMemoryMaxBatch = 0;
  expiredMemoryMaxBatch = 0;
  decisionConflictScanLimit = 0;

  prepare(sql: string) {
    return new ActivityStatement(this, sql);
  }
}

function dashboardEnv(db: ActivityD1): Pick<Env, "OPEN_BRAIN_DB"> {
  return { OPEN_BRAIN_DB: db as unknown as D1Database };
}

function taskEvent(id: string, occurredAt: number): Row {
  return {
    event_key: `task:${id}`,
    source_id: id,
    kind: "completed",
    occurred_at: occurredAt,
    project_id: "project-a",
    task_id: `task-${id}`,
    trace_id: `trace-${id}`,
    capability: "memory.search",
    task_status: "succeeded"
  };
}

function usageEvent(id: string, occurredAt: number, permissionsJson: string | null): Row {
  return {
    event_key: `memory-usage:${id}`,
    usage_event_id: `usage-${id}`,
    usage_item_id: id,
    occurred_at: occurredAt,
    project_id: "project-a",
    task_id: null,
    trace_id: null,
    capability: "memory.search",
    access_path: "hybrid",
    request_source: "api",
    actor_principal: "agent:codex",
    source_type: "memory",
    source_id: `memory-${id}`,
    reference_type: "search_result",
    used_state: "used",
    memory_label: `Memory ${id}`,
    memory_permissions_json: permissionsJson,
    decision_title: null,
    decision_visibility: null,
    decision_allowed_principals_json: null,
    reporter_principal: null,
    agent_name: "Codex",
    model: "gpt-5"
  };
}

function memoryVersionEvent(id: string, occurredAt: number, permissionsJson: string | null): Row {
  return {
    event_key: `memory-write:${id}`,
    source_id: `memory-${id}`,
    occurred_at: occurredAt,
    project_id: "project-a",
    version: 1,
    operation: "create",
    summary: `Memory ${id}`,
    kind: "semantic",
    lifecycle_state: "active",
    actor_type: "agent",
    actor_id: "agent:codex",
    permissions_json: permissionsJson
  };
}

function decisionVersionEvent(id: string, occurredAt: number, restricted: boolean): Row {
  return {
    event_key: `decision-write:${id}`,
    source_id: `decision-${id}`,
    occurred_at: occurredAt,
    project_id: "project-a",
    operation: "create",
    actor_refs_json: JSON.stringify([{ id: "agent:codex", type: "agent" }]),
    title: `Decision ${id}`,
    status: "active",
    visibility: restricted ? "restricted" : "tenant",
    allowed_principals_json: "[]"
  };
}

describe("getActivityDashboard", () => {
  it("returns the shared contract while redacting inaccessible and sensitive activity fields", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    db.observedAgents = [{
      reporter_principal: "agent:codex",
      agent_name: "Codex",
      model: "gpt-5",
      last_seen_at: now - 10 * 60_000,
      active_task_count: 0,
      read_count: 1,
      write_count: 1,
      failure_count: 0
    }];
    db.taskEvents = [{
      event_key: "task:event-failed",
      source_id: "event-failed",
      kind: "failed",
      occurred_at: now - 1_000,
      project_id: "project-a",
      task_id: "task-failed",
      trace_id: "trace-failed",
      capability: "memory.search",
      task_status: "failed",
      payload_json: "TASK-PAYLOAD-SECRET"
    }];
    db.usageEvents = [
      {
        event_key: "memory-usage:item-public",
        usage_event_id: "usage-public",
        usage_item_id: "item-public",
        occurred_at: now - 10 * 60_000,
        project_id: "project-a",
        task_id: "task-read",
        trace_id: "trace-read",
        capability: "memory.search",
        access_path: "hybrid",
        request_source: "api",
        actor_principal: "agent:codex",
        source_type: "memory",
        source_id: "memory-public",
        reference_type: "search_result",
        used_state: "used",
        memory_label: "Safe memory summary",
        memory_permissions_json: null,
        decision_title: null,
        decision_visibility: null,
        decision_allowed_principals_json: null,
        reporter_principal: "agent:legacy-fallback",
        agent_name: "Codex",
        model: "gpt-5",
        query_text: "QUERY-TEXT-SECRET"
      },
      {
        event_key: "memory-usage:item-private",
        usage_event_id: "usage-private",
        usage_item_id: "item-private",
        occurred_at: now - 2_500,
        project_id: "project-a",
        task_id: "task-read",
        trace_id: "trace-read",
        capability: "memory.search",
        access_path: "hybrid",
        request_source: "api",
        actor_principal: "agent:codex",
        source_type: "memory",
        source_id: "memory-private",
        reference_type: "search_result",
        used_state: "used",
        memory_label: "PRIVATE-MEMORY-SECRET",
        memory_permissions_json: JSON.stringify([{
          principal_type: "principal",
          principal_id: "user:bob",
          permissions: ["read"]
        }]),
        decision_title: null,
        decision_visibility: null,
        decision_allowed_principals_json: null,
        reporter_principal: null,
        agent_name: null,
        model: null
      }
    ];
    db.memoryVersions = [
      {
        event_key: "memory-write:version-public",
        source_id: "memory-public",
        occurred_at: now - 11 * 60_000,
        project_id: "project-a",
        version: 2,
        operation: "revise",
        summary: "Safe memory summary",
        kind: "semantic",
        lifecycle_state: "active",
        actor_type: "agent",
        actor_id: "agent:codex",
        permissions_json: null
      },
      {
        event_key: "memory-write:version-private",
        source_id: "memory-private",
        occurred_at: now - 1_000,
        project_id: "project-a",
        version: 2,
        operation: "revise",
        summary: "PRIVATE-WRITE-SECRET",
        kind: "semantic",
        lifecycle_state: "active",
        actor_type: "agent",
        actor_id: "agent:codex",
        permissions_json: JSON.stringify([{
          principal_type: "principal",
          principal_id: "user:bob",
          permissions: ["read"]
        }])
      }
    ];
    db.retrievalEvents = [{
      event_key: "retrieval:retrieval-miss",
      source_id: "retrieval-miss",
      occurred_at: now - 3_000,
      project_id: "project-a",
      task_id: "task-read",
      capability: "memory.search",
      search_strategy: "hybrid",
      matched_count: 0,
      returned_count: 0,
      fallback_used: 1,
      latency_ms: 17,
      query_text: "RETRIEVAL-QUERY-SECRET"
    }];
    db.effectEvents = [{
      event_key: "memory-effect:effect-negative",
      source_id: "effect-negative",
      usage_event_id: "usage-public",
      occurred_at: now - 4_000,
      project_id: "project-a",
      task_id: "task-read",
      trace_id: "trace-read",
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -10,
      failure_avoided: 0,
      request_source: "api",
      actor_principal: "agent:effect-authenticated",
      reporter_principal: "agent:legacy-effect",
      agent_name: "Effect agent",
      model: "gpt-5",
      failure_category: "FAILURE-CATEGORY-SECRET"
    }];
    db.effectAclItems = [{
      usage_event_id: "usage-public",
      source_type: "memory",
      source_id: "memory-public",
      memory_permissions_json: null,
      decision_visibility: null,
      decision_allowed_principals_json: null
    }];
    db.messageEvents = [{
      event_key: "handoff:message-1",
      source_id: "message-1",
      occurred_at: now - 5_000,
      project_id: "project-a",
      sender_principal: "agent:codex",
      target_type: "principal",
      target_key: "user:alice",
      status: "unread",
      subject: "MESSAGE-SUBJECT-SECRET",
      body: "MESSAGE-BODY-SECRET"
    }];
    db.taskAttention = [
      { id: "task-stalled", project_id: "project-a", capability: "research", status: "running", updated_at: now - 31 * 60_000 },
      { id: "task-failed", project_id: "project-a", capability: "memory.search", status: "failed", updated_at: now - 1_000 }
    ];
    db.messageAttention = [{
      id: "message-1",
      project_id: "project-a",
      sender_principal: "agent:codex",
      target_type: "principal",
      target_key: "user:alice",
      status: "unread",
      created_at: now - 31 * 60_000
    }];
    db.impactAttention = [{
      id: "impact-start",
      external_run_id: "run-1",
      project_id: "project-a",
      occurred_at: now - 31 * 60_000
    }];
    db.dormantMemories = [
      {
        id: "memory-dormant",
        project_id: "project-a",
        label: "Reusable deployment lesson",
        utility_score: 0.95,
        last_activity_at: now - 31 * 86_400_000,
        permissions_json: null
      },
      {
        id: "memory-dormant-private",
        project_id: "project-a",
        label: "PRIVATE-DORMANT-SECRET",
        utility_score: 0.99,
        last_activity_at: now - 31 * 86_400_000,
        permissions_json: JSON.stringify([{
          principal_type: "principal",
          principal_id: "user:bob",
          permissions: ["read"]
        }])
      }
    ];
    db.expiredMemories = [
      {
        id: "memory-expired",
        project_id: "project-a",
        label: "Outdated deployment fact",
        valid_until: now - 1,
        permissions_json: null
      },
      {
        id: "memory-expired-private",
        project_id: "project-a",
        label: "PRIVATE-EXPIRED-SECRET",
        valid_until: now - 2,
        permissions_json: JSON.stringify([{
          principal_type: "principal",
          principal_id: "user:bob",
          permissions: ["read"]
        }])
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60 * 60_000,
      to: now,
      now
    });

    expect(() => dashboardActivityResponseSchema.parse(result)).not.toThrow();
    expect(result.contract_version).toBe("dashboard/v1");
    expect(result.events.find((event) => event.id === "memory-usage:item-public")?.actor).toMatchObject({
      id: "agent:codex",
      label: "Codex",
      kind: "agent"
    });
    expect(result.events.find((event) => event.id === "memory-effect:effect-negative")?.actor).toMatchObject({
      id: "agent:effect-authenticated",
      label: "Effect agent",
      kind: "agent"
    });
    expect(result.events.find((event) => event.id === "task:event-failed")?.actor).toEqual({
      id: "system:cap-runner",
      label: "Capability runner",
      kind: "system"
    });
    expect(result.events.find((event) => event.id === "retrieval:retrieval-miss")?.actor).toEqual({
      id: "system:capability:memory.search",
      label: "memory.search",
      kind: "system"
    });
    expect(result.events.some((event) => event.id === "memory-usage:item-private")).toBe(false);
    expect(result.observed_agents).toEqual([expect.objectContaining({
      id: "agent:codex",
      state: "active",
      last_seen_at: now - 10 * 60_000,
      read_count: 1,
      write_count: 1
    })]);
    expect(new Set(result.attention.map((item) => item.kind))).toEqual(new Set([
      "task_stalled",
      "task_failed",
      "handoff_unacked",
      "impact_unreported",
      "retrieval_miss",
      "negative_memory_effect",
      "memory_dormant",
      "memory_expired"
    ]));
    expect(result.attention.find((item) => item.kind === "task_stalled")?.reason).toContain("30 minutes");
    expect(result.attention.filter((item) => item.kind === "memory_dormant")).toEqual([
      expect.objectContaining({ subject_id: "memory-dormant" })
    ]);
    expect(result.attention.filter((item) => item.kind === "memory_expired")).toEqual([
      expect.objectContaining({ subject_id: "memory-expired" })
    ]);

    const serialized = JSON.stringify(result);
    for (const secret of [
      "TASK-PAYLOAD-SECRET",
      "QUERY-TEXT-SECRET",
      "PRIVATE-MEMORY-SECRET",
      "PRIVATE-WRITE-SECRET",
      "PRIVATE-DORMANT-SECRET",
      "PRIVATE-EXPIRED-SECRET",
      "RETRIEVAL-QUERY-SECRET",
      "FAILURE-CATEGORY-SECRET",
      "MESSAGE-SUBJECT-SECRET",
      "MESSAGE-BODY-SECRET"
    ]) expect(serialized).not.toContain(secret);
  });

  it("keyset-scans past hidden memory pages for dormant and expired attention", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    const hiddenPermissions = JSON.stringify([{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }]);
    const hiddenCount = 300;
    db.dormantMemories = [
      ...Array.from({ length: hiddenCount }, (_, index) => ({
        id: `hidden-dormant-${String(index).padStart(3, "0")}`,
        project_id: "project-a",
        label: `HIDDEN-DORMANT-SECRET-${index}`,
        utility_score: 0.99,
        last_activity_at: now - 40 * 86_400_000 + index,
        permissions_json: hiddenPermissions
      })),
      {
        id: "readable-dormant",
        project_id: "project-a",
        label: "Readable dormant memory",
        utility_score: 0.9,
        last_activity_at: now - 40 * 86_400_000,
        permissions_json: null
      }
    ];
    db.expiredMemories = [
      ...Array.from({ length: hiddenCount }, (_, index) => ({
        id: `hidden-expired-${String(index).padStart(3, "0")}`,
        project_id: "project-a",
        label: `HIDDEN-EXPIRED-SECRET-${index}`,
        valid_until: now - index,
        permissions_json: hiddenPermissions
      })),
      {
        id: "readable-expired",
        project_id: "project-a",
        label: "Readable expired memory",
        valid_until: now - hiddenCount - 1,
        permissions_json: null
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60_000,
      to: now,
      now
    });

    expect(db.dormantMemoryMaxBatch).toBe(250);
    expect(db.expiredMemoryMaxBatch).toBe(250);
    expect(result.attention.filter((item) => item.kind === "memory_dormant")).toEqual([
      expect.objectContaining({ subject_id: "readable-dormant" })
    ]);
    expect(result.attention.filter((item) => item.kind === "memory_expired")).toEqual([
      expect.objectContaining({ subject_id: "readable-expired" })
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("HIDDEN-DORMANT-SECRET");
    expect(serialized).not.toContain("HIDDEN-EXPIRED-SECRET");
  });

  it("uses resource ACL fallback only for restricted decisions across reads, writes, and effects", async () => {
    const db = new ActivityD1();
    db.readableDecisionAclIds = ["decision-tenant-allowlisted", "decision-restricted-granted"];
    db.usageEvents = [
      {
        ...usageEvent("tenant-allowlisted", 120, null),
        source_type: "decision_memory",
        source_id: "decision-tenant-allowlisted",
        decision_title: "TENANT-ALLOWLIST-SECRET",
        decision_visibility: "tenant",
        decision_allowed_principals_json: JSON.stringify(["user:bob"])
      },
      {
        ...usageEvent("restricted-granted", 110, null),
        source_type: "decision_memory",
        source_id: "decision-restricted-granted",
        decision_title: "Readable restricted decision",
        decision_visibility: "restricted",
        decision_allowed_principals_json: "[]"
      }
    ];
    db.decisionVersions = [
      {
        ...decisionVersionEvent("tenant-allowlisted", 100, false),
        source_id: "decision-tenant-allowlisted",
        title: "TENANT-ALLOWLIST-VERSION-SECRET",
        visibility: "tenant",
        allowed_principals_json: JSON.stringify(["user:bob"])
      },
      {
        ...decisionVersionEvent("restricted-granted", 90, true),
        source_id: "decision-restricted-granted",
        title: "Readable restricted decision",
        visibility: "restricted",
        allowed_principals_json: "[]"
      }
    ];
    db.effectEvents = [
      {
        event_key: "memory-effect:tenant-allowlisted",
        source_id: "tenant-allowlisted",
        usage_event_id: "usage-tenant-allowlisted",
        occurred_at: 80,
        project_id: "project-a",
        task_id: null,
        trace_id: null,
        effect_outcome: "negative",
        evidence_level: "reported",
        net_saved_tokens_estimate: -100,
        failure_avoided: 0,
        request_source: "api",
        capability: "memory.search",
        actor_principal: "agent:hidden",
        reporter_principal: null,
        agent_name: null,
        model: null
      },
      {
        event_key: "memory-effect:restricted-granted",
        source_id: "restricted-granted",
        usage_event_id: "usage-restricted-granted",
        occurred_at: 70,
        project_id: "project-a",
        task_id: null,
        trace_id: null,
        effect_outcome: "negative",
        evidence_level: "reported",
        net_saved_tokens_estimate: -1,
        failure_avoided: 0,
        request_source: "api",
        capability: "memory.search",
        actor_principal: "agent:visible",
        reporter_principal: null,
        agent_name: null,
        model: null
      }
    ];
    db.effectAclItems = [
      {
        usage_event_id: "usage-tenant-allowlisted",
        source_type: "decision_memory",
        source_id: "decision-tenant-allowlisted",
        memory_permissions_json: null,
        decision_visibility: "tenant",
        decision_allowed_principals_json: JSON.stringify(["user:bob"])
      },
      {
        usage_event_id: "usage-restricted-granted",
        source_type: "decision_memory",
        source_id: "decision-restricted-granted",
        memory_permissions_json: null,
        decision_visibility: "restricted",
        decision_allowed_principals_json: "[]"
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(result.events.map((event) => event.id)).toEqual([
      "memory-usage:restricted-granted",
      "decision-write:restricted-granted",
      "memory-effect:restricted-granted"
    ]);
    expect(result.attention.filter((item) => item.kind === "negative_memory_effect")).toEqual([
      expect.objectContaining({ subject_id: "restricted-granted" })
    ]);
    expect(JSON.stringify(result)).not.toContain("TENANT-ALLOWLIST");
    expect(db.observedAgentSql).toContain("decision.visibility = 'restricted' AND EXISTS");
  });

  it("treats dangling memory and decision usage sources as unreadable", async () => {
    const db = new ActivityD1();
    db.usageEvents = [
      {
        ...usageEvent("dangling-memory", 120, null),
        source_id: "DANGLING-MEMORY-SECRET",
        memory_exists: 0
      },
      {
        ...usageEvent("dangling-decision", 110, null),
        source_type: "decision_memory",
        source_id: "DANGLING-DECISION-SECRET",
        memory_exists: 0,
        decision_exists: 0,
        decision_visibility: null,
        decision_allowed_principals_json: null
      }
    ];
    db.effectEvents = [{
      event_key: "memory-effect:DANGLING-EFFECT-SECRET",
      source_id: "DANGLING-EFFECT-SECRET",
      usage_event_id: "usage-dangling-effect",
      occurred_at: 100,
      project_id: "project-a",
      task_id: "DANGLING-TASK-SECRET",
      trace_id: "DANGLING-TRACE-SECRET",
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -500,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:hidden",
      reporter_principal: null,
      agent_name: null,
      model: null
    }];
    db.effectAclItems = [{
      usage_event_id: "usage-dangling-effect",
      source_type: "memory",
      source_id: "DANGLING-MEMORY-SECRET",
      memory_exists: 0,
      decision_exists: 0,
      memory_permissions_json: null,
      decision_visibility: null,
      decision_allowed_principals_json: null
    }];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(result.events).toEqual([]);
    expect(result.attention.filter((item) => item.kind === "negative_memory_effect")).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("DANGLING-");
  });

  it("omits an effect and its attention when every linked usage item is hidden", async () => {
    const db = new ActivityD1();
    const hiddenPermissions = JSON.stringify([{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }]);
    db.effectEvents = [{
      event_key: "memory-effect:HIDDEN-EFFECT-SECRET",
      source_id: "HIDDEN-EFFECT-SECRET",
      usage_event_id: "usage-all-hidden",
      occurred_at: 100,
      project_id: "project-a",
      task_id: "HIDDEN-TASK-SECRET",
      trace_id: "HIDDEN-TRACE-SECRET",
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -900,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:hidden",
      reporter_principal: null,
      agent_name: null,
      model: null
    }];
    db.effectAclItems = [
      {
        usage_event_id: "usage-all-hidden",
        source_type: "memory",
        source_id: "HIDDEN-MEMORY-SECRET",
        memory_permissions_json: hiddenPermissions,
        decision_visibility: null,
        decision_allowed_principals_json: null
      },
      {
        usage_event_id: "usage-all-hidden",
        source_type: "decision_memory",
        source_id: "HIDDEN-DECISION-SECRET",
        memory_permissions_json: null,
        decision_visibility: "restricted",
        decision_allowed_principals_json: JSON.stringify(["user:bob"])
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(result.events.filter((event) => event.type === "memory.effect")).toEqual([]);
    expect(result.attention.filter((item) => item.kind === "negative_memory_effect")).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("HIDDEN-");
  });

  it("omits an effect when linked usage items have mixed visibility", async () => {
    const db = new ActivityD1();
    db.effectEvents = [{
      event_key: "memory-effect:mixed-effect",
      source_id: "mixed-effect",
      usage_event_id: "usage-mixed",
      occurred_at: 100,
      project_id: "project-a",
      task_id: "task-readable",
      trace_id: "trace-readable",
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -5,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:codex",
      reporter_principal: null,
      agent_name: "Codex",
      model: "gpt-5"
    }];
    db.effectAclItems = [
      {
        usage_event_id: "usage-mixed",
        source_type: "decision_memory",
        source_id: "HIDDEN-MIXED-DECISION-SECRET",
        memory_permissions_json: null,
        decision_visibility: "restricted",
        decision_allowed_principals_json: JSON.stringify(["user:bob"])
      },
      {
        usage_event_id: "usage-mixed",
        source_type: "memory",
        source_id: "memory-readable",
        memory_permissions_json: null,
        decision_visibility: null,
        decision_allowed_principals_json: null
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(result.events.filter((event) => event.type === "memory.effect")).toEqual([]);
    expect(result.attention.filter((item) => item.kind === "negative_memory_effect")).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("HIDDEN-MIXED-DECISION-SECRET");
  });

  it("keeps an effect only when every linked usage item is readable", async () => {
    const db = new ActivityD1();
    db.effectEvents = [{
      event_key: "memory-effect:all-visible-effect",
      source_id: "all-visible-effect",
      usage_event_id: "usage-all-visible",
      occurred_at: 100,
      project_id: "project-a",
      task_id: "task-readable",
      trace_id: "trace-readable",
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -5,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:codex",
      reporter_principal: null,
      agent_name: "Codex",
      model: "gpt-5"
    }];
    db.effectAclItems = [
      {
        usage_event_id: "usage-all-visible",
        source_type: "decision_memory",
        source_id: "decision-readable",
        memory_permissions_json: null,
        decision_visibility: "tenant",
        decision_allowed_principals_json: "[]"
      },
      {
        usage_event_id: "usage-all-visible",
        source_type: "memory",
        source_id: "memory-readable",
        memory_permissions_json: null,
        decision_visibility: null,
        decision_allowed_principals_json: null
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(result.events.filter((event) => event.type === "memory.effect")).toEqual([
      expect.objectContaining({
        id: "memory-effect:all-visible-effect",
        task_id: "task-readable"
      })
    ]);
    expect(result.attention.filter((item) => item.kind === "negative_memory_effect")).toEqual([
      expect.objectContaining({ subject_id: "all-visible-effect" })
    ]);
  });

  it("loads more than 100 effect usage IDs through one JSON bind", async () => {
    const db = new ActivityD1();
    const count = 130;
    db.effectEvents = Array.from({ length: count }, (_, index) => ({
      event_key: `memory-effect:bulk-${String(index).padStart(3, "0")}`,
      source_id: `bulk-${index}`,
      usage_event_id: `usage-bulk-${index}`,
      occurred_at: 1_000 - index,
      project_id: "project-a",
      task_id: null,
      trace_id: null,
      effect_outcome: "positive",
      evidence_level: "reported",
      net_saved_tokens_estimate: 1,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:codex",
      reporter_principal: null,
      agent_name: null,
      model: null
    }));
    db.effectAclItems = Array.from({ length: count }, (_, index) => ({
      usage_event_id: `usage-bulk-${index}`,
      source_type: "memory",
      source_id: `memory-bulk-${index}`,
      memory_permissions_json: null,
      decision_visibility: null,
      decision_allowed_principals_json: null
    }));

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 2_000,
      now: 2_000,
      limit: 250
    });

    expect(result.events.filter((event) => event.type === "memory.effect")).toHaveLength(count);
    expect(db.effectAclMaxRequestedIds).toBe(count);
    expect(db.effectAclBindCount).toBe(2);
    expect(db.effectAclSql).toContain("json_each(?)");
  });

  it("detects normalized decision conflicts without exposing private or cross-tenant records", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    db.decisionConflicts = [
      {
        id: "decision-active",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "  Auth   Provider!!! ",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 100
      },
      {
        id: "decision-deprecated",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "auth provider",
        status: "deprecated",
        superseded_by: "decision-active",
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 200
      },
      {
        id: "decision-private-active",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "Private topic",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 300
      },
      {
        id: "decision-private-old",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "Private topic!",
        decision: "PRIVATE-DECISION-BODY-SECRET",
        status: "deprecated",
        superseded_by: "decision-private-active",
        valid_until: null,
        visibility: "restricted",
        allowed_principals_json: JSON.stringify(["user:bob"]),
        updated_at: now - 400
      },
      {
        id: "decision-other-tenant-active",
        tenant_id: "tenant-b",
        project_id: "project-a",
        title: "TENANT-B-CONFLICT-SECRET",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 500
      },
      {
        id: "decision-other-tenant-old",
        tenant_id: "tenant-b",
        project_id: "project-a",
        title: "TENANT-B-CONFLICT-SECRET!",
        status: "deprecated",
        superseded_by: "decision-other-tenant-active",
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 600
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60_000,
      to: now,
      now
    });

    expect(() => dashboardActivityResponseSchema.parse(result)).not.toThrow();
    expect(result.attention.filter((item) => item.kind === "decision_conflict")).toEqual([{
      id: "attention:decision:decision-active:conflict",
      kind: "decision_conflict",
      severity: "warning",
      detected_at: now,
      subject_type: "decision_memory",
      subject_id: "decision-active",
      reason: "Decision topic \"Auth Provider!!!\" has active/current and inactive, superseded, or expired records."
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE-DECISION-BODY-SECRET");
    expect(serialized).not.toContain("TENANT-B-CONFLICT-SECRET");
    expect(serialized).not.toContain("decision-private-old");
  });

  it("flags simultaneous current active decisions without requiring inactive history", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    db.decisionConflicts = [
      {
        id: "decision-current-newer",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "Deployment region",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 100
      },
      {
        id: "decision-current-older",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "deployment   region!",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - 200
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60_000,
      to: now,
      now
    });

    expect(result.attention.filter((item) => item.kind === "decision_conflict")).toEqual([{
      id: "attention:decision:decision-current-newer:conflict",
      kind: "decision_conflict",
      severity: "critical",
      detected_at: now,
      subject_type: "decision_memory",
      subject_id: "decision-current-newer",
      reason: "Decision topic \"Deployment region\" has multiple simultaneous current active records."
    }]);
  });

  it("keyset-scans past more than one hidden decision page to find a readable conflict", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    const hiddenCount = 300;
    db.decisionConflicts = [
      ...Array.from({ length: hiddenCount }, (_, index) => ({
        id: `hidden-${String(index).padStart(3, "0")}`,
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: `HIDDEN-CONFLICT-SECRET-${index}`,
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "restricted",
        allowed_principals_json: JSON.stringify(["user:bob"]),
        updated_at: now - index
      })),
      {
        id: "readable-active",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "Readable policy",
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - hiddenCount - 1
      },
      {
        id: "readable-old",
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: "Readable policy!",
        status: "deprecated",
        superseded_by: "readable-active",
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - hiddenCount - 2
      }
    ];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60_000,
      to: now,
      now
    });

    expect(db.decisionConflictScanLimit).toBe(250);
    expect(result.attention.filter((item) => item.kind === "decision_conflict")).toEqual([
      expect.objectContaining({ subject_id: "readable-active" })
    ]);
    expect(JSON.stringify(result)).not.toContain("HIDDEN-CONFLICT-SECRET");
  });

  it("bounds each decision-conflict page and the attention output", async () => {
    const now = 200_000_000;
    const db = new ActivityD1();
    db.decisionConflicts = Array.from({ length: 40 }, (_, index) => [
      {
        id: `active-${index}`,
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: `Topic ${String(index).padStart(2, "0")}`,
        status: "active",
        superseded_by: null,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - index * 2
      },
      {
        id: `old-${index}`,
        tenant_id: "tenant-a",
        project_id: "project-a",
        title: `Topic ${String(index).padStart(2, "0")}!`,
        status: "deprecated",
        superseded_by: `active-${index}`,
        valid_until: null,
        visibility: "tenant",
        allowed_principals_json: "[]",
        updated_at: now - index * 2 - 1
      }
    ]).flat();

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: now - 60_000,
      to: now,
      now
    });

    expect(db.decisionConflictScanLimit).toBe(250);
    expect(result.attention.filter((item) => item.kind === "decision_conflict")).toHaveLength(25);
  });

  it("uses the exact System / Unknown actor for unattributed legacy rows", async () => {
    const db = new ActivityD1();
    db.taskEvents = [{
      event_key: "task:legacy-task",
      source_id: "legacy-task-event",
      kind: "created",
      occurred_at: 10,
      project_id: "project-a",
      task_id: "legacy-task",
      trace_id: null,
      capability: "memory.search",
      task_status: "created",
      created_by_principal: null
    }];
    db.usageEvents = [{
      event_key: "memory-usage:legacy-usage",
      usage_event_id: "legacy-usage-event",
      usage_item_id: "legacy-usage",
      occurred_at: 20,
      project_id: "project-a",
      task_id: null,
      trace_id: null,
      capability: null,
      access_path: "direct",
      request_source: "api",
      actor_principal: null,
      source_type: "memory",
      source_id: "memory-one",
      reference_type: "manual",
      used_state: "used",
      memory_label: "Memory one",
      memory_permissions_json: null,
      decision_title: null,
      decision_visibility: null,
      decision_allowed_principals_json: null,
      reporter_principal: null,
      agent_name: null,
      model: null
    }];
    db.memoryVersions = [{
      event_key: "memory-write:legacy-version",
      source_id: "memory-one",
      occurred_at: 30,
      project_id: "project-a",
      version: 1,
      operation: "capture",
      summary: "Memory one",
      kind: "episodic",
      lifecycle_state: "active",
      actor_type: null,
      actor_id: null,
      permissions_json: null
    }];
    db.decisionVersions = [{
      event_key: "decision-write:legacy-decision-version",
      source_id: "decision-one",
      occurred_at: 40,
      project_id: "project-a",
      operation: "create",
      actor_refs_json: null,
      title: "Decision one",
      status: "active",
      visibility: "tenant",
      allowed_principals_json: "[]"
    }];
    db.impactEvents = [
      {
        event_key: "impact:legacy-impact",
        source_id: "legacy-impact",
        occurred_at: 50,
        project_id: "project-a",
        task_id: null,
        trace_id: null,
        external_run_id: "legacy-run",
        event_type: "eligible",
        memory_used: null,
        avoided_lookup: null,
        confidence: null,
        reporter_principal: null,
        agent_name: null,
        model: null
      },
      {
        event_key: "impact:name-only",
        source_id: "name-only",
        occurred_at: 55,
        project_id: "project-a",
        task_id: null,
        trace_id: null,
        external_run_id: "named-run",
        event_type: "eligible",
        memory_used: null,
        avoided_lookup: null,
        confidence: null,
        reporter_principal: null,
        agent_name: "Recorded Agent",
        model: null
      }
    ];
    db.effectEvents = [{
      event_key: "memory-effect:legacy-effect",
      source_id: "legacy-effect",
      usage_event_id: "legacy-usage-event",
      occurred_at: 60,
      project_id: "project-a",
      task_id: null,
      trace_id: null,
      effect_outcome: "unknown",
      evidence_level: "reported",
      net_saved_tokens_estimate: 0,
      failure_avoided: 0,
      request_source: "api",
      actor_principal: null,
      reporter_principal: null,
      agent_name: null,
      model: null
    }];
    db.effectAclItems = [{
      usage_event_id: "legacy-usage-event",
      source_type: "memory",
      source_id: "memory-one",
      memory_permissions_json: null,
      decision_visibility: null,
      decision_allowed_principals_json: null
    }];
    db.retrievalEvents = [{
      event_key: "retrieval:legacy-retrieval",
      source_id: "legacy-retrieval",
      occurred_at: 70,
      project_id: "project-a",
      task_id: "legacy-task",
      capability: "memory.search",
      search_strategy: "hybrid",
      matched_count: 1,
      returned_count: 1,
      fallback_used: 0,
      latency_ms: 5
    }];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 100,
      now: 100
    });
    const unknownActor = {
      id: "system:unknown",
      label: "System / Unknown",
      kind: "system"
    };
    const byId = new Map(result.events.map((event) => [event.id, event.actor]));
    expect(byId.get("task:legacy-task")).toEqual({
      id: "system:capability:memory.search",
      label: "memory.search",
      kind: "system"
    });
    expect(byId.get("retrieval:legacy-retrieval")).toEqual({
      id: "system:capability:memory.search",
      label: "memory.search",
      kind: "system"
    });
    expect(byId.get("impact:name-only")).toEqual({
      id: "agent-name:recorded-agent",
      label: "Recorded Agent",
      kind: "agent"
    });
    for (const id of [
      "memory-usage:legacy-usage",
      "memory-write:legacy-version",
      "decision-write:legacy-decision-version",
      "impact:legacy-impact",
      "memory-effect:legacy-effect"
    ]) expect(byId.get(id)).toEqual(unknownActor);
    expect(result.events).toHaveLength(8);
  });

  it("uses stable timestamp/id keyset cursors in both history and polling directions", async () => {
    const db = new ActivityD1();
    db.taskEvents = [
      taskEvent("event-a", 100),
      taskEvent("event-b", 200),
      taskEvent("event-c", 200)
    ];

    const first = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 2
    });
    expect(first.events.map((event) => event.id)).toEqual(["task:event-c", "task:event-b"]);
    expect(first.has_more).toBe(true);

    const older = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 2,
      before: first.oldest_cursor
    });
    expect(older.events.map((event) => event.id)).toEqual(["task:event-a"]);

    const afterEvent: Pick<ActivityEvent, "id" | "occurred_at"> = {
      id: "task:event-a",
      occurred_at: 100
    };
    const newer = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      from: 0,
      to: 1_000,
      now: 1_000,
      after: encodeActivityCursor(afterEvent)
    });
    expect(newer.events.map((event) => event.id)).toEqual(["task:event-b", "task:event-c"]);
  });

  it("keyset-scans past dense ACL-hidden usage and version rows without leaking them into pagination", async () => {
    const db = new ActivityD1();
    const privatePermissions = JSON.stringify([{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }]);
    // Exceeds the service's absolute 250-row SQL page bound, so a complete
    // result requires advancing across more than one maximum-sized page.
    const hiddenCount = 280;
    db.usageEvents = [
      ...Array.from({ length: hiddenCount }, (_, index) =>
        usageEvent(`zz-hidden-${String(index).padStart(3, "0")}`, 300, privatePermissions)),
      // The readable row shares the hidden rows' timestamp and sorts after
      // them, exercising the event-key half of the keyset cursor.
      usageEvent("aa-readable", 300, null)
    ];
    db.memoryVersions = [
      ...Array.from({ length: hiddenCount }, (_, index) =>
        memoryVersionEvent(`hidden-${String(index).padStart(3, "0")}`, 250, privatePermissions)),
      memoryVersionEvent("readable", 200, null)
    ];
    db.decisionVersions = [
      ...Array.from({ length: hiddenCount }, (_, index) =>
        decisionVersionEvent(`hidden-${String(index).padStart(3, "0")}`, 150, true)),
      decisionVersionEvent("readable", 100, false)
    ];

    const first = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 2
    });
    expect(first.events.map((event) => event.id)).toEqual([
      "memory-usage:aa-readable",
      "memory-write:readable"
    ]);
    expect(first.has_more).toBe(true);

    const older = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 2,
      before: first.oldest_cursor
    });
    expect(older.events.map((event) => event.id)).toEqual(["decision-write:readable"]);
    expect(older.has_more).toBe(false);

    const allReadable = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 250
    });
    expect(allReadable.events).toHaveLength(3);
    expect(allReadable.has_more).toBe(false);
    expect(JSON.stringify(allReadable)).not.toContain("hidden");
  });

  it("preserves exact SQL-side observed-agent counts above former scan limits", async () => {
    const db = new ActivityD1();
    db.observedAgents = [{
      reporter_principal: "agent:codex",
      agent_name: "Codex",
      model: "gpt-5",
      last_seen_at: 200,
      active_task_count: 7,
      read_count: 1_005,
      write_count: 1_006,
      failure_count: 3
    }];

    const result = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 1_000,
      now: 1_000,
      limit: 1
    });

    expect(result.observed_agents).toEqual([
      expect.objectContaining({
        id: "agent:codex",
        state: "active",
        last_seen_at: 200,
        active_task_count: 7,
        read_count: 1_005,
        write_count: 1_006,
        failure_count: 3
      })
    ]);
  });

  it("binds 120 authorization groups through one observed-agent JSON parameter", async () => {
    const db = new ActivityD1();
    db.groupIds = Array.from({ length: 120 }, (_, index) => `group-${index}`);

    await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });

    expect(db.observedAgentBindCount).toBe(6);
    expect(db.observedAgentSql).toContain("FROM json_each(?)");
    expect(db.observedAgentSubjects).toHaveLength(122);
    expect(db.observedAgentSubjects[0]).toEqual({
      subject_type: "principal",
      subject_id: "user:alice"
    });
    expect(db.observedAgentSubjects).toContainEqual({
      subject_type: "group",
      subject_id: "group-119"
    });
    expect(db.observedAgentSubjects.at(-1)).toEqual({
      subject_type: "tenant",
      subject_id: "tenant-a"
    });
  });

  it("keeps retrieval and negative-effect attention stable on a quiet after-cursor poll", async () => {
    const db = new ActivityD1();
    db.retrievalEvents = [{
      event_key: "retrieval:baseline-miss",
      source_id: "baseline-miss",
      occurred_at: 100,
      project_id: "project-a",
      task_id: "task-retrieval",
      capability: "memory.search",
      search_strategy: "hybrid",
      matched_count: 0,
      returned_count: 0,
      fallback_used: 1,
      latency_ms: 10
    }];
    db.effectEvents = [{
      event_key: "memory-effect:baseline-negative",
      source_id: "baseline-negative",
      usage_event_id: "usage-baseline-negative",
      occurred_at: 90,
      project_id: "project-a",
      task_id: "task-effect",
      trace_id: null,
      effect_outcome: "negative",
      evidence_level: "reported",
      net_saved_tokens_estimate: -1,
      failure_avoided: 0,
      request_source: "api",
      capability: "memory.search",
      actor_principal: "agent:codex",
      reporter_principal: null,
      agent_name: null,
      model: null
    }];
    db.effectAclItems = [{
      usage_event_id: "usage-baseline-negative",
      source_type: "memory",
      source_id: "memory-readable",
      memory_permissions_json: null,
      decision_visibility: null,
      decision_allowed_principals_json: null
    }];

    const first = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200
    });
    const quietPoll = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      projectId: "project-a",
      from: 0,
      to: 200,
      now: 200,
      after: first.newest_cursor
    });

    expect(first.events).toHaveLength(2);
    expect(quietPoll.events).toEqual([]);
    expect(first.attention.map((item) => item.id)).toEqual([
      "attention:effect:baseline-negative",
      "attention:retrieval:baseline-miss"
    ]);
    expect(quietPoll.attention).toEqual(first.attention);
  });

  it("retains the ACL-filtered window agent aggregate on a quiet after-cursor poll", async () => {
    const db = new ActivityD1();
    db.observedAgents = [{
      reporter_principal: "agent:codex",
      agent_name: "Codex",
      model: "gpt-5",
      last_seen_at: 100,
      active_task_count: 0,
      read_count: 1,
      write_count: 0,
      failure_count: 0
    }];
    db.usageEvents = [{
      event_key: "memory-usage:item-one",
      usage_event_id: "usage-one",
      usage_item_id: "item-one",
      occurred_at: 100,
      project_id: "project-a",
      task_id: null,
      trace_id: null,
      capability: "memory.search",
      access_path: "hybrid",
      request_source: "api",
      actor_principal: "agent:codex",
      source_type: "memory",
      source_id: "memory-public",
      reference_type: "search_result",
      used_state: "used",
      memory_label: "Public memory",
      memory_permissions_json: null,
      decision_title: null,
      decision_visibility: null,
      decision_allowed_principals_json: null,
      reporter_principal: null,
      agent_name: "Codex",
      model: "gpt-5"
    }];

    const first = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 200,
      now: 200
    });
    const quietPoll = await getActivityDashboard(dashboardEnv(db), "tenant-a", {
      principal: "user:alice",
      from: 0,
      to: 200,
      now: 200,
      after: first.newest_cursor
    });

    expect(quietPoll.events).toEqual([]);
    expect(quietPoll.observed_agents).toEqual(first.observed_agents);
    expect(quietPoll.observed_agents).toEqual([
      expect.objectContaining({ id: "agent:codex", state: "active", read_count: 1 })
    ]);
  });

  it("rejects ambiguous cursors and invalid activity windows before querying D1", async () => {
    const env = dashboardEnv(new ActivityD1());
    await expect(getActivityDashboard(env, "tenant-a", { before: "a", after: "b" }))
      .rejects.toMatchObject({ status: 400, code: "ambiguous_cursor" });
    await expect(getActivityDashboard(env, "tenant-a", { from: 0, to: 8 * 86_400_000 }))
      .rejects.toMatchObject({ status: 400, code: "activity_window_too_large" });
    await expect(getActivityDashboard(env, "tenant-a", { limit: 251 }))
      .rejects.toMatchObject({ status: 400, code: "invalid_limit" });
    await expect(getActivityDashboard(env, "tenant-a", { before: "not-a-cursor" }))
      .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
  });
});
