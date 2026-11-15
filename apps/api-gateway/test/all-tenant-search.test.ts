import { describe, expect, it, vi } from "vitest";
import { memoryD1Fixture, readMemoryMigration } from "./fixtures/memory-d1";
import { searchMemories } from "../src/memory-search-service";
import { searchDecisionMemories } from "../src/context-engine-service";
import { searchKnowledgeDocs } from "../src/knowledge-docs-service";
import worker from "../src/index";
import { finishAllTenantSearch } from "../src/all-tenant-search";
import { retrieveMemoryContext } from "../src/memory-context-service";

describe("all tenant search", () => {
  it("does not enable sharing over a pre-existing all tenant's data", () => {
    const { sql } = memoryD1Fixture(50);
    try {
      sql.exec("INSERT INTO memories(id,tenant_id,content,source,created_at) VALUES ('old','all','Private record','test',1)");
      expect(() => sql.exec(readMemoryMigration("0051_all_tenant.sql"))).toThrow(/CHECK constraint failed/);
      expect(sql.prepare("SELECT content FROM memories WHERE id='old'").get()).toMatchObject({ content: "Private record" });
      expect(sql.prepare("SELECT name FROM sqlite_master WHERE name='all_knowledge_fts'").get()).toBeUndefined();
    } finally { sql.close(); }
  });

  it("allows an explicit shared write for contributors, gives readers details, and bars arbitrary targets", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      env.API_RATE_LIMIT_FAIL_OPEN = "true";
      env.API_TENANT_POLICY_JSON = JSON.stringify({ keys: [
        { key: "writer-key", principal: "writer", tenants: ["a"], role: "contributor" },
        { key: "reader-key", principal: "reader", tenants: ["b"], role: "reader" },
        { key: "other-writer-key", principal: "other-writer", tenants: ["b"], role: "contributor" }
      ] });
      const request = (path: string, key: string, body?: object) => worker.fetch(
        new Request("https://test.invalid" + path, {
          method: body ? "POST" : "GET", headers: { "x-api-key": key, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined
        }), env, {} as ExecutionContext
      );
      const payload = { target_tenant_id: "all", source: "manual", items: [{ external_key: "checklist", content: "Kumquat checklist" }] };
      expect((await request("/v1/memories/upsert", "reader-key", { ...payload, tenant_id: "b" })).status).toBe(403);
      expect((await request("/v1/memories/upsert", "writer-key", { ...payload, tenant_id: "a", target_tenant_id: "b" })).status).toBe(400);
      const response = await request("/v1/memories/upsert", "writer-key", { ...payload, tenant_id: "a" });
      expect(response.status, await response.clone().text()).toBe(201);
      const row = sql.prepare("SELECT id, tenant_id, project_id FROM memories WHERE external_key='checklist'").get();
      expect(row).toMatchObject({ tenant_id: "all", project_id: null });
      const detail = await request(`/v1/memories/${row.id}/details?tenant_id=b&target_tenant_id=all`, "reader-key");
      expect(detail.status, await detail.clone().text()).toBe(200);
      expect(await detail.json()).toMatchObject({ data: { tenant_id: "all", memory: { id: row.id } } });
      expect((await request(`/v1/memories/${row.id}/details?tenant_id=b&target_tenant_id=all&expected_version=2`, "reader-key")).status).toBe(409);
      expect((await request("/v1/memories/upsert?tenant_id=a", "writer-key", { ...payload, tenant_id: "b" })).status).toBe(403);
      expect((await request("/v1/memories/upsert", "writer-key", {
        ...payload, tenant_id: "a", items: [{ ...payload.items[0], scope_type: "project" }]
      })).status).toBe(400);
      expect((await request("/v1/organization?tenant_id=all", "reader-key")).status).toBe(403);
      const decision = await request("/v1/decision-memories", "writer-key", {
        tenant_id: "a", target_tenant_id: "all", title: "Kumquat rule", decision: "Use kumquat",
        rationale: "Documented checklist", source_refs: [{id: "guide", title: "Restricted source", allowedPrincipals: ["writer"]}]
      });
      expect(decision.status, await decision.clone().text()).toBe(201);
      const decisionId = (await decision.json() as {data: {decisionMemory: {id: string}}}).data.decisionMemory.id;
      const revise = `/v1/decision-memories/${decisionId}/revise?tenant_id=a&target_tenant_id=all`;
      const confirm = `/v1/decision-memories/${decisionId}/confirm?tenant_id=a&target_tenant_id=all`;
      expect((await request(revise, "writer-key", { constraints: ["Contact fixture@example.invalid"] })).status).toBe(400);
      expect((await request(confirm, "writer-key", { confirmation_note: "Contact fixture@example.invalid" })).status).toBe(400);
      expect((await request(confirm, "writer-key", { confirmation_note: "Reviewed" })).status).toBe(200);
      const decisionDetail = await request(`/v1/decision-memories/${decisionId}/context?tenant_id=b&target_tenant_id=all`, "reader-key");
      expect(decisionDetail.status).toBe(200);
      expect(await decisionDetail.text()).not.toContain("Restricted source");
      const revision = await request(revise.replace("tenant_id=a", "tenant_id=b"), "other-writer-key", {
        title: "Kumquat guide"
      });
      expect(revision.status).toBe(200);
      expect(await revision.text()).not.toContain("Restricted source");
      expect((await request("/v1/decision-memories/search", "reader-key", {
        tenant_id: "b", orgId: "a", q: "kumquat"
      })).status).toBe(403);
      const docPayload = {
        target_tenant_id: "all", title: "Kumquat notes", slug: "kumquat", scope: "org", kind: "doc",
        markdown: "---\nid: kumquat-doc\ntitle: Kumquat notes\nscope: org\nkind: doc\nstability: stable\nupdated_at: 2026-01-01\n---\n\n# Kumquat notes\n\nShared notes."
      };
      expect((await request("/v1/docs", "reader-key", { ...docPayload, tenant_id: "b" })).status).toBe(403);
      expect((await request("/v1/docs", "writer-key", { ...docPayload, tenant_id: "a", visibility: "restricted" })).status).toBe(400);
      expect((await request("/v1/docs", "writer-key", { ...docPayload, tenant_id: "a", slug: "fixture@example.invalid" })).status).toBe(400);
      const doc = await request("/v1/docs", "writer-key", { ...docPayload, tenant_id: "a" });
      expect(doc.status, await doc.clone().text()).toBe(201);
      expect((await request("/v1/docs/kumquat?tenant_id=b", "reader-key")).status).toBe(404);
      expect((await request("/v1/docs/kumquat?tenant_id=b&target_tenant_id=all", "reader-key")).status).toBe(200);
    } finally { sql.close(); }
  });
  it("searches global and authorized tenant memories, and attributes usage to the caller", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      sql.exec(`
        INSERT INTO memories(id,tenant_id,project_id,content,source,created_at,scope_type,lifecycle_state,current_version,tags_json)
        VALUES ('own','a','p','kumquat checklist','test',1,'project','active',1,'["curated-memory"]'),
               ('global','all',NULL,'kumquat checklist','test',1,'tenant','active',1,'[]'),
               ('foreign','b','p','kumquat checklist','test',1,'project','active',1,'["curated-memory"]'),
               ('hidden','all','p','kumquat checklist','test',1,'project','active',1,'[]'),
               ('suppressed','all',NULL,'kumquat checklist','test',1,'tenant','suppressed',1,'[]');
        INSERT INTO memories_fts(memory_id,tenant_id,content)
        SELECT id,tenant_id,content FROM memories WHERE id IN ('own','foreign');
      `);
      const result = await searchMemories(env, { tenant_id: "a", project_id: "p", q: "kumquat", search_mode: "memories" }, {
        actorPrincipal: "reader", allowedProjectId: "p"
      });
      expect(result.results).toEqual([
        expect.objectContaining({ id: "own", tenant_id: "a" }),
        expect.objectContaining({ id: "global", tenant_id: "all" })
      ]);
      const mine = await searchMemories(env, { tenant_id: "a", project_id: "p", q: "kumquat", scope: "mine", search_mode: "memories" }, {
        actorPrincipal: "reader", allowedProjectId: "p", recordUsage: false
      });
      expect(mine.results.some((item) => item.tenant_id === "all")).toBe(false);
      expect(sql.prepare("SELECT tenant_id,source_tenant_id FROM memory_usage_items WHERE source_id='global'").get())
        .toEqual({ tenant_id: "a", source_tenant_id: "all" });
      const context = await retrieveMemoryContext(env, { tenant_id: "c", q: "kumquat", search_mode: "memories" });
      expect(context.results).toMatchObject([{ id: "global", tenant_id: "all" }]);
      expect(context.meta.usage_items).toMatchObject([{ source_id: "global", source_tenant_id: "all" }]);
    } finally { sql.close(); }
  });

  it("searches shared decisions and documents across projects without including other tenants", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      sql.exec(`
        INSERT INTO decision_memories(id,tenant_id,title,decision,rationale,source_refs_json,confirmation_state,confirmed_at,created_at,updated_at)
        VALUES ('shared-d','all','Kumquat procedure','Use kumquat','A documented reason','[{"type":"doc","id":"source","title":"Source"}]','reviewed',1,1,1),
               ('other-d','b','Kumquat procedure','Use kumquat','A documented reason','[{"type":"doc","id":"source","title":"Source"}]','reviewed',1,1,1);
        INSERT INTO knowledge_docs(id,tenant_id,scope,kind,title,slug,frontmatter,body_text,created_at,updated_at)
        VALUES ('shared-doc','all','org','doc','Kumquat guide','kumquat',
                 '{"id":"shared-doc","title":"Kumquat guide","scope":"org","kind":"doc","stability":"stable","updated_at":"2026-01-01"}',
                 'Kumquat instructions',1,1);
      `);
      const request = { tenant_id: "a", project_id: "p", q: "kumquat" };
      expect((await searchDecisionMemories(env, request)).results).toMatchObject([{ id: "shared-d", tenant_id: "all" }]);
      expect((await searchKnowledgeDocs(env, request)).results).toMatchObject([{ id: "shared-doc", tenant_id: "all" }]);
      sql.exec("UPDATE decision_memories SET visibility='restricted' WHERE id='shared-d'; UPDATE knowledge_docs SET title='Fennel', body_text='Fennel instructions' WHERE id='shared-doc'");
      expect((await searchDecisionMemories(env, request)).results).toEqual([]);
      expect((await searchKnowledgeDocs(env, request)).results).toEqual([]);
      expect((await searchKnowledgeDocs(env, { ...request, q: "fennel" })).results).toMatchObject([{ id: "shared-doc" }]);
    } finally { sql.close(); }
  });

  it("returns ordinary results and reports an incomplete shared search when the shared index fails", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      sql.exec(`
        INSERT INTO memories(id,tenant_id,content,source,created_at,tags_json)
          VALUES ('ordinary','a','kumquat checklist','test',1,'["curated-memory"]');
        INSERT INTO memories_fts(memory_id,tenant_id,content) VALUES ('ordinary','a','kumquat checklist');
        DROP TABLE all_knowledge_fts;
      `);
      const response = await searchMemories(env, { tenant_id: "a", q: "kumquat" }, { recordUsage: false });
      expect(response.meta).toMatchObject({ shared_search: "incomplete" });
      expect(response.results).toMatchObject([{ id: "ordinary" }]);
    } finally { sql.close(); }
  });

  it("bounds time spent waiting for the shared index after ordinary retrieval", async () => {
    vi.useFakeTimers();
    try {
      const result = finishAllTenantSearch(new Promise<never>(() => {}));
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toEqual({ rows: [], shared_search: "incomplete" });
    } finally { vi.useRealTimers(); }
  });
});
