import { describe, expect, it } from "vitest";
import {
  buildKnowledgeFtsQuery,
  generateMocTemplates,
  parseKnowledgeMarkdown,
  renderKnowledgeMarkdown,
  slugToDocPath
} from "../src/knowledge-docs";

describe("knowledge-docs shared helpers", () => {
  it("parses YAML frontmatter and extracts wiki links", () => {
    const parsed = parseKnowledgeMarkdown(`---
id: capability-code-review
title: Code Review
scope: capability
kind: doc
tags:
  - review
  - quality
stability: stable
updated_at: 2026-03-13
related:
  - policies/security-handling
---

# Code Review

This capability reviews generated code for correctness and maintainability.

See [[policies/security-handling]]
See [[workflows/spec-to-code|Spec To Code]]
`);

    expect(parsed.frontmatter.id).toBe("capability-code-review");
    expect(parsed.frontmatter.tags).toEqual(["review", "quality"]);
    expect(parsed.wikiLinks).toEqual(["policies/security-handling", "workflows/spec-to-code"]);
    expect(parsed.linkTargets).toEqual([
      "policies/security-handling",
      "workflows/spec-to-code"
    ]);
    expect(parsed.summary).toContain("reviews generated code");
  });

  it("renders markdown without internal metadata", () => {
    const parsed = parseKnowledgeMarkdown(`---
id: policy-security
title: Security Handling
scope: policy
kind: doc
tags: [security]
stability: stable
updated_at: 2026-03-13
---

# Security

Handle secrets carefully.
`);

    const markdown = renderKnowledgeMarkdown(parsed.frontmatter, parsed.body);
    expect(markdown).toContain("title: Security Handling");
    expect(markdown).not.toContain("_orgbrain");
  });

  it("builds MOC templates with docs paths", () => {
    const templates = generateMocTemplates({
      updatedAt: "2026-03-13",
      departmentSlugs: ["engineering"],
      projectSlugs: ["project-x"]
    });

    expect(templates.map((item) => item.slug)).toContain("ORG");
    expect(templates.map((item) => item.slug)).toContain("departments/engineering/_index");
    expect(templates.map((item) => item.slug)).toContain("projects/project-x/_index");
    expect(slugToDocPath("capabilities/_index")).toBe("docs/capabilities/_index.md");
  });

  it("builds an FTS query from meaningful tokens only", () => {
    expect(buildKnowledgeFtsQuery("security review a")).toBe("\"security\"* OR \"review\"*");
  });
});
