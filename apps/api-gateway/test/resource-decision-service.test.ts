import { describe, expect, it } from "vitest";
import {
  addKnowledgeResourceLocation,
  backfillKnowledgeResources,
  captureKnowledgeResourceVersion,
  confirmDecisionResourceLinkProposal,
  createDecisionResourceLink,
  getDecisionResources,
  getResourceDecisions,
  listDecisionResourceLinkProposals,
  resolveKnowledgeResource,
  searchKnowledgeResources,
  upsertKnowledgeResource
} from "../src/resource-decision-service";
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
  process: { cwd: () => string; getBuiltinModule: (name: string) => unknown };
}).process;

const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const { readFileSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: string, encoding: string) => string;
};

const { createHash } = runtime.getBuiltinModule("node:crypto") as {
  createHash: (algorithm: string) => { update: (value: string) => { digest: (encoding: "hex") => string } };
};

class D1StatementAdapter {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function testEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE retrieval_generations(id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO retrieval_generations VALUES('gen_active', 'active');
    CREATE TABLE retrieval_units (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      project_id TEXT, source_type TEXT NOT NULL CHECK(source_type IN ('memory', 'decision_memory')),
      source_id TEXT NOT NULL, business_category_id TEXT, work_type TEXT, unit_type TEXT NOT NULL,
      text TEXT NOT NULL, speaker TEXT, event_at INTEGER, valid_from INTEGER, valid_until INTEGER,
      source_ref_json TEXT, source_span_start INTEGER, source_span_end INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}', segment_id TEXT, content_hash TEXT NOT NULL,
      extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
      extraction_state TEXT NOT NULL DEFAULT 'degraded', degraded_reason TEXT, created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE retrieval_units_fts USING fts5(
      unit_id UNINDEXED, generation_id UNINDEXED, tenant_id UNINDEXED, text
    );
    CREATE INDEX idx_retrieval_units_source ON retrieval_units(generation_id, tenant_id, source_type, source_id, unit_type);
    CREATE INDEX idx_retrieval_units_business_work ON retrieval_units(generation_id, tenant_id, business_category_id, work_type, unit_type);
    CREATE INDEX idx_retrieval_units_timeline ON retrieval_units(generation_id, tenant_id, unit_type, event_at DESC);
    CREATE TABLE decision_memories(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT,
      decision TEXT, rationale TEXT,
      source_refs_json TEXT NOT NULL DEFAULT '[]', confirmation_state TEXT,
      visibility TEXT, allowed_principals_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE memories(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, permissions_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE decision_rationales(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      project_id TEXT, conclusion TEXT NOT NULL, reason_summary TEXT NOT NULL,
      confirmation_state TEXT
    );
    CREATE TABLE decision_evidence(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rationale_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL, evidence_ref TEXT NOT NULL, relation TEXT NOT NULL,
      note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE knowledge_docs(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT, body_text TEXT, artifact_ref TEXT, visibility TEXT, owner_principal TEXT,
      updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE group_members(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL);
    CREATE TABLE resource_acl(
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, permission TEXT NOT NULL,
      created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, resource_type, resource_id, subject_type, subject_id, permission)
    );
  `);
  const migration = readFileSync(`${runtime.cwd()}/../../migrations/0023_knowledge_resources.sql`, "utf8");
  database.exec(migration);
  const db = {
    prepare: (sql: string) => new D1StatementAdapter(database, sql),
    batch: async (statements: D1StatementAdapter[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return {
    database,
    env: {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: { get: async () => null },
      KNOWLEDGE_RESOURCE_CONNECTORS_JSON: JSON.stringify([
        { id: "test-connector", principals: ["user:1"], media_types: ["text/plain"], max_bytes: 10_000 },
        { id: "knowledge-doc-backfill", principals: ["operator:1"], max_bytes: 100_000 },
        { id: "decision-evidence-backfill", principals: ["operator:1"], max_bytes: 100_000 }
      ])
    } as unknown as Env
  };
}

const digest = (value: string) => value.repeat(64).slice(0, 64);
const textDigest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("resource decision service", () => {
  it("supports URI idempotency, N:N reasons, artifacts, proposals, search, and ACL filtering", async () => {
    const { database, env } = testEnv();
    const tenant = "tenant-1";
    const actor = "user:1";
    for (const id of ["d1", "d2", "d3"]) {
      database.prepare("INSERT INTO memories(id, tenant_id, permissions_json) VALUES(?,?,?)").run(`m-${id}`, tenant, "[]");
      database.prepare("INSERT INTO decision_rationales(id, tenant_id, memory_id, conclusion, reason_summary, confirmation_state) VALUES(?,?,?,?,?,?)")
        .run(id, tenant, `m-${id}`, `Conclusion ${id}`, `Reason ${id}`, "reviewed");
    }
    database.prepare("INSERT INTO memories(id, tenant_id, permissions_json) VALUES(?,?,?)").run(
      "m-d4",
      tenant,
      JSON.stringify([{ principal_type: "principal", principal_id: actor, permissions: ["read"] }])
    );
    database.prepare("INSERT INTO decision_rationales(id, tenant_id, memory_id, conclusion, reason_summary, confirmation_state) VALUES(?,?,?,?,?,?)")
      .run("d4", tenant, "m-d4", "Restricted conclusion", "Restricted reason", "reviewed");
    database.prepare("INSERT INTO memories(id, tenant_id, permissions_json) VALUES(?,?,?)").run("m-d5", tenant, "[]");
    database.prepare("INSERT INTO decision_rationales(id, tenant_id, memory_id, project_id, conclusion, reason_summary, confirmation_state) VALUES(?,?,?,?,?,?,?)")
      .run("d5", tenant, "m-d5", "project-b", "Other project conclusion", "Other project reason", "reviewed");

    const material = await upsertKnowledgeResource(env, {
      tenant_id: tenant,
      resource_kind: "document",
      canonical_uri: "https://EXAMPLE.com:443/material#decision",
      title: "Architecture decision material",
      source_system: "test",
      media_type: "text/plain",
      connector_id: "test-connector",
      fetch_enabled: true
    }, actor);
    const duplicate = await upsertKnowledgeResource(env, {
      tenant_id: tenant,
      resource_kind: "document",
      canonical_uri: "https://example.com/material",
      title: "Duplicate",
      source_system: "test",
      media_type: "text/plain"
    }, actor);
    expect(duplicate.created).toBe(false);
    expect(duplicate.resource.id).toBe(material.resource.id);

    const version = await captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("a"),
      snapshot_object_ref: "r2://tenant/resource/version",
      extracted_text: "The conclusion exists because the measured rationale passed.",
      extracted_text_hash: textDigest("The conclusion exists because the measured rationale passed.")
    }, actor);
    database.prepare("DELETE FROM retrieval_units_fts WHERE tenant_id = ?").run(tenant);
    database.prepare("DELETE FROM retrieval_units WHERE tenant_id = ? AND source_type = 'knowledge_resource_version'").run(tenant);
    database.prepare("DELETE FROM knowledge_resource_versions_fts WHERE tenant_id = ? AND version_id = ?").run(tenant, version.version_id);
    const rebuilt = await captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("a"),
      snapshot_object_ref: "r2://tenant/resource/version",
      extracted_text: "The conclusion exists because the measured rationale passed.",
      extracted_text_hash: textDigest("The conclusion exists because the measured rationale passed.")
    }, actor);
    expect(rebuilt.created).toBe(false);
    expect((database.prepare("SELECT COUNT(*) AS count FROM retrieval_units WHERE tenant_id = ? AND source_id = ?").get(tenant, version.version_id) as { count: number }).count).toBe(1);

    for (const [index, sourceId] of ["d1", "d2", "d3", "d4", "d5"].entries()) {
      await createDecisionResourceLink(env, {
        tenant_id: tenant,
        project_id: sourceId === "d5" ? "project-b" : null,
        decision_ref: { source_type: "decision_rationale", source_id: sourceId },
        resource_id: material.resource.id,
        resource_version_id: version.version_id,
        role: index === 0 ? "conclusion_source" : "rationale_source",
        locator: { line_start: index + 1 },
        excerpt_digest: digest(String(index + 1)),
        idempotency_key: `source-${sourceId}`
      }, actor);
    }
    await createDecisionResourceLink(env, {
      tenant_id: tenant,
      decision_ref: { source_type: "decision_rationale", source_id: "d1" },
      resource_id: material.resource.id,
      resource_version_id: version.version_id,
      role: "rationale_source",
      locator: { heading: "Rationale" },
      excerpt_digest: digest("e"),
      idempotency_key: "rationale-d1"
    }, actor);
    await expect(createDecisionResourceLink(env, {
      tenant_id: tenant,
      decision_ref: { source_type: "decision_rationale", source_id: "d2" },
      resource_id: material.resource.id,
      resource_version_id: version.version_id,
      role: "conclusion_source",
      locator: { line_start: 99 },
      excerpt_digest: digest("9"),
      idempotency_key: "rationale-d1"
    }, actor)).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await createDecisionResourceLink(env, {
      tenant_id: tenant,
      decision_ref: { source_type: "decision_rationale", source_id: "d1" },
      resource_id: material.resource.id,
      resource_version_id: version.version_id,
      role: "output_artifact",
      idempotency_key: "artifact-d1"
    }, actor);
    await createDecisionResourceLink(env, {
      tenant_id: tenant,
      decision_ref: { source_type: "decision_rationale", source_id: "d2" },
      resource_id: material.resource.id,
      resource_version_id: version.version_id,
      role: "verification_artifact",
      idempotency_key: "artifact-d2"
    }, actor);
    await createDecisionResourceLink(env, {
      tenant_id: tenant,
      decision_ref: { source_type: "decision_rationale", source_id: "d1" },
      resource_id: material.resource.id,
      resource_version_id: version.version_id,
      role: "rationale_source",
      confirmation_state: "proposal",
      idempotency_key: "proposal-d1"
    }, actor);

    const replacement = await captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("c"),
      snapshot_object_ref: "r2://tenant/resource/version-2",
      extracted_text: "The replacement no longer contains the original conclusion.",
      extracted_text_hash: textDigest("The replacement no longer contains the original conclusion.")
    }, actor);
    expect(replacement.stale_review_proposals_created).toBe(6);
    const delayedRetry = await captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("a"),
      snapshot_object_ref: "r2://tenant/resource/version",
      extracted_text: "The conclusion exists because the measured rationale passed.",
      extracted_text_hash: textDigest("The conclusion exists because the measured rationale passed.")
    }, actor);
    expect(delayedRetry.current_version_id).toBe(replacement.version_id);
    const outOfOrder = await captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("7"),
      snapshot_object_ref: "r2://tenant/resource/late-old-event",
      extracted_text: "Late old event",
      extracted_text_hash: textDigest("Late old event"),
      captured_at: 1
    }, actor);
    expect(outOfOrder.current_version_id).toBe(replacement.version_id);
    await expect(captureKnowledgeResourceVersion(env, tenant, material.resource.id, {
      connector_id: "test-connector",
      content_hash: digest("a"),
      snapshot_object_ref: "r2://tenant/resource/collision",
      extracted_text: "Different text for the same content hash",
      extracted_text_hash: textDigest("Different text for the same content hash")
    }, actor)).rejects.toMatchObject({ status: 409, code: "content_hash_conflict" });
    const proposalCount = database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_assertions WHERE tenant_id = ? AND confirmation_state = 'proposal'"
    ).get(tenant) as { count: number };
    expect(proposalCount.count).toBe(7);
    const graphEdges = database.prepare(
      "SELECT COUNT(*) AS count FROM confirmed_decision_resource_edges WHERE tenant_id = ?"
    ).get(tenant) as { count: number };
    expect(graphEdges.count).toBe(8);
    const reviewQueue = await listDecisionResourceLinkProposals(env, tenant, { principal: actor });
    const staleConclusion = reviewQueue.items.find((item) =>
      item.context.review_reason === "resource_version_changed" &&
      item.link.decision_ref.source_id === "d1" && item.link.role === "conclusion_source"
    );
    expect(staleConclusion).toBeTruthy();
    const confirmBody = {
      resource_version_id: replacement.version_id,
      locator: { heading: "Updated conclusion" },
      excerpt_digest: digest("f")
    };
    await confirmDecisionResourceLinkProposal(
      env, tenant, staleConclusion!.link.assertion_id, confirmBody, actor, "confirm-stale-d1"
    );
    expect((await confirmDecisionResourceLinkProposal(
      env, tenant, staleConclusion!.link.assertion_id, confirmBody, actor, "confirm-stale-d1"
    )).created).toBe(false);
    await expect(confirmDecisionResourceLinkProposal(env, tenant, staleConclusion!.link.assertion_id, {
      ...confirmBody,
      locator: { heading: "Different retry payload" }
    }, actor, "confirm-stale-d1")).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect((await listDecisionResourceLinkProposals(env, tenant, { principal: actor })).items).toHaveLength(6);

    const reasons = await getResourceDecisions(env, tenant, material.resource.id, { principal: actor });
    expect(reasons.resource.lifecycle_state).toBe("stale");
    expect(reasons.coverage.target_resource_version_id).not.toBe(version.version_id);
    expect(reasons.decisions).toHaveLength(5);
    expect(reasons.decisions.find((item) => item.decision_ref.source_id === "d1")?.reason_items).toHaveLength(2);
    expect(reasons.decisions.find((item) => item.decision_ref.source_id === "d1")?.reason_items.map((item) => item.role).sort())
      .toEqual(["conclusion_source", "rationale_source"]);
    expect(reasons.decisions.flatMap((item) => item.reason_items).some((item) => item.confirmation_state === "proposal")).toBe(false);
    const filteredReasons = await getResourceDecisions(env, tenant, material.resource.id, { principal: "user:2" });
    expect(filteredReasons.decisions.map((item) => item.decision_ref.source_id)).not.toContain("d4");
    const projectFiltered = await getResourceDecisions(env, tenant, material.resource.id, { principal: actor, projectId: "project-a" });
    expect(projectFiltered.decisions.map((item) => item.decision_ref.source_id)).not.toContain("d5");
    await expect(getDecisionResources(env, tenant, {
      source_type: "decision_rationale",
      source_id: "d4"
    }, { principal: "user:2" })).rejects.toMatchObject({ status: 404 });

    const artifacts = await getDecisionResources(env, tenant, {
      source_type: "decision_rationale",
      source_id: "d1"
    }, { principal: actor });
    expect(artifacts.artifacts.map((item) => item.link.role)).toEqual(["output_artifact"]);
    expect(artifacts.artifacts_by_role.output_artifact).toHaveLength(1);
    const relatedArtifacts = await getDecisionResources(env, tenant, {
      source_type: "decision_rationale",
      source_id: "d1"
    }, { principal: actor, includeRelated: true });
    expect(relatedArtifacts.artifacts.some((item) => item.related_via?.decision_ref.source_id === "d2")).toBe(true);

    const search = await searchKnowledgeResources(env, { tenant_id: tenant, q: "measured rationale" }, { principal: actor });
    expect(search.items.map((item) => item.id)).toContain(material.resource.id);
    const materialHit = search.items.find((item) => item.id === material.resource.id)?.search_hits[0];
    expect(materialHit?.resource_version_id).toBe(version.version_id);
    expect(materialHit?.locator.selector).toMatch(/^char=/u);
    expect((await resolveKnowledgeResource(env, tenant, "https://example.com/material#other", { principal: actor })).id)
      .toBe(material.resource.id);
    const alias = await addKnowledgeResourceLocation(env, {
      tenant_id: tenant,
      resource_id: material.resource.id,
      uri: "https://mirror.example.com/material#copy",
      location_role: "mirror"
    }, actor);
    expect(alias.created).toBe(true);
    expect((await resolveKnowledgeResource(env, tenant, "https://mirror.example.com/material#new", { principal: actor })).id)
      .toBe(material.resource.id);

    const restricted = await upsertKnowledgeResource(env, {
      tenant_id: tenant,
      resource_kind: "report",
      canonical_uri: "https://example.com/restricted",
      title: "Restricted",
      source_system: "test",
      media_type: "text/plain",
      visibility: "restricted"
    }, actor);
    await expect(resolveKnowledgeResource(env, tenant, restricted.resource.canonical_uri, { principal: "user:2" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(upsertKnowledgeResource(env, {
      tenant_id: tenant,
      resource_kind: "document",
      canonical_uri: "https://127.0.0.1/admin",
      title: "Private endpoint",
      source_system: "test",
      media_type: "text/plain",
      connector_id: "test-connector",
      fetch_enabled: true
    }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(upsertKnowledgeResource(env, {
      tenant_id: tenant,
      resource_kind: "document",
      canonical_uri: "https://example.com/untrusted",
      title: "Untrusted connector",
      source_system: "test",
      media_type: "text/plain",
      connector_id: "untrusted-connector",
      fetch_enabled: true
    }, actor)).rejects.toMatchObject({ status: 403, code: "connector_not_allowed" });
  });

  it("backfills legacy docs, evidence, and source refs resumably without collapsing N:N links", async () => {
    const { database, env } = testEnv();
    const tenant = "tenant-backfill";
    const actor = "operator:1";
    database.prepare(
      "INSERT INTO knowledge_docs(id, tenant_id, kind, title, summary, body_text, visibility, owner_principal, updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run("doc-1", tenant, "doc", "Runbook", "summary", "stable body", "tenant", null, 100);
    for (const id of ["r1", "r2"]) {
      database.prepare("INSERT INTO memories(id, tenant_id, permissions_json) VALUES(?,?,?)").run(`m-${id}`, tenant, "[]");
      database.prepare(
        "INSERT INTO decision_rationales(id, tenant_id, memory_id, project_id, conclusion, reason_summary, confirmation_state) VALUES(?,?,?,?,?,?,?)"
      ).run(id, tenant, `m-${id}`, "project-1", `Conclusion ${id}`, `Reason ${id}`, "reviewed");
      database.prepare(
        "INSERT INTO decision_evidence(id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, created_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(`e-${id}`, tenant, id, "doc", "ADR-42", "supports", `Evidence ${id}`, 101);
    }
    database.prepare(
      "INSERT INTO decision_evidence(id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, created_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run("e-r1-second", tenant, "r1", "doc", "ADR-42", "supports", "Second location note", 102);
    database.prepare(
      "INSERT INTO decision_memories(id, tenant_id, project_id, source_refs_json, confirmation_state) VALUES(?,?,?,?,?)"
    ).run("dm-1", tenant, "project-1", JSON.stringify([
      { type: "issue", id: "ISSUE-7", title: "Issue seven" },
      { type: "doc", url: "https://example.com/design", title: "Design" }
    ]), "reviewed");

    for (const stage of ["knowledge_docs", "decision_evidence", "decision_memory_sources"] as const) {
      const first = await backfillKnowledgeResources(env, { tenant_id: tenant, stage, limit: 50 }, actor);
      expect(first.done).toBe(true);
      expect(first.processed).toBeGreaterThan(0);
      const resumed = await backfillKnowledgeResources(env, { tenant_id: tenant, stage, cursor: first.cursor, limit: 50 }, actor);
      expect(resumed.processed).toBe(0);
      expect(resumed.done).toBe(true);
      const replayed = await backfillKnowledgeResources(env, { tenant_id: tenant, stage, limit: 50 }, actor);
      expect(replayed.processed).toBe(first.processed);
      expect(replayed.output_counts).toEqual({ resources_created: 0, versions_created: 0, links_created: 0, evidence_attached: 0 });
    }

    const evidenceResources = database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_resources WHERE tenant_id = ? AND source_system = 'decision_evidence'"
    ).get(tenant) as { count: number };
    expect(evidenceResources.count).toBe(1);
    const evidenceLinks = database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_assertions WHERE tenant_id = ? AND predicate = 'rationale_source' AND confirmation_state = 'confirmed'"
    ).get(tenant) as { count: number };
    expect(evidenceLinks.count).toBe(2);
    const evidenceVersions = database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_assertion_evidence WHERE tenant_id = ?"
    ).get(tenant) as { count: number };
    expect(evidenceVersions.count).toBe(3);
    const sourceLinks = database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_assertions WHERE tenant_id = ? AND subject_type = 'decision_memory' AND predicate = 'input'"
    ).get(tenant) as { count: number };
    expect(sourceLinks.count).toBe(2);
  });
});
