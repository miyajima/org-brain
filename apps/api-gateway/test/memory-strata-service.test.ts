import {
  dashboardStrataDetailResponseSchema,
  dashboardStrataResponseSchema
} from "@org-brain/contracts";
import { describe, expect, it } from "vitest";
import {
  getMemoryStrata,
  getMemoryStrataDetail,
  mapMemoryStrataType
} from "../src/memory-strata-service";
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
    expect(args.length).toBeLessThanOrEqual(100);
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
      summary TEXT, tags_json TEXT, kind TEXT, lifecycle_state TEXT, confidence_score REAL,
      canonical_key TEXT, current_version INTEGER, source_refs_json TEXT, evidence_json TEXT,
      permissions_json TEXT, valid_from INTEGER, valid_until INTEGER, root_memory_id TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE memory_versions(
      id TEXT PRIMARY KEY, memory_id TEXT, tenant_id TEXT, version INTEGER, operation TEXT,
      content TEXT, summary TEXT, tags_json TEXT, kind TEXT, lifecycle_state TEXT,
      scope_type TEXT, scope_key TEXT, actor_type TEXT, actor_id TEXT,
      confidence_score REAL, utility_score REAL, canonical_key TEXT, snapshot_json TEXT,
      content_hash TEXT, created_at INTEGER
    );
    CREATE TABLE memory_edges(
      id TEXT PRIMARY KEY, tenant_id TEXT, from_memory_id TEXT, to_memory_id TEXT,
      relation TEXT, created_at INTEGER
    );
    CREATE TABLE decision_memories(
      id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, title TEXT, decision TEXT,
      domain TEXT, status TEXT, confirmation_state TEXT, confidence REAL, visibility TEXT,
      allowed_principals_json TEXT, source_refs_json TEXT, valid_from INTEGER,
      valid_until INTEGER, superseded_by TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE decision_memory_versions(
      id TEXT PRIMARY KEY, decision_memory_id TEXT, tenant_id TEXT, operation TEXT,
      snapshot_json TEXT, actor_refs_json TEXT, reviewer_refs_json TEXT, note TEXT,
      created_at INTEGER
    );
    CREATE TABLE knowledge_resources(
      id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, resource_kind TEXT,
      title TEXT, source_system TEXT, media_type TEXT, visibility TEXT,
      permissions_json TEXT, current_version_id TEXT, lifecycle_state TEXT,
      created_by_principal TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE knowledge_resource_versions(
      id TEXT PRIMARY KEY, tenant_id TEXT, resource_id TEXT, connector_id TEXT,
      source_version TEXT, etag TEXT, last_modified TEXT, content_hash TEXT,
      snapshot_object_ref TEXT, extracted_text TEXT, extracted_text_hash TEXT,
      extraction_state TEXT, captured_at INTEGER, created_by_principal TEXT,
      created_at INTEGER
    );
    CREATE TABLE knowledge_resource_locations(
      id TEXT PRIMARY KEY, tenant_id TEXT, resource_id TEXT, uri TEXT,
      location_role TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE knowledge_assertions(
      id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT, assertion_type TEXT,
      subject_type TEXT, subject_ref TEXT, predicate TEXT, object_type TEXT,
      object_ref TEXT, resource_id TEXT, object_value TEXT, context_json TEXT,
      confidence REAL, confirmation_state TEXT, valid_from INTEGER, valid_until INTEGER,
      actor_principal TEXT, reviewed_by_principal TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE knowledge_assertion_evidence(
      id TEXT PRIMARY KEY, tenant_id TEXT, assertion_id TEXT, resource_id TEXT,
      resource_version_id TEXT, locator_json TEXT, note TEXT, created_at INTEGER
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

function insertMemory(database: SqliteDatabase, args: {
  id: string;
  tags?: string[];
  kind?: string;
  lifecycle?: string;
  canonicalKey?: string | null;
  permissions?: unknown[];
  updatedAt: number;
}) {
  database.prepare(
    `INSERT INTO memories(
      id, tenant_id, project_id, content, summary, tags_json, kind, lifecycle_state,
      confidence_score, canonical_key, current_version, source_refs_json, evidence_json,
      permissions_json, valid_from, valid_until, root_memory_id, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    args.id, "tenant-a", "project-a", `${args.id} current content`, `${args.id} title`,
    JSON.stringify(args.tags ?? []), args.kind ?? "episodic", args.lifecycle ?? "active", 0.8,
    args.canonicalKey ?? null, 2,
    JSON.stringify([{ type: "url", id: `${args.id}-external`, title: "External source" }]),
    "[]", JSON.stringify(args.permissions ?? []), 10, null, null, 10, args.updatedAt
  );
}

function insertResource(database: SqliteDatabase, args: {
  id: string;
  visibility?: "tenant" | "project" | "restricted";
  permissions?: string[];
  updatedAt: number;
}) {
  database.prepare(
    `INSERT INTO knowledge_resources(
      id, tenant_id, project_id, resource_kind, title, source_system, media_type,
      visibility, permissions_json, current_version_id, lifecycle_state,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    args.id, "tenant-a", "project-a", "document", `${args.id} title`, "drive",
    "text/markdown", args.visibility ?? "tenant", JSON.stringify(args.permissions ?? []),
    null, "active", "user:writer", 10, args.updatedAt
  );
}

function insertEvidence(database: SqliteDatabase, args: {
  id: string;
  assertionId: string;
  resourceId: string;
  createdAt: number;
}) {
  database.prepare("INSERT INTO knowledge_assertion_evidence VALUES(?,?,?,?,?,?,?,?)").run(
    args.id, "tenant-a", args.assertionId, args.resourceId, null, "{}", null, args.createdAt
  );
}

function seedAllSourceTypes(database: SqliteDatabase) {
  insertMemory(database, {
    id: "memory-canonical",
    kind: "semantic",
    lifecycle: "promoted",
    updatedAt: 500
  });
  insertMemory(database, {
    id: "memory-assumption",
    tags: ["assumption"],
    updatedAt: 490
  });
  const hiddenGrant = [{ principal_type: "principal", principal_id: "user:other", permissions: ["read"] }];
  insertMemory(database, { id: "memory-hidden", permissions: hiddenGrant, updatedAt: 600 });
  database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
    .run("edge-readable", "tenant-a", "memory-canonical", "memory-assumption", "supports", 250);
  database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)")
    .run("edge-hidden", "tenant-a", "memory-canonical", "memory-hidden", "supports", 251);
  database.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind,
      lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score,
      utility_score, canonical_key, snapshot_json, content_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "mv-canonical-1", "memory-canonical", "tenant-a", 1, "capture", "historic content",
    "historic summary", "[]", "semantic", "active", "project", "project-a", "agent",
    "agent:one", 0.7, 0.6, null, JSON.stringify({ content: "historic only" }), "hash-1", 100
  );
  database.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind,
      lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score,
      utility_score, canonical_key, snapshot_json, content_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "mv-canonical-2", "memory-canonical", "tenant-a", 2, "promote", "version two content",
    "version two", "[]", "semantic", "promoted", "project", "project-a", "agent",
    "agent:two", 0.9, 0.8, "canonical:key", null, "hash-2", 200
  );
  database.prepare(
    `INSERT INTO decision_memories(
      id, tenant_id, project_id, title, decision, domain, status, confirmation_state,
      confidence, visibility, allowed_principals_json, source_refs_json, valid_from,
      valid_until, superseded_by, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "decision-one", "tenant-a", "project-a", "Choose D1", "Use D1", "engineering",
    "active", "confirmed", 0.9, "tenant", "[]",
    JSON.stringify([{ type: "adr", id: "ADR-1", title: "Architecture record" }]),
    20, null, null, 20, 480
  );
  database.prepare("INSERT INTO decision_memory_versions VALUES(?,?,?,?,?,?,?,?,?)").run(
    "dv-one", "decision-one", "tenant-a", "create",
    JSON.stringify({ title: "Old title", decision: "Old decision" }),
    JSON.stringify([{ id: "agent:one" }]), "[]", null, 210
  );
  database.prepare(
    `INSERT INTO knowledge_resources(
      id, tenant_id, project_id, resource_kind, title, source_system, media_type,
      visibility, permissions_json, current_version_id, lifecycle_state,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "resource-one", "tenant-a", "project-a", "document", "Architecture note", "drive",
    "text/markdown", "tenant", "[]", "rv-one", "active", "user:writer", 30, 470
  );
  database.prepare("INSERT INTO knowledge_resource_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "rv-one", "tenant-a", "resource-one", "drive", "v1", "etag", null, "hash",
    "r2://snapshot", "Full source text", "text-hash", "ready", 300, "user:writer", 300
  );
  database.prepare("INSERT INTO knowledge_resource_locations VALUES(?,?,?,?,?,?,?)").run(
    "location-one", "tenant-a", "resource-one", "https://example.test/doc", "canonical", 30, 300
  );
  database.prepare(
    `INSERT INTO knowledge_assertions(
      id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
      object_type, object_ref, resource_id, object_value, context_json, confidence,
      confirmation_state, valid_from, valid_until, actor_principal,
      reviewed_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "assertion-proposal", "tenant-a", "project-a", "relation", "memory",
    "memory-assumption", "supported_by", "knowledge_resource", "resource-one",
    "resource-one", null, "{}", 0.6, "proposal", 40, null, "agent:one", null, 40, 460
  );
  database.prepare(
    `INSERT INTO knowledge_assertions(
      id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
      object_type, object_ref, resource_id, object_value, context_json, confidence,
      confirmation_state, valid_from, valid_until, actor_principal,
      reviewed_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "assertion-confirmed", "tenant-a", "project-a", "relation", "decision_memory",
    "decision-one", "supported_by", "knowledge_resource", "resource-one",
    "resource-one", null, "{}", 0.95, "confirmed", 50, null, "agent:one", "user:reviewer", 50, 450
  );
  database.prepare("INSERT INTO knowledge_assertion_evidence VALUES(?,?,?,?,?,?,?,?)").run(
    "evidence-one", "tenant-a", "assertion-confirmed", "resource-one", "rv-one",
    JSON.stringify({ page: 2 }), "supporting excerpt", 320
  );
}

describe("memory strata dashboard service", () => {
  it("uses only explicit canonical and assumption signals for lane mapping", () => {
    expect(mapMemoryStrataType({ sourceType: "memory", lifecycleState: "promoted" })).toBe("canonical");
    expect(mapMemoryStrataType({ sourceType: "memory", lifecycleState: "consolidated", kind: "semantic" })).toBe("learning");
    expect(mapMemoryStrataType({ sourceType: "memory", canonicalKey: "key" })).toBe("canonical");
    expect(mapMemoryStrataType({ sourceType: "memory", tags: ["canonical-memory"] })).toBe("canonical");
    expect(mapMemoryStrataType({ sourceType: "memory", tags: ["assumption"] })).toBe("assumption");
    expect(mapMemoryStrataType({ sourceType: "knowledge_assertion", confirmationState: "proposal" })).toBe("assumption");
    expect(mapMemoryStrataType({ sourceType: "decision_memory" })).toBe("decision");
    expect(mapMemoryStrataType({ sourceType: "knowledge_resource" })).toBe("source");
  });

  it("lists all supported source chains with ACL filtering and stable pagination", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);

    const first = await getMemoryStrata(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      limit: 3,
      now: 1_000
    });
    expect(dashboardStrataResponseSchema.parse(first)).toEqual(first);
    expect(first.contract_version).toBe("dashboard/v1");
    expect(first.chains).toHaveLength(3);
    expect(first.has_more).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.oldest_cursor).toBeTruthy();
    expect(first.chains.some((chain) => chain.source_id === "memory-hidden")).toBe(false);

    const second = await getMemoryStrata(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      before: first.oldest_cursor ?? undefined,
      limit: 10,
      now: 1_000
    });
    expect(dashboardStrataResponseSchema.parse(second)).toEqual(second);
    const combined = [...first.chains, ...second.chains];
    expect(new Set(combined.map((chain) => chain.source_type))).toEqual(new Set([
      "memory",
      "decision_memory",
      "knowledge_resource",
      "knowledge_assertion"
    ]));
    expect(combined.find((chain) => chain.source_id === "memory-canonical")?.type).toBe("canonical");
    expect(combined.find((chain) => chain.source_id === "memory-assumption")?.type).toBe("assumption");
    expect(combined.find((chain) => chain.source_id === "assertion-proposal")?.type).toBe("assumption");
    expect(combined.find((chain) => chain.source_id === "assertion-confirmed")?.type).toBe("learning");

    const assumptions = await getMemoryStrata(env, "tenant-a", {
      types: ["assumption"],
      limit: 20,
      now: 1_000
    });
    expect(assumptions.chains.every((chain) => chain.type === "assumption")).toBe(true);
    await expect(getMemoryStrata(env, "tenant-a", { limit: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(getMemoryStrata(env, "tenant-a", { before: "not-a-cursor" })).rejects.toMatchObject({ status: 400 });
  });

  it("returns partial historical snapshots without backfilling current state", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);

    const detail = await getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      project_id: "project-a",
      principal: "user:reader",
      revision_limit: 10,
      source_limit: 10,
      now: 1_000
    });
    expect(dashboardStrataDetailResponseSchema.parse(detail)).toEqual(detail);
    const partial = detail.chain.revisions.find((revision) => revision.id === "mv-canonical-1");
    expect(partial).toMatchObject({ partial: true, snapshot: { content: "historic only" } });
    expect(partial?.snapshot).not.toHaveProperty("kind");
    expect(partial?.snapshot).not.toHaveProperty("lifecycle_state");
    const reconstructed = detail.chain.revisions.find((revision) => revision.id === "mv-canonical-2");
    expect(reconstructed).toMatchObject({
      partial: true,
      snapshot: { content: "version two content", lifecycle_state: "promoted" }
    });
    expect(detail.chain.relations).toEqual([
      expect.objectContaining({ target_id: "memory-assumption", relation: "supports" })
    ]);
    expect(detail.chain.sources).toEqual([
      expect.objectContaining({ resource_id: "memory-canonical-external", unresolved: true })
    ]);

    const truncated = await getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      revision_limit: 1,
      source_limit: 1,
      now: 1_000
    });
    expect(truncated.chain.revisions).toHaveLength(1);
    expect(truncated.truncated.revisions).toBe(true);
    await expect(getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      revision_limit: 101
    })).rejects.toMatchObject({ status: 400 });
    await expect(getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      source_limit: 51
    })).rejects.toMatchObject({ status: 400 });
  });

  it("provides bounded detail for decisions, resources, and assertions", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);

    const decision = await getMemoryStrataDetail(env, "tenant-a", "decision_memory", "decision-one", {
      principal: "user:reader",
      now: 1_000
    });
    const resource = await getMemoryStrataDetail(env, "tenant-a", "knowledge_resource", "resource-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 1_000
    });
    const assertion = await getMemoryStrataDetail(env, "tenant-a", "knowledge_assertion", "assertion-confirmed", {
      project_id: "project-a",
      principal: "user:reader",
      now: 1_000
    });

    expect(dashboardStrataDetailResponseSchema.parse(decision)).toEqual(decision);
    expect(dashboardStrataDetailResponseSchema.parse(resource)).toEqual(resource);
    expect(dashboardStrataDetailResponseSchema.parse(assertion)).toEqual(assertion);
    expect(decision.chain.revisions[0]).toMatchObject({ partial: true, state: "unknown" });
    expect(resource.chain.revisions[0]).toMatchObject({ partial: true, state: "ready" });
    expect(resource.chain.sources[0]).toMatchObject({ relation: "canonical", unresolved: false });
    expect(assertion.chain.sources[0]).toMatchObject({
      resource_id: "resource-one",
      resource_version_id: "rv-one",
      unresolved: false
    });
    expect(assertion.chain.relations.map((relation) => relation.relation)).toEqual(["subject", "supported_by"]);

    await expect(getMemoryStrataDetail(env, "tenant-a", "memory", "memory-hidden", {
      principal: "user:reader"
    })).rejects.toMatchObject({ status: 404 });
  });

  it("marks legacy null snapshots as partial in collection summaries", async () => {
    const { database, env } = testEnv();
    insertMemory(database, { id: "memory-legacy", updatedAt: 100 });
    database.prepare(
      `INSERT INTO memory_versions(
        id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind,
        lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score,
        utility_score, canonical_key, snapshot_json, content_hash, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "mv-legacy", "memory-legacy", "tenant-a", 1, "capture", "legacy content",
      "legacy summary", "[]", "episodic", "active", "project", "project-a",
      "agent", "agent:one", 0.7, 0.6, null, null, "legacy-hash", 90
    );

    const result = await getMemoryStrata(env, "tenant-a", {
      principal: "user:reader",
      limit: 10,
      now: 1_000
    });

    expect(result.chains.find((chain) => chain.source_id === "memory-legacy")).toMatchObject({
      partial: true,
      revision_count: 1,
      attention: ["partial_history"]
    });
  });

  it("derives source counts and truncation only from ACL-readable evidence and refs", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    database.prepare(
      `INSERT INTO knowledge_resources(
        id, tenant_id, project_id, resource_kind, title, source_system, media_type,
        visibility, permissions_json, current_version_id, lifecycle_state,
        created_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "resource-hidden", "tenant-a", "project-a", "document", "PRIVATE-SOURCE-TITLE",
      "drive", "text/markdown", "restricted", JSON.stringify(["user:bob"]), null,
      "active", "user:bob", 60, 500
    );
    database.prepare(
      "UPDATE memories SET source_refs_json = ? WHERE id = ?"
    ).run(JSON.stringify([
      { type: "url", id: "public-unresolved", title: "Public unresolved" },
      { type: "document", id: "resource-hidden", title: "PRIVATE-REF-TITLE" },
      {
        type: "url",
        id: "principal-private-unresolved",
        title: "PRIVATE-ALLOWED-PRINCIPAL-TITLE",
        allowedPrincipals: ["user:bob"]
      }
    ]), "memory-canonical");
    database.prepare("INSERT INTO knowledge_assertion_evidence VALUES(?,?,?,?,?,?,?,?)").run(
      "evidence-hidden-1", "tenant-a", "assertion-confirmed", "resource-hidden", null,
      "{}", "PRIVATE-EVIDENCE-NOTE-1", 500
    );
    database.prepare("INSERT INTO knowledge_assertion_evidence VALUES(?,?,?,?,?,?,?,?)").run(
      "evidence-hidden-2", "tenant-a", "assertion-confirmed", "resource-hidden", null,
      "{}", "PRIVATE-EVIDENCE-NOTE-2", 490
    );

    const collection = await getMemoryStrata(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      limit: 20,
      now: 1_000
    });
    expect(collection.chains.find((chain) => chain.source_id === "memory-canonical")?.source_count).toBe(1);
    expect(collection.chains.find((chain) => chain.source_id === "assertion-confirmed")?.source_count).toBe(1);

    const memory = await getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      project_id: "project-a",
      principal: "user:reader",
      source_limit: 1,
      now: 1_000
    });
    expect(memory.chain.source_count).toBe(1);
    expect(memory.chain.sources).toEqual([
      expect.objectContaining({ resource_id: "public-unresolved", unresolved: true })
    ]);
    expect(memory.truncated.sources).toBe(false);

    const assertion = await getMemoryStrataDetail(
      env,
      "tenant-a",
      "knowledge_assertion",
      "assertion-confirmed",
      {
        project_id: "project-a",
        principal: "user:reader",
        source_limit: 1,
        now: 1_000
      }
    );
    expect(assertion.chain.source_count).toBe(1);
    expect(assertion.chain.sources).toEqual([
      expect.objectContaining({ resource_id: "resource-one", unresolved: false })
    ]);
    expect(assertion.truncated.sources).toBe(false);

    const serialized = JSON.stringify({ collection, memory, assertion });
    expect(serialized).not.toContain("PRIVATE-");
    expect(serialized).not.toContain("resource-hidden");
    expect(serialized).not.toContain("principal-private-unresolved");
  });

  it("does not expose hidden scan volume through pagination metadata", async () => {
    const { database, env } = testEnv();
    const hiddenGrant = [{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }];
    for (let index = 0; index < 4; index += 1) {
      insertMemory(database, {
        id: `memory-hidden-${index}`,
        permissions: hiddenGrant,
        updatedAt: 100 - index
      });
    }

    const result = await getMemoryStrata(env, "tenant-a", {
      principal: "user:reader",
      limit: 1,
      now: 1_000
    });

    expect(result.chains).toEqual([]);
    expect(result.oldest_cursor).toBeNull();
    expect(result.has_more).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("finds an older requested lane beyond the former per-table scan cap", async () => {
    const { database, env } = testEnv();
    for (let index = 0; index < 302; index += 1) {
      insertMemory(database, {
        id: `memory-learning-${String(index).padStart(3, "0")}`,
        kind: "semantic",
        updatedAt: 10_000 - index
      });
    }
    insertMemory(database, {
      id: "memory-canonical-older",
      kind: "semantic",
      lifecycle: "promoted",
      updatedAt: 100
    });

    const result = await getMemoryStrata(env, "tenant-a", {
      principal: "user:reader",
      types: ["canonical"],
      limit: 100,
      now: 20_000
    });

    expect(result.chains.map((chain) => chain.source_id)).toEqual(["memory-canonical-older"]);
    expect(result.has_more).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("fills pages past hidden rows without exposing hidden volume in pagination metadata", async () => {
    const { database, env } = testEnv();
    const hiddenGrant = [{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }];
    for (let index = 0; index < 302; index += 1) {
      insertMemory(database, {
        id: `memory-hidden-canonical-${String(index).padStart(3, "0")}`,
        lifecycle: "promoted",
        permissions: hiddenGrant,
        updatedAt: 10_000 - index
      });
    }
    insertMemory(database, { id: "memory-visible-first", lifecycle: "promoted", updatedAt: 100 });
    insertMemory(database, { id: "memory-visible-second", lifecycle: "promoted", updatedAt: 90 });

    const first = await getMemoryStrata(env, "tenant-a", {
      principal: "user:reader",
      types: ["canonical"],
      limit: 1,
      now: 20_000
    });
    expect(first.chains.map((chain) => chain.source_id)).toEqual(["memory-visible-first"]);
    expect(first.has_more).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.oldest_cursor).toBeTruthy();

    const second = await getMemoryStrata(env, "tenant-a", {
      principal: "user:reader",
      types: ["canonical"],
      before: first.oldest_cursor ?? undefined,
      limit: 1,
      now: 20_000
    });
    expect(second.chains.map((chain) => chain.source_id)).toEqual(["memory-visible-second"]);
    expect(second.has_more).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("fills assertion detail sources beyond newer hidden evidence", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    for (let index = 0; index < 405; index += 1) {
      const resourceId = `resource-hidden-density-${String(index).padStart(3, "0")}`;
      insertResource(database, {
        id: resourceId,
        visibility: "restricted",
        permissions: ["user:bob"],
        updatedAt: 20_000 - index
      });
      insertEvidence(database, {
        id: `evidence-hidden-density-${String(index).padStart(3, "0")}`,
        assertionId: "assertion-confirmed",
        resourceId,
        createdAt: 20_000 - index
      });
    }
    for (let index = 0; index < 50; index += 1) {
      const resourceId = `resource-readable-density-${String(index).padStart(2, "0")}`;
      insertResource(database, { id: resourceId, updatedAt: 200 - index });
      insertEvidence(database, {
        id: `evidence-readable-density-${String(index).padStart(2, "0")}`,
        assertionId: "assertion-confirmed",
        resourceId,
        createdAt: 200 - index
      });
    }

    const detail = await getMemoryStrataDetail(
      env,
      "tenant-a",
      "knowledge_assertion",
      "assertion-confirmed",
      {
        project_id: "project-a",
        principal: "user:reader",
        source_limit: 50,
        now: 30_000
      }
    );

    expect(detail.chain.sources).toHaveLength(50);
    expect(detail.chain.source_count).toBe(51);
    expect(detail.truncated.sources).toBe(true);
    expect(detail.chain.attention).not.toContain("source_count_truncated");
    expect(JSON.stringify(detail)).not.toContain("resource-hidden-density");
  });

  it("resolves embedded refs after ACL filtering instead of slicing raw refs", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    const refs: Array<{ id: string; title: string; type: string }> = [];
    for (let index = 0; index < 405; index += 1) {
      const resourceId = `resource-hidden-ref-${String(index).padStart(3, "0")}`;
      insertResource(database, {
        id: resourceId,
        visibility: "restricted",
        permissions: ["user:bob"],
        updatedAt: 20_000 - index
      });
      refs.push({ id: resourceId, title: `PRIVATE REF ${index}`, type: "document" });
    }
    for (let index = 0; index < 51; index += 1) {
      refs.push({
        id: `unresolved-readable-ref-${String(index).padStart(2, "0")}`,
        title: `Readable ref ${index}`,
        type: "url"
      });
    }
    database.prepare("UPDATE memories SET source_refs_json = ?, evidence_json = '[]' WHERE id = ?")
      .run(JSON.stringify(refs), "memory-canonical");

    const [collection, detail] = await Promise.all([
      getMemoryStrata(env, "tenant-a", {
        project_id: "project-a",
        principal: "user:reader",
        limit: 20,
        now: 30_000
      }),
      getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
        project_id: "project-a",
        principal: "user:reader",
        source_limit: 50,
        now: 30_000
      })
    ]);

    const summary = collection.chains.find((chain) => chain.source_id === "memory-canonical");
    expect(summary?.source_count).toBe(51);
    expect(summary?.attention).not.toContain("source_count_truncated");
    expect(detail.chain.sources).toHaveLength(50);
    expect(detail.chain.source_count).toBe(51);
    expect(detail.truncated.sources).toBe(true);
    expect(detail.chain.attention).not.toContain("source_count_truncated");
    expect(JSON.stringify({ summary, detail })).not.toContain("PRIVATE REF");
    expect(JSON.stringify({ summary, detail })).not.toContain("resource-hidden-ref");
  });

  it("counts evidence per assertion without newer sibling evidence crowd-out", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    database.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, object_value, context_json, confidence,
        confirmation_state, valid_from, valid_until, actor_principal,
        reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "assertion-skew", "tenant-a", "project-a", "relation", "knowledge_resource",
      "resource-one", "supports", null, null, "resource-one", null, "{}", 0.9,
      "confirmed", 60, null, "agent:one", "user:reviewer", 60, 440
    );
    for (let index = 0; index < 902; index += 1) {
      insertEvidence(database, {
        id: `evidence-skew-${String(index).padStart(3, "0")}`,
        assertionId: "assertion-skew",
        resourceId: "resource-one",
        createdAt: 20_000 - index
      });
    }

    const collection = await getMemoryStrata(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      types: ["learning"],
      limit: 100,
      now: 30_000
    });

    expect(collection.chains.find((chain) => chain.source_id === "assertion-confirmed")).toMatchObject({
      source_count: 1,
      partial: false
    });
    expect(collection.chains.find((chain) => chain.source_id === "assertion-skew")).toMatchObject({
      source_count: 400,
      partial: true,
      attention: ["source_count_truncated"]
    });
  });

  it("finds older readable memory edges beyond newer hidden targets", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    const hiddenGrant = [{
      principal_type: "principal",
      principal_id: "user:bob",
      permissions: ["read"]
    }];
    for (let index = 0; index < 105; index += 1) {
      const targetId = `memory-hidden-relation-${String(index).padStart(3, "0")}`;
      insertMemory(database, {
        id: targetId,
        permissions: hiddenGrant,
        updatedAt: 20_000 - index
      });
      database.prepare("INSERT INTO memory_edges VALUES(?,?,?,?,?,?)").run(
        `edge-hidden-density-${String(index).padStart(3, "0")}`,
        "tenant-a",
        "memory-canonical",
        targetId,
        "supports",
        20_000 - index
      );
    }

    const detail = await getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });

    expect(detail.chain.relations).toEqual([
      expect.objectContaining({ relation: "supports", target_id: "memory-assumption" })
    ]);
    expect(detail.chain.attention).not.toContain("relations_truncated");
    expect(JSON.stringify(detail.chain.relations)).not.toContain("memory-hidden-relation");

    const grantedDetail = await getMemoryStrataDetail(env, "tenant-a", "memory", "memory-canonical", {
      project_id: "project-a",
      principal: "user:bob",
      now: 30_000
    });
    expect(grantedDetail.chain.relations).toHaveLength(100);
    expect(grantedDetail.chain.attention).toContain("relations_truncated");
  });

  it("finds older readable confirmed relations beyond newer hidden endpoints", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    for (let index = 0; index < 105; index += 1) {
      const resourceId = `resource-hidden-relation-${String(index).padStart(3, "0")}`;
      insertResource(database, {
        id: resourceId,
        visibility: "restricted",
        permissions: ["user:bob"],
        updatedAt: 20_000 - index
      });
      database.prepare(
        `INSERT INTO knowledge_assertions(
          id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
          object_type, object_ref, resource_id, object_value, context_json, confidence,
          confirmation_state, valid_from, valid_until, actor_principal,
          reviewed_by_principal, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `assertion-hidden-relation-${String(index).padStart(3, "0")}`,
        "tenant-a", "project-a", "relation", "decision_memory", "decision-one",
        "supported_by", "knowledge_resource", resourceId, resourceId, null, "{}", 0.9,
        "confirmed", 60, null, "agent:one", "user:reviewer", 60, 20_000 - index
      );
    }

    const detail = await getMemoryStrataDetail(env, "tenant-a", "decision_memory", "decision-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });

    expect(detail.chain.relations).toEqual([
      expect.objectContaining({ relation: "supported_by", target_id: "resource-one" })
    ]);
    expect(detail.chain.attention).not.toContain("relations_truncated");
    expect(JSON.stringify(detail.chain.relations)).not.toContain("resource-hidden-relation");
  });

  it("does not expose confirmed predicates backed by an unreadable attached resource", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    insertResource(database, {
      id: "resource-private-evidence",
      visibility: "restricted",
      permissions: ["user:bob"],
      updatedAt: 20_000
    });
    database.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, object_value, context_json, confidence,
        confirmation_state, valid_from, valid_until, actor_principal,
        reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "assertion-private-predicate", "tenant-a", "project-a", "relation",
      "decision_memory", "decision-one", "PRIVATE_PREDICATE", "memory",
      "memory-assumption", "resource-private-evidence", null, "{}", 0.99,
      "confirmed", 60, null, "agent:one", "user:reviewer", 60, 20_000
    );
    insertEvidence(database, {
      id: "evidence-private-predicate",
      assertionId: "assertion-private-predicate",
      resourceId: "resource-private-evidence",
      createdAt: 20_000
    });

    const detail = await getMemoryStrataDetail(env, "tenant-a", "decision_memory", "decision-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });

    expect(detail.chain.relations).toEqual([
      expect.objectContaining({ relation: "supported_by", target_id: "resource-one" })
    ]);
    const serialized = JSON.stringify(detail.chain.relations);
    expect(serialized).not.toContain("PRIVATE_PREDICATE");
    expect(serialized).not.toContain("resource-private-evidence");
    expect(serialized).not.toContain("memory-assumption");
  });

  it("normalizes decision and resource assertion aliases without bypassing resource ACL", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    insertResource(database, {
      id: "resource-private-alias",
      visibility: "restricted",
      permissions: ["user:bob"],
      updatedAt: 20_000
    });
    const insertAssertion = database.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, object_value, context_json, confidence,
        confirmation_state, valid_from, valid_until, actor_principal,
        reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    insertAssertion.run(
      "assertion-decision-alias", "tenant-a", "project-a", "relation",
      "decision", "decision-one", "alias_supports", "memory", "memory-assumption",
      "resource-one", null, "{}", 0.99, "confirmed", 60, null,
      "agent:one", "user:reviewer", 60, 20_100
    );
    insertAssertion.run(
      "assertion-resource-alias", "tenant-a", "project-a", "relation",
      "resource", "resource-one", "alias_documents", "memory", "memory-assumption",
      "resource-one", null, "{}", 0.99, "confirmed", 60, null,
      "agent:one", "user:reviewer", 60, 20_090
    );
    insertAssertion.run(
      "assertion-private-resource-alias", "tenant-a", "project-a", "relation",
      "resource", "resource-private-alias", "PRIVATE_RESOURCE_ALIAS", "decision",
      "decision-one", null, null, "{}", 0.99, "confirmed", 60, null,
      "agent:one", "user:reviewer", 60, 20_080
    );

    const decision = await getMemoryStrataDetail(env, "tenant-a", "decision_memory", "decision-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });
    const resource = await getMemoryStrataDetail(env, "tenant-a", "knowledge_resource", "resource-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });
    const collection = await getMemoryStrata(env, "tenant-a", {
      project_id: "project-a",
      principal: "user:reader",
      limit: 100,
      now: 30_000
    });

    expect(decision.chain.relations).toContainEqual(
      expect.objectContaining({ relation: "alias_supports", target_id: "memory-assumption" })
    );
    expect(resource.chain.relations).toContainEqual(
      expect.objectContaining({ relation: "alias_documents", target_id: "memory-assumption" })
    );
    const serialized = JSON.stringify({ decision, resource, collection });
    expect(serialized).not.toContain("PRIVATE_RESOURCE_ALIAS");
    expect(serialized).not.toContain("assertion-private-resource-alias");
  });

  it("does not mix cross-project confirmed assertions into relation detail", async () => {
    const { database, env } = testEnv();
    seedAllSourceTypes(database);
    database.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, object_value, context_json, confidence,
        confirmation_state, valid_from, valid_until, actor_principal,
        reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "assertion-cross-project", "tenant-a", "project-b", "relation",
      "decision_memory", "decision-one", "CROSS_PROJECT_PREDICATE", "memory",
      "memory-assumption", "resource-one", null, "{}", 0.99, "confirmed",
      60, null, "agent:one", "user:reviewer", 60, 20_000
    );

    const detail = await getMemoryStrataDetail(env, "tenant-a", "decision_memory", "decision-one", {
      project_id: "project-a",
      principal: "user:reader",
      now: 30_000
    });

    expect(detail.chain.relations).toEqual([
      expect.objectContaining({ relation: "supported_by", target_id: "resource-one" })
    ]);
    const serialized = JSON.stringify(detail.chain.relations);
    expect(serialized).not.toContain("CROSS_PROJECT_PREDICATE");
    expect(serialized).not.toContain("assertion-cross-project");
  });
});
