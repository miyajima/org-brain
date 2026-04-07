import { describe, expect, it } from "vitest";
import { getMemoryProfile, listMemories, listMemoriesPage, searchMemories, upsertMemories } from "../src/memory-service";

type MemoryRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  lexical_score?: number | null;
};

type KnowledgeDocRecord = {
  id: string;
  tenant_id: string;
  scope: string;
  kind: string;
  title: string;
  slug: string;
  summary: string | null;
  body_text: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  raw_rank?: number | null;
};

function extractQuotedTerms(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1].replace(/\*$/, "").toLowerCase());
}

function matchesFts(content: string, query: string): boolean {
  const haystack = content.toLowerCase();
  const terms = extractQuotedTerms(query);
  if (terms.length === 0) return false;
  if (query.includes(" OR ")) {
    return terms.some((term) => haystack.includes(term));
  }
  return haystack.includes(terms[0]);
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isPrimaryLexicalMemory(memory: MemoryRecord): boolean {
  const tags = parseTags(memory.tags_json);
  return (
    tags.includes("curated-memory") ||
    tags.includes("canonical-memory") ||
    tags.includes("promoted") ||
    tags.includes("memory-digest")
  );
}

class FakeStatement {
  sql: string;
  db: FakeD1;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.startsWith("SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?")) {
      const tenantId = this.args[0] as string;
      const externalKey = this.args[1] as string;
      const row = this.db.memories.find((memory) => memory.tenant_id === tenantId && memory.external_key === externalKey);
      return (row ? { id: row.id } : null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("SELECT id, external_key") && this.sql.includes("external_key IN")) {
      const tenantId = this.args[0] as string;
      const keys = new Set(this.args.slice(1).map((value) => String(value)));
      return {
        results: this.db.memories
          .filter((memory) => memory.tenant_id === tenantId && memory.external_key && keys.has(memory.external_key))
          .map((memory) => ({ id: memory.id, external_key: memory.external_key })) as T[]
      };
    }

    if (this.sql.includes("FROM memories_fts")) {
      const tenantId = this.args[0] as string;
      const query = this.args[1] as string;
      const hasProjectPriority = this.sql.includes("CASE WHEN m.project_id = ?");
      const projectId = hasProjectPriority ? (this.args[2] as string) : null;
      const limit = this.args[this.args.length - 1] as number;
      const rows = this.db.memories
        .filter((memory) => memory.tenant_id === tenantId && matchesFts(memory.content, query))
        .filter((memory) => isPrimaryLexicalMemory(memory))
        .sort((left, right) => {
          const projectSort =
            (projectId && left.project_id === projectId ? 0 : 1) - (projectId && right.project_id === projectId ? 0 : 1);
          if (projectSort !== 0) return projectSort;
          return (left.lexical_score ?? 0) - (right.lexical_score ?? 0) || right.created_at - left.created_at;
        })
        .slice(0, limit)
        .map((memory) => ({
          ...memory,
          raw_rank: memory.lexical_score ?? null
        }));
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_docs_fts")) {
      const tenantId = this.args[0] as string;
      const query = this.args[1] as string;
      const limit = this.args[2] as number;
      const rows = this.db.knowledgeDocs
        .filter((doc) => doc.tenant_id === tenantId && doc.deleted_at === null)
        .filter((doc) => matchesFts(`${doc.title} ${doc.summary ?? ""} ${doc.body_text ?? ""}`, query))
        .sort((left, right) => (left.raw_rank ?? 0) - (right.raw_rank ?? 0) || right.updated_at - left.updated_at)
        .slice(0, limit)
        .map((doc) => ({
          ...doc,
          raw_rank: doc.raw_rank ?? null
        }));
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM memories") && this.sql.includes("WHERE tenant_id = ? AND source = ?")) {
      const tenantId = this.args[0] as string;
      const source = this.args[1] as string;
      const limit = this.args[2] as number;
      const rows = this.db.memories
        .filter((memory) => memory.tenant_id === tenantId && memory.source === source)
        .sort((left, right) => right.created_at - left.created_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    if (this.sql.includes("COUNT(*) AS total") && this.sql.includes("FROM memories")) {
      const tenantId = this.args[0] as string;
      const hasSource = this.sql.includes("source = ?");
      const hasProject = this.sql.includes("AND project_id = ?");
      let cursor = 1;
      const source = hasSource ? (this.args[cursor++] as string) : null;
      const projectId = hasProject ? (this.args[cursor] as string) : null;
      const rows = this.db.memories.filter((memory) => {
        if (memory.tenant_id !== tenantId) return false;
        if (source && memory.source !== source) return false;
        if (projectId && memory.project_id !== projectId) return false;
        return true;
      });
      return {
        results: [{
          total: rows.length,
          canonical_count: rows.filter((memory) => parseTags(memory.tags_json).includes("canonical-memory")).length,
          digest_count: rows.filter((memory) => parseTags(memory.tags_json).includes("memory-digest")).length,
          compacted_count: rows.filter((memory) => parseTags(memory.tags_json).includes("compacted")).length
        }] as T[]
      };
    }

    if (this.sql.includes("FROM memories") && this.sql.includes("ORDER BY") && !this.sql.includes("FROM memories_fts")) {
      const tenantId = this.args[0] as string;
      const hasSource = this.sql.includes("source = ?");
      const hasProjectPriority = this.sql.includes("CASE WHEN memories.project_id = ?");
      const hasProjectFilter = this.sql.includes("AND project_id = ?");
      const hasOffset = this.sql.includes("OFFSET ?");
      let cursor = 1;
      const source = hasSource ? (this.args[cursor++] as string) : null;
      const projectFilter = hasProjectFilter ? (this.args[cursor++] as string) : null;
      const projectId = hasProjectPriority ? (this.args[cursor++] as string) : null;
      const limit = this.args[this.args.length - (hasOffset ? 2 : 1)] as number;
      const offset = hasOffset ? (this.args[this.args.length - 1] as number) : 0;
      const rows = this.db.memories
        .filter((memory) => memory.tenant_id === tenantId)
        .filter((memory) => !source || memory.source === source)
        .filter((memory) => !projectFilter || memory.project_id === projectFilter)
        .sort((left, right) => {
          const projectSort =
            (projectId && left.project_id === projectId ? 0 : 1) - (projectId && right.project_id === projectId ? 0 : 1);
          if (projectSort !== 0) return projectSort;
          return right.created_at - left.created_at;
        })
        .slice(offset, offset + limit);
      return { results: rows as T[] };
    }

    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO memories(")) {
      this.db.memories.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        project_id: this.args[2] as string | null,
        content: this.args[3] as string,
        summary: this.args[4] as string | null,
        tags_json: this.args[5] as string | null,
        source: this.args[6] as string,
        external_key: this.args[7] as string | null,
        created_at: this.args[8] as number
      });
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE memories SET")) {
      const projectId = this.args[0] as string | null;
      const content = this.args[1] as string;
      const summary = this.args[2] as string | null;
      const tagsJson = this.args[3] as string | null;
      const source = this.args[4] as string;
      const createdAt = this.args[5] as number;
      const tenantId = this.args[6] as string;
      const id = this.args[7] as string;
      const row = this.db.memories.find((memory) => memory.tenant_id === tenantId && memory.id === id);
      if (row) {
        row.project_id = projectId;
        row.content = content;
        row.summary = summary;
        row.tags_json = tagsJson;
        row.source = source;
        row.created_at = createdAt;
      }
      return { success: true };
    }

    return { success: true };
  }
}

class FakeD1 {
  memories: MemoryRecord[] = [];
  knowledgeDocs: KnowledgeDocRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const stmt of statements) {
      await stmt.run();
    }
    return [];
  }
}

describe("memory-service", () => {
  it("upserts memories by external_key with last-write-wins and lists by source", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;

    const first = await upsertMemories(env, {
      tenant_id: "default",
      source: "openclaw",
      items: [
        {
          external_key: "openclaw:c1",
          content: "first content",
          summary: "first",
          tags: ["openclaw", "chunk"],
          created_at: 1000
        },
        {
          external_key: "openclaw:c1",
          content: "latest content in same request",
          summary: "latest",
          tags: ["openclaw", "policy"],
          created_at: 1500
        }
      ]
    });
    expect(first).toMatchObject({ inserted: 1, updated: 0 });

    const second = await upsertMemories(env, {
      tenant_id: "default",
      source: "openclaw",
      items: [
        {
          external_key: "openclaw:c1",
          content: "updated content",
          summary: "second",
          tags: ["openclaw", "chunk"],
          created_at: 2000
        }
      ]
    });
    expect(second).toMatchObject({ inserted: 0, updated: 1 });

    const listed = await listMemories(env, "default", { limit: 10, source: "openclaw" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      external_key: "openclaw:c1",
      content: "updated content",
      summary: "second",
      source: "openclaw"
    });
  });

  it("returns deduped hybrid search results with doc fallback", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.memories = [
      {
        id: "m1",
        tenant_id: "default",
        project_id: "proj1",
        content: "deploy checklist and deploy runbook details",
        summary: "Deploy checklist",
        tags_json: JSON.stringify(["policy", "curated-memory"]),
        source: "claude",
        external_key: "m1",
        created_at: now - 2 * 24 * 60 * 60 * 1000,
        lexical_score: -1.5
      }
    ];
    db.knowledgeDocs = [
      {
        id: "doc-dup",
        tenant_id: "default",
        scope: "policy",
        kind: "doc",
        title: "Deploy checklist",
        slug: "policies/deploy-checklist",
        summary: "Deploy checklist",
        body_text: "same content as memory",
        created_at: now - 1000,
        updated_at: now - 500,
        deleted_at: null,
        raw_rank: -0.9
      },
      {
        id: "doc-2",
        tenant_id: "default",
        scope: "policy",
        kind: "doc",
        title: "Release runbook",
        slug: "policies/release-runbook",
        summary: "Release runbook",
        body_text: "deploy runbook for release day",
        created_at: now - 900,
        updated_at: now - 400,
        deleted_at: null,
        raw_rank: -0.8
      }
    ];

    const env = { OPEN_BRAIN_DB: db } as any;
    const result = await searchMemories(env, {
      tenant_id: "default",
      project_id: "proj1",
      q: "deploy runbooks",
      rewrite_query: true,
      search_mode: "hybrid"
    });

    expect(result.meta.search_strategy).toBe("hybrid_memory_docs_v1");
    expect(result.results.map((row) => `${row.kind}:${row.id}`)).toEqual(["memory:m1", "doc:doc-2"]);
  });

  it("builds durable and recent profile sections with search results", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.memories = [
      {
        id: "dur-1",
        tenant_id: "default",
        project_id: "proj1",
        content: "stable deployment policy for project",
        summary: "Stable deployment policy",
        tags_json: JSON.stringify(["policy", "curated-memory"]),
        source: "claude",
        external_key: "dur-1",
        created_at: now - 3 * 24 * 60 * 60 * 1000,
        lexical_score: -1.2
      },
      {
        id: "dur-dup",
        tenant_id: "default",
        project_id: "proj2",
        content: "stable deployment policy duplicate",
        summary: "Stable deployment policy",
        tags_json: JSON.stringify(["diagnosis", "curated-memory"]),
        source: "claude",
        external_key: "dur-dup",
        created_at: now - 4 * 24 * 60 * 60 * 1000,
        lexical_score: -0.7
      },
      {
        id: "dur-2",
        tenant_id: "default",
        project_id: "proj2",
        content: "shared architecture diagnosis",
        summary: "Shared architecture diagnosis",
        tags_json: JSON.stringify(["diagnosis", "curated-memory"]),
        source: "claude",
        external_key: "dur-2",
        created_at: now - 5 * 24 * 60 * 60 * 1000,
        lexical_score: -0.6
      },
      {
        id: "recent-1",
        tenant_id: "default",
        project_id: "proj1",
        content: "debugging release automation today",
        summary: "Debugging release automation",
        tags_json: JSON.stringify(["workaround", "curated-memory"]),
        source: "codex",
        external_key: "recent-1",
        created_at: now - 2 * 60 * 60 * 1000,
        lexical_score: -1.4
      }
    ];

    const env = { OPEN_BRAIN_DB: db } as any;
    const profile = await getMemoryProfile(env, {
      tenant_id: "default",
      project_id: "proj1",
      q: "release automation",
      limit_durable: 8,
      limit_recent: 8
    });

    expect(profile.durable.map((item) => item.summary)).toEqual([
      "Stable deployment policy",
      "Shared architecture diagnosis"
    ]);
    expect(profile.recent.map((item) => item.summary)).toEqual(["Debugging release automation"]);
    expect(profile.search_results[0]).toMatchObject({
      kind: "memory",
      id: "recent-1"
    });
    expect(profile.meta.search?.search_strategy).toBe("bm25_v1");
  });

  it("prefers canonical and curated memories in primary lexical search while leaving raw items to recent history", async () => {
    const db = new FakeD1();
    const now = Date.now();
    db.memories = [
      {
        id: "canonical-1",
        tenant_id: "default",
        project_id: "proj1",
        content: "deploy cron maintenance stable guidance",
        summary: "proj1 canonical memory deploy maintenance",
        tags_json: JSON.stringify(["canonical-memory", "policy", "proj1"]),
        source: "org-brain",
        external_key: "canonical-1",
        created_at: now - 6 * 24 * 60 * 60 * 1000,
        lexical_score: -0.9
      },
      {
        id: "raw-1",
        tenant_id: "default",
        project_id: "proj1",
        content: "deploy cron maintenance issue happened today",
        summary: "recent deploy issue",
        tags_json: JSON.stringify(["hook", "agent-turn-complete", "proj1"]),
        source: "codex",
        external_key: "raw-1",
        created_at: now - 60 * 60 * 1000,
        lexical_score: -1.5
      },
      {
        id: "curated-1",
        tenant_id: "default",
        project_id: "proj2",
        content: "deploy cron maintenance runbook",
        summary: "deploy maintenance runbook",
        tags_json: JSON.stringify(["policy", "curated-memory"]),
        source: "claude",
        external_key: "curated-1",
        created_at: now - 8 * 24 * 60 * 60 * 1000,
        lexical_score: -1.1
      },
      {
        id: "raw-openclaw-hook",
        tenant_id: "default",
        project_id: "proj9",
        content: "deploy cron maintenance noisy hook payload",
        summary: "noisy openclaw hook payload",
        tags_json: JSON.stringify(["openclaw", "hook", "message"]),
        source: "openclaw",
        external_key: "raw-openclaw-hook",
        created_at: now - 9 * 24 * 60 * 60 * 1000,
        lexical_score: -0.5
      }
    ];

    const env = { OPEN_BRAIN_DB: db } as any;
    const search = await searchMemories(env, {
      tenant_id: "default",
      project_id: "proj1",
      q: "deploy cron maintenance"
    });
    expect(search.results.map((item) => item.id)).toEqual(["canonical-1", "curated-1"]);
    expect(search.results.map((item) => item.id)).not.toContain("raw-openclaw-hook");

    const profile = await getMemoryProfile(env, {
      tenant_id: "default",
      project_id: "proj1",
      limit_durable: 8,
      limit_recent: 8
    });
    expect(profile.recent.map((item) => item.id)).toContain("raw-1");
  });

  it("returns paginated memory listing metadata for corpus browsing", async () => {
    const db = new FakeD1();
    db.memories = [
      {
        id: "m3",
        tenant_id: "default",
        project_id: "proj1",
        content: "third",
        summary: "third",
        tags_json: JSON.stringify(["memory-digest"]),
        source: "claude",
        external_key: "m3",
        created_at: 3000
      },
      {
        id: "m2",
        tenant_id: "default",
        project_id: "proj1",
        content: "second",
        summary: "second",
        tags_json: JSON.stringify(["canonical-memory"]),
        source: "claude",
        external_key: "m2",
        created_at: 2000
      },
      {
        id: "m1",
        tenant_id: "default",
        project_id: "proj2",
        content: "first",
        summary: "first",
        tags_json: JSON.stringify(["compacted"]),
        source: "codex",
        external_key: "m1",
        created_at: 1000
      }
    ];

    const env = { OPEN_BRAIN_DB: db } as any;
    const page = await listMemoriesPage(env, "default", { limit: 2, offset: 0 });

    expect(page.items.map((item) => item.id)).toEqual(["m3", "m2"]);
    expect(page.meta).toMatchObject({
      total: 3,
      has_next: true,
      has_prev: false,
      canonical_count: 1,
      digest_count: 1,
      compacted_count: 1
    });
  });
});
