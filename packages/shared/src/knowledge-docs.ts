import YAML from "yaml";
import { HttpError } from "./errors";

export const KNOWLEDGE_DOC_SCOPES = [
  "org",
  "department",
  "project",
  "capability",
  "workflow",
  "policy"
] as const;

export const KNOWLEDGE_DOC_KINDS = [
  "moc",
  "doc",
  "playbook",
  "policy",
  "capability",
  "workflow"
] as const;

export const KNOWLEDGE_LINK_RELATIONS = [
  "references",
  "requires",
  "related",
  "parent",
  "child"
] as const;

export type KnowledgeDocScope = (typeof KNOWLEDGE_DOC_SCOPES)[number];
export type KnowledgeDocKind = (typeof KNOWLEDGE_DOC_KINDS)[number];
export type KnowledgeLinkRelation = (typeof KNOWLEDGE_LINK_RELATIONS)[number];

export const KNOWLEDGE_DOC_INLINE_BODY_LIMIT = 16_000;
export const KNOWLEDGE_DOC_FTS_BODY_LIMIT = 8_000;
export const KNOWLEDGE_CONTEXT_LIMITS = {
  current: 1,
  parent_moc: 1,
  related: 3,
  children: 3,
  direct_links: 6
} as const;

type FrontmatterInput = Record<string, unknown>;

type OrgBrainFrontmatterMeta = {
  wiki_links: string[];
  link_targets: string[];
};

export type KnowledgeDocFrontmatter = {
  id: string;
  title: string;
  scope: KnowledgeDocScope;
  kind: KnowledgeDocKind;
  tags: string[];
  stability: string;
  updated_at: string;
  owner?: string;
  related?: string[];
  capability?: string;
  workflow?: string;
  department?: string;
  project?: string;
  summary?: string;
  _orgbrain?: OrgBrainFrontmatterMeta;
  [key: string]: unknown;
};

export type ParsedKnowledgeDoc = {
  body: string;
  frontmatter: KnowledgeDocFrontmatter;
  summary: string;
  wikiLinks: string[];
  linkTargets: string[];
  markdown: string;
};

export type MocTemplate = {
  slug: string;
  path: string;
  scope: KnowledgeDocScope;
  kind: "moc";
  title: string;
  markdown: string;
};

export function normalizeDocSlug(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
  if (!normalized) {
    throw new HttpError(400, "invalid_payload", "slug must not be empty");
  }
  if (normalized.includes("..")) {
    throw new HttpError(400, "invalid_payload", "slug must not contain '..'");
  }
  return normalized.replace(/\/{2,}/g, "/");
}

export function slugToDocPath(slug: string): string {
  return slug === "ORG" ? "docs/ORG.md" : `docs/${normalizeDocSlug(slug)}.md`;
}

export function normalizeDocScope(raw: unknown, field = "scope"): KnowledgeDocScope {
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const normalized = raw.trim() as KnowledgeDocScope;
  if (!KNOWLEDGE_DOC_SCOPES.includes(normalized)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${KNOWLEDGE_DOC_SCOPES.join(", ")}`);
  }
  return normalized;
}

export function normalizeDocKind(raw: unknown, field = "kind"): KnowledgeDocKind {
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const normalized = raw.trim() as KnowledgeDocKind;
  if (!KNOWLEDGE_DOC_KINDS.includes(normalized)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${KNOWLEDGE_DOC_KINDS.join(", ")}`);
  }
  return normalized;
}

export function normalizeStringArray(raw: unknown, field: string, limit = 32): string[] {
  if (raw === undefined || raw === null) return [];

  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!values) {
    throw new HttpError(400, "invalid_payload", `${field} must be an array of strings`);
  }

  const cleaned = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, limit);

  return [...new Set(cleaned)];
}

export function normalizeOptionalString(raw: unknown, field: string, maxLength = 256): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function normalizeUpdatedAt(raw: unknown): string {
  if (raw instanceof Date) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString().slice(0, 10);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new HttpError(400, "invalid_payload", "updated_at must not be empty");
    }
    return trimmed;
  }
  throw new HttpError(400, "invalid_payload", "updated_at must be a date-like value");
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry)).filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeJsonValue(entry);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function parseFrontmatterSection(markdown: string): { rawFrontmatter: string; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new HttpError(400, "invalid_payload", "markdown must start with YAML frontmatter");
  }
  const rawFrontmatter = match[1];
  const body = markdown.slice(match[0].length).replace(/^\s*\n/, "");
  return { rawFrontmatter, body };
}

function parseFrontmatterYaml(rawFrontmatter: string): FrontmatterInput {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawFrontmatter);
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_payload",
      `frontmatter could not be parsed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_payload", "frontmatter must be a YAML object");
  }
  return parsed as FrontmatterInput;
}

function coerceFrontmatter(frontmatterInput: FrontmatterInput): KnowledgeDocFrontmatter {
  const sanitized = (sanitizeJsonValue(frontmatterInput) ?? {}) as Record<string, unknown>;

  const id = normalizeOptionalString(sanitized.id, "frontmatter.id", 200);
  if (!id) {
    throw new HttpError(400, "invalid_payload", "frontmatter.id is required");
  }

  const title = normalizeOptionalString(sanitized.title, "frontmatter.title", 200);
  if (!title) {
    throw new HttpError(400, "invalid_payload", "frontmatter.title is required");
  }

  const stability = normalizeOptionalString(sanitized.stability, "frontmatter.stability", 64);
  if (!stability) {
    throw new HttpError(400, "invalid_payload", "frontmatter.stability is required");
  }

  const related = normalizeStringArray(sanitized.related, "frontmatter.related");
  const tags = normalizeStringArray(sanitized.tags, "frontmatter.tags");

  const frontmatter: KnowledgeDocFrontmatter = {
    ...sanitized,
    id,
    title,
    scope: normalizeDocScope(sanitized.scope, "frontmatter.scope"),
    kind: normalizeDocKind(sanitized.kind, "frontmatter.kind"),
    tags,
    stability,
    updated_at: normalizeUpdatedAt(sanitized.updated_at),
    related
  };

  const owner = normalizeOptionalString(sanitized.owner, "frontmatter.owner", 128);
  const capability = normalizeOptionalString(sanitized.capability, "frontmatter.capability", 128);
  const workflow = normalizeOptionalString(sanitized.workflow, "frontmatter.workflow", 128);
  const department = normalizeOptionalString(sanitized.department, "frontmatter.department", 128);
  const project = normalizeOptionalString(sanitized.project, "frontmatter.project", 128);
  const summary = normalizeOptionalString(sanitized.summary, "frontmatter.summary", 1000);

  if (owner) frontmatter.owner = owner;
  if (capability) frontmatter.capability = capability;
  if (workflow) frontmatter.workflow = workflow;
  if (department) frontmatter.department = department;
  if (project) frontmatter.project = project;
  if (summary) frontmatter.summary = summary;

  return frontmatter;
}

export function extractWikiLinks(body: string): string[] {
  const results: string[] = [];
  const pattern = /\[\[([^[\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1].split("|")[0]?.split("#")[0];
    if (!target) continue;
    const normalized = normalizeDocSlug(target);
    results.push(normalized);
  }
  return [...new Set(results)];
}

function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|([^[\]]+))?\]\]/g, (_m, slug, label) => label || slug)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveDocSummary(body: string, explicitSummary?: string): string {
  if (explicitSummary) {
    return explicitSummary.trim().slice(0, 320);
  }

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((section) => stripMarkdown(section))
    .filter((section) => section.length > 0);

  const candidate = paragraphs.find((section) => section.length >= 24) ?? paragraphs[0] ?? "";
  return candidate.slice(0, 320);
}

export function getStoredLinkTargets(frontmatter: KnowledgeDocFrontmatter | Record<string, unknown>): string[] {
  const record = frontmatter as Record<string, unknown>;
  const internal = record._orgbrain;
  if (internal && typeof internal === "object" && !Array.isArray(internal)) {
    const linkTargets = normalizeStringArray((internal as Record<string, unknown>).link_targets, "_orgbrain.link_targets");
    if (linkTargets.length > 0) {
      return linkTargets.map((slug) => normalizeDocSlug(slug));
    }
  }
  return normalizeStringArray(record.related, "frontmatter.related").map((slug) => normalizeDocSlug(slug));
}

export function parseKnowledgeMarkdown(
  markdown: string,
  expected?: { title?: string; scope?: KnowledgeDocScope; kind?: KnowledgeDocKind }
): ParsedKnowledgeDoc {
  const { rawFrontmatter, body } = parseFrontmatterSection(markdown);
  const input = parseFrontmatterYaml(rawFrontmatter);
  const frontmatter = coerceFrontmatter(input);

  if (expected?.title && expected.title.trim() !== frontmatter.title) {
    throw new HttpError(400, "invalid_payload", "title must match frontmatter.title");
  }
  if (expected?.scope && expected.scope !== frontmatter.scope) {
    throw new HttpError(400, "invalid_payload", "scope must match frontmatter.scope");
  }
  if (expected?.kind && expected.kind !== frontmatter.kind) {
    throw new HttpError(400, "invalid_payload", "kind must match frontmatter.kind");
  }

  const wikiLinks = extractWikiLinks(body);
  const related = frontmatter.related?.map((slug) => normalizeDocSlug(slug)) ?? [];
  const linkTargets = [...new Set([...related, ...wikiLinks])];
  const summary = deriveDocSummary(body, frontmatter.summary);

  return {
    body,
    summary,
    wikiLinks,
    linkTargets,
    markdown,
    frontmatter: {
      ...frontmatter,
      related,
      _orgbrain: {
        wiki_links: wikiLinks,
        link_targets: linkTargets
      }
    }
  };
}

export function renderKnowledgeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const printable = { ...frontmatter };
  delete printable._orgbrain;
  const header = YAML.stringify(printable).trimEnd();
  return `---\n${header}\n---\n\n${body}`;
}

export function buildKnowledgeFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8)
    .map((token) => `"${token.replace(/"/g, '""')}"*`);

  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

export function deriveParentMocCandidates(slug: string): string[] {
  const normalized = normalizeDocSlug(slug);
  if (normalized === "ORG") return [];

  const segments = normalized.split("/");
  if (segments[0] === "capabilities") {
    return normalized === "capabilities/_index" ? ["ORG"] : ["capabilities/_index", "ORG"];
  }
  if (segments[0] === "workflows") {
    return normalized === "workflows/_index" ? ["ORG"] : ["workflows/_index", "ORG"];
  }
  if (segments[0] === "policies") {
    return normalized === "policies/_index" ? ["ORG"] : ["policies/_index", "ORG"];
  }
  if (segments[0] === "departments" && segments[1]) {
    const departmentMoc = `departments/${segments[1]}/_index`;
    return normalized === departmentMoc ? ["ORG"] : [departmentMoc, "ORG"];
  }
  if (segments[0] === "projects" && segments[1]) {
    const projectMoc = `projects/${segments[1]}/_index`;
    return normalized === projectMoc ? ["ORG"] : [projectMoc, "ORG"];
  }
  return ["ORG"];
}

export function generateMocTemplates(input?: {
  updatedAt?: string;
  orgTitle?: string;
  departmentSlugs?: string[];
  projectSlugs?: string[];
}): MocTemplate[] {
  const updatedAt = input?.updatedAt?.trim() || new Date().toISOString().slice(0, 10);
  const organizationTitle = input?.orgTitle?.trim() || "Organization";
  const departmentSlugs = (input?.departmentSlugs ?? []).map((slug) => normalizeDocSlug(slug));
  const projectSlugs = (input?.projectSlugs ?? []).map((slug) => normalizeDocSlug(slug));

  const topLevel = [
    { slug: "capabilities/_index", title: "Capabilities", scope: "capability" as const },
    { slug: "workflows/_index", title: "Workflows", scope: "workflow" as const },
    { slug: "policies/_index", title: "Policies", scope: "policy" as const }
  ];

  const templates: MocTemplate[] = [
    {
      slug: "ORG",
      path: slugToDocPath("ORG"),
      scope: "org",
      kind: "moc",
      title: `${organizationTitle} MOC`,
      markdown: renderKnowledgeMarkdown(
        {
          id: "org-root",
          title: `${organizationTitle} MOC`,
          scope: "org",
          kind: "moc",
          tags: ["org", "navigation"],
          stability: "stable",
          updated_at: updatedAt
        },
        [
          "# Organization",
          "",
          "Start here for the top-level maps of contents.",
          "",
          ...topLevel.map((item) => `- [[${item.slug}]]`)
        ].join("\n")
      )
    },
    ...topLevel.map((item) => ({
      slug: item.slug,
      path: slugToDocPath(item.slug),
      scope: item.scope,
      kind: "moc" as const,
      title: item.title,
      markdown: renderKnowledgeMarkdown(
        {
          id: item.slug.replace(/[\/_]/g, "-"),
          title: item.title,
          scope: item.scope,
          kind: "moc",
          tags: [item.scope, "navigation"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["ORG"]
        },
        [`# ${item.title}`, "", "Use this MOC as the entry point for linked docs in this scope."].join("\n")
      )
    }))
  ];

  for (const departmentSlug of departmentSlugs) {
    const slug = `departments/${departmentSlug}/_index`;
    templates.push({
      slug,
      path: slugToDocPath(slug),
      scope: "department",
      kind: "moc",
      title: `${departmentSlug} Department`,
      markdown: renderKnowledgeMarkdown(
        {
          id: `department-${departmentSlug}`,
          title: `${departmentSlug} Department`,
          scope: "department",
          kind: "moc",
          tags: ["department", departmentSlug],
          stability: "stable",
          updated_at: updatedAt,
          department: departmentSlug,
          related: ["ORG"]
        },
        [`# ${departmentSlug}`, "", "Department entry point for related docs and workflows."].join("\n")
      )
    });
  }

  for (const projectSlug of projectSlugs) {
    const slug = `projects/${projectSlug}/_index`;
    templates.push({
      slug,
      path: slugToDocPath(slug),
      scope: "project",
      kind: "moc",
      title: `${projectSlug} Project`,
      markdown: renderKnowledgeMarkdown(
        {
          id: `project-${projectSlug}`,
          title: `${projectSlug} Project`,
          scope: "project",
          kind: "moc",
          tags: ["project", projectSlug],
          stability: "stable",
          updated_at: updatedAt,
          project: projectSlug,
          related: ["ORG"]
        },
        [`# ${projectSlug}`, "", "Project entry point for scoped knowledge docs."].join("\n")
      )
    });
  }

  return templates;
}
