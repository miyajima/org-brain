import { parseKnowledgeMarkdown } from "@org-brain/shared";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/capabilities/knowledge-context";

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
  tenant_id: string;
  from_doc_id: string;
  to_doc_id: string;
  relation: string;
};

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
    return null;
  }

  async all<T>() {
    if (this.sql.includes("FROM knowledge_links l") && this.sql.includes("l.from_doc_id = ?")) {
      const [tenantId, docId] = this.args as [string, string];
      const rows = this.db.links
        .filter((link) => link.tenant_id === tenantId && link.from_doc_id === docId)
        .map((link) => {
          const doc = this.db.docs.find((entry) => entry.id === link.to_doc_id && entry.tenant_id === tenantId);
          return doc ? { ...doc, relation: link.relation } : null;
        })
        .filter((row): row is KnowledgeDocRecord & { relation: string } => Boolean(row));
      return { results: rows as T[] };
    }

    if (this.sql.includes("FROM knowledge_links l") && this.sql.includes("l.to_doc_id = ?")) {
      const [tenantId, docId] = this.args as [string, string];
      const rows = this.db.links
        .filter((link) => link.tenant_id === tenantId && link.to_doc_id === docId)
        .map((link) => {
          const doc = this.db.docs.find((entry) => entry.id === link.from_doc_id && entry.tenant_id === tenantId);
          return doc ? { ...doc, relation: link.relation } : null;
        })
        .filter((row): row is KnowledgeDocRecord & { relation: string } => Boolean(row));
      return { results: rows as T[] };
    }

    return { results: [] as T[] };
  }
}

class FakeD1 {
  docs: KnowledgeDocRecord[] = [];
  links: KnowledgeLinkRecord[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeBucket {
  objects = new Map<string, string>();

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value
    };
  }
}

function createDoc(args: {
  id: string;
  slug: string;
  title: string;
  scope: "org" | "capability" | "policy";
  kind: "moc" | "doc";
  tags: string[];
  markdown: string;
  artifactRef?: string | null;
}) {
  const parsed = parseKnowledgeMarkdown(args.markdown, {
    title: args.title,
    scope: args.scope,
    kind: args.kind
  });

  return {
    id: args.id,
    tenant_id: "default",
    scope: args.scope,
    kind: args.kind,
    title: args.title,
    slug: args.slug,
    summary: parsed.summary,
    tags: JSON.stringify(args.tags),
    frontmatter: JSON.stringify(parsed.frontmatter),
    body_text: parsed.body,
    artifact_ref: args.artifactRef ?? null,
    created_at: 1000,
    updated_at: 2000,
    deleted_at: null
  } satisfies KnowledgeDocRecord;
}

describe("loadContext", () => {
  it("loads progressive disclosure summaries first and body only on demand", async () => {
    const db = new FakeD1();
    const bucket = new FakeBucket();

    const orgDoc = createDoc({
      id: "org-root",
      slug: "ORG",
      title: "Organization MOC",
      scope: "org",
      kind: "moc",
      tags: ["org"],
      markdown: `---
id: org-root
title: Organization MOC
scope: org
kind: moc
tags: [org]
stability: stable
updated_at: 2026-03-13
---

# Organization
`
    });

    const capIndex = createDoc({
      id: "capabilities-index",
      slug: "capabilities/_index",
      title: "Capabilities",
      scope: "capability",
      kind: "moc",
      tags: ["capability"],
      markdown: `---
id: capabilities-index
title: Capabilities
scope: capability
kind: moc
tags: [capability]
stability: stable
updated_at: 2026-03-13
related:
  - ORG
---

# Capabilities
`
    });

    const capabilityDoc = createDoc({
      id: "capability-code-review",
      slug: "capabilities/code-review",
      title: "Code Review",
      scope: "capability",
      kind: "doc",
      tags: ["review"],
      markdown: `---
id: capability-code-review
title: Code Review
scope: capability
kind: doc
tags: [review]
stability: stable
updated_at: 2026-03-13
---

# Code Review

Use [[policies/security-handling]] before merge.
`,
      artifactRef: "r2://tenants/default/knowledge-docs/capability-code-review/content.md"
    });

    const policyDoc = createDoc({
      id: "policy-security-handling",
      slug: "policies/security-handling",
      title: "Security Handling",
      scope: "policy",
      kind: "doc",
      tags: ["security"],
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

Protect secrets.
`
    });

    db.docs.push(orgDoc, capIndex, capabilityDoc, policyDoc);
    db.links.push(
      { tenant_id: "default", from_doc_id: capIndex.id, to_doc_id: orgDoc.id, relation: "parent" },
      { tenant_id: "default", from_doc_id: orgDoc.id, to_doc_id: capIndex.id, relation: "child" },
      { tenant_id: "default", from_doc_id: capabilityDoc.id, to_doc_id: capIndex.id, relation: "parent" },
      { tenant_id: "default", from_doc_id: capIndex.id, to_doc_id: capabilityDoc.id, relation: "child" },
      { tenant_id: "default", from_doc_id: capabilityDoc.id, to_doc_id: policyDoc.id, relation: "references" }
    );
    bucket.objects.set("tenants/default/knowledge-docs/capability-code-review/content.md", capabilityDoc.body_text ?? "");

    const summaryOnly = await loadContext(
      { OPEN_BRAIN_DB: db, OPEN_BRAIN_BUCKET: bucket } as any,
      "default",
      "capabilities/code-review"
    );

    expect(summaryOnly.current.markdown).toBeUndefined();
    expect(summaryOnly.parent_moc?.slug).toBe("capabilities/_index");
    expect(summaryOnly.related.map((item) => item.slug)).toContain("policies/security-handling");

    const withBody = await loadContext(
      { OPEN_BRAIN_DB: db, OPEN_BRAIN_BUCKET: bucket } as any,
      "default",
      "capabilities/code-review",
      { includeBody: true }
    );

    expect(withBody.current.markdown).toContain("Code Review");
    expect(withBody.direct_links.map((item) => item.doc.slug)).toContain("policies/security-handling");
  });
});
