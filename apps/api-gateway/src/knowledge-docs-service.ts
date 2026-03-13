import {
  buildKnowledgeFtsQuery,
  deriveParentMocCandidates,
  KNOWLEDGE_CONTEXT_LIMITS,
  KNOWLEDGE_DOC_FTS_BODY_LIMIT,
  KNOWLEDGE_DOC_INLINE_BODY_LIMIT,
  normalizeDocKind,
  normalizeDocScope,
  normalizeDocSlug,
  normalizeOptionalString,
  normalizeStringArray,
  parseKnowledgeMarkdown,
  renderKnowledgeMarkdown,
  type KnowledgeDocFrontmatter,
  type KnowledgeDocKind,
  type KnowledgeDocScope,
  type KnowledgeLinkRelation
} from "@org-brain/shared";
import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

type UpsertKnowledgeDocRequest = {
  tenant_id?: string;
  scope: KnowledgeDocScope;
  kind: KnowledgeDocKind;
  title: string;
  slug: string;
  markdown: string;
};

type SearchKnowledgeDocsRequest = {
  tenant_id?: string;
  q?: string;
  scope?: KnowledgeDocScope[];
  limit?: number;
};

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

type KnowledgeDocLookupRow = {
  id: string;
  slug: string;
  created_at: number;
};

type KnowledgeDocLinkRow = KnowledgeDocRow & {
  relation: KnowledgeLinkRelation;
};

type StoredDocSummary = {
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

type StoredDocDetail = StoredDocSummary & {
  frontmatter: KnowledgeDocFrontmatter;
  artifact_ref: string | null;
};

type StoredDocLink = {
  relation: KnowledgeLinkRelation;
  doc: StoredDocSummary;
};

function parseString(raw: unknown, field: string, maxLength = 256): string {
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed.slice(0, maxLength);
}

function parseTenantId(raw: unknown): string {
  if (raw === undefined || raw === null) return "default";
  return parseString(raw, "tenant_id", 128);
}

function parseUpsertKnowledgeDocRequest(raw: unknown): {
  tenantId: string;
  scope: KnowledgeDocScope;
  kind: KnowledgeDocKind;
  title: string;
  slug: string;
  markdown: string;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }

  const body = raw as UpsertKnowledgeDocRequest;
  const tenantId = parseTenantId(body.tenant_id);
  const title = parseString(body.title, "title", 200);
  const slug = normalizeDocSlug(parseString(body.slug, "slug", 300));
  const markdown = parseString(body.markdown, "markdown", 200_000);

  return {
    tenantId,
    scope: normalizeDocScope(body.scope, "scope"),
    kind: normalizeDocKind(body.kind, "kind"),
    title,
    slug,
    markdown
  };
}

function parseSearchKnowledgeDocsRequest(raw: unknown): {
  tenantId: string;
  q: string;
  scopes: KnowledgeDocScope[];
  limit: number;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }

  const body = raw as SearchKnowledgeDocsRequest;
  const tenantId = parseTenantId(body.tenant_id);
  const q = typeof body.q === "string" ? body.q.trim() : "";
  const scopes = (body.scope ?? []).map((scope) => normalizeDocScope(scope, "scope"));
  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50, Math.floor(body.limit)))
      : 10;

  return { tenantId, q, scopes, limit };
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
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("frontmatter must be a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...record,
      id: parseString(record.id, "frontmatter.id", 200),
      title: parseString(record.title, "frontmatter.title", 200),
      scope: normalizeDocScope(record.scope, "frontmatter.scope"),
      kind: normalizeDocKind(record.kind, "frontmatter.kind"),
      tags: normalizeStringArray(record.tags, "frontmatter.tags"),
      stability: parseString(record.stability, "frontmatter.stability", 64),
      updated_at: parseString(record.updated_at, "frontmatter.updated_at", 64),
      owner: normalizeOptionalString(record.owner, "frontmatter.owner", 128),
      related: normalizeStringArray(record.related, "frontmatter.related"),
      capability: normalizeOptionalString(record.capability, "frontmatter.capability", 128),
      workflow: normalizeOptionalString(record.workflow, "frontmatter.workflow", 128),
      department: normalizeOptionalString(record.department, "frontmatter.department", 128),
      project: normalizeOptionalString(record.project, "frontmatter.project", 128),
      summary: normalizeOptionalString(record.summary, "frontmatter.summary", 1000)
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      500,
      "corrupt_doc",
      `knowledge doc frontmatter could not be read: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function rowToSummary(row: KnowledgeDocRow): StoredDocSummary {
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

function rowToDetail(row: KnowledgeDocRow): StoredDocDetail {
  const summary = rowToSummary(row);
  return {
    ...summary,
    frontmatter: parseFrontmatterJson(row.frontmatter),
    artifact_ref: row.artifact_ref
  };
}

function stripR2RefPrefix(ref: string): string {
  return ref.startsWith("r2://") ? ref.slice("r2://".length) : ref;
}

function knowledgeDocArtifactRef(tenantId: string, docId: string): string {
  return `r2://tenants/${tenantId}/knowledge-docs/${docId}/content.md`;
}

function buildBodyExcerpt(body: string): string {
  return body.slice(0, KNOWLEDGE_DOC_FTS_BODY_LIMIT);
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

async function findKnowledgeDocById(env: Env, tenantId: string, id: string) {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, scope, kind, title, slug, summary, tags, frontmatter, body_text, artifact_ref, created_at, updated_at, deleted_at
     FROM knowledge_docs
     WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
  )
    .bind(tenantId, id)
    .first<KnowledgeDocRow>();
}

async function listTenantKnowledgeDocLookups(env: Env, tenantId: string) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, slug, created_at
     FROM knowledge_docs
     WHERE tenant_id = ? AND deleted_at IS NULL`
  )
    .bind(tenantId)
    .all<KnowledgeDocLookupRow>();

  return result.results;
}

async function listTenantKnowledgeDocRows(env: Env, tenantId: string) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, scope, kind, title, slug, summary, tags, frontmatter, body_text, artifact_ref, created_at, updated_at, deleted_at
     FROM knowledge_docs
     WHERE tenant_id = ? AND deleted_at IS NULL`
  )
    .bind(tenantId)
    .all<KnowledgeDocRow>();

  return result.results;
}

async function readKnowledgeDocMarkdown(env: Env, row: KnowledgeDocRow): Promise<string> {
  if (row.artifact_ref) {
    const key = stripR2RefPrefix(row.artifact_ref);
    const object = await env.OPEN_BRAIN_BUCKET.get(key);
    if (!object) {
      throw new HttpError(500, "artifact_missing", `knowledge doc artifact missing: ${row.artifact_ref}`);
    }
    return object.text();
  }

  return renderKnowledgeMarkdown(parseFrontmatterJson(row.frontmatter), row.body_text ?? "");
}

async function replaceKnowledgeDocFts(
  env: Env,
  tenantId: string,
  docId: string,
  title: string,
  summary: string,
  tags: string[],
  bodyText: string
) {
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare("DELETE FROM knowledge_docs_fts WHERE doc_id = ? AND tenant_id = ?").bind(docId, tenantId),
    env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO knowledge_docs_fts(doc_id, tenant_id, title, summary, tags, body_text) VALUES(?,?,?,?,?,?)"
    ).bind(docId, tenantId, title, summary, tags.join(" "), bodyText)
  ]);
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
  })) satisfies StoredDocLink[];
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
  })) satisfies StoredDocLink[];
}

async function rebuildKnowledgeLinks(env: Env, tenantId: string) {
  const docs = await listTenantKnowledgeDocRows(env, tenantId);
  const bySlug = new Map(docs.map((row) => [row.slug, row]));
  const seen = new Set<string>();
  const now = Date.now();
  const statements = [env.OPEN_BRAIN_DB.prepare("DELETE FROM knowledge_links WHERE tenant_id = ?").bind(tenantId)];

  const pushRelation = (fromDocId: string, toDocId: string, relation: KnowledgeLinkRelation) => {
    const key = `${fromDocId}:${toDocId}:${relation}`;
    if (fromDocId === toDocId || seen.has(key)) return;
    seen.add(key);
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO knowledge_links(id, tenant_id, from_doc_id, to_doc_id, relation, created_at) VALUES(?,?,?,?,?,?)"
      ).bind(ulid(), tenantId, fromDocId, toDocId, relation, now)
    );
  };

  for (const row of docs) {
    const frontmatter = parseFrontmatterJson(row.frontmatter);
    const relatedSlugs = new Set(frontmatter.related ?? []);
    const internalTargets =
      frontmatter._orgbrain && typeof frontmatter._orgbrain === "object"
        ? normalizeStringArray(frontmatter._orgbrain.link_targets, "_orgbrain.link_targets")
        : [];

    for (const slug of internalTargets) {
      const target = bySlug.get(normalizeDocSlug(slug));
      if (!target) continue;
      pushRelation(row.id, target.id, relatedSlugs.has(slug) ? "related" : "references");
    }

    const parent = deriveParentMocCandidates(row.slug)
      .map((candidate) => bySlug.get(candidate))
      .find((candidate): candidate is KnowledgeDocRow => Boolean(candidate && candidate.id !== row.id));

    if (parent) {
      pushRelation(row.id, parent.id, "parent");
      pushRelation(parent.id, row.id, "child");
    }
  }

  await env.OPEN_BRAIN_DB.batch(statements);
}

function dedupeSummaryDocs(docs: StoredDocSummary[], excludeIds = new Set<string>()) {
  const seen = new Set<string>();
  return docs.filter((doc) => {
    if (excludeIds.has(doc.id) || seen.has(doc.id)) return false;
    seen.add(doc.id);
    return true;
  });
}

export async function upsertKnowledgeDoc(env: Env, rawBody: unknown) {
  const { tenantId, scope, kind, title, slug, markdown } = parseUpsertKnowledgeDocRequest(rawBody);
  const parsed = parseKnowledgeMarkdown(markdown, { title, scope, kind });
  const docId = parsed.frontmatter.id;

  const existingBySlug = await findKnowledgeDocBySlug(env, tenantId, slug);
  if (existingBySlug && existingBySlug.id !== docId) {
    throw new HttpError(409, "doc_conflict", `slug already belongs to another doc: ${slug}`);
  }

  const existingById = await findKnowledgeDocById(env, tenantId, docId);
  if (existingById && existingById.slug !== slug && existingBySlug && existingBySlug.id !== existingById.id) {
    throw new HttpError(409, "doc_conflict", `id already belongs to another slug: ${existingById.slug}`);
  }

  const existing = existingById ?? existingBySlug;
  const now = Date.now();
  const createdAt = existing?.created_at ?? now;
  const inlineBody = parsed.body.length <= KNOWLEDGE_DOC_INLINE_BODY_LIMIT ? parsed.body : buildBodyExcerpt(parsed.body);
  const tagsJson = JSON.stringify(parsed.frontmatter.tags);
  const frontmatterJson = JSON.stringify(parsed.frontmatter);
  const artifactRef = parsed.body.length <= KNOWLEDGE_DOC_INLINE_BODY_LIMIT ? null : knowledgeDocArtifactRef(tenantId, docId);

  if (artifactRef) {
    await env.OPEN_BRAIN_BUCKET.put(stripR2RefPrefix(artifactRef), parsed.markdown, {
      httpMetadata: {
        contentType: "text/markdown; charset=utf-8"
      },
      customMetadata: {
        tenant_id: tenantId,
        doc_id: docId,
        slug
      }
    });
  }

  if (existing) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_docs
       SET scope = ?, kind = ?, title = ?, slug = ?, summary = ?, tags = ?, frontmatter = ?, body_text = ?, artifact_ref = ?, updated_at = ?, deleted_at = NULL
       WHERE tenant_id = ? AND id = ?`
    )
      .bind(
        scope,
        kind,
        title,
        slug,
        parsed.summary,
        tagsJson,
        frontmatterJson,
        inlineBody,
        artifactRef,
        now,
        tenantId,
        docId
      )
      .run();
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_docs(id, tenant_id, scope, kind, title, slug, summary, tags, frontmatter, body_text, artifact_ref, created_at, updated_at, deleted_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`
    )
      .bind(
        docId,
        tenantId,
        scope,
        kind,
        title,
        slug,
        parsed.summary,
        tagsJson,
        frontmatterJson,
        inlineBody,
        artifactRef,
        createdAt,
        now
      )
      .run();
  }

  await replaceKnowledgeDocFts(env, tenantId, docId, title, parsed.summary, parsed.frontmatter.tags, inlineBody);
  await rebuildKnowledgeLinks(env, tenantId);

  if (!artifactRef && existing?.artifact_ref) {
    await env.OPEN_BRAIN_BUCKET.delete(stripR2RefPrefix(existing.artifact_ref));
  }

  const stored = await findKnowledgeDocBySlug(env, tenantId, slug);
  if (!stored) {
    throw new HttpError(500, "doc_not_persisted", "knowledge doc could not be reloaded after save");
  }

  return {
    created: !existing,
    doc: rowToDetail(stored)
  };
}

export async function getKnowledgeDoc(env: Env, tenantId: string, rawSlug: string) {
  const slug = normalizeDocSlug(rawSlug);
  const row = await findKnowledgeDocBySlug(env, tenantId, slug);
  if (!row) {
    throw new HttpError(404, "doc_not_found", `knowledge doc not found: ${slug}`);
  }

  return {
    doc: rowToDetail(row),
    resolved_links: await listOutgoingKnowledgeLinks(env, tenantId, row.id, KNOWLEDGE_CONTEXT_LIMITS.direct_links),
    markdown: await readKnowledgeDocMarkdown(env, row)
  };
}

export async function searchKnowledgeDocs(env: Env, rawBody: unknown) {
  const { tenantId, q, scopes, limit } = parseSearchKnowledgeDocsRequest(rawBody);
  const ftsQuery = buildKnowledgeFtsQuery(q);
  const scopeSql = scopes.length > 0 ? ` AND d.scope IN (${scopes.map(() => "?").join(", ")})` : "";

  if (ftsQuery) {
    const result = await env.OPEN_BRAIN_DB.prepare(
      `SELECT d.id, d.tenant_id, d.scope, d.kind, d.title, d.slug, d.summary, d.tags, d.frontmatter, d.body_text, d.artifact_ref, d.created_at, d.updated_at, d.deleted_at
       FROM knowledge_docs_fts
       JOIN knowledge_docs d
         ON d.id = knowledge_docs_fts.doc_id
        AND d.tenant_id = knowledge_docs_fts.tenant_id
       WHERE knowledge_docs_fts.tenant_id = ?
         AND knowledge_docs_fts MATCH ?${scopeSql}
         AND d.deleted_at IS NULL
       ORDER BY bm25(knowledge_docs_fts) ASC, d.updated_at DESC
       LIMIT ?`
    )
      .bind(tenantId, ftsQuery, ...scopes, limit)
      .all<KnowledgeDocRow>();

    return {
      tenant_id: tenantId,
      q,
      results: result.results.map((row) => rowToSummary(row))
    };
  }

  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, scope, kind, title, slug, summary, tags, frontmatter, body_text, artifact_ref, created_at, updated_at, deleted_at
     FROM knowledge_docs d
     WHERE tenant_id = ?${scopeSql}
       AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(tenantId, ...scopes, limit)
    .all<KnowledgeDocRow>();

  return {
    tenant_id: tenantId,
    q,
    results: result.results.map((row) => rowToSummary(row))
  };
}

export async function getKnowledgeDocContext(env: Env, tenantId: string, rawSlug: string) {
  const slug = normalizeDocSlug(rawSlug);
  const row = await findKnowledgeDocBySlug(env, tenantId, slug);
  if (!row) {
    throw new HttpError(404, "doc_not_found", `knowledge doc not found: ${slug}`);
  }

  const outgoing = await listOutgoingKnowledgeLinks(env, tenantId, row.id, 20);
  const incoming = await listIncomingKnowledgeLinks(env, tenantId, row.id, 12);
  const parentMoc = outgoing.find((link) => link.relation === "parent")?.doc ?? null;
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

  const directLinks = outgoing
    .filter((link) => link.relation !== "parent" && link.relation !== "child")
    .slice(0, KNOWLEDGE_CONTEXT_LIMITS.direct_links);

  return {
    current: rowToSummary(row),
    parent_moc: parentMoc,
    related,
    children,
    direct_links: directLinks,
    limits: KNOWLEDGE_CONTEXT_LIMITS
  };
}

export async function listKnowledgeDocSlugs(env: Env, tenantId: string) {
  return listTenantKnowledgeDocLookups(env, tenantId);
}
