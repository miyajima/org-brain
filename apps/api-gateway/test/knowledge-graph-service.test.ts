import { dashboardKnowledgeGraphResponseSchema } from "@org-brain/contracts";
import { describe, expect, it } from "vitest";
import { getKnowledgeGraph } from "../src/knowledge-graph-service";
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

class D1StatementAdapter {
  private args: unknown[] = [];

  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}

  bind(...args: unknown[]) {
    if (args.length > 100) {
      throw new Error(`Graph query exceeded D1's 100-parameter limit: ${args.length}`);
    }
    this.args = args;
    return this;
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function testEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL,
      summary TEXT, kind TEXT, lifecycle_state TEXT, confidence_score REAL,
      permissions_json TEXT, updated_at INTEGER, created_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
    CREATE TABLE memory_edges(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, from_memory_id TEXT NOT NULL,
      to_memory_id TEXT NOT NULL, relation TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE decision_memories(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, domain TEXT,
      title TEXT, decision TEXT, status TEXT, confirmation_state TEXT, confidence REAL,
      visibility TEXT, allowed_principals_json TEXT, superseded_by TEXT,
      updated_at INTEGER, created_at INTEGER
    );
    CREATE TABLE knowledge_resources(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, resource_kind TEXT,
      title TEXT, source_system TEXT, lifecycle_state TEXT, visibility TEXT,
      permissions_json TEXT, updated_at INTEGER, created_at INTEGER
    );
    CREATE TABLE tasks(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, capability TEXT,
      status TEXT, priority INTEGER, updated_at INTEGER, created_at INTEGER
    );
    CREATE TABLE entities(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT, canonical_name TEXT
    );
    CREATE TABLE memory_entities(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, memory_id TEXT, entity_id TEXT,
      role TEXT, confidence_score REAL, created_at INTEGER
    );
    CREATE TABLE knowledge_assertions(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, subject_type TEXT, subject_ref TEXT,
      predicate TEXT, object_type TEXT, object_ref TEXT, resource_id TEXT,
      confidence REAL, confirmation_state TEXT, valid_until INTEGER, updated_at INTEGER
    );
    CREATE TABLE memory_usage_events(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, task_id TEXT
    );
    CREATE TABLE memory_usage_items(
      id TEXT PRIMARY KEY, usage_event_id TEXT, tenant_id TEXT NOT NULL,
      source_type TEXT, source_id TEXT, reference_type TEXT, used_state TEXT,
      score REAL, created_at INTEGER
    );
    CREATE TABLE group_members(tenant_id TEXT, group_id TEXT, principal TEXT);
    CREATE TABLE resource_acl(
      tenant_id TEXT, resource_type TEXT, resource_id TEXT, subject_type TEXT,
      subject_id TEXT, permission TEXT
    );
  `);
  return {
    database,
    env: { OPEN_BRAIN_DB: { prepare: (sql: string) => new D1StatementAdapter(database, sql) } } as unknown as Env
  };
}

function insertMemory(database: SqliteDatabase, id: string, args: {
  projectId?: string | null;
  permissions?: unknown[];
  updatedAt?: number;
} = {}) {
  database.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    "tenant-a",
    args.projectId === undefined ? "project-a" : args.projectId,
    `${id} content`,
    `${id} summary`,
    "semantic",
    "active",
    0.8,
    JSON.stringify(args.permissions ?? []),
    args.updatedAt ?? 100,
    10,
    null
  );
}

describe("knowledge graph dashboard service", () => {
  it("returns the dashboard/v1 DTO with only explicit, ACL-safe edges", async () => {
    const { database, env } = testEnv();
    const hiddenGrant = [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }];
    insertMemory(database, "memory-visible", { updatedAt: 500 });
    insertMemory(database, "memory-neighbor", { updatedAt: 450 });
    insertMemory(database, "memory-hidden", { permissions: hiddenGrant, updatedAt: 440 });
    insertMemory(database, "memory-granted", {
      permissions: [{ principal_type: "principal", principal_id: "user:reader", permissions: ["read"] }],
      updatedAt: 430
    });
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("edge-visible", "tenant-a", "memory-visible", "memory-neighbor", "supports", 300);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("edge-hidden", "tenant-a", "memory-visible", "memory-hidden", "supports", 290);
    database.prepare("INSERT INTO entities VALUES(?,?,?,?)")
      .run("entity-api", "tenant-a", "service", "API Gateway");
    database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)")
      .run("link-entity", "tenant-a", "memory-visible", "entity-api", "mentions", 0.7, 280);
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "decision-visible", "tenant-a", "project-a", "engineering", "Choose D1", "Use D1",
      "active", "confirmed", 0.9, "tenant", "[]", null, 520, 20
    );
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "decision-group-granted", "tenant-a", "project-a", "engineering", "Private D1", "Use D1 privately",
      "active", "confirmed", 0.9, "restricted", "[]", null, 519, 20
    );
    database.prepare("INSERT INTO group_members VALUES(?,?,?)").run("tenant-a", "engineering", "user:reader");
    database.prepare("INSERT INTO resource_acl VALUES(?,?,?,?,?,?)")
      .run("tenant-a", "decision_memory", "decision-group-granted", "group", "engineering", "read");
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "resource-visible", "tenant-a", "project-a", "document", "Architecture note", "drive",
      "active", "tenant", "[]", 510, 20
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "resource-hidden", "tenant-a", "project-a", "document", "Private note", "drive",
      "active", "restricted", "[]", 505, 20
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "resource-granted", "tenant-a", "project-a", "document", "Reader note", "drive",
      "active", "restricted", "[\"user:reader\"]", 504, 20
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "assertion-confirmed", "tenant-a", "project-a", "decision_memory", "decision-visible", "supported_by",
      "knowledge_resource", "resource-visible", "resource-visible", 0.95, "confirmed", null, 530
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "assertion-hidden", "tenant-a", "project-a", "decision_memory", "decision-visible", "supported_by",
      "knowledge_resource", "resource-hidden", "resource-hidden", 0.9, "confirmed", null, 529
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "assertion-proposal", "tenant-a", "project-a", "decision_memory", "decision-visible", "contradicts",
      "memory", "memory-neighbor", null, 0.4, "proposal", null, 528
    );
    database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(
      "task-one", "tenant-a", "project-a", "implementation", "running", 1, 540, 30
    );
    database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)")
      .run("usage-one", "tenant-a", "project-a", "task-one");
    database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)").run(
      "usage-item-one", "usage-one", "tenant-a", "memory", "memory-visible", "injected", "used", 0.8, 550
    );

    const first = await getKnowledgeGraph(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      node_limit: 30,
      edge_limit: 60,
      now: 1_000
    });
    const second = await getKnowledgeGraph(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      node_limit: 30,
      edge_limit: 60,
      now: 1_000
    });

    expect(dashboardKnowledgeGraphResponseSchema.parse(first)).toEqual(first);
    expect(first.generated_at).toBe(1_000);
    expect(second).toEqual(first);
    expect(first.contract_version).toBe("dashboard/v1");
    expect(first.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "project:project-a",
      "memory:memory-visible",
      "memory:memory-neighbor",
      "memory:memory-granted",
      "decision:decision-visible",
      "decision:decision-group-granted",
      "resource:resource-visible",
      "resource:resource-granted",
      "entity:entity-api",
      "task:task-one"
    ]));
    expect(first.nodes.some((node) => node.id.includes("hidden"))).toBe(false);
    expect(first.edges.map((edge) => edge.id)).toEqual(expect.arrayContaining([
      "memory_edge:edge-visible",
      "memory_entity:link-entity",
      "knowledge_assertion:assertion-confirmed",
      "memory_usage:usage-item-one"
    ]));
    expect(first.edges.some((edge) => edge.id === "memory_edge:edge-hidden")).toBe(false);
    expect(first.edges.some((edge) => edge.id === "knowledge_assertion:assertion-hidden")).toBe(false);
    expect(first.edges.some((edge) => edge.id === "knowledge_assertion:assertion-proposal")).toBe(false);
    const ids = new Set(first.nodes.map((node) => node.id));
    expect(first.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.inferred === false)).toBe(true);
    expect(first.nodes.find((node) => node.id === "memory:memory-visible")).toMatchObject({
      usage_count_30d: 1,
      last_used_at: 550
    });
  });

  it("honors focus depth, lexical filtering, and strict contract bounds", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "focus", { updatedAt: 200 });
    insertMemory(database, "neighbor", { updatedAt: 190 });
    insertMemory(database, "outer", { updatedAt: 180 });
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("focus-edge", "tenant-a", "focus", "neighbor", "supports", 100);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("outer-edge", "tenant-a", "neighbor", "outer", "supports", 90);

    const focused = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "focus",
      depth: 1,
      q: "neighbor",
      node_limit: 10,
      edge_limit: 10,
      now: 1_000
    });
    expect(focused.nodes.map((node) => node.id)).toEqual(["memory:focus", "memory:neighbor"]);
    expect(focused.edges).toHaveLength(1);

    const twoHop = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "focus",
      depth: 2,
      node_limit: 10,
      edge_limit: 10,
      now: 1_000
    });
    expect(twoHop.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "memory:focus",
      "memory:neighbor",
      "memory:outer"
    ]));

    const bounded = await getKnowledgeGraph(env, "tenant-a", { node_limit: 1, edge_limit: 1, now: 1_000 });
    expect(bounded.nodes).toHaveLength(1);
    expect(bounded.edges.length).toBeLessThanOrEqual(1);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omitted_node_count).toBeGreaterThan(0);

    for (let index = 0; index < 8; index += 1) {
      insertMemory(database, `recent-noise-${index}`, { updatedAt: 1_000 + index });
    }
    insertMemory(database, "legacy-needle", { updatedAt: 1 });
    const lexical = await getKnowledgeGraph(env, "tenant-a", {
      q: "legacy-needle",
      node_limit: 1,
      edge_limit: 1,
      now: 2_000
    });
    expect(lexical.nodes.map((node) => node.id)).toEqual(["memory:legacy-needle"]);

    await expect(getKnowledgeGraph(env, "tenant-a", { node_limit: 151 })).rejects.toMatchObject({ status: 400 });
    await expect(getKnowledgeGraph(env, "tenant-a", { focus_type: "memory" })).rejects.toMatchObject({ status: 400 });
    await expect(getKnowledgeGraph(env, "tenant-a", {
      focus_type: "resource",
      focus_id: "missing"
    })).rejects.toMatchObject({ status: 404 });
  });

  it("supports a project focus without expanding the graph count query into an invalid compound select", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "project-focus-memory", { projectId: "project-a", updatedAt: 200 });
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "project-focus-decision", "tenant-a", "project-a", "engineering", "Project decision", "Keep the scope visible",
      "active", "confirmed", 0.9, "tenant", "[]", null, 180, 10
    );

    const result = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "project",
      focus_id: "project-a",
      project_id: "project-a",
      q: "project-a",
      depth: 2,
      node_limit: 20,
      edge_limit: 20,
      now: 1_000
    });

    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "project:project-a",
      "memory:project-focus-memory",
      "decision:project-focus-decision"
    ]));
  });

  it("scans past newer unreadable candidates without leaking them into truncation", async () => {
    const { database, env } = testEnv();
    const hiddenGrant = [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }];
    const hiddenCount = 920;
    for (let index = 0; index < hiddenCount; index += 1) {
      insertMemory(database, `hidden-needle-${String(index).padStart(3, "0")}`, {
        permissions: hiddenGrant,
        updatedAt: 1_000 + index
      });
    }
    insertMemory(database, "legacy-needle-a", { updatedAt: 2 });
    insertMemory(database, "legacy-needle-b", { updatedAt: 1 });
    database.prepare("INSERT INTO entities VALUES(?,?,?,?)")
      .run("entity-legacy", "tenant-a", "system", "Legacy service");
    const insertLink = database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < hiddenCount; index += 1) {
      const memoryId = `hidden-needle-${String(index).padStart(3, "0")}`;
      insertLink.run(`hidden-link-${index}`, "tenant-a", memoryId, "entity-legacy", "mentions", 0.8, 2_000 + index);
    }
    insertLink.run("legacy-link-a", "tenant-a", "legacy-needle-a", "entity-legacy", "mentions", 0.8, 2);
    insertLink.run("legacy-link-b", "tenant-a", "legacy-needle-b", "entity-legacy", "mentions", 0.8, 1);

    const lexical = await getKnowledgeGraph(env, "tenant-a", {
      q: "needle",
      principal: "user:reader",
      node_limit: 2,
      edge_limit: 4,
      now: 3_000
    });
    expect(lexical.nodes.map((node) => node.id)).toEqual([
      "memory:legacy-needle-a",
      "memory:legacy-needle-b"
    ]);
    expect(lexical.truncated).toBe(false);
    expect(lexical.omitted_node_count).toBe(0);

    const focused = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "entity",
      focus_id: "entity-legacy",
      depth: 1,
      principal: "user:reader",
      node_limit: 3,
      edge_limit: 4,
      now: 3_000
    });
    expect(focused.nodes.map((node) => node.id)).toEqual([
      "entity:entity-legacy",
      "memory:legacy-needle-a",
      "memory:legacy-needle-b"
    ]);
    expect(focused.truncated).toBe(false);
    expect(focused.omitted_node_count).toBe(0);
  });

  it("filters dense hidden assertion and usage relations before edge bounds", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "edge-memory", { projectId: null, updatedAt: 400 });
    insertMemory(database, "edge-hidden", {
      projectId: null,
      permissions: [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }],
      updatedAt: 900
    });
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "edge-decision", "tenant-a", null, "engineering", "Edge decision", "Keep explicit relations",
      "active", "confirmed", 0.9, "tenant", "[]", null, 390, 20
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "edge-resource", "tenant-a", null, "document", "Edge resource", "drive",
      "active", "tenant", "[]", 380, 20
    );
    database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(
      "edge-task", "tenant-a", null, "relation-test", "running", 1, 370, 20
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "eligible-assertion", "tenant-a", null, "decision_memory", "edge-decision", "supported_by",
      "knowledge_resource", "edge-resource", "edge-resource", 0.9, "confirmed", null, 10
    );
    database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)").run(
      "edge-usage-event", "tenant-a", null, "edge-task"
    );
    database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)").run(
      "eligible-usage", "edge-usage-event", "tenant-a", "memory", "edge-memory",
      "injected", "used", 0.8, 10
    );
    const insertAssertion = database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertUsage = database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 20; index += 1) {
      insertAssertion.run(
        `hidden-assertion-${index}`, "tenant-a", null, "memory", "edge-hidden", "supported_by",
        "knowledge_resource", "edge-resource", "edge-resource", 0.9, "confirmed", null, 1_000 + index
      );
      insertUsage.run(
        `hidden-usage-${index}`, "edge-usage-event", "tenant-a", "memory", "edge-hidden",
        "injected", "used", 0.8, 1_000 + index
      );
    }

    const result = await getKnowledgeGraph(env, "tenant-a", {
      principal: "user:reader",
      node_limit: 4,
      edge_limit: 2,
      now: 2_000
    });

    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "memory:edge-memory",
      "decision:edge-decision",
      "resource:edge-resource",
      "task:edge-task"
    ]));
    expect(result.nodes.some((node) => node.id === "memory:edge-hidden")).toBe(false);
    expect(result.edges.map((edge) => edge.id)).toEqual([
      "knowledge_assertion:eligible-assertion",
      "memory_usage:eligible-usage"
    ]);
    expect(result.truncated).toBe(false);
    expect(result.omitted_node_count).toBe(0);
  });

  it("prioritizes focused-memory entity links under dense relations and signals truncation", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "focus-memory", { projectId: null, updatedAt: 100 });
    insertMemory(database, "noisy-memory", { projectId: null, updatedAt: 200 });
    database.prepare("INSERT INTO entities VALUES(?,?,?,?)")
      .run("focus-entity", "tenant-a", "service", "Focused entity");
    database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)")
      .run("focus-link", "tenant-a", "focus-memory", "focus-entity", "mentions", 0.9, 1);
    const insertEntity = database.prepare("INSERT INTO entities VALUES(?,?,?,?)");
    const insertLink = database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < 12; index += 1) {
      const entityId = `noisy-entity-${index}`;
      insertEntity.run(entityId, "tenant-a", "service", `Noisy entity ${index}`);
      insertLink.run(
        `noisy-link-${index}`,
        "tenant-a",
        "noisy-memory",
        entityId,
        "mentions",
        0.7,
        1_000 + index
      );
    }

    const result = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "focus-memory",
      depth: 1,
      node_limit: 2,
      edge_limit: 2,
      now: 2_000
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      "memory:focus-memory",
      "entity:focus-entity"
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["memory_entity:focus-link"]);
    expect(result.truncated).toBe(true);
    expect(result.omitted_node_count).toBe(0);
  });

  it("finds entities by name when linked memory text does not match and counts hydrated memories exactly", async () => {
    const { database, env } = testEnv();
    database.prepare("INSERT INTO entities VALUES(?,?,?,?)")
      .run("entity-direct-match", "tenant-a", "service", "Entity-only Needle");
    const insertLink = database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < 5; index += 1) {
      const memoryId = `unrelated-context-${index}`;
      insertMemory(database, memoryId, { projectId: "project-a", updatedAt: 100 + index });
      insertLink.run(
        `entity-direct-link-${index}`,
        "tenant-a",
        memoryId,
        "entity-direct-match",
        "mentions",
        0.9,
        100 + index
      );
    }
    insertMemory(database, "unrelated-hidden-context", {
      projectId: "project-a",
      permissions: [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }],
      updatedAt: 200
    });
    insertLink.run(
      "entity-direct-hidden-link",
      "tenant-a",
      "unrelated-hidden-context",
      "entity-direct-match",
      "mentions",
      0.9,
      200
    );
    insertMemory(database, "unrelated-other-project", { projectId: "project-b", updatedAt: 300 });
    insertLink.run(
      "entity-direct-other-project-link",
      "tenant-a",
      "unrelated-other-project",
      "entity-direct-match",
      "mentions",
      0.9,
      300
    );

    const result = await getKnowledgeGraph(env, "tenant-a", {
      project_id: "project-a",
      q: "Entity-only Needle",
      principal: "user:reader",
      node_limit: 2,
      edge_limit: 4,
      now: 1_000
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      "entity:entity-direct-match",
      "memory:unrelated-context-4"
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["memory_entity:entity-direct-link-4"]);
    expect(result.omitted_node_count).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("hydrates an entity focus through linked memories to explicit ACL-safe hop-two neighbors", async () => {
    const { database, env } = testEnv();
    for (let index = 0; index < 20; index += 1) {
      insertMemory(database, `entity-hop-noise-${index}`, { projectId: null, updatedAt: 1_000 + index });
    }
    insertMemory(database, "entity-hop-linked-old", { projectId: null, updatedAt: 3 });
    insertMemory(database, "entity-hop-neighbor-old", { projectId: null, updatedAt: 2 });
    insertMemory(database, "entity-hop-hidden-old", {
      projectId: null,
      permissions: [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }],
      updatedAt: 1
    });
    insertMemory(database, "entity-hop-other-project", { projectId: "project-b", updatedAt: 1 });
    database.prepare("INSERT INTO entities VALUES(?,?,?,?)")
      .run("entity-hop-focus", "tenant-a", "service", "Entity hop focus");
    database.prepare("INSERT INTO memory_entities VALUES(?,?,?,?,?,?,?)")
      .run("entity-hop-focus-link", "tenant-a", "entity-hop-linked-old", "entity-hop-focus", "mentions", 0.9, 30);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("entity-hop-readable-edge", "tenant-a", "entity-hop-linked-old", "entity-hop-neighbor-old", "supports", 20);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("entity-hop-hidden-edge", "tenant-a", "entity-hop-linked-old", "entity-hop-hidden-old", "supports", 40);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("entity-hop-other-project-edge", "tenant-a", "entity-hop-linked-old", "entity-hop-other-project", "supports", 50);

    const result = await getKnowledgeGraph(env, "tenant-a", {
      project_id: "project-a",
      q: "entity-hop",
      focus_type: "entity",
      focus_id: "entity-hop-focus",
      depth: 2,
      principal: "user:reader",
      node_limit: 3,
      edge_limit: 4,
      now: 2_000
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      "entity:entity-hop-focus",
      "memory:entity-hop-linked-old",
      "memory:entity-hop-neighbor-old"
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual([
      "memory_entity:entity-hop-focus-link",
      "memory_edge:entity-hop-readable-edge"
    ]);
    expect(result.omitted_node_count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("hydrates ACL-readable older memory neighbors for one-hop and two-hop focus", async () => {
    const { database, env } = testEnv();
    for (let index = 0; index < 20; index += 1) {
      insertMemory(database, `focus-noise-${index}`, { projectId: null, updatedAt: 1_000 + index });
    }
    insertMemory(database, "focus-old", { projectId: null, updatedAt: 3 });
    insertMemory(database, "neighbor-old", { projectId: null, updatedAt: 2 });
    insertMemory(database, "outer-old", { projectId: null, updatedAt: 1 });
    insertMemory(database, "hidden-old", {
      projectId: null,
      permissions: [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }],
      updatedAt: 1
    });
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("old-focus-edge", "tenant-a", "focus-old", "neighbor-old", "supports", 30);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("old-outer-edge", "tenant-a", "neighbor-old", "outer-old", "supports", 20);
    database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
      .run("old-hidden-edge", "tenant-a", "focus-old", "hidden-old", "supports", 40);
    const insertDenseEdge = database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < 20; index += 1) {
      insertDenseEdge.run(
        `new-unrelated-edge-${index}`,
        "tenant-a",
        `focus-noise-${11 + (index % 9)}`,
        `focus-noise-${11 + ((index + 1) % 9)}`,
        "supports",
        1_000 + index
      );
    }

    const oneHop = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "focus-old",
      depth: 1,
      principal: "user:reader",
      node_limit: 3,
      edge_limit: 4,
      now: 2_000
    });
    expect(oneHop.nodes.map((node) => node.id)).toEqual([
      "memory:focus-old",
      "memory:neighbor-old"
    ]);
    expect(oneHop.edges.map((edge) => edge.id)).toEqual(["memory_edge:old-focus-edge"]);
    expect(oneHop.truncated).toBe(true);
    expect(oneHop.omitted_node_count).toBe(0);

    const twoHop = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "focus-old",
      depth: 2,
      principal: "user:reader",
      node_limit: 3,
      edge_limit: 4,
      now: 2_000
    });
    expect(twoHop.nodes.map((node) => node.id)).toEqual([
      "memory:focus-old",
      "memory:neighbor-old",
      "memory:outer-old"
    ]);
    expect(twoHop.edges.map((edge) => edge.id)).toEqual([
      "memory_edge:old-focus-edge",
      "memory_edge:old-outer-edge"
    ]);
    expect(twoHop.nodes.some((node) => node.id === "memory:hidden-old")).toBe(false);
    expect(twoHop.truncated).toBe(true);
    expect(twoHop.omitted_node_count).toBe(0);
  });

  it("hydrates older assertion and usage neighbors for decision, resource, and task focus", async () => {
    const { database, env } = testEnv();
    for (let index = 0; index < 12; index += 1) {
      insertMemory(database, `typed-memory-noise-${index}`, { projectId: null, updatedAt: 1_000 + index });
      database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        `typed-decision-noise-${index}`, "tenant-a", null, "engineering", `Noise decision ${index}`, "Noise",
        "active", "confirmed", 0.8, "tenant", "[]", null, 1_000 + index, 20
      );
      database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        `typed-resource-noise-${index}`, "tenant-a", null, "document", `Noise resource ${index}`, "drive",
        "active", "tenant", "[]", 1_000 + index, 20
      );
      database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(
        `typed-task-noise-${index}`, "tenant-a", null, `noise-task-${index}`, "complete", 1, 1_000 + index, 20
      );
    }
    insertMemory(database, "typed-memory-old", { projectId: null, updatedAt: 1 });
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "typed-decision-old", "tenant-a", null, "engineering", "Old decision", "Keep old relation",
      "active", "confirmed", 0.9, "tenant", "[]", null, 3, 1
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "typed-resource-old", "tenant-a", null, "document", "Old resource", "drive",
      "active", "tenant", "[]", 2, 1
    );
    database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(
      "typed-task-old", "tenant-a", null, "old-task", "running", 1, 1, 1
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "typed-decision-resource", "tenant-a", null, "decision_memory", "typed-decision-old", "supported_by",
      "knowledge_resource", "typed-resource-old", "typed-resource-old", 0.9, "confirmed", null, 30
    );
    database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "typed-resource-memory", "tenant-a", null, "knowledge_resource", "typed-resource-old", "documents",
      "memory", "typed-memory-old", null, 0.9, "confirmed", null, 20
    );
    database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)")
      .run("typed-usage-event", "tenant-a", null, "typed-task-old");
    database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)").run(
      "typed-task-memory", "typed-usage-event", "tenant-a", "memory", "typed-memory-old",
      "injected", "used", 0.8, 10
    );
    const insertDenseAssertion = database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertDenseUsageEvent = database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)");
    const insertDenseUsageItem = database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 20; index += 1) {
      const noiseIndex = 3 + (index % 9);
      insertDenseAssertion.run(
        `typed-new-assertion-${index}`,
        "tenant-a",
        null,
        "decision_memory",
        `typed-decision-noise-${noiseIndex}`,
        "supported_by",
        "knowledge_resource",
        `typed-resource-noise-${noiseIndex}`,
        `typed-resource-noise-${noiseIndex}`,
        0.8,
        "confirmed",
        null,
        1_000 + index
      );
      insertDenseUsageEvent.run(
        `typed-new-usage-event-${index}`,
        "tenant-a",
        null,
        `typed-task-noise-${noiseIndex}`
      );
      insertDenseUsageItem.run(
        `typed-new-usage-${index}`,
        `typed-new-usage-event-${index}`,
        "tenant-a",
        "memory",
        `typed-memory-noise-${noiseIndex}`,
        "injected",
        "used",
        0.8,
        1_000 + index
      );
    }

    const decisionFocus = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "decision",
      focus_id: "typed-decision-old",
      depth: 2,
      node_limit: 3,
      edge_limit: 4,
      now: 2_000
    });
    expect(decisionFocus.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "decision:typed-decision-old",
      "resource:typed-resource-old",
      "memory:typed-memory-old"
    ]));
    expect(decisionFocus.edges.map((edge) => edge.id)).toEqual(expect.arrayContaining([
      "knowledge_assertion:typed-decision-resource",
      "knowledge_assertion:typed-resource-memory"
    ]));

    const resourceFocus = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "resource",
      focus_id: "typed-resource-old",
      depth: 1,
      node_limit: 3,
      edge_limit: 4,
      now: 2_000
    });
    expect(resourceFocus.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "resource:typed-resource-old",
      "decision:typed-decision-old",
      "memory:typed-memory-old"
    ]));

    const taskFocus = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "task",
      focus_id: "typed-task-old",
      depth: 1,
      node_limit: 2,
      edge_limit: 2,
      now: 2_000
    });
    expect(taskFocus.nodes.map((node) => node.id)).toEqual([
      "task:typed-task-old",
      "memory:typed-memory-old"
    ]);
    expect(taskFocus.edges.map((edge) => edge.id)).toEqual(["memory_usage:typed-task-memory"]);
  });

  it("computes usage stats only from current candidate source IDs", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "z-usage-target", { projectId: null, updatedAt: 1 });
    database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)")
      .run("usage-stats-event", "tenant-a", null, null);
    const insertUsage = database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 920; index += 1) {
      insertUsage.run(
        `usage-stats-noise-${index}`,
        "usage-stats-event",
        "tenant-a",
        "memory",
        `a-unrelated-source-${String(index).padStart(3, "0")}`,
        "retrieved",
        "unused",
        0.1,
        1_000 + index
      );
    }
    insertUsage.run(
      "usage-stats-target",
      "usage-stats-event",
      "tenant-a",
      "memory",
      "z-usage-target",
      "injected",
      "used",
      0.9,
      10
    );

    const result = await getKnowledgeGraph(env, "tenant-a", {
      q: "z-usage-target",
      node_limit: 1,
      edge_limit: 1,
      now: 2_000
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: "memory:z-usage-target",
      usage_count_30d: 1,
      last_used_at: 10
    });
  });

  it("scopes usage statistics to the requested usage-event project", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "project-usage-shared", { projectId: null, updatedAt: 1 });
    const insertEvent = database.prepare("INSERT INTO memory_usage_events VALUES(?,?,?,?)");
    insertEvent.run("project-usage-a", "tenant-a", "project-a", null);
    insertEvent.run("project-usage-b", "tenant-a", "project-b", null);
    insertEvent.run("project-usage-global", "tenant-a", null, null);
    const insertUsage = database.prepare("INSERT INTO memory_usage_items VALUES(?,?,?,?,?,?,?,?,?)");
    insertUsage.run(
      "project-usage-item-a", "project-usage-a", "tenant-a", "memory", "project-usage-shared",
      "injected", "used", 0.9, 10
    );
    insertUsage.run(
      "project-usage-item-b", "project-usage-b", "tenant-a", "memory", "project-usage-shared",
      "injected", "used", 0.9, 30
    );
    insertUsage.run(
      "project-usage-item-global", "project-usage-global", "tenant-a", "memory", "project-usage-shared",
      "injected", "used", 0.9, 40
    );

    const result = await getKnowledgeGraph(env, "tenant-a", {
      project_id: "project-a",
      q: "project-usage-shared",
      node_limit: 1,
      edge_limit: 1,
      now: 100
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: "memory:project-usage-shared",
      usage_count_30d: 1,
      last_used_at: 10
    });
  });

  it("keeps Graph statements below D1's bind cap for dense ACL candidate pages", async () => {
    const { database, env } = testEnv();
    const insertDecision = database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertResource = database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const insertAcl = database.prepare("INSERT INTO resource_acl VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < 130; index += 1) {
      const decisionId = `bind-safe-decision-${String(index).padStart(3, "0")}`;
      const resourceId = `bind-safe-resource-${String(index).padStart(3, "0")}`;
      insertDecision.run(
        decisionId, "tenant-a", null, "engineering", `Bind safe decision ${index}`, "Bind safe",
        "active", "confirmed", 0.9, "restricted", "[]", null, 1_000 + index, 1
      );
      insertResource.run(
        resourceId, "tenant-a", null, "document", `Bind safe resource ${index}`, "drive",
        "active", "restricted", "[]", 1_000 + index, 1
      );
      insertAcl.run("tenant-a", "decision_memory", decisionId, "principal", "user:reader", "read");
      insertAcl.run("tenant-a", "knowledge_resource", resourceId, "principal", "user:reader", "read");
    }

    const result = await getKnowledgeGraph(env, "tenant-a", {
      q: "Bind safe",
      principal: "user:reader",
      node_limit: 150,
      edge_limit: 1,
      now: 2_000
    });

    expect(result.nodes).toHaveLength(150);
    expect(result.omitted_node_count).toBe(110);
    expect(result.truncated).toBe(true);
  });

  it("passes more than 100 hydrated focus relation IDs through JSON binds", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "bind-focus", { projectId: null, updatedAt: 1_000 });
    const insertEdge = database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < 120; index += 1) {
      const neighborId = `bind-neighbor-${String(index).padStart(3, "0")}`;
      insertMemory(database, neighborId, { projectId: null, updatedAt: 900 - index });
      insertEdge.run(
        `bind-edge-${String(index).padStart(3, "0")}`,
        "tenant-a",
        "bind-focus",
        neighborId,
        "supports",
        800 - index
      );
    }

    const result = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "memory",
      focus_id: "bind-focus",
      depth: 1,
      node_limit: 150,
      edge_limit: 300,
      now: 2_000
    });

    expect(result.nodes).toHaveLength(121);
    expect(result.edges).toHaveLength(120);
    expect(result.omitted_node_count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("reports the exact ACL-visible omitted node count beyond the candidate window", async () => {
    const { database, env } = testEnv();
    const hiddenGrant = [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }];
    for (let index = 0; index < 40; index += 1) {
      insertMemory(database, `count-visible-${String(index).padStart(2, "0")}`, {
        projectId: null,
        updatedAt: 100 + index
      });
    }
    for (let index = 0; index < 30; index += 1) {
      insertMemory(database, `count-hidden-${String(index).padStart(2, "0")}`, {
        projectId: null,
        permissions: hiddenGrant,
        updatedAt: 1_000 + index
      });
    }

    const result = await getKnowledgeGraph(env, "tenant-a", {
      q: "count",
      principal: "user:reader",
      node_limit: 3,
      edge_limit: 2,
      now: 2_000
    });

    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every((node) => node.id.startsWith("memory:count-visible-"))).toBe(true);
    expect(result.omitted_node_count).toBe(37);
    expect(result.truncated).toBe(true);
  });

  it("rejects confirmed assertions with unreadable or missing attached evidence resources", async () => {
    const { database, env } = testEnv();
    insertMemory(database, "assertion-readable-target", { projectId: null, updatedAt: 10 });
    insertMemory(database, "assertion-hidden-evidence-target", { projectId: null, updatedAt: 9 });
    insertMemory(database, "assertion-missing-evidence-target", { projectId: null, updatedAt: 8 });
    database.prepare("INSERT INTO decision_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "assertion-focus", "tenant-a", null, "security", "Evidence ACL", "Respect evidence visibility",
      "active", "confirmed", 0.9, "tenant", "[]", null, 11, 1
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "evidence-readable", "tenant-a", null, "document", "Readable evidence", "drive",
      "active", "tenant", "[]", 12, 1
    );
    database.prepare("INSERT INTO knowledge_resources VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "evidence-hidden", "tenant-a", null, "document", "Hidden evidence", "drive",
      "active", "restricted", "[]", 13, 1
    );
    const insertAssertion = database.prepare("INSERT INTO knowledge_assertions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insertAssertion.run(
      "assertion-readable-evidence", "tenant-a", null, "decision_memory", "assertion-focus", "supports",
      "memory", "assertion-readable-target", "evidence-readable", 0.9, "confirmed", null, 20
    );
    insertAssertion.run(
      "assertion-hidden-evidence", "tenant-a", null, "decision_memory", "assertion-focus", "supports",
      "memory", "assertion-hidden-evidence-target", "evidence-hidden", 0.9, "confirmed", null, 30
    );
    insertAssertion.run(
      "assertion-missing-evidence", "tenant-a", null, "decision_memory", "assertion-focus", "supports",
      "memory", "assertion-missing-evidence-target", "evidence-missing", 0.9, "confirmed", null, 40
    );

    const result = await getKnowledgeGraph(env, "tenant-a", {
      focus_type: "decision",
      focus_id: "assertion-focus",
      depth: 1,
      principal: "user:reader",
      node_limit: 10,
      edge_limit: 10,
      now: 100
    });

    expect(result.nodes.map((node) => node.id)).toEqual([
      "decision:assertion-focus",
      "memory:assertion-readable-target"
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual([
      "knowledge_assertion:assertion-readable-evidence"
    ]);
    expect(result.omitted_node_count).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
