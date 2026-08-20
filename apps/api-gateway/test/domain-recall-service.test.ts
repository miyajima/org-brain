import { describe, expect, it } from "vitest";
import {
  applyPortableImport,
  createPortableImport,
  getDomainRecall,
  getDomainRecallById,
  planPortableImport,
  putPortableImportChunk,
  recordDomainRecallFeedback
} from "../src/domain-recall-service";
import type { Env } from "../src/types";

type SqliteStatement = { all: (...args: unknown[]) => Record<string, unknown>[]; get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => { changes?: number | bigint } };
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
const { readFileSync } = runtime.getBuiltinModule("node:fs") as { readFileSync: (path: string | URL, encoding: string) => string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function portableArchive(payload: Record<string, unknown>) {
  const record = {
    contract_version: "orgbrain-portable-archive/v1",
    record_type: "record",
    section: "recall_preferences",
    id: "preference:user:alice:unit-sre",
    version: 1,
    digest: await digest(JSON.stringify(canonical(payload))),
    payload
  };
  const contentDigest = await digest(`${JSON.stringify(canonical(record))}\n`);
  return [
    JSON.stringify({ contract_version: "orgbrain-portable-archive/v1", record_type: "header", archive_id: "archive-recall-preference" }),
    JSON.stringify(record),
    JSON.stringify({ contract_version: "orgbrain-portable-archive/v1", record_type: "footer", archive_id: "archive-recall-preference", record_count: 1, content_digest: contentDigest })
  ].join("\n");
}

class Statement {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[] }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0029_mcp_client_installations.sql", "0034_domain_pack_platform.sql", "0036_domain_recall.sql"]) {
    database.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const manifest = JSON.parse(readFileSync(new URL("../../../domain-packs/first-party/sre/manifest.json", import.meta.url), "utf8"));
  database.prepare("INSERT INTO domain_pack_releases(id, pack_id, version, classification, visibility, manifest_digest, manifest_json, publisher_id, license_id, status, created_at) VALUES('release-sre','function.sre','1.1.0','function','first_party','digest',?,'orgbrain','Apache-2.0','active',1)").run(JSON.stringify(manifest));
  database.exec("INSERT INTO domain_pack_installations(id, tenant_id, release_id, pack_id, version, manifest_digest, state, installed_by, installed_at, updated_at) VALUES('install-sre','tenant-a','release-sre','function.sre','1.1.0','digest','installed','user:admin',1,1)");
  database.prepare(
    `INSERT INTO domain_recall_units(id, tenant_id, project_id, pack_id, object_type_key, object_id, intent_aliases_json,
      scope_json, relation, decision_json, metrics_json, evidence_json, workflow, evidence_verified, metric_fresh,
      visibility, owner_principal, allowed_principals_json, search_text, content_digest, created_at, updated_at)
     VALUES('unit-sre','tenant-a','payments','function.sre','service','payments-api','["timeout"]',?,'primary',?, ?, ?,
      'service-degradation-response',1,1,'project','user:alice','[]','payments-api timeout retry','digest',1,1)`
  ).run(
    JSON.stringify({ service: "payments-api", dependency: "fraud-provider" }),
    JSON.stringify({ source_type: "decision_memory", id: "DEC-SRE-INC-0042", statement: "retry上限を2回にしてcircuit breakerを有効化する", rationale: "retry amplification", confirmation_state: "confirmed" }),
    JSON.stringify([{ metric_key: "error_budget_burn_rate", role: "outcome", value: 0.6, unit: "ratio", state: "measured", expires_at: 9_999_999_999_999 }]),
    JSON.stringify([{ id: "incident-report", title: "INC-0042", source: "Incident Management", resource_kind: "report", verification_state: "verified", body: "secret body" }])
  );
  const prepare = (sql: string) => new Statement(database, sql);
  return {
    database,
    env: {
      DOMAIN_RECALL_MODE: "on",
      OPEN_BRAIN_DB: {
        prepare,
        batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run()))
      }
    } as unknown as Env
  };
}

describe("Cloud Domain Recall", () => {
  it("requires exact high-assurance scope and stores only a query hash", async () => {
    const ctx = fixture();
    const input = { tenant_id: "tenant-a", project_id: "payments", query: "payments-apiでtimeout延長を検討", object_type_key: "service", object_id: "payments-api", scope: { service: "payments-api", dependency: "fraud-provider" } };
    const result = await getDomainRecall(ctx.env, input, { ownerPrincipal: "user:alice", runtimeActor: "client:recall-1", clientInstallationId: "recall-1" });
    const primary = result.bundle?.primary as { decision: { id: string }; evidence: Array<Record<string, unknown>> } | null | undefined;
    expect(result.inject).toBe(true);
    expect(primary?.decision.id).toBe("DEC-SRE-INC-0042");
    expect(primary?.evidence[0]).not.toHaveProperty("body");
    expect(JSON.stringify(result.bundle).length).toBeLessThan(6 * 1024);
    const event = ctx.database.prepare("SELECT query_hash, bundle_json FROM domain_recall_events WHERE id=?").get(result.bundle?.id);
    expect(event?.query_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(event)).not.toContain(String(input.query));
    expect(ctx.database.prepare("SELECT pack_id, role, score FROM domain_recall_event_candidates WHERE recall_id=?").get(result.bundle?.id)).toMatchObject({ pack_id: "function.sre", role: "primary" });
    await expect(getDomainRecallById(ctx.env, "tenant-a", String(result.bundle?.id), "user:bob")).rejects.toMatchObject({ status: 404 });
    await expect(getDomainRecallById(ctx.env, "tenant-a", String(result.bundle?.id), "user:alice")).resolves.toMatchObject({ id: result.bundle?.id });
    const wrong = await getDomainRecall(ctx.env, { ...input, scope: { ...input.scope, dependency: "search" } }, { ownerPrincipal: "user:alice" });
    expect(wrong.bundle?.primary).toBeNull();
    const bounded = await getDomainRecall(ctx.env, { ...input, max_tokens: 256 }, { ownerPrincipal: "user:alice" });
    expect(new TextEncoder().encode(JSON.stringify(bounded.bundle)).byteLength).toBeLessThanOrEqual(1_024);
  });

  it("turns incorrect relation feedback into review without mutating the unit", async () => {
    const ctx = fixture();
    const recall = await getDomainRecall(ctx.env, { tenant_id: "tenant-a", project_id: "payments", query: "payments-api timeout", object_type_key: "service", object_id: "payments-api", scope: { service: "payments-api", dependency: "fraud-provider" } }, { ownerPrincipal: "user:alice" });
    const feedback = await recordDomainRecallFeedback(ctx.env, "tenant-a", String(recall.bundle?.id), { feedback: "incorrect_relation", candidate_id: "unit-sre" }, { ownerPrincipal: "user:alice", runtimeActor: "client:recall-1" });
    expect(feedback).toMatchObject({ effect: "team_review_proposal", assertion_mutated: false });
    expect(ctx.database.prepare("SELECT COUNT(*) AS count FROM domain_recall_review_proposals").get()?.count).toBe(1);
    expect(ctx.database.prepare("SELECT COUNT(*) AS count FROM domain_recall_units").get()?.count).toBe(1);
  });

  it("plans and applies portable records idempotently and rejects digest conflicts", async () => {
    const ctx = fixture();
    const payload = { principal: "user:alice", candidate_id: "unit-sre", state: "suppressed", reason: "wrong_scope", updated_at: 10 };
    const archive = await portableArchive(payload);
    const first = await createPortableImport(ctx.env, "tenant-a", "user:admin", {});
    await putPortableImportChunk(ctx.env, "tenant-a", first.id, 0, { chunk: archive });
    await expect(planPortableImport(ctx.env, "tenant-a", first.id)).resolves.toMatchObject({ applicable: true, actions: [{ action: "apply" }] });
    await expect(applyPortableImport(ctx.env, "tenant-a", first.id)).resolves.toMatchObject({ applied_count: 1, materialized: true });
    expect(ctx.database.prepare("SELECT state, reason FROM domain_recall_preferences WHERE tenant_id='tenant-a' AND principal='user:alice' AND candidate_id='unit-sre'").get()).toMatchObject({ state: "suppressed", reason: "wrong_scope" });

    const replay = await createPortableImport(ctx.env, "tenant-a", "user:admin", {});
    await putPortableImportChunk(ctx.env, "tenant-a", replay.id, 0, { chunk: archive });
    await expect(applyPortableImport(ctx.env, "tenant-a", replay.id)).resolves.toMatchObject({ applied_count: 0, actions: [{ action: "skip_same_digest" }] });

    const conflicting = await createPortableImport(ctx.env, "tenant-a", "user:admin", {});
    await putPortableImportChunk(ctx.env, "tenant-a", conflicting.id, 0, { chunk: await portableArchive({ ...payload, state: "active" }) });
    await expect(planPortableImport(ctx.env, "tenant-a", conflicting.id)).resolves.toMatchObject({ applicable: false, actions: [{ action: "reject_digest_conflict" }] });
    await expect(applyPortableImport(ctx.env, "tenant-a", conflicting.id)).rejects.toMatchObject({ status: 409, code: "digest_conflict" });
  });
});
