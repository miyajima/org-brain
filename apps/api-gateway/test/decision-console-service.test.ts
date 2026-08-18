import { beforeEach, describe, expect, it } from "vitest";
import { getDecisionBriefing, getDecisionMap, getDecisionTrace } from "../src/decision-console-service";
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
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { readFileSync, readdirSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: URL, encoding: "utf8") => string;
  readdirSync: (path: URL) => string[];
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

function applyMigrations(database: SqliteDatabase) {
  const directory = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
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
  return { database, env: { OPEN_BRAIN_DB: db, ACCESS_POLICY_SHADOW_MODE: "off" } as unknown as Env };
}

const TENANT = "tenant-decision-console";
const PROJECT = "project-decision-console";
const PRINCIPAL = "user:reader";
const NOW = 1_800_000_000_000;

function insertDecision(database: SqliteDatabase, id: string, options: {
  owner?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  confirmationState?: string;
  validUntil?: number | null;
} = {}) {
  const owner = options.owner ?? PRINCIPAL;
  const createdAt = options.createdAt ?? NOW - 1_000;
  const updatedAt = options.updatedAt ?? NOW;
  database.prepare(`
    INSERT INTO decision_memories(
      id, tenant_id, project_id, domain, title, decision, rationale,
      rejected_alternatives_json, constraints_json, known_pitfalls_json,
      source_refs_json, owner_refs_json, reviewer_refs_json, valid_from, valid_until,
      status, superseded_by, confidence, visibility, allowed_principals_json,
      confirmation_state, confirmation_note, confirmed_at, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,'[]','[]','[]','[]',?,'[]',?,?,?,NULL,?,'tenant','[]',?,NULL,?,?,?)
  `).run(
    id, TENANT, PROJECT, "product", options.title ?? `Decision ${id}`,
    `Adopt ${id}`, `Reason for ${id}`, JSON.stringify([{ type: "principal", id: owner }]),
    NOW - 10_000, options.validUntil ?? null, "active", 0.9,
    options.confirmationState ?? "user_confirmed", NOW - 500, createdAt, updatedAt
  );
  database.prepare(`
    INSERT INTO decision_memory_versions(
      id, decision_memory_id, tenant_id, operation, snapshot_json,
      actor_refs_json, reviewer_refs_json, note, created_at
    ) VALUES(?,?,?,'create',?,'[]','[]',NULL,?)
  `).run(`version:${id}`, id, TENANT, JSON.stringify({ id, decision: `Adopt ${id}` }), createdAt);
  insertPolicy(database, "decision_memory", id, options.owner === "user:other" ? "private" : "tenant", owner);
}

function insertPolicy(
  database: SqliteDatabase,
  resourceType: string,
  resourceId: string,
  scope: "private" | "project" | "group" | "tenant" | "restricted" = "tenant",
  owner = PRINCIPAL
) {
  database.prepare(`
    INSERT OR IGNORE INTO resource_access_policies(
      id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
      group_ids_json, restricted_subjects_json, storage_location, policy_version,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,'[]','[]',?,1,?,?,?)
  `).run(
    `policy:${resourceType}:${resourceId}`, TENANT, resourceType, resourceId, scope, owner, PROJECT,
    resourceType === "knowledge_resource" || resourceType === "skill_asset" ? "d1_r2" : "d1",
    owner, NOW, NOW
  );
}

const SOURCE_ROLES = ["conclusion_source", "rationale_source", "contradiction", "input"] as const;
const ARTIFACT_ROLES = ["implementation_artifact", "output_artifact", "verification_artifact"] as const;
type ResourceRole = typeof SOURCE_ROLES[number] | typeof ARTIFACT_ROLES[number];

function insertResourceLink(database: SqliteDatabase, values: {
  decisionId: string;
  resourceId: string;
  title?: string;
  role: ResourceRole;
  confirmation?: "confirmed" | "proposal";
  scope?: "private" | "tenant";
  owner?: string;
}) {
  database.prepare(`
    INSERT OR IGNORE INTO knowledge_resources(
      id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system,
      media_type, visibility, permissions_json, current_version_id, lifecycle_state,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,'document',?,?,?,'text/markdown','tenant','[]',NULL,'active',?,?,?)
  `).run(
    values.resourceId, TENANT, PROJECT, `https://example.test/${values.resourceId}`,
    values.title ?? `Resource ${values.resourceId}`, "fixture", PRINCIPAL, NOW, NOW
  );
  insertPolicy(database, "knowledge_resource", values.resourceId, values.scope ?? "tenant", values.owner ?? PRINCIPAL);
  const assertionId = `assertion:${values.decisionId}:${values.resourceId}:${values.role}`;
  database.prepare(`
    INSERT INTO knowledge_assertions(
      id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
      object_type, object_ref, resource_id, context_json, confidence, confirmation_state,
      idempotency_key, valid_from, valid_until, actor_principal, reviewed_by_principal,
      created_at, updated_at
    ) VALUES(?,?,?,'relation','decision_memory',?,?, 'knowledge_resource',?,?,'{}',0.9,?,?,?,NULL,?,?,?,?)
  `).run(
    assertionId, TENANT, PROJECT, values.decisionId, values.role,
    values.resourceId, values.resourceId, values.confirmation ?? "confirmed",
    `idem:${assertionId}`, NOW - 1_000, PRINCIPAL,
    values.confirmation === "proposal" ? null : PRINCIPAL, NOW, NOW
  );
}

function insertSkill(database: SqliteDatabase, decisionId: string, id: string, scope: "private" | "tenant" = "tenant") {
  const versionId = `${id}:v1`;
  database.prepare(`
    INSERT INTO skill_assets(
      id, tenant_id, project_id, name, description, status, current_version_id,
      published_version_id, source_decision_id, owner_principal, valid_until,
      generation_task_id, created_at, updated_at, published_at, retired_at
    ) VALUES(?,?,?,?,?,'published',?,?,?,?,NULL,NULL,?,?,?,NULL)
  `).run(id, TENANT, PROJECT, `Skill ${id}`, `Description ${id}`, versionId, versionId, decisionId, PRINCIPAL, NOW, NOW, NOW);
  database.prepare(`
    INSERT INTO skill_asset_versions(
      id, tenant_id, skill_asset_id, version, schema_version, manifest_json,
      content_hash, validation_json, created_by_principal, created_at
    ) VALUES(?,?,?,1,1,'{}',?,'{}',?,?)
  `).run(versionId, TENANT, id, `hash:${id}`, PRINCIPAL, NOW);
  insertPolicy(database, "skill_asset", id, scope, scope === "private" ? "user:other" : PRINCIPAL);
  return versionId;
}

function insertAgent(database: SqliteDatabase, id: string, skillIds: string[], options: {
  loadoutCount?: number;
  loadoutScope?: "private" | "tenant";
} = {}) {
  const loadoutCount = options.loadoutCount ?? 1;
  database.prepare(`
    INSERT INTO agents(
      id, tenant_id, project_id, agent_key, name, role, status, current_loadout_id,
      source_decision_id, owner_principal, last_used_at, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,'active',?,?,?,NULL,?,?)
  `).run(id, TENANT, PROJECT, `key-${id}`, `Agent ${id}`, "Apply decisions", `${id}:loadout:0`, null, PRINCIPAL, NOW, NOW);
  insertPolicy(database, "agent", id);
  for (let loadoutIndex = 0; loadoutIndex < loadoutCount; loadoutIndex += 1) {
    const loadoutId = `${id}:loadout:${loadoutIndex}`;
    database.prepare(`
      INSERT INTO agent_loadouts(
        id, tenant_id, agent_id, name, description, status, owner_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,'active',?,?,?)
    `).run(loadoutId, TENANT, id, `Loadout ${loadoutIndex}`, "Fixture", PRINCIPAL, NOW, NOW);
    insertPolicy(
      database,
      "agent_loadout",
      loadoutId,
      options.loadoutScope ?? "tenant",
      options.loadoutScope === "private" ? "user:other" : PRINCIPAL
    );
    for (const [skillIndex, skillId] of skillIds.entries()) {
      database.prepare(`
        INSERT INTO agent_loadout_bindings(
          id, tenant_id, loadout_id, skill_asset_id, usage_mode, priority,
          version_policy, pinned_version_id, valid_until, created_by_principal,
          created_at, updated_at
        ) VALUES(?,?,?,?,'always',?,'latest_published',NULL,NULL,?,?,?)
      `).run(
        `binding:${loadoutId}:${skillId}`, TENANT, loadoutId, skillId,
        100 - (skillIndex % 100), PRINCIPAL, NOW, NOW
      );
    }
  }
}

function insertUsage(database: SqliteDatabase, index: number, skillId: string, versionId: string, agentId: string) {
  database.prepare(`
    INSERT INTO asset_usage_events(
      id, tenant_id, project_id, skill_asset_id, skill_asset_version_id,
      agent_id, agent_key, task_id, event_type, outcome, context_tokens,
      metadata_json, created_at
    ) VALUES(?,?,?,?,?,?,?,NULL,'outcome',?,12,'{}',?)
  `).run(
    `usage:${index}`, TENANT, PROJECT, skillId, versionId, agentId,
    `key-${agentId}`, `Outcome ${index}`, NOW - index
  );
}

describe("Decision Console read models", () => {
  let database: SqliteDatabase;
  let env: Env;

  beforeEach(() => {
    ({ database, env } = createEnv());
  });

  it("excludes unreadable nodes and edges, and adds proposals only after opt-in", async () => {
    insertDecision(database, "decision-main", { title: "Readable decision" });
    insertDecision(database, "decision-hidden", { title: "Hidden decision", owner: "user:other", updatedAt: NOW + 100 });
    insertResourceLink(database, {
      decisionId: "decision-main", resourceId: "evidence-visible", title: "Visible evidence", role: "rationale_source"
    });
    insertResourceLink(database, {
      decisionId: "decision-main", resourceId: "evidence-hidden", title: "Hidden evidence",
      role: "conclusion_source", scope: "private", owner: "user:other"
    });
    insertResourceLink(database, {
      decisionId: "decision-main", resourceId: "artifact-visible", title: "Visible artifact", role: "output_artifact"
    });
    insertResourceLink(database, {
      decisionId: "decision-main", resourceId: "proposal-visible", title: "Proposed evidence",
      role: "input", confirmation: "proposal"
    });
    const visibleVersion = insertSkill(database, "decision-main", "skill-visible");
    insertSkill(database, "decision-main", "skill-hidden", "private");
    insertAgent(database, "agent-visible", ["skill-visible"]);
    insertAgent(database, "agent-private-loadout", ["skill-visible"], { loadoutScope: "private" });
    insertUsage(database, 1, "skill-visible", visibleVersion, "agent-visible");
    insertUsage(database, 2, "skill-visible", visibleVersion, "agent-private-loadout");

    const explicit = await getDecisionTrace(env, {
      tenantId: TENANT, decisionId: "decision-main", principal: PRINCIPAL,
      projectId: PROJECT, includeInferred: false, nodeLimit: 150, edgeLimit: 300
    });
    const serialized = JSON.stringify(explicit);
    expect(serialized).toContain("Visible evidence");
    expect(serialized).toContain("Visible artifact");
    expect(serialized).toContain("skill-visible");
    expect(serialized).toContain("agent-visible");
    expect(serialized).not.toContain("Hidden evidence");
    expect(serialized).not.toContain("skill-hidden");
    expect(serialized).not.toContain("agent-private-loadout");
    expect(serialized).not.toContain("Proposed evidence");
    expect(explicit.edges.every((edge) =>
      explicit.nodes.some((node) => node.id === edge.source) && explicit.nodes.some((node) => node.id === edge.target)
    )).toBe(true);

    const inferred = await getDecisionMap(env, {
      tenantId: TENANT, decisionId: "decision-main", principal: PRINCIPAL,
      projectId: PROJECT, includeInferred: true, nodeLimit: 150, edgeLimit: 300
    });
    expect(inferred.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Proposed evidence", status: "proposal" })
    ]));
    expect(inferred.edges).toEqual(expect.arrayContaining([expect.objectContaining({ inferred: true })]));

    const briefing = await getDecisionBriefing(env, {
      tenantId: TENANT, principal: PRINCIPAL, projectId: PROJECT, limit: 10
    });
    expect(briefing.items).toHaveLength(1);
    expect(briefing.items[0]).toMatchObject({ title: "Readable decision", artifact_count: 1 });
    expect(JSON.stringify(briefing)).not.toContain("Hidden decision");
  });

  it("caps a dense trace at 150 nodes without dangling edges", async () => {
    insertDecision(database, "decision-nodes");
    for (let index = 0; index < 170; index += 1) {
      insertResourceLink(database, {
        decisionId: "decision-nodes",
        resourceId: `node-resource-${String(index).padStart(3, "0")}`,
        role: "rationale_source"
      });
    }
    const trace = await getDecisionTrace(env, {
      tenantId: TENANT, decisionId: "decision-nodes", principal: PRINCIPAL,
      projectId: PROJECT, nodeLimit: 150, edgeLimit: 300
    });
    expect(trace.nodes).toHaveLength(150);
    expect(trace.truncated).toBe(true);
    expect(trace.omitted_node_count).toBe(22);
    expect(trace.edges.every((edge) =>
      trace.nodes.some((node) => node.id === edge.source) && trace.nodes.some((node) => node.id === edge.target)
    )).toBe(true);
  });

  it("caps a dense many-to-many trace at 300 edges", async () => {
    insertDecision(database, "decision-edges");
    for (let resourceIndex = 0; resourceIndex < 20; resourceIndex += 1) {
      for (const role of [...SOURCE_ROLES, ...ARTIFACT_ROLES]) {
        insertResourceLink(database, {
          decisionId: "decision-edges",
          resourceId: `edge-resource-${resourceIndex}`,
          role
        });
      }
    }
    const skills = Array.from({ length: 20 }, (_, index) => `edge-skill-${index}`);
    const versions = new Map(skills.map((skill) => [skill, insertSkill(database, "decision-edges", skill)]));
    insertAgent(database, "edge-agent", skills, { loadoutCount: 8 });
    for (let index = 0; index < 100; index += 1) {
      const skill = skills[index % skills.length];
      insertUsage(database, 1000 + index, skill, versions.get(skill)!, "edge-agent");
    }
    const trace = await getDecisionTrace(env, {
      tenantId: TENANT, decisionId: "decision-edges", principal: PRINCIPAL,
      projectId: PROJECT, nodeLimit: 150, edgeLimit: 300
    });
    expect(trace.edges).toHaveLength(300);
    expect(trace.truncated).toBe(true);
    expect(trace.omitted_edge_count).toBeGreaterThan(0);
    expect(new Set(trace.edges.map((edge) => edge.id)).size).toBe(trace.edges.length);
  });
});
