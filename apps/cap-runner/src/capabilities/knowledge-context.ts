import {
  deriveParentMocCandidates,
  KNOWLEDGE_CONTEXT_LIMITS,
  normalizeDocKind,
  normalizeDocScope,
  normalizeDocSlug,
  normalizeOptionalString,
  normalizeStringArray,
  renderKnowledgeMarkdown,
  type KnowledgeDocFrontmatter,
  type KnowledgeDocKind,
  type KnowledgeDocScope,
  type KnowledgeLinkRelation
} from "@org-brain/shared";
import { HttpError } from "@org-brain/shared";
import type { Env } from "../types";

type KnowledgeDocRow = {
  id: string;
  tenant_id: string;
  scope: KnowledgeDocScope;
  kind: KnowledgeDocKind;
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

type KnowledgeDocLinkRow = KnowledgeDocRow & {
  relation: KnowledgeLinkRelation;
};

type KnowledgeDocSummary = {
  id: string;
  slug: string;
  scope: KnowledgeDocScope;
  kind: KnowledgeDocKind;
  title: string;
  summary: string | null;
  tags: string[];
  stability?: string;
  updated_at_frontmatter?: string;
  owner?: string;
  created_at: number;
  updated_at: number;
  body_storage: "inline" | "r2";
};

type KnowledgeContextLink = {
  relation: KnowledgeLinkRelation;
  doc: KnowledgeDocSummary;
};

type KnowledgeContextCurrent = KnowledgeDocSummary & {
  frontmatter: KnowledgeDocFrontmatter;
  artifact_ref: string | null;
  markdown?: string;
};

function parseString(raw: unknown, field: string, maxLength = 256): string {
  if (typeof raw !== "string") {
    throw new HttpError(500, "corrupt_doc", `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(500, "corrupt_doc", `${field} must not be empty`);
  }
  return trimmed.slice(0, maxLength);
}

function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function parseFrontmatterJson(raw: string | null): KnowledgeDocFrontmatter {
  if (!raw) {
    throw new HttpError(500, "corrupt_doc", "knowledge doc frontmatter is missing");
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...parsed,
    id: parseString(parsed.id, "frontmatter.id", 200),
    title: parseString(parsed.title, "frontmatter.title", 200),
    scope: normalizeDocScope(parsed.scope, "frontmatter.scope"),
    kind: normalizeDocKind(parsed.kind, "frontmatter.kind"),
    tags: normalizeStringArray(parsed.tags, "frontmatter.tags"),
    stability: parseString(parsed.stability, "frontmatter.stability", 64),
    updated_at: parseString(parsed.updated_at, "frontmatter.updated_at", 64),
    owner: normalizeOptionalString(parsed.owner, "frontmatter.owner", 128),
    related: normalizeStringArray(parsed.related, "frontmatter.related"),
    capability: normalizeOptionalString(parsed.capability, "frontmatter.capability", 128),
    workflow: normalizeOptionalString(parsed.workflow, "frontmatter.workflow", 128),
    department: normalizeOptionalString(parsed.department, "frontmatter.department", 128),
    project: normalizeOptionalString(parsed.project, "frontmatter.project", 128),
    summary: normalizeOptionalString(parsed.summary, "frontmatter.summary", 1000)
  };
}

function rowToSummary(row: KnowledgeDocRow): KnowledgeDocSummary {
  const frontmatter = parseFrontmatterJson(row.frontmatter);
  return {
    id: row.id,
    slug: row.slug,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    tags: parseTagsJson(row.tags),
    stability: frontmatter.stability,
    updated_at_frontmatter: frontmatter.updated_at,
    owner: frontmatter.owner,
    created_at: row.created_at,
    updated_at: row.updated_at,
    body_storage: row.artifact_ref ? "r2" : "inline"
  };
}

function stripR2RefPrefix(ref: string): string {
  return ref.startsWith("r2://") ? ref.slice("r2://".length) : ref;
}

async function findKnowledgeDocBySlug(env: Env, tenantId: string, slug: string) {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, scope, kind, title, slug, summary, tags, frontmatter, body_text, artifact_ref, created_at, updated_at, deleted_at
     FROM knowledge_docs
     WHERE tenant_id = ? AND slug = ? AND deleted_at IS NULL`
  )
    .bind(tenantId, slug)
    .first<KnowledgeDocRow>();
}

async function readKnowledgeDocMarkdown(env: Env, row: KnowledgeDocRow) {
  if (row.artifact_ref) {
    const object = await env.OPEN_BRAIN_BUCKET.get(stripR2RefPrefix(row.artifact_ref));
    if (!object) {
      throw new HttpError(500, "artifact_missing", `knowledge doc artifact missing: ${row.artifact_ref}`);
    }
    return object.text();
  }
  return renderKnowledgeMarkdown(parseFrontmatterJson(row.frontmatter), row.body_text ?? "");
}

async function listOutgoingKnowledgeLinks(env: Env, tenantId: string, docId: string, limit = 20) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.tenant_id, d.scope, d.kind, d.title, d.slug, d.summary, d.tags, d.frontmatter, d.body_text, d.artifact_ref, d.created_at, d.updated_at, d.deleted_at, l.relation
     FROM knowledge_links l
     JOIN knowledge_docs d
       ON d.id = l.to_doc_id
      AND d.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.from_doc_id = ? AND d.deleted_at IS NULL
     ORDER BY
       CASE l.relation
         WHEN 'parent' THEN 0
         WHEN 'related' THEN 1
         WHEN 'references' THEN 2
         WHEN 'requires' THEN 3
         WHEN 'child' THEN 4
         ELSE 5
       END,
       d.updated_at DESC
     LIMIT ?`
  )
    .bind(tenantId, docId, limit)
    .all<KnowledgeDocLinkRow>();

  return result.results.map((row) => ({
    relation: row.relation,
    doc: rowToSummary(row)
  })) satisfies KnowledgeContextLink[];
}

async function listIncomingKnowledgeLinks(env: Env, tenantId: string, docId: string, limit = 20) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.tenant_id, d.scope, d.kind, d.title, d.slug, d.summary, d.tags, d.frontmatter, d.body_text, d.artifact_ref, d.created_at, d.updated_at, d.deleted_at, l.relation
     FROM knowledge_links l
     JOIN knowledge_docs d
       ON d.id = l.from_doc_id
      AND d.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.to_doc_id = ? AND d.deleted_at IS NULL
     ORDER BY d.updated_at DESC
     LIMIT ?`
  )
    .bind(tenantId, docId, limit)
    .all<KnowledgeDocLinkRow>();

  return result.results.map((row) => ({
    relation: row.relation,
    doc: rowToSummary(row)
  })) satisfies KnowledgeContextLink[];
}

function dedupeSummaryDocs(docs: KnowledgeDocSummary[], excludeIds = new Set<string>()) {
  const seen = new Set<string>();
  return docs.filter((doc) => {
    if (excludeIds.has(doc.id) || seen.has(doc.id)) return false;
    seen.add(doc.id);
    return true;
  });
}

export async function loadContext(
  env: Env,
  tenantId: string,
  rawSlug: string,
  options?: { includeBody?: boolean }
) {
  const slug = normalizeDocSlug(rawSlug);
  const row = await findKnowledgeDocBySlug(env, tenantId, slug);
  if (!row) {
    throw new HttpError(404, "doc_not_found", `knowledge doc not found: ${slug}`);
  }

  const outgoing = await listOutgoingKnowledgeLinks(env, tenantId, row.id, 20);
  const incoming = await listIncomingKnowledgeLinks(env, tenantId, row.id, 12);
  const parentMoc =
    outgoing.find((link) => link.relation === "parent")?.doc ??
    (await Promise.all(
      deriveParentMocCandidates(slug).map(async (candidate) => {
        const parent = await findKnowledgeDocBySlug(env, tenantId, candidate);
        return parent ? rowToSummary(parent) : null;
      })
    )).find((candidate): candidate is KnowledgeDocSummary => Boolean(candidate)) ??
    null;

  const children = outgoing
    .filter((link) => link.relation === "child")
    .map((link) => link.doc)
    .slice(0, KNOWLEDGE_CONTEXT_LIMITS.children);

  const excludeIds = new Set<string>([row.id, ...(parentMoc ? [parentMoc.id] : []), ...children.map((child) => child.id)]);
  const related = dedupeSummaryDocs(
    [
      ...outgoing.filter((link) => link.relation === "related").map((link) => link.doc),
      ...outgoing.filter((link) => link.relation === "references" || link.relation === "requires").map((link) => link.doc),
      ...incoming.filter((link) => link.relation === "related" || link.relation === "references").map((link) => link.doc)
    ],
    excludeIds
  ).slice(0, KNOWLEDGE_CONTEXT_LIMITS.related);

  const current: KnowledgeContextCurrent = {
    ...rowToSummary(row),
    frontmatter: parseFrontmatterJson(row.frontmatter),
    artifact_ref: row.artifact_ref
  };

  if (options?.includeBody) {
    current.markdown = await readKnowledgeDocMarkdown(env, row);
  }

  return {
    current,
    parent_moc: parentMoc,
    related,
    children,
    direct_links: outgoing
      .filter((link) => link.relation !== "parent" && link.relation !== "child")
      .slice(0, KNOWLEDGE_CONTEXT_LIMITS.direct_links),
    limits: KNOWLEDGE_CONTEXT_LIMITS
  };
}
