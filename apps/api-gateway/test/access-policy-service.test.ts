import { beforeEach, describe, expect, it } from "vitest";
import {
  canReadResource,
  getAccessPolicy,
  getAccessPolicyShadowSummary,
  loadAccessPolicy,
  updateAccessPolicy
} from "../src/access-policy-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const runtime = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

class Statement {
  private args: unknown[] = [];

  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.args) as T[] };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE resource_access_policies(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, scope TEXT NOT NULL, owner_principal TEXT NOT NULL,
      project_id TEXT, group_ids_json TEXT NOT NULL DEFAULT '[]',
      restricted_subjects_json TEXT NOT NULL DEFAULT '[]', storage_location TEXT NOT NULL DEFAULT 'd1',
      policy_version INTEGER NOT NULL DEFAULT 1, created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, resource_type, resource_id)
    );
    CREATE TABLE group_members(
      tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member'
    );
    CREATE TABLE resource_acl(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      permission TEXT NOT NULL, created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, resource_type, resource_id, subject_type, subject_id, permission)
    );
    CREATE TABLE access_policy_shadow_diffs(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, principal TEXT NOT NULL, project_key TEXT NOT NULL DEFAULT '',
      policy_version INTEGER NOT NULL, unified_readable INTEGER NOT NULL,
      legacy_readable INTEGER NOT NULL, sample_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, resolved_at INTEGER,
      UNIQUE(tenant_id, resource_type, resource_id, principal, project_key)
    );
    CREATE TABLE knowledge_resources(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, visibility TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_assets(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_principal TEXT,
      updated_at INTEGER
    );
    CREATE TABLE agents(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT NOT NULL, owner_principal TEXT,
      updated_at INTEGER
    );
    CREATE TABLE agent_loadouts(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      status TEXT NOT NULL, owner_principal TEXT, updated_at INTEGER
    );
    CREATE TABLE agent_loadout_bindings(
      tenant_id TEXT NOT NULL, loadout_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL
    );
  `);
  const db = {
    prepare: (sql: string) => new Statement(database, sql),
    batch: async (statements: Statement[]) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return {
    database,
    env: { OPEN_BRAIN_DB: db, ACCESS_POLICY_SHADOW_MODE: "on" } as unknown as Env
  };
}

function insertPolicy(database: SqliteDatabase, values: {
  resourceType?: string;
  resourceId: string;
  scope: string;
  owner?: string;
  projectId?: string | null;
  groups?: string[];
  subjects?: Array<{ subject_type: string; subject_id: string }>;
}) {
  const now = Date.now();
  database.prepare(`
    INSERT INTO resource_access_policies(
      id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
      group_ids_json, restricted_subjects_json, storage_location, policy_version,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'d1',1,?,?,?)
  `).run(
    `policy:${values.resourceId}`, "tenant-a", values.resourceType ?? "skill_asset",
    values.resourceId, values.scope, values.owner ?? "user:owner", values.projectId ?? null,
    JSON.stringify(values.groups ?? []), JSON.stringify(values.subjects ?? []),
    values.owner ?? "user:owner", now, now
  );
}

describe("unified resource access policy", () => {
  let database: SqliteDatabase;
  let env: Env;

  beforeEach(() => {
    ({ database, env } = createEnv());
  });

  it("fails closed across tenants and immediately reflects Group departure", async () => {
    insertPolicy(database, { resourceId: "skill-group", scope: "group", groups: ["group-a"] });
    database.prepare("INSERT INTO group_members(tenant_id, group_id, principal, role) VALUES(?,?,?,'member')")
      .run("tenant-a", "group-a", "user:member");
    const policy = await loadAccessPolicy(env, "tenant-a", "skill_asset", "skill-group");

    await expect(canReadResource(env, policy, {
      tenantId: "tenant-a", principal: "user:member"
    })).resolves.toBe(true);
    await expect(canReadResource(env, policy, {
      tenantId: "tenant-b", principal: "user:member"
    })).resolves.toBe(false);

    database.prepare("DELETE FROM group_members WHERE tenant_id = ? AND group_id = ? AND principal = ?")
      .run("tenant-a", "group-a", "user:member");
    await expect(canReadResource(env, policy, {
      tenantId: "tenant-a", principal: "user:member"
    })).resolves.toBe(false);
  });

  it("uses optimistic policy updates and mirrors only readable subjects", async () => {
    database.prepare("INSERT INTO skill_assets VALUES(?,?,?,?)")
      .run("skill-private", "tenant-a", "user:owner", Date.now());
    insertPolicy(database, {
      resourceId: "skill-private",
      scope: "private",
      projectId: "project-legacy"
    });
    const result = await updateAccessPolicy(env, {
      resource_type: "skill_asset",
      resource_id: "skill-private",
      scope: "restricted",
      project_id: null,
      group_ids: [],
      restricted_subjects: [{ subject_type: "principal", subject_id: "user:reader" }],
      expected_policy_version: 1
    }, { tenantId: "tenant-a", actorPrincipal: "user:owner", isAdmin: false });

    expect(result.policy).toMatchObject({ policy_version: 2, project_id: null });
    const policy = await loadAccessPolicy(env, "tenant-a", "skill_asset", "skill-private");
    await expect(canReadResource(env, policy, { tenantId: "tenant-a", principal: "user:reader" })).resolves.toBe(true);
    await expect(canReadResource(env, policy, { tenantId: "tenant-a", principal: "user:stranger" })).resolves.toBe(false);
    expect(database.prepare("SELECT subject_id FROM resource_acl WHERE resource_id = ? ORDER BY subject_id").all("skill-private"))
      .toEqual([{ subject_id: "user:owner" }, { subject_id: "user:reader" }]);

    await expect(updateAccessPolicy(env, {
      resource_type: "skill_asset",
      resource_id: "skill-private",
      scope: "tenant",
      project_id: null,
      group_ids: [],
      restricted_subjects: [],
      expected_policy_version: 1
    }, { tenantId: "tenant-a", actorPrincipal: "user:owner", isAdmin: false })).rejects.toMatchObject({ status: 409 });

    await expect(updateAccessPolicy(env, {
      resource_type: "skill_asset",
      resource_id: "skill-private",
      scope: "restricted",
      owner_principal: "user:new-owner",
      project_id: null,
      group_ids: [],
      restricted_subjects: [{ subject_type: "principal", subject_id: "user:reader" }],
      expected_policy_version: 2
    }, { tenantId: "tenant-a", actorPrincipal: "user:admin", isAdmin: true })).resolves.toMatchObject({
      policy: { policy_version: 3, owner_principal: "user:new-owner" }
    });
    expect(database.prepare("SELECT owner_principal FROM skill_assets WHERE id = ?").get("skill-private"))
      .toEqual({ owner_principal: "user:new-owner" });
  });

  it("filters utilizing Agents through both Agent and Loadout policies", async () => {
    database.prepare("INSERT INTO skill_assets VALUES(?,?,?,?)")
      .run("skill-shared", "tenant-a", "user:owner", Date.now());
    database.prepare("INSERT INTO agents VALUES(?,?,?,?,?,?,?)")
      .run("agent-hidden", "tenant-a", "hidden", "Hidden agent", "active", "user:other", Date.now());
    database.prepare("INSERT INTO agent_loadouts VALUES(?,?,?,?,?,?)")
      .run("loadout-hidden", "tenant-a", "agent-hidden", "active", "user:other", Date.now());
    database.prepare("INSERT INTO agent_loadout_bindings VALUES(?,?,?)")
      .run("tenant-a", "loadout-hidden", "skill-shared");
    insertPolicy(database, { resourceId: "skill-shared", scope: "tenant" });
    insertPolicy(database, {
      resourceType: "agent",
      resourceId: "agent-hidden",
      scope: "private",
      owner: "user:other"
    });
    insertPolicy(database, {
      resourceType: "agent_loadout",
      resourceId: "loadout-hidden",
      scope: "tenant"
    });

    await expect(getAccessPolicy(env, {
      tenantId: "tenant-a",
      resourceType: "skill_asset",
      resourceId: "skill-shared",
      principal: "user:reader"
    })).resolves.toMatchObject({ utilizing_agents: [] });

    database.prepare(
      "UPDATE resource_access_policies SET scope = 'tenant' WHERE resource_type = 'agent' AND resource_id = ?"
    ).run("agent-hidden");
    database.prepare(
      "UPDATE resource_access_policies SET scope = 'private', owner_principal = 'user:other' WHERE resource_type = 'agent_loadout' AND resource_id = ?"
    ).run("loadout-hidden");
    await expect(getAccessPolicy(env, {
      tenantId: "tenant-a",
      resourceType: "skill_asset",
      resourceId: "skill-shared",
      principal: "user:reader"
    })).resolves.toMatchObject({ utilizing_agents: [] });

    database.prepare(
      "UPDATE resource_access_policies SET scope = 'tenant' WHERE resource_type = 'agent_loadout' AND resource_id = ?"
    ).run("loadout-hidden");
    await expect(getAccessPolicy(env, {
      tenantId: "tenant-a",
      resourceType: "skill_asset",
      resourceId: "skill-shared",
      principal: "user:reader"
    })).resolves.toMatchObject({
      utilizing_agents: [{ id: "agent-hidden", agent_key: "hidden", name: "Hidden agent", status: "active" }]
    });
  });

  it("records and resolves legacy shadow differences without changing the unified answer", async () => {
    database.prepare(
      "INSERT INTO knowledge_resources(id, tenant_id, project_id, visibility, permissions_json, updated_at) VALUES(?,?,?,?,?,?)"
    ).run("resource-a", "tenant-a", null, "tenant", "[]", Date.now());
    insertPolicy(database, { resourceType: "knowledge_resource", resourceId: "resource-a", scope: "private" });
    const policy = await loadAccessPolicy(env, "tenant-a", "knowledge_resource", "resource-a");

    await expect(canReadResource(env, policy, { tenantId: "tenant-a", principal: "user:reader" })).resolves.toBe(false);
    let summary = await getAccessPolicyShadowSummary(env, "tenant-a");
    expect(summary.counts.open).toBe(1);
    expect(summary.diffs[0]).toMatchObject({ unified_readable: false, legacy_readable: true });

    database.prepare("UPDATE knowledge_resources SET visibility = 'restricted' WHERE id = ?").run("resource-a");
    await expect(canReadResource(env, policy, { tenantId: "tenant-a", principal: "user:reader" })).resolves.toBe(false);
    summary = await getAccessPolicyShadowSummary(env, "tenant-a", { includeResolved: true });
    expect(summary.counts.open).toBe(0);
    expect(summary.counts.resolved).toBe(1);
  });
});
