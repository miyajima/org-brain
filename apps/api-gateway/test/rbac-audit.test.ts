import { describe, expect, it } from "vitest";
import { appendAuditEvent, verifyAuditChain } from "../src/audit-service";
import { authorizePermission } from "../src/rbac-service";

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

  async first<T>() {
    if (this.sql.includes("FROM audit_events")) {
      const tenantId = String(this.args[0]);
      const row = [...this.db.auditEvents]
        .filter((event) => event.tenant_id === tenantId)
        .sort((left, right) => Number(right.created_at) - Number(left.created_at) || String(right.id).localeCompare(String(left.id)))[0];
      return (row ? { entry_hash: row.entry_hash, created_at: row.created_at } : null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("FROM principal_role_assignments")) {
      const tenantId = String(this.args[0]);
      const principal = this.sql.includes("principal = ?") ? String(this.args[1]) : null;
      const projectId = this.sql.includes("(project_id IS NULL OR project_id = ?)")
        ? String(this.args[this.args.length - 1])
        : null;
      return {
        results: this.db.roles.filter((role) =>
          role.tenant_id === tenantId &&
          (!principal || role.principal === principal) &&
          (!projectId || role.project_id === null || role.project_id === projectId)
        ) as T[]
      };
    }
    if (this.sql.includes("FROM audit_events")) {
      const tenantId = String(this.args[0]);
      return {
        results: this.db.auditEvents
          .filter((event) => event.tenant_id === tenantId)
          .sort((left, right) => Number(left.created_at) - Number(right.created_at) || String(left.id).localeCompare(String(right.id))) as T[]
      };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO audit_events(")) {
      this.db.auditEvents.push({
        id: this.args[0],
        tenant_id: this.args[1],
        project_id: this.args[2],
        principal: this.args[3],
        action: this.args[4],
        resource_type: this.args[5],
        resource_id: this.args[6],
        outcome: this.args[7],
        request_id: this.args[8],
        metadata_json: this.args[9],
        previous_hash: this.args[10],
        entry_hash: this.args[11],
        created_at: this.args[12]
      });
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  roles: Array<Record<string, any>> = [];
  auditEvents: Array<Record<string, any>> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

describe("RBAC and audit", () => {
  it("separates fixed role permissions and honors project scope", async () => {
    const db = new FakeD1();
    db.roles.push({
      id: "role-1",
      tenant_id: "tenant-a",
      project_id: "project-a",
      principal: "user:owner",
      role: "project_owner",
      created_by_principal: "user:admin",
      created_at: 1,
      updated_at: 1
    });
    const env = { OPEN_BRAIN_DB: db } as any;

    expect((await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-a",
      principal: "user:owner",
      permission: "delete",
      fallbackRole: "reader"
    })).allowed).toBe(true);

    expect((await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-b",
      principal: "user:owner",
      permission: "delete",
      fallbackRole: "reader"
    })).allowed).toBe(false);

    expect((await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-a",
      principal: "service:agent",
      permission: "write",
      fallbackRole: "service_agent"
    })).allowed).toBe(true);

    expect((await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-a",
      principal: "service:agent",
      permission: "delete",
      fallbackRole: "service_agent"
    })).allowed).toBe(false);
  });

  it("creates a hash chain and detects audit tampering", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;
    await appendAuditEvent(env, {
      tenantId: "tenant-a",
      principal: "user:admin",
      action: "capture",
      resourceType: "memory",
      resourceId: "memory-1",
      outcome: "succeeded",
      metadata: { status: 201 }
    });
    await appendAuditEvent(env, {
      tenantId: "tenant-a",
      principal: "user:admin",
      action: "delete",
      resourceType: "memory",
      resourceId: "memory-1",
      outcome: "succeeded",
      metadata: { status: 200 }
    });
    expect(await verifyAuditChain(env, "tenant-a")).toEqual({ ok: true, checked: 2, errors: [] });

    db.auditEvents[0].metadata_json = '{"status":500}';
    const tampered = await verifyAuditChain(env, "tenant-a");
    expect(tampered.ok).toBe(false);
    expect(tampered.errors[0]).toContain("entry hash mismatch");
  });

  it("prevents privilege escalation through fallback roles or project scope", async () => {
    const db = new FakeD1();
    db.roles.push({
      id: "role-reader",
      tenant_id: "tenant-a",
      project_id: "project-a",
      principal: "user:attacker",
      role: "reader",
      created_by_principal: "user:admin",
      created_at: 1,
      updated_at: 1
    });
    const env = { OPEN_BRAIN_DB: db } as any;

    const assignedRoleWins = await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-a",
      principal: "user:attacker",
      permission: "admin",
      fallbackRole: "tenant_admin"
    });
    expect(assignedRoleWins).toMatchObject({
      allowed: false,
      source: "assignment",
      matched_roles: ["reader"]
    });

    const crossProject = await authorizePermission(env, {
      tenantId: "tenant-a",
      projectId: "project-b",
      principal: "user:attacker",
      permission: "delete",
      fallbackRole: "contributor"
    });
    expect(crossProject.allowed).toBe(false);
  });
});
