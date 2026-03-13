import { describe, expect, it } from "vitest";
import {
  getKnowledgeDoc,
  getKnowledgeDocContext,
  searchKnowledgeDocs,
  upsertKnowledgeDoc
} from "../src/knowledge-docs-service";

type KnowledgeDocRecord = {
  id: string;
  tenant_id: string;
  scope: string;
  kind: string;
  title: string;
  slug: string;
  summary: string | null;
  tags: string | null;
  frontmatter: string | null;
  body_text: string | null;
  artifact_ref: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

type KnowledgeLinkRecord = {
  id: string;
  tenant_id: string;
  from_doc_id: string;
  to_doc_id: string;
  relation: string;
  created_at: number;
};

type KnowledgeFtsRecord = {
  doc_id: string;
  tenant_id: string;
  title: string;
  summary: string;
  tags: string;
  body_text: string;
};

function parseMatchTokens(raw: string) {
  return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1].replace(/\*$/, "").toLowerCase());
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
    if (this.sql.includes("FROM knowledge_docs") && this.sql.includes("slug = ?")) {
      const [tenantId, slug] = this.args as [string, string];
      const row = this.db.docs.find((doc) => doc.tenant_id === tenantId && doc.slug === slug && doc.deleted_at === null);
      return (row ?? null) as T | null;
    }

    if (this.sql.includes("FROM knowledge_docs") && this.sql.includes("id = ?")) {
      const [tenantId, id] = this.args as [string, string];
      const row = this.db.docs.find((doc) => doc.tenant_id === tenantId && doc.id === id && doc.deleted_at === null);
      return (row ?? null) as T | null;
    }

    return null;
  }

  async all<T>() {
    if (this.sql.includes("SELECT id, slug, created_at") && this.sql.includes("FROM knowledge_docs")) {
      const [tenantId] = this.args as [string];
      const rows = this.db.docs
        .filter((doc) => doc.tenant_id === tenantId && doc.deleted_at === null)
        .map((doc) => ({ id: doc.id, slug: doc.slug, created_at: doc.created_at }));
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_docs_fts") && this.sql.includes("JOIN knowledge_docs d")) {
      const tenantId = this.args[0] as string;
      const match = this.args[1] as string;
      const limit = this.args.at(-1) as number;
      const scopeArgs = this.args.slice(2, -1) as string[];
      const scopes = new Set(scopeArgs);
      const tokens = parseMatchTokens(match);
      const rows = this.db.fts
        .filter((record) => record.tenant_id === tenantId)
        .filter((record) => {
          const haystack = [record.title, record.summary, record.tags, record.body_text].join(" ").toLowerCase();
          return tokens.some((token) => haystack.includes(token));
        })
        .map((record) => this.db.docs.find((doc) => doc.id === record.doc_id && doc.tenant_id === tenantId))
        .filter((doc): doc is KnowledgeDocRecord => Boolean(doc && doc.deleted_at === null))
        .filter((doc) => (scopes.size > 0 ? scopes.has(doc.scope) : true))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_docs d") && this.sql.includes("ORDER BY updated_at DESC")) {
      const tenantId = this.args[0] as string;
      const limit = this.args.at(-1) as number;
      const scopeArgs = this.args.slice(1, -1) as string[];
      const scopes = new Set(scopeArgs);
      const rows = this.db.docs
        .filter((doc) => doc.tenant_id === tenantId && doc.deleted_at === null)
        .filter((doc) => (scopes.size > 0 ? scopes.has(doc.scope) : true))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_docs") && this.sql.includes("deleted_at IS NULL")) {
      const [tenantId] = this.args as [string];
      const rows = this.db.docs.filter((doc) => doc.tenant_id === tenantId && doc.deleted_at === null);
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_links l") && this.sql.includes("l.from_doc_id = ?")) {
      const [tenantId, docId, limit] = this.args as [string, string, number];
      const rows = this.db.links
        .filter((link) => link.tenant_id === tenantId && link.from_doc_id === docId)
        .map((link) => {
          const doc = this.db.docs.find((entry) => entry.id === link.to_doc_id && entry.tenant_id === tenantId);
          return doc ? { ...doc, relation: link.relation } : null;
        })
        .filter((row): row is KnowledgeDocRecord & { relation: string } => Boolean(row))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_links l") && this.sql.includes("l.to_doc_id = ?")) {
      const [tenantId, docId, limit] = this.args as [string, string, number];
      const rows = this.db.links
        .filter((link) => link.tenant_id === tenantId && link.to_doc_id === docId)
        .map((link) => {
          const doc = this.db.docs.find((entry) => entry.id === link.from_doc_id && entry.tenant_id === tenantId);
          return doc ? { ...doc, relation: link.relation } : null;
        })
        .filter((row): row is KnowledgeDocRecord & { relation: string } => Boolean(row))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }

    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO knowledge_docs(")) {
      this.db.docs.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        scope: this.args[2] as string,
        kind: this.args[3] as string,
        title: this.args[4] as string,
        slug: this.args[5] as string,
        summary: this.args[6] as string | null,
        tags: this.args[7] as string | null,
        frontmatter: this.args[8] as string | null,
        body_text: this.args[9] as string | null,
        artifact_ref: this.args[10] as string | null,
        created_at: this.args[11] as number,
        updated_at: this.args[12] as number,
        deleted_at: null
      });
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE knowledge_docs")) {
      const row = this.db.docs.find((doc) => doc.tenant_id === (this.args[10] as string) && doc.id === (this.args[11] as string));
      if (row) {
        row.scope = this.args[0] as string;
        row.kind = this.args[1] as string;
        row.title = this.args[2] as string;
        row.slug = this.args[3] as string;
        row.summary = this.args[4] as string | null;
        row.tags = this.args[5] as string | null;
        row.frontmatter = this.args[6] as string | null;
        row.body_text = this.args[7] as string | null;
        row.artifact_ref = this.args[8] as string | null;
        row.updated_at = this.args[9] as number;
        row.deleted_at = null;
      }
      return { success: true };
    }

    if (this.sql.startsWith("DELETE FROM knowledge_docs_fts")) {
      const [docId, tenantId] = this.args as [string, string];
      this.db.fts = this.db.fts.filter((record) => !(record.doc_id === docId && record.tenant_id === tenantId));
      return { success: true };
    }

    if (this.sql.startsWith("INSERT INTO knowledge_docs_fts")) {
      this.db.fts.push({
        doc_id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        title: this.args[2] as string,
        summary: this.args[3] as string,
        tags: this.args[4] as string,
        body_text: this.args[5] as string
      });
      return { success: true };
    }

    if (this.sql.startsWith("DELETE FROM knowledge_links")) {
      const [tenantId] = this.args as [string];
      this.db.links = this.db.links.filter((link) => link.tenant_id !== tenantId);
      return { success: true };
    }

    if (this.sql.startsWith("INSERT INTO knowledge_links(")) {
      this.db.links.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        from_doc_id: this.args[2] as string,
        to_doc_id: this.args[3] as string,
        relation: this.args[4] as string,
        created_at: this.args[5] as number
      });
      return { success: true };
    }

    return { success: true };
  }
}

class FakeD1 {
  docs: KnowledgeDocRecord[] = [];
  links: KnowledgeLinkRecord[] = [];
  fts: KnowledgeFtsRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }
}

class FakeR2Bucket {
  objects = new Map<string, string>();

  async put(key: string, value: string) {
    this.objects.set(key, value);
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function createEnv() {
  return {
    OPEN_BRAIN_DB: new FakeD1(),
    OPEN_BRAIN_BUCKET: new FakeR2Bucket()
  } as any;
}

describe("knowledge-docs-service", () => {
  it("upserts docs, preserves structured frontmatter, and resolves wiki links after later saves", async () => {
    const env = createEnv();

    await upsertKnowledgeDoc(env, {
      tenant_id: "default",
      scope: "org",
      kind: "moc",
      title: "Organization MOC",
      slug: "ORG",
      markdown: `---
id: org-root
title: Organization MOC
scope: org
kind: moc
tags: [org, navigation]
stability: stable
updated_at: 2026-03-13
---

# Organization

See [[capabilities/_index]]
`
    });

    await upsertKnowledgeDoc(env, {
      tenant_id: "default",
      scope: "capability",
      kind: "moc",
      title: "Capabilities",
      slug: "capabilities/_index",
      markdown: `---
id: capabilities-index
title: Capabilities
scope: capability
kind: moc
tags: [capability, navigation]
stability: stable
updated_at: 2026-03-13
related:
  - ORG
---

# Capabilities
`
    });

    const saved = await upsertKnowledgeDoc(env, {
      tenant_id: "default",
      scope: "capability",
      kind: "doc",
      title: "Code Review",
      slug: "capabilities/code-review",
      markdown: `---
id: capability-code-review
title: Code Review
scope: capability
kind: doc
tags:
  - review
  - quality
stability: stable
updated_at: 2026-03-13
---

# Code Review

This capability reviews generated code for correctness and maintainability.

See [[policies/security-handling]]
`
    });

    expect(saved.created).toBe(true);
    expect(saved.doc.body_storage).toBe("inline");
    expect(JSON.parse(env.OPEN_BRAIN_DB.docs[2].frontmatter ?? "{}")._orgbrain.link_targets).toEqual([
      "policies/security-handling"
    ]);

    const beforePolicy = await getKnowledgeDoc(env, "default", "capabilities/code-review");
    expect(beforePolicy.resolved_links).toHaveLength(1);
    expect(beforePolicy.resolved_links[0].relation).toBe("parent");

    await upsertKnowledgeDoc(env, {
      tenant_id: "default",
      scope: "policy",
      kind: "doc",
      title: "Security Handling",
      slug: "policies/security-handling",
      markdown: `---
id: policy-security-handling
title: Security Handling
scope: policy
kind: doc
tags: [security]
stability: stable
updated_at: 2026-03-13
---

# Security Handling

Review secret handling and access boundaries.
`
    });

    const doc = await getKnowledgeDoc(env, "default", "capabilities/code-review");
    expect(doc.markdown).toContain("Code Review");
    expect(doc.resolved_links.map((link) => `${link.relation}:${link.doc.slug}`)).toEqual(
      expect.arrayContaining([
        "parent:capabilities/_index",
        "references:policies/security-handling"
      ])
    );

    const context = await getKnowledgeDocContext(env, "default", "capabilities/code-review");
    expect(context.parent_moc?.slug).toBe("capabilities/_index");
    expect(context.related.map((item) => item.slug)).toContain("policies/security-handling");

    const mocContext = await getKnowledgeDocContext(env, "default", "capabilities/_index");
    expect(mocContext.children.map((item) => item.slug)).toContain("capabilities/code-review");
  });

  it("stores long docs in R2 and returns them through get/search", async () => {
    const env = createEnv();
    const longBody = `# Spec Writer\n\n${"Detailed guidance for spec writing.\n\n".repeat(800)}`;

    const saved = await upsertKnowledgeDoc(env, {
      tenant_id: "default",
      scope: "capability",
      kind: "doc",
      title: "Spec Writer",
      slug: "capabilities/spec-writer",
      markdown: `---
id: capability-spec-writer
title: Spec Writer
scope: capability
kind: doc
tags: [writing, specs]
stability: stable
updated_at: 2026-03-13
---

${longBody}`
    });

    expect(saved.doc.body_storage).toBe("r2");
    expect(saved.doc.artifact_ref).toContain("r2://tenants/default/knowledge-docs/capability-spec-writer/content.md");

    const loaded = await getKnowledgeDoc(env, "default", "capabilities/spec-writer");
    expect(loaded.markdown).toContain("Detailed guidance for spec writing");

    const search = await searchKnowledgeDocs(env, {
      tenant_id: "default",
      q: "spec guidance",
      scope: ["capability"],
      limit: 5
    });
    expect(search.results.map((item) => item.slug)).toContain("capabilities/spec-writer");
  });
});
