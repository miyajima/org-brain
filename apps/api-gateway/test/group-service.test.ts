import { describe, expect, it } from "vitest";
import { addGroupMember, createGroup, getGroup, getGroupMemberImpact, removeGroupMember } from "../src/group-service";

type Statement = { all: (...args: unknown[]) => Record<string, unknown>[]; get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => { changes?: number | bigint } };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement };
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => Database };

class D1Statement {
  private args: unknown[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE groups(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted_at INTEGER, source TEXT NOT NULL DEFAULT 'local', external_id TEXT);
    CREATE TABLE group_members(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY(tenant_id, group_id, principal));
    CREATE TABLE user_profiles(tenant_id TEXT NOT NULL, principal TEXT NOT NULL, display_name TEXT, avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(tenant_id, principal));
    CREATE TABLE principal_role_assignments(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT,
      principal TEXT NOT NULL, role TEXT NOT NULL, created_by_principal TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE resource_access_policies(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, scope TEXT NOT NULL, owner_principal TEXT NOT NULL, project_id TEXT,
      group_ids_json TEXT NOT NULL, restricted_subjects_json TEXT NOT NULL, storage_location TEXT NOT NULL,
      policy_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const db = {
    prepare: (sql: string) => new D1Statement(database, sql),
    batch: async (statements: D1Statement[]) => Promise.all(statements.map((statement) => statement.run()))
  };
  return { database, env: { OPEN_BRAIN_DB: db } as any };
}

describe("group-service", () => {
  it("shows human member profiles and fail-closes removal when the impact digest changes", async () => {
    const { database, env } = fixture();
    const created = await createGroup(env, "tenant-a", "user:owner", { name: "Engineering" });
    const groupId = created.group.id;
    database.prepare("INSERT INTO user_profiles VALUES(?,?,?,?,?)").run("tenant-a", "user:member", "Mika Sato", "https://example.test/avatar.png", "active");
    await addGroupMember(env, "tenant-a", groupId, "user:owner", { principal: "user:member", role: "member" });
    const now = Date.now();
    const insertPolicy = database.prepare(`INSERT INTO resource_access_policies
      (id,tenant_id,resource_type,resource_id,scope,owner_principal,project_id,group_ids_json,restricted_subjects_json,storage_location,policy_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertPolicy.run("policy-lost", "tenant-a", "memory", "memory-lost", "group", "user:other", null, JSON.stringify([groupId]), "[]", "d1", 1, now, now);
    insertPolicy.run("policy-retained", "tenant-a", "memory", "memory-retained", "restricted", "user:other", null, JSON.stringify([groupId]), JSON.stringify([{ subject_type: "principal", subject_id: "user:member" }]), "d1", 1, now, now);

    const group = await getGroup(env, "tenant-a", groupId, "user:owner");
    expect(group.members.find((member) => member.principal === "user:member")).toMatchObject({ display_name: "Mika Sato", status: "active", can_remove: true });
    expect(group.members.find((member) => member.principal === "user:owner")).toMatchObject({ can_remove: false });
    const first = await getGroupMemberImpact(env, "tenant-a", groupId, "user:owner", "user:member");
    expect(first.impact).toMatchObject({ lost_count: 1, retained_count: 1 });
    expect(first.impact_digest).toMatch(/^[0-9a-f]{64}$/u);

    const alternate = await createGroup(env, "tenant-a", "user:owner", { name: "Release managers" });
    database.prepare("UPDATE resource_access_policies SET group_ids_json=?, policy_version=2, updated_at=? WHERE id='policy-lost'")
      .run(JSON.stringify([groupId, alternate.group.id]), now + 1);
    const membershipSensitive = await getGroupMemberImpact(env, "tenant-a", groupId, "user:owner", "user:member");
    await addGroupMember(env, "tenant-a", alternate.group.id, "user:owner", { principal: "user:member", role: "member" });
    await expect(removeGroupMember(env, "tenant-a", groupId, "user:owner", "user:member", membershipSensitive.impact_digest))
      .rejects.toMatchObject({ status: 409, code: "impact_changed" });
    const afterAlternateMembership = await getGroupMemberImpact(env, "tenant-a", groupId, "user:owner", "user:member");
    expect(afterAlternateMembership.impact).toMatchObject({ lost_count: 0, retained_count: 2 });

    database.prepare("UPDATE resource_access_policies SET policy_version=3, updated_at=? WHERE id='policy-lost'").run(now + 2);
    await expect(removeGroupMember(env, "tenant-a", groupId, "user:owner", "user:member", afterAlternateMembership.impact_digest)).rejects.toMatchObject({ status: 409, code: "impact_changed" });
    const current = await getGroupMemberImpact(env, "tenant-a", groupId, "user:owner", "user:member");
    await expect(removeGroupMember(env, "tenant-a", groupId, "user:owner", "user:member", current.impact_digest)).resolves.toMatchObject({ members: expect.not.arrayContaining([expect.objectContaining({ principal: "user:member" })]) });
  });

  it("requires an impact preview digest", async () => {
    const { env } = fixture();
    const created = await createGroup(env, "tenant-a", "user:owner", { name: "Engineering" });
    await addGroupMember(env, "tenant-a", created.group.id, "user:owner", { principal: "user:member", role: "member" });
    await expect(removeGroupMember(env, "tenant-a", created.group.id, "user:owner", "user:member", null)).rejects.toMatchObject({ status: 428, code: "impact_preview_required" });
  });

  it("explains why the current owner cannot remove themselves", async () => {
    const { env } = fixture();
    const created = await createGroup(env, "tenant-a", "user:owner", { name: "Engineering" });
    const group = await getGroup(env, "tenant-a", created.group.id, "user:owner");
    expect(group.members).toContainEqual(expect.objectContaining({
      principal: "user:owner",
      can_remove: false,
      removal_block_reason: "self_owner"
    }));
  });
});
