import { buildMemoryFtsQuery, HttpError } from "@org-brain/shared";
import type { Context } from "hono";
import { assertApiTenantAccess, tenantFromBody, type ApiContextEnv } from "./auth";
import type { Env } from "./types";

export const ALL_TENANT = "all";
type SharedKind = "memory" | "decision_memory" | "doc";
const SOURCE_TABLES = { memory: "memories", decision_memory: "decision_memories", doc: "knowledge_docs" } as const;

export function allTenantPayload(kind: SharedKind, source: Record<string, unknown>) {
  const invalid = () => new HttpError(400, "invalid_shared_scope", "Shared records must be visible to all tenants and cannot belong to a project");
  const { target_tenant_id: target, ...body } = source;
  if (target !== ALL_TENANT) throw new HttpError(400, "invalid_target_tenant", "target_tenant_id must be all");
  if (body.visibility != null && body.visibility !== "tenant") throw invalid();
  if (body.allowed_principals != null && JSON.stringify(body.allowed_principals) !== "[]" ||
      body.allowedPrincipals != null && JSON.stringify(body.allowedPrincipals) !== "[]") throw invalid();
  const fields = { ...body, tenant_id: ALL_TENANT, orgId: ALL_TENANT, project_id: null, projectId: null };
  if (kind !== "memory" || !Array.isArray(body.items)) return fields;
  return { ...fields, items: body.items.map((item: Record<string, unknown>) => {
    if (item && (item.scope_type != null && !["tenant", "org"].includes(String(item.scope_type)) ||
        item.permissions != null && JSON.stringify(item.permissions) !== "[]")) throw invalid();
    return item && { ...item, project_id: null, scope_type: "tenant", scope_key: ALL_TENANT };
  }) };
}

// Only the resource routes that call this resolver accept a shared destination.
// The gateway middleware has already checked the operation in the origin tenant.
export async function allTenantRoute(c: Context<ApiContextEnv>, kind: SharedKind, rawBody?: unknown, id?: string) {
  const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
  const source = assertApiTenantAccess(c, c.req.query("tenant_id") || tenantFromBody(body));
  const target = c.req.query("target_tenant_id") ?? body.target_tenant_id;
  if (target === undefined) return { tenantId: source, body: rawBody };
  if (target !== ALL_TENANT) throw new HttpError(400, "invalid_target_tenant", "target_tenant_id must be all");
  if ((body.tenant_id != null && body.tenant_id !== source) || (body.orgId != null && body.orgId !== source)) {
    throw new HttpError(400, "source_tenant_mismatch", "The caller tenant must match the authenticated request");
  }
  if (id !== undefined) await assertAllTenantReadable(c.env, kind, id, rawBody === undefined);
  return { tenantId: ALL_TENANT, body: rawBody === undefined ? undefined : allTenantPayload(kind, { ...body, target_tenant_id: target }) };
}

// Check the authoritative row and policy before LIMIT, even if the index is stale.
export function allTenantVisibility(kind: SharedKind, alias: string) {
  const rules = kind === "memory"
    ? `${alias}.project_id IS NULL AND ${alias}.scope_type IN ('tenant','org') AND ${alias}.deleted_at IS NULL
       AND COALESCE(${alias}.permissions_json,'[]') = '[]'`
    : kind === "decision_memory"
      ? `${alias}.project_id IS NULL AND ${alias}.visibility = 'tenant' AND ${alias}.allowed_principals_json = '[]'`
      : `${alias}.visibility = 'tenant' AND ${alias}.deleted_at IS NULL AND ${alias}.scope != 'project'
         AND CASE WHEN json_valid(${alias}.frontmatter) THEN json_extract(${alias}.frontmatter, '$.project') IS NULL ELSE 0 END`;
  const resourceType = kind === "doc" ? "knowledge_doc" : kind;
  return `${alias}.tenant_id = 'all' AND ${rules} AND NOT EXISTS (
    SELECT 1 FROM resource_access_policies p
    WHERE p.tenant_id = 'all' AND p.resource_type = '${resourceType}' AND p.resource_id = ${alias}.id
      AND (p.scope != 'tenant' OR p.project_id IS NOT NULL)
  )`;
}

export function allTenantCurrent(kind: SharedKind, alias: string, at = Date.now()) {
  if (kind === "doc") return "1 = 1";
  const ts = Math.trunc(Number.isFinite(at) ? at : Date.now());
  const validity = `(${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${ts})
    AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${ts})`;
  if (kind === "decision_memory") {
    return `${validity} AND ${alias}.status = 'active'
      AND ${alias}.confirmation_state IN ('user_confirmed','user_corrected','reviewed') AND ${alias}.confirmed_at IS NOT NULL
      AND TRIM(${alias}.rationale) != '' AND ${alias}.source_refs_json != '[]'`;
  }
  return `${validity} AND ${alias}.lifecycle_state = 'active'
    AND COALESCE(${alias}.verification_state,'unverified') != 'rejected'
    AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${ts})
    AND COALESCE(${alias}.tags_json,'[]') NOT LIKE '%"source-drift"%'
    AND COALESCE(${alias}.tags_json,'[]') NOT LIKE '%"compacted"%'
    AND COALESCE(${alias}.conflicts_json,'[]') NOT LIKE '%source_drift%'`;
}

export async function assertAllTenantReadable(env: Env, kind: SharedKind, id: string, current = true) {
  const identity = kind === "doc" ? "slug" : "id";
  const visible = await env.OPEN_BRAIN_DB.prepare(
    `SELECT 1 FROM ${SOURCE_TABLES[kind]} r WHERE r.${identity} = ? AND ${allTenantVisibility(kind, "r")} AND ${current ? allTenantCurrent(kind, "r") : "1 = 1"}`
  ).bind(id).first();
  if (!visible) throw new HttpError(404, "shared_record_not_found", "Shared record not found");
}

type SharedSearchInput = {
  kind: SharedKind;
  q: string;
  limit: number;
  at?: number;
  businessCategoryId?: string | null;
  confirmationState?: string | null;
  workType?: string | null;
  scopes?: string[];
};

export function startAllTenantSearch<T>(env: Env, input: SharedSearchInput) {
  const { kind, limit, scopes = [] } = input;
  const query = buildMemoryFtsQuery(input.q.slice(0, 500));
  const at = input.at ?? Date.now();
  const where = [allTenantVisibility(kind, "r"), allTenantCurrent(kind, "r", at)];
  const terms: unknown[] = [];
  if (kind !== "doc") {
    if (input.businessCategoryId) { where.push("r.business_category_id = ?"); terms.push(input.businessCategoryId); }
    if (input.workType) { where.push("r.work_type = ?"); terms.push(input.workType); }
  }
  if (kind === "decision_memory" && input.confirmationState) {
    where.push("r.confirmation_state = ?");
    terms.push(input.confirmationState);
  }
  if (kind === "doc" && scopes.length) {
    where.push(`r.scope IN (${scopes.map(() => "?").join(",")})`);
    terms.push(...scopes);
  }
  // An empty query is a browse request for decisions and documents.
  const projection = kind === "memory"
    ? "r.id, r.created_at, r.summary, substr(r.content,1,600) AS content_preview, r.source, r.kind, r.current_version, r.source_refs_json"
    : "r.*";
  const table = SOURCE_TABLES[kind];
  return Promise.resolve().then(async () => {
    if (!query && kind === "memory") return [];
    const sql = query
      ? `SELECT ${projection} FROM all_knowledge_fts
           CROSS JOIN ${table} r ON r.id = all_knowledge_fts.source_id
         WHERE all_knowledge_fts MATCH ? AND ${where.join(" AND ")}
         AND rank MATCH 'bm25(0,0,2,1)'
         ORDER BY rank LIMIT ?`
      : `SELECT ${projection} FROM ${table} r WHERE ${where.join(" AND ")}
         ORDER BY r.updated_at DESC, r.id LIMIT ?`;
    const bindings = query ? [`kind:${kind} AND {title content}:(${query})`, ...terms, limit] : [...terms, limit];
    return (await env.OPEN_BRAIN_DB.prepare(sql).bind(...bindings).all<T>()).results;
  }).catch(() => null);
}

export async function finishAllTenantSearch<T>(pending: Promise<T[] | null>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([pending, new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 100);
    })]);
    return { rows: rows ?? [], shared_search: rows === null ? "incomplete" as const : "complete" as const };
  } finally { clearTimeout(timer); }
}

// Each index produces a ranked list with its own score scale. Compare positions,
// preferring the caller's tenant when the ranks are equal.
export function mergeTenantRanks<T>(ordinary: T[], shared: T[], limit: number): T[] {
  if (!shared.length) return ordinary.slice(0, limit);
  const merged: T[] = [];
  for (let i = 0; merged.length < limit && (i < ordinary.length || i < shared.length); i++) {
    if (i < ordinary.length) merged.push(ordinary[i]!);
    if (merged.length < limit && i < shared.length) merged.push(shared[i]!);
  }
  return merged;
}
