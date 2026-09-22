import { describe, expect, it } from "vitest";
import { memoryReadAccessSql, buildTenantMemoryProfile, searchTenantMemories } from "@org-brain/shared";
import { getMemoryDetails, listMemoriesPage, listMemoriesCursorPage } from "../src/memory-service";
import type { Env } from "../src/types";
const runtime = (globalThis as unknown as { process: { getBuiltinModule(name: string): any } }).process;
const { DatabaseSync } = runtime.getBuiltinModule('node:sqlite');
const { readFileSync, readdirSync } = runtime.getBuiltinModule('node:fs');

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../../../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name: string) => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const database = { prepare(query: string) {
    let args: any[] = [];
    return { bind(...values: any[]) { args = values; return this; },
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }, async batch(statements: any[]) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, env: { OPEN_BRAIN_DB: database } as unknown as Env };
}


function seed(sql: any, id: string, owner: string, policy?: string) {
  sql.prepare(`INSERT INTO memories(id,tenant_id,project_id,content,summary,tags_json,source,created_at,owner_principal,scope_type,scope_key)
    VALUES(?, 'default', 'p', ?, ?, '["curated-memory"]', 'test', ?, ?, 'tenant', 'default')`).run(id, `unique searchable lesson ${id}`, `unique searchable lesson ${id}`, Date.now() - 172800000, owner);
  sql.prepare(`INSERT INTO memories_fts(memory_id,tenant_id,content) VALUES(?, 'default', ?)`).run(id, `unique searchable lesson ${id}`);
  if (policy) sql.prepare(`INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,project_id,created_by_principal,created_at,updated_at)
    VALUES(?, 'default', 'memory', ?, ?, ?, 'p', ?, 1, 1)`).run(id, id, policy, owner, owner);
}

describe("memory read consistency on migrated SQLite", () => {
  it("excludes private data before paging, totals, search and profiles; details match absent data", async () => {
    const { sql, env } = fixture();
    try {
      seed(sql, "private", "alice", "private");
      seed(sql, "public", "alice", "tenant");
      sql.exec("INSERT INTO memory_versions(id,memory_id,tenant_id,version,operation,content,summary,kind,lifecycle_state,scope_type,created_at) VALUES('v','private','default',1,'capture','secret version','secret','fact','active','user',1)");
      const readAccess = { principal: "bob" };
      const page = await listMemoriesPage(env, "default", { readAccess, limit: 1 });
      expect(page.items.map((m) => m.id)).toEqual(["public"]);
      expect(page.meta.total).toBe(1);
      const cursor = await listMemoriesCursorPage(env, "default", { readAccess, limit: 1 });
      expect(cursor.items.map((m) => m.id)).toEqual(["public"]);
      expect(cursor.next_cursor).toBeNull();
      expect(await getMemoryDetails(env, "default", "private", { actorPrincipal: "bob", recordUsage: false })).toMatchObject({ memory: null, versions: [], rationales: [] });
      const profile = await buildTenantMemoryProfile(env.OPEN_BRAIN_DB, { tenantId: "default", readAccess });
      expect(profile.durable.map((m) => m.id)).toEqual(["public"]);
      const result = await searchTenantMemories(env.OPEN_BRAIN_DB, { tenantId: "default", q: "searchable", readAccess, limit: 1 });
      expect(result.results.map((m) => m.id)).toEqual(["public"]);
      expect((await listMemoriesPage(env, "default", { readAccess: { principal: "alice" } })).meta.total).toBe(2);
      expect((await listMemoriesPage(env, "default", { readAccess: { principal: "admin", isAdmin: true } })).meta.total).toBe(2);
    } finally { sql.close(); }
  });
  it("uses live project/group membership, canonical precedence, legacy grants and mine scope", () => {
    const { sql } = fixture();
    try {
      seed(sql, "project", "alice", "project"); seed(sql, "group", "alice", "group");
      seed(sql, "legacy", "bob"); seed(sql, "denied", "alice", "private");
      sql.exec(`UPDATE resource_access_policies SET group_ids_json='["g"]' WHERE id='group';
        INSERT INTO group_members(tenant_id,group_id,principal,role,created_at,updated_at) VALUES('default','g','bob','member',1,1);
        INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES('r','default','p','bob','reader','alice',1,1);`);
      const ids = (scope?: "mine") => sql.prepare(`SELECT id FROM memories m WHERE ${memoryReadAccessSql("m", { principal: "bob", scope })} ORDER BY id`).all().map((row: any) => row.id);
      expect(ids()).toEqual(["group", "legacy", "project"]);
      expect(ids("mine")).toEqual(["legacy"]);
      sql.exec("DELETE FROM group_members; DELETE FROM principal_role_assignments;");
      expect(ids()).toEqual(["legacy"]);
      expect(sql.prepare(`SELECT id FROM memories m WHERE ${memoryReadAccessSql("m", { principal: "bob' OR 1=1 --" })}`).all().map((row: any) => row.id)).toEqual(["legacy"]);
    } finally { sql.close(); }
  });
});

it("honors explicit legacy grants, restricted policies and scoped token boundaries", () => {
  const { sql } = fixture();
  try {
    seed(sql, "principal-grant", "alice"); seed(sql, "tenant-grant", "alice"); seed(sql, "private-legacy", "alice");
    seed(sql, "malformed", "alice"); seed(sql, "restricted", "alice", "restricted"); seed(sql, "project-token", "alice", "project");
    sql.exec(`UPDATE memories SET permissions_json='[{"principal_type":"principal","principal_id":"bob","permissions":["read"]}]' WHERE id='principal-grant';
      UPDATE memories SET permissions_json='[{"principal_type":"tenant","principal_id":"default","permissions":["read"]}]' WHERE id='tenant-grant';
      UPDATE memories SET scope_type='user',scope_key='alice' WHERE id='private-legacy';
      UPDATE memories SET permissions_json='invalid' WHERE id='malformed';
      UPDATE resource_access_policies SET restricted_subjects_json='[{"subject_type":"principal","subject_id":"bob"}]' WHERE id='restricted';`);
    const ids = (access: any) => sql.prepare(`SELECT id FROM memories m WHERE ${memoryReadAccessSql("m", access)} ORDER BY id`).all().map((row: any) => row.id);
    expect(ids({ principal: "bob" })).toEqual(["principal-grant", "restricted", "tenant-grant"]);
    expect(ids({ principal: "bob", allowedProjectId: "p" })).toEqual(["principal-grant", "project-token", "restricted", "tenant-grant"]);
    expect(ids({ principal: "alice", isAdmin: true, allowedProjectId: "other" })).toEqual([]);
  } finally { sql.close(); }
});

it("keeps ACL-filtered pagination and counts bounded with 100k rows", async () => {
  const { sql, env } = fixture();
  try {
    sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
      INSERT INTO memories(id,tenant_id,content,summary,source,created_at,owner_principal,scope_type,scope_key)
      SELECT 'scale-'||n,'default','test','test','test',n,'alice','user',CASE WHEN n=1 THEN 'bob' ELSE 'alice' END FROM seq;`);
    const timings: number[] = [];
    for (let sample=0; sample<5; sample++) {
      const start = performance.now();
      const page = await listMemoriesPage(env, "default", { readAccess: { principal: "bob" }, limit: 1 });
      timings.push(performance.now()-start);
      expect(page.meta.total).toBe(1);
      expect(page.items.map((row) => row.id)).toEqual(["scale-1"]);
    }
    const maximum = Math.max(...timings);
    console.info("memory-acl-pagination", JSON.stringify({ rows: 100000, samples: timings.length, max_ms: Math.round(maximum) }));
    expect(maximum).toBeLessThan(2000);
  } finally { sql.close(); }
});
