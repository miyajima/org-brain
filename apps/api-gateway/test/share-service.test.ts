import { describe, expect, it } from "vitest";
import { getResourceShare, updateResourceShare } from "../src/share-service";

type KnowledgeDocRecord = {
  tenant_id: string;
  id: string;
  owner_principal: string | null;
  deleted_at: number | null;
};

type DecisionMemoryRecord = {
  tenant_id: string;
  id: string;
  owner_refs_json: string | null;
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
  created_by_principal?: string;
};

class FakeStatement {
  args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    readonly sql: string
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.includes("SELECT owner_principal")) {
      const [tenantId, id] = this.args as [string, string];
      return (this.db.knowledgeDocs.find((row) => row.tenant_id === tenantId && row.id === id && row.deleted_at === null) ?? null) as T | null;
    }

    if (this.sql.includes("SELECT owner_refs_json")) {
      const [tenantId, id] = this.args as [string, string];
      return (this.db.decisionMemories.find((row) => row.tenant_id === tenantId && row.id === id) ?? null) as T | null;
    }

    if (this.sql.includes("SELECT role") && this.sql.includes("FROM group_members")) {
      const [tenantId, groupId, principal] = this.args as [string, string, string];
      return (this.db.groupMembers.find(
        (row) => row.tenant_id === tenantId && row.group_id === groupId && row.principal === principal
      ) ?? null) as T | null;
    }

    return null;
  }

  async all<T>() {
    if (this.sql.includes("FROM resource_acl")) {
      const [tenantId, resourceType, resourceId] = this.args as [string, string, string];
      const rows = this.db.resourceAcl
        .filter((row) => row.tenant_id === tenantId && row.resource_type === resourceType && row.resource_id === resourceId)
        .sort((a, b) => `${a.subject_type}:${a.subject_id}`.localeCompare(`${b.subject_type}:${b.subject_id}`))
        .map((row) => ({ subject_type: row.subject_type, subject_id: row.subject_id, permission: row.permission }));
      return { results: rows as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("DELETE FROM resource_acl")) {
      const [tenantId, resourceType, resourceId] = this.args as [string, string, string];
      this.db.resourceAcl = this.db.resourceAcl.filter(
        (row) => !(row.tenant_id === tenantId && row.resource_type === resourceType && row.resource_id === resourceId)
      );
      return { success: true };
    }

    if (this.sql.startsWith("INSERT INTO resource_acl(")) {
      this.db.resourceAcl.push({
        tenant_id: this.args[1] as string,
        resource_type: this.args[2] as string,
        resource_id: this.args[3] as string,
        subject_type: this.args[4] as string,
        subject_id: this.args[5] as string,
        permission: this.args[6] as string,
        created_by_principal: this.args[7] as string
      });
      return { success: true };
    }

    return { success: true };
  }
}

class FakeD1 {
  knowledgeDocs: KnowledgeDocRecord[] = [];
  decisionMemories: DecisionMemoryRecord[] = [];
  groupMembers: GroupMemberRecord[] = [];
  resourceAcl: ResourceAclRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) await statement.run();
    return [];
  }
}

describe("share service", () => {
  it("allows a knowledge doc owner to share with an administered group", async () => {
    const db = new FakeD1();
    db.knowledgeDocs.push({ tenant_id: "team-a", id: "doc_1", owner_principal: "user:alice", deleted_at: null });
    db.groupMembers.push({ tenant_id: "team-a", group_id: "grp_1", principal: "user:alice", role: "admin" });

    const result = await updateResourceShare(
      { OPEN_BRAIN_DB: db } as any,
      {
        tenant_id: "team-a",
        resource_type: "knowledge_doc",
        resource_id: "doc_1",
        entries: [{ subject_type: "group", subject_id: "grp_1", permission: "read" }]
      },
      "user:alice"
    );

    expect(result.acl).toEqual([{ subject_type: "group", subject_id: "grp_1", permission: "read" }]);
    await expect(getResourceShare({ OPEN_BRAIN_DB: db } as any, "team-a", "knowledge_doc", "doc_1")).resolves.toMatchObject({
      acl: [{ subject_type: "group", subject_id: "grp_1", permission: "read" }]
    });
  });

  it("rejects sharing by a non-owner", async () => {
    const db = new FakeD1();
    db.decisionMemories.push({
      tenant_id: "team-a",
      id: "dm_1",
      owner_refs_json: JSON.stringify([{ type: "principal", id: "user:alice" }])
    });

    await expect(
      updateResourceShare(
        { OPEN_BRAIN_DB: db } as any,
        { tenant_id: "team-a", resource_type: "decision_memory", resource_id: "dm_1", entries: [] },
        "user:bob"
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("rejects group sharing unless the actor administers the group", async () => {
    const db = new FakeD1();
    db.knowledgeDocs.push({ tenant_id: "team-a", id: "doc_1", owner_principal: "user:alice", deleted_at: null });
    db.groupMembers.push({ tenant_id: "team-a", group_id: "grp_1", principal: "user:alice", role: "member" });

    await expect(
      updateResourceShare(
        { OPEN_BRAIN_DB: db } as any,
        {
          tenant_id: "team-a",
          resource_type: "knowledge_doc",
          resource_id: "doc_1",
          entries: [{ subject_type: "group", subject_id: "grp_1", permission: "read" }]
        },
        "user:alice"
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
