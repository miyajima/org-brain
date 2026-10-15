import { describe, expect, it, vi } from "vitest";
import { searchTenantRetrievalUnitsV3, searchTenantRetrievalUnitsV4 } from "@org-brain/shared";
import type { Env } from "../src/types";

const provider = vi.hoisted(() => ({ hits: [] as Array<{ id: string; score: number }>, scores: new Map<string, number>(), seen: [] as string[], afterRerank: null as (() => void) | null }));
vi.mock("../src/business-category-service", () => ({ validateBusinessClassification: vi.fn() }));
vi.mock("../src/retrieval-generation-service", () => ({
  resolveRetrievalGenerationAssignment: async () => ({ active_generation_id: "fixture", shadow_generation_id: null }),
  loadRetrievalGenerationProfile: async () => ({ id: "fixture", unit_schema_version: 2, extractor_name: "fixture", extractor_version: "1",
    embedding_profile_id: "fixture", ranking_profile_id: "fixture", ranking_algorithm: "reciprocal_rank_fusion", ranking_config_json: "{}" })
}));
vi.mock("../src/retrieval-index-service", () => ({
  searchRetrievalGenerationSemanticIndex: async () => ({ hits: provider.hits, provider: "fixture" }),
  rerankV3MemoryCandidates: async (_env: unknown, _q: unknown, candidates: Array<{ id: string }>) => {
    provider.seen = candidates.map((candidate) => candidate.id);
    provider.afterRerank?.();
    return { scores: provider.scores, provider: "fixture" };
  }
}));
vi.mock("../src/memory-integrity-service", () => ({ annotateMemorySearchIntegrity: async (_env: unknown, _tenant: unknown, rows: unknown[]) => rows }));
import { searchMemories } from "../src/memory-search-service";

const { readFileSync, readdirSync } = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: string): string; readdirSync(path: string): string[];
};
const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): void }; close(): void }
};

function fixture() {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync("../../migrations").filter((file) => file.endsWith(".sql")).sort()) sql.exec(readFileSync(`../../migrations/${file}`, "utf8"));
  const db = { prepare(query: string) { return { args: [] as unknown[], bind(...args: unknown[]) { this.args = args; return this; },
    async all() { return { results: sql.prepare(query).all(...this.args) }; } }; } };
  const add = (id: string, units = 1, extra: { project?: string; state?: string; permissions?: string; unitUntil?: number } = {}) => {
    sql.prepare(`INSERT INTO memories (id,tenant_id,project_id,content,created_at,source,current_version,lifecycle_state,permissions_json,owner_principal)
      VALUES (?, 't', ?, 'cache repair staging evidence', 1, 'fixture', 1, ?, ?, ?)`)
      .run(id, extra.project ?? "p", extra.state ?? "active", extra.permissions ?? "[]", id === "denied" ? "bob" : "alice");
    for (let index = 0; index < units; index++) {
      const unit = `${id}-${index}`;
      sql.prepare(`INSERT INTO retrieval_units (id,generation_id,tenant_id,project_id,source_type,source_id,unit_type,text,content_hash,extractor_name,extractor_version,created_at,valid_until)
        VALUES (?, 'fixture', 't', ?, 'memory', ?, 'atomic', 'cache repair staging evidence', ?, 'fixture', '1', ?, ?)`)
        .run(unit, extra.project ?? "p", id, unit, 10000 + index, extra.unitUntil ?? null);
      sql.prepare("INSERT INTO retrieval_units_fts (unit_id,generation_id,tenant_id,text) VALUES (?, 'fixture','t','cache repair staging evidence')").run(unit);
      for (const table of ["memory_retrieval_units", "memory_retrieval_units_v4"]) {
        sql.prepare(`INSERT INTO ${table}(id,memory_id,tenant_id,project_id,unit_type,text,content_hash,extractor,extractor_version,created_at,valid_until)
          VALUES (?, ?, 't', ?, 'atomic', 'cache repair staging evidence', ?, 'fixture', '1', 1, ?)`)
          .run(unit, id, extra.project ?? "p", unit, extra.unitUntil ?? null);
        sql.prepare(`INSERT INTO ${table}_fts(unit_id,memory_id,tenant_id,text) VALUES(?,?, 't','cache repair staging evidence')`).run(unit, id);
      }
    }
  };
  return { sql, add, env: { OPEN_BRAIN_DB: db } as unknown as Env };
}

describe("stable generation bounded fusion", () => {
  it("keeps a quiet matching parent despite over 200 units from one source and uses reranker relevance", async () => {
    const f = fixture();
    try {
      f.add("verbose", 220); f.add("quiet");
      provider.hits = []; provider.scores = new Map([["quiet", .95], ["verbose", .1]]);
      const result = await searchMemories(f.env, { tenant_id: "t", project_id: "p", generation_id: "fixture", q: "cache repair", limit: 2 }, { recordUsage: false });
      expect(result.results.map((row) => row.id)).toEqual(["quiet", "verbose"]);
      expect(provider.seen).toEqual(expect.arrayContaining(["quiet", "verbose"]));
      expect(result.meta.retrieval?.lexical_candidate_count).toBe(2);
    } finally { f.sql.close(); }
  });

  it("preserves one strong semantic candidate before a bounded rerank pool and excludes invalid sources", async () => {
    const f = fixture();
    try {
      for (let index = 0; index < 80; index++) f.add(`lex${index}`);
      f.add("semantic"); f.add("suppressed", 1, { state: "suppressed" });
      f.add("other-project", 1, { project: "other" }); f.add("expired-unit", 1, { unitUntil: 1 });
      f.add("denied", 1, { permissions: JSON.stringify([{ principal_id: "bob", permissions: ["read"] }]) });
      provider.hits = ["suppressed", "other-project", "expired-unit", "semantic"].map((id) => ({ id: `${id}-0`, score: .95 }));
      provider.scores = new Map([["semantic", .99]]);
      const result = await searchMemories(f.env, { tenant_id: "t", project_id: "p", generation_id: "fixture", q: "cache repair", limit: 5, at: 1000 }, { recordUsage: false, actorPrincipal: "alice" });
      expect(provider.seen.length).toBeLessThanOrEqual(50);
      expect(provider.seen).toContain("semantic");
      for (const id of ["suppressed", "other-project", "expired-unit", "denied"]) expect(provider.seen).not.toContain(id);
      expect(result.results[0].id).toBe("semantic");
    } finally { f.sql.close(); }
  });
  it("rechecks current ACL after reranker completion", async () => {
    const f = fixture();
    try {
      f.add("changing");
      provider.hits = [{ id: "changing-0", score: .95 }]; provider.scores = new Map([["changing", .99]]);
      provider.afterRerank = () => f.sql.prepare("UPDATE memories SET owner_principal='bob', permissions_json=? WHERE id='changing'")
        .run(JSON.stringify([{ principal_id: "bob", permissions: ["read"] }]));
      const result = await searchMemories(f.env, { tenant_id: "t", project_id: "p", generation_id: "fixture", q: "cache repair", limit: 5 }, { recordUsage: false, actorPrincipal: "alice" });
      expect(provider.seen).toContain("changing");
      expect(result.results).toEqual([]);
    } finally { provider.afterRerank = null; f.sql.close(); }
  });

  it("legacy v3 and v4 keep semantic discovery eligible before reranking and enforce current ACL", async () => {
    const f = fixture();
    try {
      for (let index = 0; index < 70; index++) f.add(`lex${index}`);
      f.add("semantic"); f.add("denied", 1, { permissions: JSON.stringify([{ principal_id: "bob", permissions: ["read"] }]) });
      for (const search of [searchTenantRetrievalUnitsV3, searchTenantRetrievalUnitsV4]) {
        const response = await search(f.env.OPEN_BRAIN_DB, { tenantId: "t", projectId: "p", q: "cache repair", limit: 5,
          semanticHits: [{ id: "denied-0", score: .99 }, { id: "semantic-0", score: .95 }],
          rerankerScores: new Map([["semantic", .99]]), principalId: "alice", readAccess: { principal: "alice" } });
        expect(response.results[0].id).toBe("semantic");
        expect(response.results.map((row) => row.id)).not.toContain("denied");
      }
    } finally { f.sql.close(); }
  });

});
