import {
  decisionRefSchema,
  decisionResourceLinkCreateSchema,
  knowledgeResourceCreateSchema,
  knowledgeResourceLocationCreateSchema,
  knowledgeResourceVersionCaptureSchema,
  type DecisionRef,
  type DecisionResourceLink,
  type KnowledgeResource,
  type KnowledgeResourceExtractionState,
  type ResourceLocator,
  type MemoryMapTraceResource
} from "@org-brain/contracts";
import { assertConnectorFetchUri, chunkKnowledgeResourceText, normalizeKnowledgeResourceUri } from "@org-brain/core";
import { buildKnowledgeFtsQuery, HttpError, ulid } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import { ensureAccessPolicy } from "./access-policy-service";
import { stableResultReadable } from "./memory-service";
import type { Env } from "./types";

type PrincipalOptions = {
  principal?: string | null;
  projectId?: string | null;
  resourceVersionId?: string | null;
  includeRelated?: boolean;
  accessMode?: "legacy" | "defer";
};

function assertConnectorAuthorized(
  env: Env,
  connectorId: string,
  actorPrincipal: string,
  mediaType?: string,
  extractedText?: string
) {
  let connectors: Array<{ id?: unknown; principals?: unknown; media_types?: unknown; max_bytes?: unknown }> = [];
  try {
    const parsed = JSON.parse(env.KNOWLEDGE_RESOURCE_CONNECTORS_JSON ?? "[]") as unknown;
    if (Array.isArray(parsed)) connectors = parsed as typeof connectors;
  } catch {
    throw new HttpError(500, "connector_policy_invalid", "Connector policy is invalid");
  }
  const connector = connectors.find((item) => item.id === connectorId);
  const principals = connector && Array.isArray(connector.principals)
    ? connector.principals.filter((item): item is string => typeof item === "string")
    : [];
  if (!connector || !principals.includes(actorPrincipal)) {
    throw new HttpError(403, "connector_not_allowed", "Connector is not allowlisted for this principal");
  }
  const mediaTypes = Array.isArray(connector.media_types)
    ? connector.media_types.filter((item): item is string => typeof item === "string")
    : [];
  if (mediaType && mediaTypes.length > 0 && !mediaTypes.includes(mediaType)) {
    throw new HttpError(415, "connector_media_type_forbidden", "Connector does not allow this media type");
  }
  const maxBytes = typeof connector.max_bytes === "number" ? connector.max_bytes : 5_000_000;
  if (extractedText && new TextEncoder().encode(extractedText).byteLength > maxBytes) {
    throw new HttpError(413, "connector_payload_too_large", "Connector snapshot exceeds its size limit");
  }
}

export type KnowledgeResourceBackfillStage = "knowledge_docs" | "decision_evidence" | "decision_memory_sources";

export type KnowledgeResourceBackfillRequest = {
  tenant_id?: string;
  stage?: KnowledgeResourceBackfillStage;
  cursor?: string | null;
  limit?: number;
};

type ResourceRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  resource_kind: KnowledgeResource["resource_kind"];
  canonical_uri: string;
  title: string;
  source_system: string;
  media_type: string;
  visibility: KnowledgeResource["visibility"];
  permissions_json: string | null;
  current_version_id: string | null;
  lifecycle_state: KnowledgeResource["lifecycle_state"];
  created_at: number;
  updated_at: number;
};

type LinkRow = {
  assertion_id: string;
  source_type: DecisionRef["source_type"];
  source_id: string;
  resource_id: string;
  role: DecisionResourceLink["role"];
  resource_version_id: string | null;
  locator_json: string | null;
  excerpt_digest: string | null;
  note: string | null;
  confirmation_state: DecisionResourceLink["confirmation_state"];
  valid_from: number;
  valid_until: number | null;
  actor_principal: string;
  reviewed_by_principal: string | null;
  created_at: number;
  confidence?: number;
};

type DecisionTraceReadRow = LinkRow & {
  resource_tenant_id: string;
  resource_project_id: string | null;
  resource_kind: KnowledgeResource["resource_kind"];
  canonical_uri: string;
  resource_title: string;
  source_system: string;
  media_type: string;
  visibility: KnowledgeResource["visibility"];
  permissions_json: string | null;
  current_version_id: string | null;
  lifecycle_state: KnowledgeResource["lifecycle_state"];
  resource_created_at: number;
  resource_updated_at: number;
  version_id: string | null;
  version_source_version: string | null;
  version_content_hash: string | null;
  version_captured_at: number | null;
  version_extraction_state: KnowledgeResourceExtractionState | null;
};

async function createStaleReviewProposals(
  env: Env,
  tenantId: string,
  resourceId: string,
  currentVersionId: string,
  actorPrincipal: string
): Promise<number> {
  const confirmed = await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT a.id, a.project_id, a.subject_type, a.subject_ref, a.predicate,
                     a.confidence, a.valid_from
     FROM knowledge_assertions a
     JOIN knowledge_assertion_evidence e
       ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id AND e.resource_id = a.resource_id
     WHERE a.tenant_id = ? AND a.resource_id = ? AND a.assertion_type = 'relation'
       AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
       AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
       AND e.resource_version_id <> ?`
  ).bind(tenantId, resourceId, currentVersionId).all<{
    id: string;
    project_id: string | null;
    subject_type: DecisionRef["source_type"];
    subject_ref: string;
    predicate: DecisionResourceLink["role"];
    confidence: number;
    valid_from: number;
  }>();
  let created = 0;
  for (const source of confirmed.results) {
    const idempotencyKey = `stale-review:${source.id}:${currentVersionId}`;
    const prior = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM knowledge_assertions WHERE tenant_id = ? AND idempotency_key = ?`
    ).bind(tenantId, idempotencyKey).first<{ id: string }>();
    if (prior) continue;
    const proposalId = ulid();
    const now = Date.now();
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO knowledge_assertions(
          id, tenant_id, project_id, assertion_type, subject_type, subject_ref,
          predicate, object_type, object_ref, resource_id, context_json, confidence,
          confirmation_state, idempotency_key, valid_from, actor_principal,
          created_at, updated_at
        ) VALUES(?,?,?,'relation',?,?,?,'knowledge_resource',?,?,?,?,'proposal',?,?,?,?,?)`
      ).bind(
        proposalId, tenantId, source.project_id, source.subject_type, source.subject_ref,
        source.predicate, resourceId, resourceId,
        JSON.stringify({ review_reason: "resource_version_changed", source_assertion_id: source.id, current_resource_version_id: currentVersionId }),
        source.confidence, idempotencyKey, now, actorPrincipal, now, now
      ),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO knowledge_assertion_evidence(
          id, tenant_id, assertion_id, resource_id, resource_version_id,
          locator_json, excerpt_digest, note, created_at
        )
        SELECT ? || ':' || e.id, e.tenant_id, ?, e.resource_id, e.resource_version_id,
               e.locator_json, e.excerpt_digest, e.note, ?
        FROM knowledge_assertion_evidence e
        WHERE e.tenant_id = ? AND e.assertion_id = ?`
      ).bind(proposalId, proposalId, now, tenantId, source.id)
    ]);
    created += 1;
  }
  return created;
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function principalsFromGrantJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const grant = item as { principal_type?: unknown; principal_id?: unknown; permissions?: unknown };
      return grant.principal_type === "principal" && typeof grant.principal_id === "string" &&
        Array.isArray(grant.permissions) && grant.permissions.includes("read") ? [grant.principal_id] : [];
    });
  } catch {
    return [];
  }
}

function parseLocator(raw: string | null): ResourceLocator | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResourceLocator;
  } catch {
    return null;
  }
}

function toResource(row: ResourceRow): KnowledgeResource {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    resource_kind: row.resource_kind,
    canonical_uri: row.canonical_uri,
    title: row.title,
    source_system: row.source_system,
    media_type: row.media_type,
    visibility: row.visibility,
    permissions: parseArray(row.permissions_json),
    current_version_id: row.current_version_id,
    lifecycle_state: row.lifecycle_state,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toLink(row: LinkRow): DecisionResourceLink {
  return {
    assertion_id: row.assertion_id,
    decision_ref: { source_type: row.source_type, source_id: row.source_id },
    resource_id: row.resource_id,
    role: row.role,
    resource_version_id: row.resource_version_id,
    locator: parseLocator(row.locator_json),
    excerpt_digest: row.excerpt_digest,
    note: row.note,
    confirmation_state: row.confirmation_state,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    actor: row.actor_principal,
    reviewed_by: row.reviewed_by_principal,
    created_at: row.created_at
  };
}

function principal(options: PrincipalOptions): string | null {
  const value = options.principal?.trim();
  return value || null;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableBackfillUri(kind: string, id: string): string {
  return `orgbrain://${kind}/${encodeURIComponent(id)}`;
}

function asResourceUri(value: string, fallbackKind: string, fallbackId: string): string {
  try {
    return normalizeKnowledgeResourceUri(value);
  } catch {
    return stableBackfillUri(fallbackKind, fallbackId);
  }
}

function isHumanConfirmed(value: string | null): boolean {
  return value === "user_confirmed" || value === "user_corrected" || value === "reviewed" || value === "confirmed";
}

async function filterReadableResources(env: Env, tenantId: string, rows: ResourceRow[], options: PrincipalOptions): Promise<ResourceRow[]> {
  const requestPrincipal = principal(options);
  const direct = rows.filter((row) => {
    if (row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && row.project_id === options.projectId);
    return Boolean(requestPrincipal && parseArray(row.permissions_json).includes(requestPrincipal));
  });
  const directIds = new Set(direct.map((row) => row.id));
  const restricted = rows.filter((row) => row.visibility === "restricted" && !directIds.has(row.id));
  if (!requestPrincipal || restricted.length === 0) return direct;
  const authz = await buildAuthzContext(env, tenantId, requestPrincipal);
  const allowed = await loadReadableResourceIds(env, {
    tenantId,
    resourceType: "knowledge_resource",
    resourceIds: restricted.map((row) => row.id),
    authz
  });
  return rows.filter((row) => directIds.has(row.id) || allowed.has(row.id));
}

async function getResourceRow(env: Env, tenantId: string, resourceId: string): Promise<ResourceRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system,
            media_type, visibility, permissions_json, current_version_id, lifecycle_state,
            created_at, updated_at
     FROM knowledge_resources WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, resourceId).first<ResourceRow>();
  if (!row) throw new HttpError(404, "resource_not_found", "Knowledge resource not found");
  return row;
}

async function getReadableResourceRow(env: Env, tenantId: string, resourceId: string, options: PrincipalOptions): Promise<ResourceRow> {
  const row = await getResourceRow(env, tenantId, resourceId);
  const [readable] = await filterReadableResources(env, tenantId, [row], options);
  if (!readable) throw new HttpError(404, "resource_not_found", "Knowledge resource not found");
  return readable;
}

export async function upsertKnowledgeResource(env: Env, rawBody: unknown, actorPrincipal: string) {
  const input = knowledgeResourceCreateSchema.parse(rawBody);
  const tenantId = input.tenant_id ?? "default";
  if (input.connector_id) assertConnectorAuthorized(env, input.connector_id, actorPrincipal, input.media_type);
  let normalizedUri: string;
  try {
    normalizedUri = normalizeKnowledgeResourceUri(input.canonical_uri);
    if (input.fetch_enabled && (normalizedUri.startsWith("https:") || normalizedUri.startsWith("git+https:"))) {
      assertConnectorFetchUri(normalizedUri);
    }
  } catch (error) {
    throw new HttpError(400, "invalid_resource_uri", error instanceof Error ? error.message : "invalid resource URI");
  }
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.id, r.tenant_id, r.project_id, r.resource_kind, r.canonical_uri, r.title,
            r.source_system, r.media_type, r.visibility, r.permissions_json,
            r.current_version_id, r.lifecycle_state, r.created_at, r.updated_at
     FROM knowledge_resource_locations l
     JOIN knowledge_resources r ON r.tenant_id = l.tenant_id AND r.id = l.resource_id
     WHERE l.tenant_id = ? AND l.normalized_uri = ?`
  ).bind(tenantId, normalizedUri).first<ResourceRow>();
  if (existing) {
    const [readable] = await filterReadableResources(env, tenantId, [existing], { principal: actorPrincipal, projectId: input.project_id });
    if (!readable) throw new HttpError(404, "resource_not_found", "Knowledge resource not found");
    if (input.connector_id) {
      const update = await env.OPEN_BRAIN_DB.prepare(
        `UPDATE knowledge_resource_locations
         SET connector_id = COALESCE(connector_id, ?),
             fetch_enabled = CASE WHEN ? = 1 THEN 1 ELSE fetch_enabled END,
             updated_at = ?
         WHERE tenant_id = ? AND resource_id = ? AND normalized_uri = ?
           AND (connector_id IS NULL OR connector_id = ?)`
      ).bind(input.connector_id, input.fetch_enabled ? 1 : 0, Date.now(), tenantId, existing.id, normalizedUri, input.connector_id).run();
      if (!update.meta.changes) throw new HttpError(409, "resource_connector_conflict", "URI is already bound to another connector");
    }
    await ensureAccessPolicy(env, {
      tenantId,
      resourceType: "knowledge_resource",
      resourceId: existing.id,
      scope: existing.visibility === "tenant" ? "tenant" : existing.visibility === "project" ? "project" : "restricted",
      ownerPrincipal: actorPrincipal,
      projectId: existing.project_id,
      restrictedSubjects: parseArray(existing.permissions_json).map((subjectId) => ({
        subject_type: "principal" as const,
        subject_id: subjectId
      })),
      storageLocation: "external",
      actorPrincipal
    });
    return { created: false, resource: toResource(existing) };
  }

  const now = Date.now();
  const resourceId = ulid();
  const locationId = ulid();
  const permissions = input.visibility === "restricted"
    ? [...new Set([actorPrincipal, ...input.permissions])]
    : input.permissions;
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_resources(
        id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system,
        media_type, visibility, permissions_json, lifecycle_state, created_by_principal,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`
    ).bind(
      resourceId, tenantId, input.project_id ?? null, input.resource_kind, normalizedUri,
      input.title, input.source_system, input.media_type, input.visibility,
      JSON.stringify(permissions), actorPrincipal, now, now
    ),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_resource_locations(
        id, tenant_id, resource_id, uri, normalized_uri, location_role, connector_id,
        fetch_enabled, created_at, updated_at
      ) VALUES(?,?,?,?,?,'canonical',?,?,?,?)`
    ).bind(
      locationId, tenantId, resourceId, input.canonical_uri, normalizedUri,
      input.connector_id ?? null, input.fetch_enabled ? 1 : 0, now, now
    )
  ]);
  await ensureAccessPolicy(env, {
    tenantId,
    resourceType: "knowledge_resource",
    resourceId,
    scope: input.visibility === "tenant" ? "tenant" : input.visibility === "project" ? "project" : "restricted",
    ownerPrincipal: actorPrincipal,
    projectId: input.project_id,
    restrictedSubjects: permissions.map((subjectId) => ({
      subject_type: "principal" as const,
      subject_id: subjectId
    })),
    storageLocation: "external",
    actorPrincipal
  });
  return {
    created: true,
    resource: {
      id: resourceId,
      tenant_id: tenantId,
      project_id: input.project_id ?? null,
      resource_kind: input.resource_kind,
      canonical_uri: normalizedUri,
      title: input.title,
      source_system: input.source_system,
      media_type: input.media_type,
      visibility: input.visibility,
      permissions,
      current_version_id: null,
      lifecycle_state: "active" as const,
      created_at: now,
      updated_at: now
    }
  };
}

export async function addKnowledgeResourceLocation(env: Env, rawBody: unknown, actorPrincipal: string) {
  const input = knowledgeResourceLocationCreateSchema.parse(rawBody);
  const tenantId = input.tenant_id ?? "default";
  if (input.connector_id) assertConnectorAuthorized(env, input.connector_id, actorPrincipal);
  await getReadableResourceRow(env, tenantId, input.resource_id, {
    principal: actorPrincipal,
    projectId: input.project_id
  });
  let normalizedUri: string;
  try {
    normalizedUri = normalizeKnowledgeResourceUri(input.uri);
    if (input.fetch_enabled && (normalizedUri.startsWith("https:") || normalizedUri.startsWith("git+https:"))) {
      assertConnectorFetchUri(normalizedUri);
    }
  } catch (error) {
    throw new HttpError(400, "invalid_resource_uri", error instanceof Error ? error.message : "invalid resource URI");
  }
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT resource_id FROM knowledge_resource_locations WHERE tenant_id = ? AND normalized_uri = ?`
  ).bind(tenantId, normalizedUri).first<{ resource_id: string }>();
  if (existing) {
    if (existing.resource_id !== input.resource_id) throw new HttpError(409, "resource_uri_conflict", "URI is already registered");
    return { created: false, resource_id: input.resource_id, normalized_uri: normalizedUri };
  }
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO knowledge_resource_locations(
      id, tenant_id, resource_id, uri, normalized_uri, location_role,
      connector_id, fetch_enabled, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    ulid(), tenantId, input.resource_id, input.uri, normalizedUri, input.location_role,
    input.connector_id ?? null, input.fetch_enabled ? 1 : 0, now, now
  ).run();
  return { created: true, resource_id: input.resource_id, normalized_uri: normalizedUri };
}

export async function captureKnowledgeResourceVersion(
  env: Env,
  tenantId: string,
  resourceId: string,
  rawBody: unknown,
  actorPrincipal: string,
  projectId: string | null = null
) {
  const input = knowledgeResourceVersionCaptureSchema.parse(rawBody);
  if (await sha256(input.extracted_text) !== input.extracted_text_hash) {
    throw new HttpError(400, "extracted_text_hash_mismatch", "extracted_text_hash does not match extracted_text");
  }
  const resource = await getReadableResourceRow(env, tenantId, resourceId, {
    principal: actorPrincipal,
    projectId
  });
  assertConnectorAuthorized(env, input.connector_id, actorPrincipal, resource.media_type, input.extracted_text);
  const connector = await env.OPEN_BRAIN_DB.prepare(
    `SELECT connector_id FROM knowledge_resource_locations
     WHERE tenant_id = ? AND resource_id = ? AND connector_id = ? AND fetch_enabled = 1 LIMIT 1`
  ).bind(tenantId, resourceId, input.connector_id).first<{ connector_id: string }>();
  if (!connector) throw new HttpError(403, "connector_not_allowed", "Resource connector is not allowlisted");
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, extracted_text_hash FROM knowledge_resource_versions
     WHERE tenant_id = ? AND resource_id = ? AND content_hash = ?`
  ).bind(tenantId, resourceId, input.content_hash).first<{ id: string; extracted_text_hash: string }>();
  if (existing) {
    if (existing.extracted_text_hash !== input.extracted_text_hash) {
      throw new HttpError(409, "content_hash_conflict", "Content hash is already bound to different extracted text");
    }
    const advanceResult = await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_resources
       SET current_version_id = ?,
           lifecycle_state = CASE WHEN EXISTS (
             SELECT 1 FROM knowledge_assertions a
             JOIN knowledge_assertion_evidence e ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
             WHERE a.tenant_id = knowledge_resources.tenant_id
               AND a.resource_id = knowledge_resources.id
               AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
               AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
               AND e.resource_version_id <> ?
           ) THEN 'stale' ELSE 'active' END,
           updated_at = ?
       WHERE tenant_id = ? AND id = ?
         AND (current_version_id IS NULL OR current_version_id = ?)`
    ).bind(existing.id, existing.id, Date.now(), tenantId, resourceId, existing.id).run();
    const advancesCurrent = Boolean(advanceResult.meta.changes);
    const capturedAt = input.captured_at ?? Date.now();
    const chunks = chunkKnowledgeResourceText(input.extracted_text);
    const chunkHashes = await Promise.all(chunks.map((chunk) => sha256(chunk.text)));
    const projectionStatements = [
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO knowledge_resource_versions_fts(version_id, tenant_id, resource_id, title, text)
         SELECT ?,?,?,?,? WHERE NOT EXISTS (
           SELECT 1 FROM knowledge_resource_versions_fts WHERE tenant_id = ? AND version_id = ?
         )`
      ).bind(existing.id, tenantId, resourceId, resource.title, input.extracted_text, tenantId, existing.id),
      ...chunks.map((chunk, index) => env.OPEN_BRAIN_DB.prepare(
        `INSERT OR IGNORE INTO retrieval_units(
          id, generation_id, tenant_id, project_id, source_type, source_id,
          unit_type, text, event_at, valid_from, source_ref_json, source_span_start,
          source_span_end, metadata_json, content_hash, extractor_name,
          extractor_version, extraction_state, created_at
        )
        SELECT ? || id, id, ?, ?, 'knowledge_resource_version', ?,
               'resource_document', ?, ?, ?, ?, ?, ?, ?, ?, 'connector-snapshot', '1', ?, ?
        FROM retrieval_generations WHERE status IN ('active', 'shadow', 'fallback')`
      ).bind(
        `resource:${existing.id}:${chunk.index}:`, tenantId, resource.project_id, existing.id, chunk.text,
        capturedAt, capturedAt,
        JSON.stringify({ type: "knowledge_resource", ref: resource.canonical_uri, version_id: existing.id }),
        chunk.source_span_start, chunk.source_span_end,
        JSON.stringify({ resource_id: resourceId, title: resource.title, chunk_index: chunk.index }),
        chunkHashes[index], input.extraction_state, Date.now()
      )),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
         SELECT u.id, u.generation_id, u.tenant_id, u.text FROM retrieval_units u
         WHERE u.tenant_id = ? AND u.source_type = 'knowledge_resource_version' AND u.source_id = ?
           AND NOT EXISTS (SELECT 1 FROM retrieval_units_fts f WHERE f.unit_id = u.id AND f.generation_id = u.generation_id)`
      ).bind(tenantId, existing.id)
    ];
    await env.OPEN_BRAIN_DB.batch(projectionStatements);
    const stale_review_proposals_created = advancesCurrent
      ? await createStaleReviewProposals(env, tenantId, resourceId, existing.id, actorPrincipal)
      : 0;
    return {
      created: false,
      version_id: existing.id,
      current_version_id: advancesCurrent ? existing.id : (await getResourceRow(env, tenantId, resourceId)).current_version_id,
      stale_review_proposals_created
    };
  }

  const versionId = ulid();
  const capturedAt = input.captured_at ?? Date.now();
  const chunks = chunkKnowledgeResourceText(input.extracted_text);
  const chunkHashes = await Promise.all(chunks.map((chunk) => sha256(chunk.text)));
  const retrievalStatements = chunks.map((chunk, index) => env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO retrieval_units(
      id, generation_id, tenant_id, project_id, source_type, source_id,
      unit_type, text, event_at, valid_from, source_ref_json, source_span_start,
      source_span_end, metadata_json, content_hash, extractor_name,
      extractor_version, extraction_state, created_at
    )
    SELECT ? || id, id, ?, ?, 'knowledge_resource_version', ?,
           'resource_document', ?, ?, ?, ?, ?, ?, ?, ?, 'connector-snapshot', '1', ?, ?
    FROM retrieval_generations WHERE status IN ('active', 'shadow', 'fallback')`
  ).bind(
    `resource:${versionId}:${chunk.index}:`, tenantId, resource.project_id, versionId, chunk.text,
    capturedAt, capturedAt,
    JSON.stringify({ type: "knowledge_resource", ref: resource.canonical_uri, version_id: versionId }),
    chunk.source_span_start, chunk.source_span_end,
    JSON.stringify({ resource_id: resourceId, title: resource.title, chunk_index: chunk.index }),
    chunkHashes[index], input.extraction_state, Date.now()
  ));
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_resource_versions(
        id, tenant_id, resource_id, connector_id, source_version, etag, last_modified,
        content_hash, snapshot_object_ref, extracted_text, extracted_text_hash,
        extraction_state, captured_at, created_by_principal, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      versionId, tenantId, resourceId, input.connector_id, input.source_version ?? null,
      input.etag ?? null, input.last_modified ?? null, input.content_hash,
      input.snapshot_object_ref, input.extracted_text, input.extracted_text_hash,
      input.extraction_state, capturedAt, actorPrincipal, Date.now()
    ),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_resource_versions_fts(version_id, tenant_id, resource_id, title, text)
       VALUES(?,?,?,?,?)`
    ).bind(versionId, tenantId, resourceId, resource.title, input.extracted_text),
    ...retrievalStatements,
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
       SELECT id, generation_id, tenant_id, text FROM retrieval_units
       WHERE tenant_id = ? AND source_type = 'knowledge_resource_version' AND source_id = ?`
    ).bind(tenantId, versionId)
  ]);
  const advanceResult = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_resources
     SET current_version_id = ?,
         lifecycle_state = CASE WHEN EXISTS (
           SELECT 1 FROM knowledge_assertions a
           JOIN knowledge_assertion_evidence e
             ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id AND e.resource_id = a.resource_id
           WHERE a.tenant_id = knowledge_resources.tenant_id
             AND a.resource_id = knowledge_resources.id
             AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
             AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
             AND e.resource_version_id <> ?
         ) THEN 'stale' ELSE 'active' END,
         updated_at = ?
     WHERE tenant_id = ? AND id = ? AND (
       current_version_id IS NULL OR ? > COALESCE((
         SELECT captured_at FROM knowledge_resource_versions current
         WHERE current.tenant_id = knowledge_resources.tenant_id
           AND current.resource_id = knowledge_resources.id
           AND current.id = knowledge_resources.current_version_id
       ), -1)
     )`
  ).bind(versionId, versionId, Date.now(), tenantId, resourceId, capturedAt).run();
  const advancesCurrent = Boolean(advanceResult.meta.changes);
  const currentVersionId = advancesCurrent ? versionId : (await getResourceRow(env, tenantId, resourceId)).current_version_id;
  const stale_review_proposals_created = advancesCurrent
    ? await createStaleReviewProposals(env, tenantId, resourceId, versionId, actorPrincipal)
    : 0;
  return {
    created: true,
    version_id: versionId,
    current_version_id: currentVersionId,
    stale_review_proposals_created
  };
}

export async function resolveKnowledgeResource(env: Env, tenantId: string, uri: string, options: PrincipalOptions = {}) {
  let normalized: string;
  try {
    normalized = normalizeKnowledgeResourceUri(uri);
  } catch {
    throw new HttpError(400, "invalid_resource_uri", "Invalid resource URI");
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.id, r.tenant_id, r.project_id, r.resource_kind, r.canonical_uri, r.title,
            r.source_system, r.media_type, r.visibility, r.permissions_json,
            r.current_version_id, r.lifecycle_state, r.created_at, r.updated_at
     FROM knowledge_resource_locations l
     JOIN knowledge_resources r ON r.tenant_id = l.tenant_id AND r.id = l.resource_id
     WHERE l.tenant_id = ? AND l.normalized_uri = ?`
  ).bind(tenantId, normalized).first<ResourceRow>();
  if (!row) throw new HttpError(404, "resource_not_found", "Knowledge resource not found");
  const [readable] = await filterReadableResources(env, tenantId, [row], options);
  if (!readable) throw new HttpError(404, "resource_not_found", "Knowledge resource not found");
  return toResource(readable);
}

export async function searchKnowledgeResources(env: Env, rawBody: unknown, options: PrincipalOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const tenantId = typeof body.tenant_id === "string" && body.tenant_id.trim() ? body.tenant_id.trim() : "default";
  const q = typeof body.q === "string" ? body.q.trim().slice(0, 512) : "";
  if (!q) throw new HttpError(400, "invalid_payload", "q is required");
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 20;
  const ftsQuery = buildKnowledgeFtsQuery(q);
  type ResourceSearchHitRow = ResourceRow & {
    hit_version_id: string;
    source_span_start: number | null;
    source_span_end: number | null;
  };
  const ftsRows = ftsQuery
    ? (await env.OPEN_BRAIN_DB.prepare(
        `SELECT DISTINCT r.id, r.tenant_id, r.project_id, r.resource_kind, r.canonical_uri,
                r.title, r.source_system, r.media_type, r.visibility, r.permissions_json,
                r.current_version_id, r.lifecycle_state, r.created_at, r.updated_at,
                u.source_id AS hit_version_id, u.source_span_start, u.source_span_end
         FROM retrieval_units_fts f
         JOIN retrieval_units u ON u.id = f.unit_id AND u.generation_id = f.generation_id AND u.tenant_id = f.tenant_id
         JOIN knowledge_resource_versions v ON v.tenant_id = u.tenant_id AND v.id = u.source_id
         JOIN knowledge_resources r ON r.tenant_id = v.tenant_id AND r.id = v.resource_id
         WHERE f.tenant_id = ? AND retrieval_units_fts MATCH ?
           AND u.source_type = 'knowledge_resource_version'
           AND r.lifecycle_state <> 'retired'
         ORDER BY r.updated_at DESC LIMIT ?`
      ).bind(tenantId, ftsQuery, limit * 6).all<ResourceSearchHitRow>()).results
    : [];
  const metadataRows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT r.id, r.tenant_id, r.project_id, r.resource_kind, r.canonical_uri,
            r.title, r.source_system, r.media_type, r.visibility, r.permissions_json,
            r.current_version_id, r.lifecycle_state, r.created_at, r.updated_at
     FROM knowledge_resources r
     LEFT JOIN knowledge_resource_locations l
       ON l.tenant_id = r.tenant_id AND l.resource_id = r.id
     WHERE r.tenant_id = ? AND r.lifecycle_state <> 'retired'
       AND (lower(r.title) LIKE lower(?) OR lower(r.canonical_uri) LIKE lower(?)
            OR lower(COALESCE(l.normalized_uri, '')) LIKE lower(?))
     ORDER BY r.updated_at DESC LIMIT ?`
  ).bind(tenantId, `%${q}%`, `%${q}%`, `%${q}%`, limit * 3).all<ResourceRow>()).results;
  const byId = new Map<string, ResourceRow>();
  for (const row of [...ftsRows, ...metadataRows]) if (!byId.has(row.id)) byId.set(row.id, row);
  const readable = await filterReadableResources(env, tenantId, [...byId.values()], options);
  const hitsByResource = new Map<string, Array<{ resource_version_id: string; locator: ResourceLocator }>>();
  for (const row of ftsRows) {
    const hits = hitsByResource.get(row.id) ?? [];
    hits.push({
      resource_version_id: row.hit_version_id,
      locator: { selector: `char=${row.source_span_start ?? 0}:${row.source_span_end ?? 0}` }
    });
    hitsByResource.set(row.id, hits);
  }
  return {
    items: readable.slice(0, limit).map((row) => ({ ...toResource(row), search_hits: hitsByResource.get(row.id) ?? [] })),
    coverage: { truncated: readable.length > limit, hit_provenance_included: true }
  };
}

async function assertDecisionExists(env: Env, tenantId: string, decisionRef: DecisionRef): Promise<{ project_id: string | null }> {
  const table = decisionRef.source_type === "decision_memory" ? "decision_memories" : "decision_rationales";
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id FROM ${table} WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, decisionRef.source_id).first<{ id: string; project_id: string | null }>();
  if (!row) throw new HttpError(404, "decision_not_found", "Decision not found");
  return { project_id: row.project_id };
}

export async function createDecisionResourceLink(env: Env, rawBody: unknown, actorPrincipal: string) {
  const input = decisionResourceLinkCreateSchema.parse(rawBody);
  const tenantId = input.tenant_id ?? "default";
  const decisionRecord = await assertDecisionExists(env, tenantId, input.decision_ref);
  if (input.project_id && decisionRecord.project_id && input.project_id !== decisionRecord.project_id) {
    throw new HttpError(404, "decision_not_found", "Decision not found");
  }
  if (!await readableDecision(env, tenantId, input.decision_ref, actorPrincipal, input.project_id ?? null)) {
    throw new HttpError(404, "decision_not_found", "Decision not found");
  }
  await getReadableResourceRow(env, tenantId, input.resource_id, { principal: actorPrincipal, projectId: input.project_id });
  if (input.resource_version_id) {
    const version = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM knowledge_resource_versions
       WHERE tenant_id = ? AND resource_id = ? AND id = ?`
    ).bind(tenantId, input.resource_id, input.resource_version_id).first<{ id: string }>();
    if (!version) throw new HttpError(404, "resource_version_not_found", "Resource version not found");
  }
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.id AS assertion_id, a.subject_type AS source_type, a.subject_ref AS source_id,
            a.object_ref AS resource_id, a.predicate AS role, e.resource_version_id,
            e.locator_json, e.excerpt_digest, e.note, a.confirmation_state,
            a.valid_from, a.valid_until, a.actor_principal, a.reviewed_by_principal, a.created_at,
            a.confidence
     FROM knowledge_assertions a
     LEFT JOIN knowledge_assertion_evidence e ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
     WHERE a.tenant_id = ? AND a.idempotency_key = ?`
  ).bind(tenantId, input.idempotency_key).first<LinkRow>();
  if (existing) {
    const samePayload = existing.source_type === input.decision_ref.source_type &&
      existing.source_id === input.decision_ref.source_id &&
      existing.resource_id === input.resource_id &&
      existing.role === input.role &&
      existing.resource_version_id === (input.resource_version_id ?? null) &&
      JSON.stringify(parseLocator(existing.locator_json)) === JSON.stringify(input.locator ?? null) &&
      existing.excerpt_digest === (input.excerpt_digest ?? null) &&
      existing.note === (input.note ?? null) &&
      existing.confirmation_state === input.confirmation_state &&
      (existing.confidence ?? input.confidence) === input.confidence;
    if (!samePayload) throw new HttpError(409, "idempotency_conflict", "Idempotency key was used for a different link payload");
    return { created: false, link: toLink(existing) };
  }

  const assertionId = ulid();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, context_json, confidence, confirmation_state,
        idempotency_key, valid_from, actor_principal, reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,'relation',?,?,?,'knowledge_resource',?,?,'{}',?,?,?,?,?,?,?,?)`
    ).bind(
      assertionId, tenantId, input.project_id ?? null, input.decision_ref.source_type,
      input.decision_ref.source_id, input.role, input.resource_id, input.resource_id, input.confidence,
      input.confirmation_state, input.idempotency_key, now, actorPrincipal,
      input.confirmation_state === "confirmed" ? actorPrincipal : null, now, now
    )
  ];
  if (input.resource_version_id) {
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_assertion_evidence(
        id, tenant_id, assertion_id, resource_id, resource_version_id, locator_json, excerpt_digest, note, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(
      ulid(), tenantId, assertionId, input.resource_id, input.resource_version_id,
      input.locator ? JSON.stringify(input.locator) : null,
      input.excerpt_digest ?? null, input.note ?? null, now
    ));
  }
  statements.push(env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_resources
     SET lifecycle_state = CASE WHEN EXISTS (
       SELECT 1 FROM knowledge_assertions a
       JOIN knowledge_assertion_evidence e
         ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id AND e.resource_id = a.resource_id
       WHERE a.tenant_id = knowledge_resources.tenant_id
         AND a.resource_id = knowledge_resources.id
         AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
         AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
         AND e.resource_version_id <> knowledge_resources.current_version_id
     ) THEN 'stale' ELSE 'active' END,
     updated_at = ?
     WHERE tenant_id = ? AND id = ? AND lifecycle_state <> 'retired'`
  ).bind(now, tenantId, input.resource_id));
  await env.OPEN_BRAIN_DB.batch(statements);
  return {
    created: true,
    link: {
      assertion_id: assertionId,
      decision_ref: input.decision_ref,
      resource_id: input.resource_id,
      role: input.role,
      resource_version_id: input.resource_version_id ?? null,
      locator: input.locator ?? null,
      excerpt_digest: input.excerpt_digest ?? null,
      note: input.note ?? null,
      confirmation_state: input.confirmation_state,
      valid_from: now,
      valid_until: null,
      actor: actorPrincipal,
      reviewed_by: input.confirmation_state === "confirmed" ? actorPrincipal : null,
      created_at: now
    } satisfies DecisionResourceLink
  };
}

async function listConfirmedLinks(env: Env, tenantId: string, clause: "resource" | "decision", value: string, sourceType?: DecisionRef["source_type"]): Promise<LinkRow[]> {
  const base = `SELECT a.id AS assertion_id, a.subject_type AS source_type, a.subject_ref AS source_id,
                       a.object_ref AS resource_id, a.predicate AS role, e.resource_version_id,
                       e.locator_json, e.excerpt_digest, e.note, a.confirmation_state,
                       a.valid_from, a.valid_until, a.actor_principal, a.reviewed_by_principal, a.created_at
                FROM knowledge_assertions a
                LEFT JOIN knowledge_assertion_evidence e ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
                WHERE a.tenant_id = ? AND a.assertion_type = 'relation'
                  AND a.object_type = 'knowledge_resource' AND a.confirmation_state = 'confirmed'
                  AND a.valid_until IS NULL`;
  const query = clause === "resource"
    ? `${base} AND a.object_ref = ? ORDER BY a.created_at, a.id`
    : `${base} AND a.subject_type = ? AND a.subject_ref = ? ORDER BY a.created_at, a.id`;
  const result = clause === "resource"
    ? await env.OPEN_BRAIN_DB.prepare(query).bind(tenantId, value).all<LinkRow>()
    : await env.OPEN_BRAIN_DB.prepare(query).bind(tenantId, sourceType, value).all<LinkRow>();
  return result.results;
}

async function readableDecision(
  env: Env,
  tenantId: string,
  ref: DecisionRef,
  actorPrincipal: string,
  projectId: string | null = null
): Promise<{ conclusion: string; reason_summary: string } | null> {
  if (ref.source_type === "decision_memory") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT decision, rationale, project_id, visibility, allowed_principals_json
       FROM decision_memories WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, ref.source_id).first<{
      decision: string | null;
      rationale: string | null;
      project_id: string | null;
      visibility: string | null;
      allowed_principals_json: string | null;
    }>();
    if (!row || (projectId && row.project_id && row.project_id !== projectId)) return null;
    const allowed = parseArray(row.allowed_principals_json);
    if (row.visibility === "restricted" || allowed.length > 0) {
      let readable = allowed.includes(actorPrincipal);
      if (!readable) {
        const authz = await buildAuthzContext(env, tenantId, actorPrincipal);
        readable = (await loadReadableResourceIds(env, {
          tenantId,
          resourceType: "decision_memory",
          resourceIds: [ref.source_id],
          authz
        })).has(ref.source_id);
      }
      if (!readable) return null;
    }
    return { conclusion: row.decision ?? "", reason_summary: row.rationale ?? "" };
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.conclusion, r.reason_summary, r.project_id, m.permissions_json
     FROM decision_rationales r
     JOIN memories m ON m.tenant_id = r.tenant_id AND m.id = r.memory_id
     WHERE r.tenant_id = ? AND r.id = ?`
  ).bind(tenantId, ref.source_id).first<{
    conclusion: string;
    reason_summary: string;
    project_id: string | null;
    permissions_json: string | null;
  }>();
  if (!row) return null;
  if (projectId && row.project_id && row.project_id !== projectId) return null;
  if (!stableResultReadable(row.permissions_json, actorPrincipal)) return null;
  return { conclusion: row.conclusion, reason_summary: row.reason_summary };
}

export async function getResourceDecisions(env: Env, tenantId: string, resourceId: string, options: PrincipalOptions = {}) {
  const actor = principal(options);
  if (!actor) throw new HttpError(401, "unauthorized", "Principal is required");
  const resource = await getReadableResourceRow(env, tenantId, resourceId, options);
  if (options.resourceVersionId) {
    const version = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM knowledge_resource_versions WHERE tenant_id = ? AND resource_id = ? AND id = ?`
    ).bind(tenantId, resourceId, options.resourceVersionId).first<{ id: string }>();
    if (!version) throw new HttpError(404, "resource_version_not_found", "Resource version not found");
  }
  const links = await listConfirmedLinks(env, tenantId, "resource", resourceId);
  const grouped = new Map<string, { decision_ref: DecisionRef; conclusion: string; reason_summary: string; reason_items: DecisionResourceLink[] }>();
  for (const row of links) {
    if (!["conclusion_source", "rationale_source", "contradiction", "input"].includes(row.role)) continue;
    if (options.resourceVersionId && row.resource_version_id !== options.resourceVersionId) continue;
    const ref = { source_type: row.source_type, source_id: row.source_id } satisfies DecisionRef;
    const decision = await readableDecision(env, tenantId, ref, actor, options.projectId ?? null);
    if (!decision) continue;
    const key = `${ref.source_type}:${ref.source_id}`;
    const item = grouped.get(key) ?? { decision_ref: ref, ...decision, reason_items: [] };
    item.reason_items.push(toLink(row));
    grouped.set(key, item);
  }
  return {
    resource: toResource(resource),
    decisions: [...grouped.values()],
    coverage: {
      target_resource_version_id: options.resourceVersionId ?? resource.current_version_id,
      resource_state: resource.lifecycle_state,
      proposed_excluded: true,
      truncated: false
    }
  };
}

export async function getDecisionResources(env: Env, tenantId: string, rawRef: unknown, options: PrincipalOptions = {}) {
  const actor = principal(options);
  if (!actor) throw new HttpError(401, "unauthorized", "Principal is required");
  const ref = decisionRefSchema.parse(rawRef);
  const decision = await readableDecision(env, tenantId, ref, actor, options.projectId ?? null);
  if (!decision) throw new HttpError(404, "decision_not_found", "Decision not found");
  const links = await listConfirmedLinks(env, tenantId, "decision", ref.source_id, ref.source_type);
  const artifacts: Array<{
    link: DecisionResourceLink;
    resource: KnowledgeResource;
    freshness: string;
    availability: string;
    related_via?: { resource_id: string; decision_ref: DecisionRef };
  }> = [];
  for (const row of links) {
    if (!["implementation_artifact", "output_artifact", "verification_artifact"].includes(row.role)) continue;
    const resource = await getResourceRow(env, tenantId, row.resource_id);
    const [readable] = await filterReadableResources(env, tenantId, [resource], options);
    if (!readable) continue;
    const value = toResource(readable);
    artifacts.push({
      link: toLink(row),
      resource: value,
      freshness: value.lifecycle_state,
      availability: "readable"
    });
  }
  if (options.includeRelated) {
    const related = await env.OPEN_BRAIN_DB.prepare(
      `SELECT DISTINCT peer.subject_type, peer.subject_ref, seed.resource_id AS shared_resource_id
       FROM knowledge_assertions seed
       JOIN knowledge_assertions peer
         ON peer.tenant_id = seed.tenant_id AND peer.resource_id = seed.resource_id
       WHERE seed.tenant_id = ? AND seed.subject_type = ? AND seed.subject_ref = ?
         AND seed.predicate IN ('conclusion_source', 'rationale_source', 'contradiction', 'input')
         AND peer.predicate IN ('conclusion_source', 'rationale_source', 'contradiction', 'input')
         AND seed.confirmation_state = 'confirmed' AND seed.valid_until IS NULL
         AND peer.confirmation_state = 'confirmed' AND peer.valid_until IS NULL
         AND (peer.subject_type <> seed.subject_type OR peer.subject_ref <> seed.subject_ref)`
    ).bind(tenantId, ref.source_type, ref.source_id).all<{
      subject_type: DecisionRef["source_type"];
      subject_ref: string;
      shared_resource_id: string;
    }>();
    const seen = new Set(artifacts.map((item) => item.link.assertion_id));
    for (const peer of related.results) {
      const sharedResource = await getResourceRow(env, tenantId, peer.shared_resource_id);
      if (!(await filterReadableResources(env, tenantId, [sharedResource], options))[0]) continue;
      const peerRef = { source_type: peer.subject_type, source_id: peer.subject_ref } satisfies DecisionRef;
      if (!await readableDecision(env, tenantId, peerRef, actor, options.projectId ?? null)) continue;
      const peerLinks = await listConfirmedLinks(env, tenantId, "decision", peer.subject_ref, peer.subject_type);
      for (const row of peerLinks) {
        if (seen.has(row.assertion_id) || !["implementation_artifact", "output_artifact", "verification_artifact"].includes(row.role)) continue;
        const resource = await getResourceRow(env, tenantId, row.resource_id);
        const [readable] = await filterReadableResources(env, tenantId, [resource], options);
        if (!readable) continue;
        seen.add(row.assertion_id);
        const value = toResource(readable);
        artifacts.push({
          link: toLink(row), resource: value, freshness: value.lifecycle_state, availability: "readable",
          related_via: { resource_id: peer.shared_resource_id, decision_ref: peerRef }
        });
      }
    }
  }
  const artifactsByRole = {
    implementation_artifact: artifacts.filter((item) => item.link.role === "implementation_artifact"),
    output_artifact: artifacts.filter((item) => item.link.role === "output_artifact"),
    verification_artifact: artifacts.filter((item) => item.link.role === "verification_artifact")
  };
  return {
    decision: { decision_ref: ref, ...decision },
    artifacts,
    artifacts_by_role: artifactsByRole,
    coverage: { proposed_excluded: true, truncated: false, related_included: options.includeRelated === true }
  };
}

const MEMORY_MAP_TRACE_RESOURCE_LIMIT = 40;

export async function getDecisionResourceTrace(
  env: Env,
  tenantId: string,
  rawRef: unknown,
  options: PrincipalOptions = {}
): Promise<{
  sources: MemoryMapTraceResource[];
  artifacts: MemoryMapTraceResource[];
  truncated: boolean;
}> {
  const actor = principal(options);
  if (!actor) throw new HttpError(401, "unauthorized", "Principal is required");
  const ref = decisionRefSchema.parse(rawRef);
  if (options.accessMode === "defer") {
    const exists = ref.source_type === "decision_memory"
      ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT 1 AS found FROM decision_memories WHERE tenant_id = ? AND id = ?`
      ).bind(tenantId, ref.source_id).first<{ found: number }>()
      : await env.OPEN_BRAIN_DB.prepare(
        `SELECT 1 AS found FROM decision_rationales WHERE tenant_id = ? AND id = ?`
      ).bind(tenantId, ref.source_id).first<{ found: number }>();
    if (!exists) throw new HttpError(404, "decision_not_found", "Decision not found");

    // The Decision Console applies the unified policy in one bulk pass. Fetch the
    // bounded resource projection here so remote D1 latency does not grow with
    // every node in the trace.
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT a.id AS assertion_id, a.subject_type AS source_type, a.subject_ref AS source_id,
              a.object_ref AS resource_id, a.predicate AS role, e.resource_version_id,
              e.locator_json, e.excerpt_digest, e.note, a.confirmation_state,
              a.valid_from, a.valid_until, a.actor_principal, a.reviewed_by_principal,
              a.created_at, a.confidence,
              r.tenant_id AS resource_tenant_id, r.project_id AS resource_project_id,
              r.resource_kind, r.canonical_uri, r.title AS resource_title,
              r.source_system, r.media_type, r.visibility, r.permissions_json,
              r.current_version_id, r.lifecycle_state,
              r.created_at AS resource_created_at, r.updated_at AS resource_updated_at,
              v.id AS version_id, v.source_version AS version_source_version,
              v.content_hash AS version_content_hash, v.captured_at AS version_captured_at,
              v.extraction_state AS version_extraction_state
       FROM knowledge_assertions a
       JOIN knowledge_resources r
         ON r.tenant_id = a.tenant_id AND r.id = a.object_ref
       LEFT JOIN knowledge_assertion_evidence e
         ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
        AND e.id = (
          SELECT evidence.id FROM knowledge_assertion_evidence evidence
          WHERE evidence.tenant_id = a.tenant_id AND evidence.assertion_id = a.id
          ORDER BY evidence.created_at, evidence.id LIMIT 1
        )
       LEFT JOIN knowledge_resource_versions v
         ON v.tenant_id = r.tenant_id AND v.resource_id = r.id
        AND v.id = COALESCE(e.resource_version_id, r.current_version_id)
       WHERE a.tenant_id = ? AND a.assertion_type = 'relation'
         AND a.subject_type = ? AND a.subject_ref = ?
         AND a.object_type = 'knowledge_resource' AND a.confirmation_state = 'confirmed'
         AND a.valid_until IS NULL AND r.lifecycle_state <> 'retired'
         AND a.predicate IN (
           'conclusion_source', 'rationale_source', 'contradiction', 'input',
           'implementation_artifact', 'output_artifact', 'verification_artifact'
         )
       ORDER BY a.created_at, a.id LIMIT ?`
    ).bind(tenantId, ref.source_type, ref.source_id, MEMORY_MAP_TRACE_RESOURCE_LIMIT * 5 + 1)
      .all<DecisionTraceReadRow>();
    const visible = rows.results.slice(0, MEMORY_MAP_TRACE_RESOURCE_LIMIT * 5).map((row) => {
      const resource = toResource({
        id: row.resource_id,
        tenant_id: row.resource_tenant_id,
        project_id: row.resource_project_id,
        resource_kind: row.resource_kind,
        canonical_uri: row.canonical_uri,
        title: row.resource_title,
        source_system: row.source_system,
        media_type: row.media_type,
        visibility: row.visibility,
        permissions_json: row.permissions_json,
        current_version_id: row.current_version_id,
        lifecycle_state: row.lifecycle_state,
        created_at: row.resource_created_at,
        updated_at: row.resource_updated_at
      });
      return {
        link: toLink(row),
        resource,
        version: row.version_id ? {
          id: row.version_id,
          source_version: row.version_source_version,
          content_hash: row.version_content_hash ?? "",
          captured_at: row.version_captured_at ?? 0,
          extraction_state: row.version_extraction_state ?? "pending",
          pinned: row.resource_version_id !== null
        } : null,
        freshness: resource.lifecycle_state,
        availability: "readable" as const
      };
    });
    return {
      sources: visible.filter((item) => [
        "conclusion_source", "rationale_source", "contradiction", "input"
      ].includes(item.link.role)),
      artifacts: visible.filter((item) => [
        "implementation_artifact", "output_artifact", "verification_artifact"
      ].includes(item.link.role)),
      truncated: rows.results.length > MEMORY_MAP_TRACE_RESOURCE_LIMIT * 5
    };
  } else {
    const decision = await readableDecision(env, tenantId, ref, actor, options.projectId ?? null);
    if (!decision) throw new HttpError(404, "decision_not_found", "Decision not found");
  }

  const links = await listConfirmedLinks(env, tenantId, "decision", ref.source_id, ref.source_type);
  const traceLimit = MEMORY_MAP_TRACE_RESOURCE_LIMIT;
  const visible: MemoryMapTraceResource[] = [];
  const seenAssertions = new Set<string>();
  for (const row of links) {
    if (seenAssertions.has(row.assertion_id)) continue;
    if (![
      "conclusion_source",
      "rationale_source",
      "contradiction",
      "input",
      "implementation_artifact",
      "output_artifact",
      "verification_artifact"
    ].includes(row.role)) continue;
    seenAssertions.add(row.assertion_id);

    const resource = await getResourceRow(env, tenantId, row.resource_id);
    const readableResource = (await filterReadableResources(env, tenantId, [resource], options))[0];
    if (!readableResource || readableResource.lifecycle_state === "retired") continue;
    const resourceVersionId = row.resource_version_id ?? readableResource.current_version_id;
    const version = resourceVersionId
      ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, source_version, content_hash, captured_at, extraction_state
         FROM knowledge_resource_versions
         WHERE tenant_id = ? AND resource_id = ? AND id = ?`
      ).bind(tenantId, readableResource.id, resourceVersionId).first<{
        id: string;
        source_version: string | null;
        content_hash: string;
        captured_at: number;
        extraction_state: KnowledgeResourceExtractionState;
      }>()
      : null;

    visible.push({
      link: toLink(row),
      resource: toResource(readableResource),
      version: version ? {
        id: version.id,
        source_version: version.source_version,
        content_hash: version.content_hash,
        captured_at: version.captured_at,
        extraction_state: version.extraction_state,
        pinned: row.resource_version_id !== null
      } : null,
      freshness: readableResource.lifecycle_state,
      availability: "readable"
    });
    if (visible.length >= traceLimit) break;
  }

  const sources = visible.filter((item) => [
    "conclusion_source", "rationale_source", "contradiction", "input"
  ].includes(item.link.role));
  const artifacts = visible.filter((item) => [
    "implementation_artifact", "output_artifact", "verification_artifact"
  ].includes(item.link.role));
  return {
    sources,
    artifacts,
    truncated: links.length > traceLimit
  };
}

export async function listDecisionResourceLinkProposals(
  env: Env,
  tenantId: string,
  options: PrincipalOptions = {}
) {
  const actor = principal(options);
  if (!actor) throw new HttpError(401, "unauthorized", "Principal is required");
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.id AS assertion_id, a.subject_type AS source_type, a.subject_ref AS source_id,
            a.object_ref AS resource_id, a.predicate AS role, e.resource_version_id,
            e.locator_json, e.excerpt_digest, e.note, a.confirmation_state,
            a.valid_from, a.valid_until, a.actor_principal, a.reviewed_by_principal,
            a.created_at, a.context_json
     FROM knowledge_assertions a
     LEFT JOIN knowledge_assertion_evidence e ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
     WHERE a.tenant_id = ? AND a.assertion_type = 'relation'
       AND a.object_type = 'knowledge_resource' AND a.confirmation_state = 'proposal'
       AND a.valid_until IS NULL ORDER BY a.created_at, a.id`
  ).bind(tenantId).all<LinkRow & { context_json: string }>();
  const items = [];
  for (const row of result.results) {
    const resourceRow = await getResourceRow(env, tenantId, row.resource_id);
    const [readableResource] = await filterReadableResources(env, tenantId, [resourceRow], options);
    if (!readableResource) continue;
    const decisionRef = { source_type: row.source_type, source_id: row.source_id } satisfies DecisionRef;
    const decision = await readableDecision(env, tenantId, decisionRef, actor, options.projectId ?? null);
    if (!decision) continue;
    let context: Record<string, unknown> = {};
    try { context = JSON.parse(row.context_json) as Record<string, unknown>; } catch { context = {}; }
    items.push({ link: toLink(row), resource: toResource(readableResource), decision: { decision_ref: decisionRef, ...decision }, context });
  }
  return { items, coverage: { truncated: false, unauthorized_counts_disclosed: false } };
}

export async function confirmDecisionResourceLinkProposal(
  env: Env,
  tenantId: string,
  assertionId: string,
  rawBody: unknown,
  actorPrincipal: string,
  idempotencyKey: string,
  projectId: string | null = null
) {
  const proposal = await env.OPEN_BRAIN_DB.prepare(
    `SELECT subject_type, subject_ref, predicate, resource_id, project_id, confidence,
            confirmation_state, valid_until
     FROM knowledge_assertions WHERE tenant_id = ? AND id = ? AND assertion_type = 'relation'
       AND object_type = 'knowledge_resource'`
  ).bind(tenantId, assertionId).first<{
    subject_type: DecisionRef["source_type"];
    subject_ref: string;
    predicate: DecisionResourceLink["role"];
    resource_id: string;
    project_id: string | null;
    confidence: number;
    confirmation_state: string;
    valid_until: number | null;
  }>();
  if (!proposal || (projectId && proposal.project_id && projectId !== proposal.project_id)) {
    throw new HttpError(404, "link_proposal_not_found", "Decision resource link proposal not found");
  }
  const record = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
  const input = decisionResourceLinkCreateSchema.parse({
    tenant_id: tenantId,
    project_id: proposal.project_id,
    decision_ref: { source_type: proposal.subject_type, source_id: proposal.subject_ref },
    resource_id: proposal.resource_id,
    role: proposal.predicate,
    resource_version_id: record.resource_version_id,
    locator: record.locator,
    excerpt_digest: record.excerpt_digest,
    note: record.note,
    confirmation_state: "confirmed",
    confidence: proposal.confidence,
    idempotency_key: `proposal-confirm:${assertionId}:${idempotencyKey}`
  });
  await getReadableResourceRow(env, tenantId, proposal.resource_id, { principal: actorPrincipal, projectId });
  if (!await readableDecision(env, tenantId, input.decision_ref, actorPrincipal, projectId)) {
    throw new HttpError(404, "link_proposal_not_found", "Decision resource link proposal not found");
  }
  if (input.resource_version_id) {
    const version = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM knowledge_resource_versions WHERE tenant_id = ? AND resource_id = ? AND id = ?`
    ).bind(tenantId, input.resource_id, input.resource_version_id).first<{ id: string }>();
    if (!version) throw new HttpError(400, "resource_version_not_found", "Resource version does not belong to Resource");
  }
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.id, e.resource_version_id, e.locator_json, e.excerpt_digest, e.note
     FROM knowledge_assertions a
     LEFT JOIN knowledge_assertion_evidence e ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id
     WHERE a.tenant_id = ? AND a.idempotency_key = ?`
  ).bind(tenantId, input.idempotency_key).first<{
    id: string;
    resource_version_id: string | null;
    locator_json: string | null;
    excerpt_digest: string | null;
    note: string | null;
  }>();
  if (existing) {
    const samePayload = existing.resource_version_id === (input.resource_version_id ?? null) &&
      JSON.stringify(parseLocator(existing.locator_json)) === JSON.stringify(input.locator ?? null) &&
      existing.excerpt_digest === (input.excerpt_digest ?? null) && existing.note === (input.note ?? null);
    if (!samePayload) throw new HttpError(409, "idempotency_conflict", "Idempotency key was used for different proposal evidence");
    return { created: false, assertion_id: existing.id, proposal_id: assertionId };
  }
  if (proposal.confirmation_state !== "proposal" || proposal.valid_until != null) {
    throw new HttpError(404, "link_proposal_not_found", "Decision resource link proposal not found");
  }
  const confirmedId = ulid();
  const now = Date.now();
  const statements = [
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_assertions SET confirmation_state = 'retired', valid_until = ?, updated_at = ?, reviewed_by_principal = ?
       WHERE tenant_id = ? AND subject_type = ? AND subject_ref = ? AND predicate = ?
         AND resource_id = ? AND confirmation_state = 'confirmed' AND valid_until IS NULL`
    ).bind(now, now, actorPrincipal, tenantId, input.decision_ref.source_type, input.decision_ref.source_id, input.role, input.resource_id),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_assertions SET confirmation_state = 'retired', valid_until = ?, updated_at = ?, reviewed_by_principal = ?
       WHERE tenant_id = ? AND id = ? AND confirmation_state = 'proposal' AND valid_until IS NULL`
    ).bind(now, now, actorPrincipal, tenantId, assertionId),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, context_json, confidence, confirmation_state,
        idempotency_key, valid_from, actor_principal, reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,?,'relation',?,?,?,'knowledge_resource',?,?,?,?,'confirmed',?,?,?,?,?,?)`
    ).bind(
      confirmedId, tenantId, input.project_id ?? null, input.decision_ref.source_type,
      input.decision_ref.source_id, input.role, input.resource_id, input.resource_id,
      JSON.stringify({ confirmed_from_proposal_id: assertionId }), input.confidence,
      input.idempotency_key, now, actorPrincipal, actorPrincipal, now, now
    )
  ];
  if (input.resource_version_id) {
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_assertion_evidence(
        id, tenant_id, assertion_id, resource_id, resource_version_id,
        locator_json, excerpt_digest, note, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(
      ulid(), tenantId, confirmedId, input.resource_id, input.resource_version_id,
      JSON.stringify(input.locator ?? null), input.excerpt_digest ?? null, input.note ?? null, now
    ));
  }
  statements.push(env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_resources
     SET lifecycle_state = CASE WHEN EXISTS (
       SELECT 1 FROM knowledge_assertions a
       JOIN knowledge_assertion_evidence e
         ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id AND e.resource_id = a.resource_id
       WHERE a.tenant_id = knowledge_resources.tenant_id
         AND a.resource_id = knowledge_resources.id
         AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
         AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
         AND e.resource_version_id <> knowledge_resources.current_version_id
     ) THEN 'stale' ELSE 'active' END,
     updated_at = ?
     WHERE tenant_id = ? AND id = ? AND lifecycle_state <> 'retired'`
  ).bind(now, tenantId, input.resource_id));
  await env.OPEN_BRAIN_DB.batch(statements);
  return { created: true, assertion_id: confirmedId, proposal_id: assertionId };
}

export async function retireDecisionResourceLink(
  env: Env,
  tenantId: string,
  assertionId: string,
  actorPrincipal: string,
  projectId: string | null = null
) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT subject_type, subject_ref, resource_id, project_id, confirmation_state, valid_until
     FROM knowledge_assertions
     WHERE tenant_id = ? AND id = ? AND assertion_type = 'relation'
       AND object_type = 'knowledge_resource'`
  ).bind(tenantId, assertionId).first<{
    subject_type: DecisionRef["source_type"];
    subject_ref: string;
    resource_id: string;
    project_id: string | null;
    confirmation_state: string;
    valid_until: number | null;
  }>();
  if (!row) throw new HttpError(404, "link_not_found", "Decision resource link not found");
  if (projectId && row.project_id && projectId !== row.project_id) {
    throw new HttpError(404, "link_not_found", "Decision resource link not found");
  }
  await getReadableResourceRow(env, tenantId, row.resource_id, { principal: actorPrincipal, projectId });
  if (!await readableDecision(
    env,
    tenantId,
    { source_type: row.subject_type, source_id: row.subject_ref },
    actorPrincipal,
    projectId
  )) {
    throw new HttpError(404, "link_not_found", "Decision resource link not found");
  }
  if (row.confirmation_state === "retired" && row.valid_until != null) {
    return { assertion_id: assertionId, retired: true, valid_until: row.valid_until };
  }
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_assertions
     SET confirmation_state = 'retired', valid_until = ?, updated_at = ?, reviewed_by_principal = ?
     WHERE tenant_id = ? AND id = ? AND assertion_type = 'relation'
       AND object_type = 'knowledge_resource' AND valid_until IS NULL`
  ).bind(now, now, actorPrincipal, tenantId, assertionId).run();
  if (!result.meta.changes) throw new HttpError(404, "link_not_found", "Decision resource link not found");
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_resources
     SET lifecycle_state = CASE WHEN EXISTS (
       SELECT 1 FROM knowledge_assertions a
       JOIN knowledge_assertion_evidence e
         ON e.tenant_id = a.tenant_id AND e.assertion_id = a.id AND e.resource_id = a.resource_id
       WHERE a.tenant_id = knowledge_resources.tenant_id
         AND a.resource_id = knowledge_resources.id
         AND a.predicate IN ('conclusion_source', 'rationale_source', 'contradiction')
         AND a.confirmation_state = 'confirmed' AND a.valid_until IS NULL
         AND e.resource_version_id <> knowledge_resources.current_version_id
     ) THEN 'stale' ELSE 'active' END,
     updated_at = ? WHERE tenant_id = ? AND id = ? AND lifecycle_state <> 'retired'`
  ).bind(now, tenantId, row.resource_id).run();
  return { assertion_id: assertionId, retired: true, valid_until: now };
}

type KnowledgeDocBackfillRow = {
  id: string;
  project_id: string | null;
  kind: string;
  title: string;
  summary: string | null;
  body_text: string | null;
  artifact_ref: string | null;
  visibility: string | null;
  owner_principal: string | null;
  updated_at: number;
};

type DecisionEvidenceBackfillRow = {
  id: string;
  rationale_id: string;
  project_id: string | null;
  confirmation_state: string | null;
  permissions_json: string | null;
  evidence_type: string;
  evidence_ref: string;
  relation: string;
  note: string | null;
  created_at: number;
};

type DecisionMemoryBackfillRow = {
  id: string;
  project_id: string | null;
  confirmation_state: string | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  source_refs_json: string | null;
};

type BackfillCounts = {
  resources_created: number;
  versions_created: number;
  links_created: number;
  evidence_attached: number;
};

function emptyBackfillCounts(): BackfillCounts {
  return { resources_created: 0, versions_created: 0, links_created: 0, evidence_attached: 0 };
}

async function copyLegacyResourceAcl(
  env: Env,
  tenantId: string,
  sourceType: string,
  sourceId: string,
  resourceId: string,
  actorPrincipal: string
): Promise<void> {
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT subject_type, subject_id, permission
     FROM resource_acl
     WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`
  ).bind(tenantId, sourceType, sourceId).all<{
    subject_type: string;
    subject_id: string;
    permission: string;
  }>()).results;
  if (!rows.length) return;
  await env.OPEN_BRAIN_DB.batch(rows.map((row) => env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO resource_acl(
      id, tenant_id, resource_type, resource_id, subject_type, subject_id,
      permission, created_by_principal, created_at
    ) VALUES(?,?,'knowledge_resource',?,?,?,?,?,?)`
  ).bind(ulid(), tenantId, resourceId, row.subject_type, row.subject_id, row.permission, actorPrincipal, Date.now())));
}

async function grantKnowledgeResourcePrincipals(
  env: Env,
  tenantId: string,
  resourceId: string,
  principals: string[],
  actorPrincipal: string
): Promise<void> {
  const unique = [...new Set(principals.filter(Boolean))];
  if (!unique.length) return;
  await env.OPEN_BRAIN_DB.batch(unique.map((subjectId) => env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO resource_acl(
      id, tenant_id, resource_type, resource_id, subject_type, subject_id,
      permission, created_by_principal, created_at
    ) VALUES(?,?,'knowledge_resource',?,'principal',?,'read',?,?)`
  ).bind(ulid(), tenantId, resourceId, subjectId, actorPrincipal, Date.now())));
}

type LegacySourceRef = {
  type?: string;
  id?: string;
  title?: string;
  url?: string;
  allowedPrincipals?: string[];
};

function parseLegacySourceRefs(raw: string | null): LegacySourceRef[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LegacySourceRef => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  } catch {
    return [];
  }
}

function evidenceRole(relation: string): DecisionResourceLink["role"] {
  if (relation === "contradicts") return "contradiction";
  if (relation === "supports") return "rationale_source";
  return "input";
}

function resourceKindForLegacy(kind: string): KnowledgeResource["resource_kind"] {
  if (["artifact", "file", "command"].includes(kind)) return "other";
  if (["issue", "pull_request", "commit", "design", "runbook", "dashboard", "dataset", "report", "test_result", "build", "release"].includes(kind)) {
    return kind as KnowledgeResource["resource_kind"];
  }
  return kind === "doc" || kind === "adr" ? "document" : "other";
}

async function readLegacyKnowledgeDoc(env: Env, row: KnowledgeDocBackfillRow): Promise<string> {
  if (!row.artifact_ref) return row.body_text ?? row.summary ?? "";
  const key = row.artifact_ref.startsWith("r2://") ? row.artifact_ref.slice("r2://".length) : row.artifact_ref;
  const object = await env.OPEN_BRAIN_BUCKET.get(key);
  if (!object) throw new HttpError(500, "artifact_missing", `knowledge doc artifact missing: ${row.artifact_ref}`);
  return object.text();
}

async function backfillKnowledgeDocs(env: Env, tenantId: string, cursor: string, limit: number, actorPrincipal: string) {
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, NULL AS project_id, kind, title, summary, body_text, artifact_ref,
            visibility, owner_principal, updated_at
     FROM knowledge_docs
     WHERE tenant_id = ? AND deleted_at IS NULL AND id > ?
     ORDER BY id LIMIT ?`
  ).bind(tenantId, cursor, limit).all<KnowledgeDocBackfillRow>()).results;
  const counts = emptyBackfillCounts();
  for (const row of rows) {
    const uri = stableBackfillUri("knowledge-doc", row.id);
    const resourceResult = await upsertKnowledgeResource(env, {
      tenant_id: tenantId,
      project_id: row.project_id,
      resource_kind: resourceKindForLegacy(row.kind),
      canonical_uri: uri,
      title: row.title,
      source_system: "knowledge_docs",
      media_type: "text/markdown",
      visibility: row.visibility === "restricted" ? "restricted" : "tenant",
      permissions: row.owner_principal ? [row.owner_principal] : [],
      connector_id: "knowledge-doc-backfill",
      fetch_enabled: true
    }, actorPrincipal);
    if (resourceResult.created) counts.resources_created += 1;
    await grantKnowledgeResourcePrincipals(
      env, tenantId, resourceResult.resource.id, row.owner_principal ? [row.owner_principal] : [], actorPrincipal
    );
    await copyLegacyResourceAcl(env, tenantId, "knowledge_doc", row.id, resourceResult.resource.id, actorPrincipal);
    const text = await readLegacyKnowledgeDoc(env, row);
    const digest = await sha256(text);
    const version = await captureKnowledgeResourceVersion(env, tenantId, resourceResult.resource.id, {
      connector_id: "knowledge-doc-backfill",
      source_version: String(row.updated_at),
      content_hash: digest,
      snapshot_object_ref: row.artifact_ref ?? `${uri}/versions/${row.updated_at}`,
      extracted_text: text,
      extracted_text_hash: digest,
      extraction_state: "ready",
      captured_at: row.updated_at
    }, actorPrincipal);
    if (version.created) counts.versions_created += 1;
  }
  return { rows, counts };
}

async function backfillDecisionEvidence(env: Env, tenantId: string, cursor: string, limit: number, actorPrincipal: string) {
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id, e.rationale_id, r.project_id, r.confirmation_state, m.permissions_json,
            e.evidence_type, e.evidence_ref, e.relation, e.note, e.created_at
     FROM decision_evidence e
     JOIN decision_rationales r ON r.tenant_id = e.tenant_id AND r.id = e.rationale_id
     JOIN memories m ON m.tenant_id = r.tenant_id AND m.id = r.memory_id
     WHERE e.tenant_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`
  ).bind(tenantId, cursor, limit).all<DecisionEvidenceBackfillRow>()).results;
  const counts = emptyBackfillCounts();
  for (const row of rows) {
    const uri = asResourceUri(row.evidence_ref, `evidence-${row.evidence_type}`, row.evidence_ref);
    const resourceResult = await upsertKnowledgeResource(env, {
      tenant_id: tenantId,
      project_id: row.project_id,
      resource_kind: resourceKindForLegacy(row.evidence_type),
      canonical_uri: uri,
      title: row.evidence_ref.slice(0, 512),
      source_system: "decision_evidence",
      media_type: "text/plain",
      visibility: row.permissions_json && row.permissions_json !== "[]" ? "restricted" : "tenant",
      permissions: principalsFromGrantJson(row.permissions_json),
      connector_id: "decision-evidence-backfill",
      fetch_enabled: true
    }, actorPrincipal);
    if (resourceResult.created) counts.resources_created += 1;
    await grantKnowledgeResourcePrincipals(
      env, tenantId, resourceResult.resource.id, principalsFromGrantJson(row.permissions_json), actorPrincipal
    );
    const backingMemory = await env.OPEN_BRAIN_DB.prepare(
      `SELECT memory_id FROM decision_rationales WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, row.rationale_id).first<{ memory_id: string }>();
    if (backingMemory) {
      await copyLegacyResourceAcl(env, tenantId, "memory", backingMemory.memory_id, resourceResult.resource.id, actorPrincipal);
    }
    const evidenceText = row.evidence_ref;
    const digest = await sha256(evidenceText);
    const version = await captureKnowledgeResourceVersion(env, tenantId, resourceResult.resource.id, {
      connector_id: "decision-evidence-backfill",
      source_version: row.id,
      content_hash: digest,
      snapshot_object_ref: stableBackfillUri("decision-evidence-snapshot", row.id),
      extracted_text: evidenceText,
      extracted_text_hash: digest,
      extraction_state: "degraded",
      captured_at: row.created_at
    }, actorPrincipal);
    if (version.created) counts.versions_created += 1;
    const confirmationState = isHumanConfirmed(row.confirmation_state) ? "confirmed" : "proposal";
    const role = evidenceRole(row.relation);
    const existing = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM knowledge_assertions
       WHERE tenant_id = ? AND subject_type = 'decision_rationale' AND subject_ref = ?
         AND predicate = ? AND object_type = 'knowledge_resource' AND object_ref = ?
         AND confirmation_state = ? AND valid_until IS NULL
       ORDER BY created_at LIMIT 1`
    ).bind(tenantId, row.rationale_id, role, resourceResult.resource.id, confirmationState).first<{ id: string }>();
    if (existing) {
      const attached = await env.OPEN_BRAIN_DB.prepare(
        `INSERT OR IGNORE INTO knowledge_assertion_evidence(
          id, tenant_id, assertion_id, resource_id, resource_version_id, locator_json, excerpt_digest, note, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`
      ).bind(
        ulid(), tenantId, existing.id, resourceResult.resource.id, version.version_id,
        JSON.stringify({ line_start: 1, line_end: 1 }), digest, row.note, Date.now()
      ).run();
      if (attached.meta.changes) counts.evidence_attached += 1;
      continue;
    }
    const link = await createDecisionResourceLink(env, {
      tenant_id: tenantId,
      project_id: row.project_id,
      decision_ref: { source_type: "decision_rationale", source_id: row.rationale_id },
      resource_id: resourceResult.resource.id,
      role,
      resource_version_id: version.version_id,
      locator: { line_start: 1, line_end: 1 },
      note: row.note,
      excerpt_digest: digest,
      confirmation_state: confirmationState,
      confidence: 1,
      idempotency_key: `backfill:decision-evidence:${row.id}`
    }, actorPrincipal);
    if (link.created) {
      counts.links_created += 1;
      counts.evidence_attached += 1;
    }
  }
  return { rows, counts };
}

async function backfillDecisionMemorySources(env: Env, tenantId: string, cursor: string, limit: number, actorPrincipal: string) {
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, confirmation_state, visibility,
            allowed_principals_json, source_refs_json
     FROM decision_memories
     WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`
  ).bind(tenantId, cursor, limit).all<DecisionMemoryBackfillRow>()).results;
  const counts = emptyBackfillCounts();
  for (const row of rows) {
    const refs = parseLegacySourceRefs(row.source_refs_json);
    const linkedResourceIds = new Set<string>();
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const identity = ref.url || ref.id || `${row.id}-${index}`;
      const uri = asResourceUri(ref.url ?? "", `source-${ref.type ?? "unknown"}`, identity);
      const decisionPrincipals = parseArray(row.allowed_principals_json);
      const refPrincipals = ref.allowedPrincipals ?? [];
      const permissions = decisionPrincipals.length && refPrincipals.length
        ? decisionPrincipals.filter((item) => refPrincipals.includes(item))
        : decisionPrincipals.length ? decisionPrincipals : refPrincipals;
      const visibility = row.visibility === "restricted" || refPrincipals.length ? "restricted" : "tenant";
      const result = await upsertKnowledgeResource(env, {
        tenant_id: tenantId,
        project_id: row.project_id,
        resource_kind: resourceKindForLegacy(ref.type ?? "other"),
        canonical_uri: uri,
        title: (ref.title || ref.id || ref.url || "Legacy source").slice(0, 512),
        source_system: ref.type ?? "decision_memory_source",
        media_type: "text/plain",
        visibility,
        permissions,
        fetch_enabled: false
      }, actorPrincipal);
      if (result.created) counts.resources_created += 1;
      await grantKnowledgeResourcePrincipals(env, tenantId, result.resource.id, permissions, actorPrincipal);
      await copyLegacyResourceAcl(env, tenantId, "decision_memory", row.id, result.resource.id, actorPrincipal);
      if (linkedResourceIds.has(result.resource.id)) continue;
      linkedResourceIds.add(result.resource.id);
      const link = await createDecisionResourceLink(env, {
        tenant_id: tenantId,
        project_id: row.project_id,
        decision_ref: { source_type: "decision_memory", source_id: row.id },
        resource_id: result.resource.id,
        role: "input",
        confirmation_state: isHumanConfirmed(row.confirmation_state) ? "confirmed" : "proposal",
        confidence: 1,
        idempotency_key: `backfill:decision-memory-source:${row.id}:${index}`
      }, actorPrincipal);
      if (link.created) counts.links_created += 1;
    }
  }
  return { rows, counts };
}

export async function backfillKnowledgeResources(env: Env, rawBody: unknown, actorPrincipal: string) {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as KnowledgeResourceBackfillRequest;
  const tenantId = typeof body.tenant_id === "string" && body.tenant_id.trim() ? body.tenant_id.trim() : "default";
  const stage = body.stage ?? "knowledge_docs";
  if (!["knowledge_docs", "decision_evidence", "decision_memory_sources"].includes(stage)) {
    throw new HttpError(400, "invalid_payload", "unknown backfill stage");
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : "";
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(200, Math.floor(body.limit))) : 50;
  const result = stage === "knowledge_docs"
    ? await backfillKnowledgeDocs(env, tenantId, cursor, limit, actorPrincipal)
    : stage === "decision_evidence"
      ? await backfillDecisionEvidence(env, tenantId, cursor, limit, actorPrincipal)
      : await backfillDecisionMemorySources(env, tenantId, cursor, limit, actorPrincipal);
  const nextCursor = result.rows.at(-1)?.id ?? cursor;
  return {
    tenant_id: tenantId,
    stage,
    cursor: nextCursor,
    processed: result.rows.length,
    output_counts: result.counts,
    done: result.rows.length < limit,
    batch_digest: await sha256(result.rows.map((row) => row.id).join("\n"))
  };
}
