import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgent,
  listAgents,
  resolveAgentLoadoutContext,
  updateAgentLoadout
} from "../src/agent-loadout-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

class Statement {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[] }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function policy(database: SqliteDatabase, resourceType: string, resourceId: string, scope = "tenant", owner = "user:owner") {
  const now = Date.now();
  database.prepare(`
    INSERT INTO resource_access_policies(
      id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
      group_ids_json, restricted_subjects_json, storage_location, policy_version,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,NULL,'[]','[]','d1',1,?,?,?)
  `).run(`policy:${resourceType}:${resourceId}`, "tenant-a", resourceType, resourceId, scope, owner, owner, now, now);
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agents(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, agent_key TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, current_loadout_id TEXT,
      source_decision_id TEXT, owner_principal TEXT NOT NULL, last_used_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_loadouts(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, owner_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_assets(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, current_version_id TEXT,
      published_version_id TEXT, valid_until INTEGER
    );
    CREATE TABLE skill_asset_versions(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL);
    CREATE TABLE skill_asset_files(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL,
      skill_asset_version_id TEXT NOT NULL, path TEXT NOT NULL, r2_key TEXT NOT NULL
    );
    CREATE TABLE agent_loadout_bindings(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, loadout_id TEXT NOT NULL,
      skill_asset_id TEXT NOT NULL, usage_mode TEXT NOT NULL, priority INTEGER NOT NULL,
      version_policy TEXT NOT NULL, pinned_version_id TEXT, valid_until INTEGER,
      created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, loadout_id, skill_asset_id)
    );
    CREATE TABLE resource_access_policies(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, scope TEXT NOT NULL, owner_principal TEXT NOT NULL,
      project_id TEXT, group_ids_json TEXT NOT NULL, restricted_subjects_json TEXT NOT NULL,
      storage_location TEXT NOT NULL, policy_version INTEGER NOT NULL,
      created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, resource_type, resource_id)
    );
    CREATE TABLE group_members(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL);
    CREATE TABLE asset_usage_events(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, skill_asset_id TEXT NOT NULL,
      skill_asset_version_id TEXT NOT NULL, agent_id TEXT, agent_key TEXT, event_type TEXT NOT NULL,
      context_tokens INTEGER NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  database.prepare(`INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "agent-a", "tenant-a", null, "reviewer", "Reviewer", "Review decisions", "active",
    "loadout-a", null, "user:runner", null, now, now
  );
  database.prepare(`INSERT INTO agent_loadouts VALUES(?,?,?,?,?,?,?,?,?)`).run(
    "loadout-a", "tenant-a", "agent-a", "Default", "", "active", "user:runner", now, now
  );
  policy(database, "agent", "agent-a", "tenant", "user:runner");
  policy(database, "agent_loadout", "loadout-a", "tenant", "user:runner");

  const objects = new Map<string, string>();
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
  const env = {
    OPEN_BRAIN_DB: db,
    OPEN_BRAIN_BUCKET: {
      get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null
    },
    LOADOUT_RESOLUTION_MODE: "beta"
  } as unknown as Env;
  return { database, env, objects };
}

function addSkill(
  database: SqliteDatabase,
  objects: Map<string, string>,
  values: {
    id: string;
    mode: "always" | "auto" | "on_demand";
    priority: number;
    status?: "draft" | "published" | "retired";
    publishedVersion?: string | null;
    pinnedVersion?: string | null;
    policyScope?: string;
    policyOwner?: string;
    validUntil?: number | null;
  }
) {
  const status = values.status ?? "published";
  const publishedVersion = values.publishedVersion === undefined ? `${values.id}-v2` : values.publishedVersion;
  const pinnedVersion = values.pinnedVersion === undefined ? null : values.pinnedVersion;
  database.prepare("INSERT INTO skill_assets VALUES(?,?,?,?,?,?,?,?,?)").run(
    values.id, "tenant-a", null, `Skill ${values.id}`, `Description ${values.id}`,
    status, publishedVersion, publishedVersion, values.validUntil ?? null
  );
  for (const versionId of new Set([publishedVersion, pinnedVersion].filter((item): item is string => Boolean(item)))) {
    database.prepare("INSERT INTO skill_asset_versions VALUES(?,?,?)").run(versionId, "tenant-a", values.id);
    const key = `skills/${values.id}/${versionId}/SKILL.md`;
    database.prepare("INSERT INTO skill_asset_files VALUES(?,?,?,?,?,?)").run(
      `file:${values.id}:${versionId}`, "tenant-a", values.id, versionId, "SKILL.md", key
    );
    objects.set(key, `# ${values.id}\n\nUse ${values.id} safely.`);
  }
  database.prepare("INSERT INTO agent_loadout_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    `binding:${values.id}`, "tenant-a", "loadout-a", values.id, values.mode, values.priority,
    pinnedVersion ? "pinned" : "latest_published", pinnedVersion, null, "user:runner", Date.now(), Date.now()
  );
  policy(database, "skill_asset", values.id, values.policyScope ?? "tenant", values.policyOwner ?? "user:runner");
}

describe("ACL-first Agent Loadout resolution", () => {
  let database: SqliteDatabase;
  let env: Env;
  let objects: Map<string, string>;

  beforeEach(() => {
    ({ database, env, objects } = createEnv());
  });

  it("keeps pinned versions fixed, returns handles for on-demand, and omits unavailable Skills", async () => {
    addSkill(database, objects, { id: "pinned", mode: "always", priority: 100, publishedVersion: "pinned-v2", pinnedVersion: "pinned-v1" });
    addSkill(database, objects, { id: "on-demand", mode: "on_demand", priority: 90 });
    addSkill(database, objects, { id: "private", mode: "always", priority: 80, policyScope: "private", policyOwner: "user:other" });
    addSkill(database, objects, { id: "retired", mode: "always", priority: 70, status: "retired" });
    addSkill(database, objects, { id: "expired", mode: "always", priority: 60, validUntil: Date.now() - 1 });
    addSkill(database, objects, { id: "draft", mode: "always", priority: 50, status: "draft", publishedVersion: null });

    const result = await resolveAgentLoadoutContext(env, {
      tenantId: "tenant-a",
      agentKey: "reviewer",
      principal: "user:runner",
      taskText: "Review the current decision",
      maxTokens: 2000,
      enforceRuntimeFlag: true
    });

    expect(result.injected_skills).toEqual([
      expect.objectContaining({ skill_asset_id: "pinned", version_id: "pinned-v1", usage_mode: "always" })
    ]);
    expect(result.on_demand_skills).toEqual([
      expect.objectContaining({
        skill_asset_id: "on-demand",
        handle: expect.stringContaining("/on-demand/versions/on-demand-v2")
      })
    ]);
    expect(result.on_demand_skills[0]).not.toHaveProperty("content");
    expect(result.omitted).toEqual(expect.arrayContaining([
      { skill_asset_id: "private", reason: "access_denied" },
      { skill_asset_id: "retired", reason: "not_published" },
      { skill_asset_id: "expired", reason: "expired" },
      { skill_asset_id: "draft", reason: "not_published" }
    ]));

    const detail = await getAgent(env, {
      tenantId: "tenant-a",
      agentId: "agent-a",
      principal: "user:runner"
    });
    expect(detail.bindings.map((binding) => binding.skill_asset_id)).not.toContain("private");
    await expect(listAgents(env, {
      tenantId: "tenant-a",
      principal: "user:runner"
    })).resolves.toMatchObject({ items: [expect.objectContaining({ binding_count: 5 })] });
  });

  it("does not let a binding override Skill or Loadout access", async () => {
    addSkill(database, objects, { id: "restricted", mode: "always", priority: 100, policyScope: "private", policyOwner: "user:other" });

    await expect(updateAgentLoadout(env, "tenant-a", "agent-a", "loadout-a", {
      name: "Default",
      bindings: [{
        skill_asset_id: "restricted",
        usage_mode: "always",
        priority: 100,
        version_policy: "latest_published",
        pinned_version_id: null
      }]
    }, { actorPrincipal: "user:runner", isAdmin: false })).rejects.toMatchObject({ status: 404 });

    database.prepare("UPDATE resource_access_policies SET scope = 'tenant' WHERE resource_type = 'skill_asset' AND resource_id = ?")
      .run("restricted");
    await expect(updateAgentLoadout(env, "tenant-a", "agent-a", "loadout-a", {
      name: "Default",
      bindings: [{
        skill_asset_id: "restricted",
        usage_mode: "always",
        priority: 100,
        version_policy: "latest_published",
        pinned_version_id: null
      }]
    }, { actorPrincipal: "user:runner", isAdmin: false })).resolves.toMatchObject({
      bindings: [expect.objectContaining({ skill_asset_id: "restricted" })]
    });

    database.prepare("UPDATE resource_access_policies SET scope = 'private', owner_principal = 'user:other' WHERE resource_type = 'agent_loadout' AND resource_id = ?")
      .run("loadout-a");
    await expect(updateAgentLoadout(env, "tenant-a", "agent-a", "loadout-a", {
      name: "Default",
      bindings: []
    }, { actorPrincipal: "user:runner", isAdmin: false })).rejects.toMatchObject({ status: 404 });
    await expect(resolveAgentLoadoutContext(env, {
      tenantId: "tenant-a",
      agentKey: "reviewer",
      principal: "user:runner",
      taskText: "Review",
      maxTokens: 1000
    })).rejects.toMatchObject({ status: 404 });
  });

  it("never resolves or mutates an archived Loadout", async () => {
    addSkill(database, objects, { id: "published", mode: "always", priority: 100 });
    database.prepare("UPDATE agent_loadouts SET status = 'archived' WHERE id = ?").run("loadout-a");

    await expect(resolveAgentLoadoutContext(env, {
      tenantId: "tenant-a",
      agentKey: "reviewer",
      principal: "user:runner",
      taskText: "Review",
      maxTokens: 1000
    })).resolves.toMatchObject({
      injected_skills: [],
      on_demand_skills: [],
      omitted: [{ reason: "loadout_not_active" }]
    });
    await expect(updateAgentLoadout(env, "tenant-a", "agent-a", "loadout-a", {
      name: "Default",
      bindings: []
    }, { actorPrincipal: "user:runner", isAdmin: false })).rejects.toMatchObject({
      status: 409,
      code: "loadout_archived"
    });
  });
});
