import {
  DASHBOARD_CONTRACT_VERSION,
  dashboardStrataQuerySchema,
  type DashboardSourceType,
  type DashboardStrataChain,
  type DashboardStrataChainSummary,
  type DashboardStrataDetailResponse,
  type DashboardStrataQuery,
  type DashboardStrataRelation,
  type DashboardStrataResponse,
  type DashboardStrataRevision,
  type DashboardStrataSource,
  type DashboardStrataType
} from "@org-brain/contracts";
import { HttpError, normalizeLifecycleState, normalizeMemoryKind } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import { stableResultReadable } from "./memory-service";
import type { Env } from "./types";

const DEFAULT_REVISION_LIMIT = 100;
const MAX_REVISION_LIMIT = 100;
const DEFAULT_SOURCE_LIMIT = 50;
const MAX_SOURCE_LIMIT = 50;
const MAX_RELATIONS = 100;
const MAX_VISIBLE_SOURCE_COUNT = 400;
const COLLECTION_SCAN_BATCH_SIZE = 250;
const RESOURCE_ID_CHUNK_SIZE = 300;
const SOURCE_SCAN_CONCURRENCY = 8;
const MAX_SNAPSHOT_JSON_CHARS = 1_500;

export type MemoryStrataOptions = Partial<DashboardStrataQuery> & {
  principal?: string | null;
  now?: number;
};

export type MemoryStrataDetailOptions = {
  project_id?: string;
  principal?: string | null;
  revision_limit?: number;
  source_limit?: number;
  now?: number;
};

type Cursor = { v: 1; at: number; key: string };

type ParsedCollectionOptions = DashboardStrataQuery & {
  principal: string | null;
  now: number;
  cursor: Cursor | null;
};

type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  kind: string | null;
  lifecycle_state: string | null;
  confidence_score: number | null;
  canonical_key: string | null;
  current_version: number;
  source_refs_json: string | null;
  evidence_json: string | null;
  permissions_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  root_memory_id: string | null;
  created_at: number;
  updated_at: number | null;
  revision_count: number;
  partial_revision_count: number;
};

type DecisionRow = {
  id: string;
  project_id: string | null;
  title: string;
  decision: string;
  domain: string;
  status: string;
  confirmation_state: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  source_refs_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  revision_count: number;
  partial_revision_count: number;
};

type ResourceRow = {
  id: string;
  project_id: string | null;
  resource_kind: string;
  title: string;
  source_system: string;
  media_type: string;
  visibility: string;
  permissions_json: string | null;
  current_version_id: string | null;
  lifecycle_state: string;
  created_by_principal: string;
  created_at: number;
  updated_at: number;
  revision_count: number;
  source_count: number;
};

type AssertionRow = {
  id: string;
  project_id: string | null;
  assertion_type: string;
  subject_type: string;
  subject_ref: string;
  predicate: string;
  object_type: string | null;
  object_ref: string | null;
  resource_id: string | null;
  object_value: string | null;
  context_json: string | null;
  confidence: number | null;
  confirmation_state: string;
  valid_from: number;
  valid_until: number | null;
  actor_principal: string;
  reviewed_by_principal: string | null;
  created_at: number;
  updated_at: number;
  source_count: number;
};

type MemoryVersionRow = {
  id: string;
  version: number;
  operation: string;
  content: string;
  summary: string | null;
  tags_json: string | null;
  kind: string;
  lifecycle_state: string;
  scope_type: string;
  scope_key: string | null;
  actor_type: string | null;
  actor_id: string | null;
  confidence_score: number | null;
  utility_score: number | null;
  canonical_key: string | null;
  snapshot_json: string | null;
  content_hash: string | null;
  created_at: number;
};

type DecisionVersionRow = {
  id: string;
  operation: string;
  snapshot_json: string | null;
  actor_refs_json: string | null;
  reviewer_refs_json: string | null;
  note: string | null;
  created_at: number;
};

type ResourceVersionRow = {
  id: string;
  connector_id: string;
  source_version: string | null;
  etag: string | null;
  last_modified: string | null;
  content_hash: string;
  snapshot_object_ref: string;
  extracted_text: string;
  extracted_text_hash: string;
  extraction_state: string;
  captured_at: number;
  created_by_principal: string;
  created_at: number;
};

type MemoryRelationRow = {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation: string;
  created_at: number;
};

type AssertionReadableRow = Pick<AssertionRow,
  "subject_type" | "subject_ref" | "predicate" | "object_type" | "object_ref" | "resource_id" | "valid_from" | "valid_until"
>;

type AssertionRelationRow = AssertionReadableRow & Pick<AssertionRow, "id" | "updated_at">;

type EvidenceRow = {
  id: string;
  assertion_id: string;
  resource_id: string;
  resource_version_id: string;
  locator_json: string | null;
  note: string | null;
  created_at: number;
  title: string | null;
  visibility: string | null;
  project_id: string | null;
  permissions_json: string | null;
};

type EmbeddedSourceCandidate = {
  source: DashboardStrataSource;
  allowedPrincipals: string[];
};

type SafeSourceCount = { count: number; partial: boolean };

type LocationRow = {
  id: string;
  resource_id: string;
  uri: string;
  location_role: string;
  created_at: number;
};

function normalizeTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 128) {
    throw new HttpError(400, "invalid_tenant_id", "tenant_id must be between 1 and 128 characters");
  }
  return tenantId;
}

function optionalPrincipal(value: string | null | undefined): string | null {
  const principal = value?.trim();
  return principal ? principal.slice(0, 128) : null;
}

function compactText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function finiteConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function jsonValue(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function jsonArray(value: string | null | undefined): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function stringArray(value: string | null | undefined): string[] {
  return jsonArray(value).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return compactText(value, 1_000) ?? "";
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => boundedJson(item, depth + 1));
  const record = recordValue(value);
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).slice(0, 48)
    .map(([key, item]) => [key.slice(0, 128), boundedJson(item, depth + 1)]));
}

function boundedRecord(value: unknown): Record<string, unknown> {
  const normalized = recordValue(boundedJson(value)) ?? {};
  if (JSON.stringify(normalized).length <= MAX_SNAPSHOT_JSON_CHARS) return normalized;
  const priority = [
    "status", "confirmationState", "confirmation_state", "validFrom", "valid_from",
    "validUntil", "valid_until", "supersededBy", "superseded_by", "title",
    "summary", "decision", "content", "rationale"
  ];
  const priorityIndex = new Map(priority.map((key, index) => [key, index]));
  const entries = Object.entries(normalized).sort(([left], [right]) => {
    const leftPriority = priorityIndex.get(left) ?? priority.length;
    const rightPriority = priorityIndex.get(right) ?? priority.length;
    return leftPriority - rightPriority || left.localeCompare(right);
  });
  const result: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, item] of entries) {
    const candidate = { ...result, [key]: item, _truncated: true };
    if (JSON.stringify(candidate).length <= MAX_SNAPSHOT_JSON_CHARS) result[key] = item;
    else truncated = true;
  }
  if (truncated) result._truncated = true;
  return result;
}

function parseLimit(value: number | undefined, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, "invalid_dashboard_query", `${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (item) => item.charCodeAt(0)));
}

export function encodeMemoryStrataCursor(chain: Pick<DashboardStrataChainSummary, "source_type" | "source_id" | "changed_at">): string {
  return encodeBase64Url(JSON.stringify({
    v: 1,
    at: chain.changed_at,
    key: `${chain.source_type}:${chain.source_id}`
  } satisfies Cursor));
}

function parseCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(value)) as Partial<Cursor>;
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.at) || Number(parsed.at) < 0 || typeof parsed.key !== "string" || !parsed.key) {
      throw new Error("invalid cursor fields");
    }
    return { v: 1, at: Number(parsed.at), key: parsed.key.slice(0, 512) };
  } catch {
    throw new HttpError(400, "invalid_cursor", "before cursor is invalid");
  }
}

function parseCollectionOptions(raw: MemoryStrataOptions): ParsedCollectionOptions {
  const parsed = dashboardStrataQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_dashboard_query", parsed.error.issues[0]?.message ?? "Invalid memory strata query");
  }
  return {
    ...parsed.data,
    principal: optionalPrincipal(raw.principal),
    now: Number.isSafeInteger(raw.now) && Number(raw.now) >= 0 ? Number(raw.now) : Date.now(),
    cursor: parseCursor(parsed.data.before)
  };
}

/** Maps persisted, explicit state to one of the five dashboard strata lanes. */
export function mapMemoryStrataType(args: {
  sourceType: DashboardSourceType;
  kind?: string | null;
  lifecycleState?: string | null;
  canonicalKey?: string | null;
  tags?: string[];
  confirmationState?: string | null;
}): DashboardStrataType {
  if (args.sourceType === "decision_memory") return "decision";
  if (args.sourceType === "knowledge_resource") return "source";
  if (args.sourceType === "knowledge_assertion") {
    return args.confirmationState === "proposal" ? "assumption" : "learning";
  }
  const tags = new Set((args.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()));
  if (
    normalizeLifecycleState(args.lifecycleState) === "promoted" ||
    Boolean(args.canonicalKey?.trim()) ||
    tags.has("canonical-memory")
  ) return "canonical";
  if (tags.has("assumption") || tags.has("hypothesis")) return "assumption";
  const kind = normalizeMemoryKind(args.kind);
  if (kind === "decision" || kind === "constraint") return "decision";
  if (["semantic", "org_knowledge", "fact", "preference", "pitfall"].includes(kind)) return "learning";
  return "source";
}

function collectionFilter(
  options: ParsedCollectionOptions,
  changedExpression: string,
  keyExpression: string
): { sql: string; bindings: unknown[] } {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (options.project_id) {
    clauses.push("(project_id = ? OR project_id IS NULL)");
    bindings.push(options.project_id);
  }
  if (options.from !== undefined) {
    clauses.push(`${changedExpression} >= ?`);
    bindings.push(options.from);
  }
  if (options.to !== undefined) {
    clauses.push(`${changedExpression} <= ?`);
    bindings.push(options.to);
  }
  if (options.cursor) {
    clauses.push(`(${changedExpression} < ? OR (${changedExpression} = ? AND ${keyExpression} < ?))`);
    bindings.push(options.cursor.at, options.cursor.at, options.cursor.key);
  }
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", bindings };
}

async function filterReadableDecisions(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: DecisionRow[],
  principal: string | null
): Promise<DecisionRow[]> {
  const directIds = new Set(rows.filter((row) => {
    const allowed = stringArray(row.allowed_principals_json);
    if (row.visibility !== "restricted" && allowed.length === 0) return true;
    return Boolean(principal && allowed.includes(principal));
  }).map((row) => row.id));
  const restricted = rows.filter((row) => row.visibility === "restricted" && !directIds.has(row.id));
  if (!principal || restricted.length === 0) return rows.filter((row) => directIds.has(row.id));
  const authz = await buildAuthzContext(env as Env, tenantId, principal);
  const readable = await loadReadableResourceIds(env as Env, {
    tenantId,
    resourceType: "decision_memory",
    resourceIds: restricted.map((row) => row.id),
    authz
  });
  return rows.filter((row) => directIds.has(row.id) || readable.has(row.id));
}

async function filterReadableResources(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: ResourceRow[],
  projectId: string | undefined,
  principal: string | null
): Promise<ResourceRow[]> {
  const directIds = new Set(rows.filter((row) => {
    if (row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && row.project_id === projectId);
    return Boolean(principal && stringArray(row.permissions_json).includes(principal));
  }).map((row) => row.id));
  const restricted = rows.filter((row) => row.visibility === "restricted" && !directIds.has(row.id));
  if (!principal || restricted.length === 0) return rows.filter((row) => directIds.has(row.id));
  const authz = await buildAuthzContext(env as Env, tenantId, principal);
  const readable = await loadReadableResourceIds(env as Env, {
    tenantId,
    resourceType: "knowledge_resource",
    resourceIds: restricted.map((row) => row.id),
    authz
  });
  return rows.filter((row) => directIds.has(row.id) || readable.has(row.id));
}

function principalAliases(principal: string | null): Set<string> {
  if (!principal) return new Set();
  const aliases = new Set([principal]);
  if (!principal.startsWith("user:") && !principal.startsWith("agent:")) {
    aliases.add(`user:${principal}`);
    aliases.add(`agent:${principal}`);
  }
  return aliases;
}

function sourceAllowed(candidate: EmbeddedSourceCandidate, principal: string | null): boolean {
  if (candidate.allowedPrincipals.length === 0) return true;
  const aliases = principalAliases(principal);
  return candidate.allowedPrincipals.some((allowed) => aliases.has(allowed));
}

async function loadResourceVisibility(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  resourceIds: string[],
  projectId: string | undefined,
  principal: string | null
): Promise<{ existing: Set<string>; readable: Set<string>; resources: Map<string, ResourceRow> }> {
  const existing = new Set<string>();
  const readable = new Set<string>();
  const resources = new Map<string, ResourceRow>();
  for (let index = 0; index < resourceIds.length; index += RESOURCE_ID_CHUNK_SIZE) {
    const chunk = resourceIds.slice(index, index + RESOURCE_ID_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, resource_kind, title, source_system, media_type, visibility,
              permissions_json, current_version_id, lifecycle_state, created_by_principal,
              created_at, updated_at, 0 AS revision_count, 0 AS source_count
       FROM knowledge_resources
       WHERE tenant_id = ?
         AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    ).bind(tenantId, JSON.stringify(chunk)).all<ResourceRow>();
    for (const row of rows.results) {
      existing.add(row.id);
      resources.set(row.id, row);
    }
    for (const row of await filterReadableResources(env, tenantId, rows.results, projectId, principal)) {
      if (projectMatches(row.project_id, projectId)) readable.add(row.id);
    }
  }
  return { existing, readable, resources };
}

function assertionResourceIds(row: AssertionReadableRow): string[] {
  return [...new Set([
    row.resource_id,
    row.subject_type === "knowledge_resource" || row.subject_type === "resource" ? row.subject_ref : null,
    row.object_type === "knowledge_resource" || row.object_type === "resource" ? row.object_ref : null
  ].filter((value): value is string => Boolean(value)))];
}

async function filterAssertionsWithReadableResources<Row extends AssertionReadableRow>(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: Row[],
  projectId: string | undefined,
  principal: string | null
): Promise<Row[]> {
  const resourceIds = [...new Set(rows.flatMap(assertionResourceIds))];
  if (resourceIds.length === 0) return rows;
  const visibility = await loadResourceVisibility(env, tenantId, resourceIds, projectId, principal);
  return rows.filter((row) => assertionResourceIds(row).every((resourceId) =>
    visibility.existing.has(resourceId) && visibility.readable.has(resourceId)
  ));
}

function assertionSensitiveTargets(row: AssertionReadableRow): DashboardStrataRelation[] {
  const targets: DashboardStrataRelation[] = [];
  if (["memory", "decision_memory", "decision"].includes(row.subject_type)) {
    targets.push({
      relation: "subject",
      target_type: row.subject_type,
      target_id: row.subject_ref,
      valid_from: Number(row.valid_from),
      valid_until: row.valid_until === null ? null : Number(row.valid_until)
    });
  }
  if (row.object_type && row.object_ref && ["memory", "decision_memory", "decision"].includes(row.object_type)) {
    targets.push({
      relation: row.predicate,
      target_type: row.object_type,
      target_id: row.object_ref,
      valid_from: Number(row.valid_from),
      valid_until: row.valid_until === null ? null : Number(row.valid_until)
    });
  }
  return targets;
}

function relationTargetKey(relation: DashboardStrataRelation): string {
  return `${relation.target_type}:${relation.target_id}`;
}

async function filterReadableAssertions<Row extends AssertionReadableRow>(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: Row[],
  projectId: string | undefined,
  principal: string | null
): Promise<Row[]> {
  const resourceReadable = await filterAssertionsWithReadableResources(env, tenantId, rows, projectId, principal);
  const sensitiveTargets = resourceReadable.flatMap(assertionSensitiveTargets);
  if (sensitiveTargets.length === 0) return resourceReadable;
  const readableTargetKeys = new Set((await filterReadableRelations(
    env,
    tenantId,
    sensitiveTargets,
    projectId,
    principal
  )).map(relationTargetKey));
  return resourceReadable.filter((row) => assertionSensitiveTargets(row)
    .every((target) => readableTargetKeys.has(relationTargetKey(target))));
}

async function collectionEmbeddedSourceCounts(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  entries: Array<{ key: string; rawItems: unknown[] }>,
  options: { projectId?: string; principal: string | null }
): Promise<Map<string, SafeSourceCount>> {
  const counts = new Map<string, SafeSourceCount>();
  for (let index = 0; index < entries.length; index += SOURCE_SCAN_CONCURRENCY) {
    const batch = entries.slice(index, index + SOURCE_SCAN_CONCURRENCY);
    const scans = await Promise.all(batch.map((entry) => scanVisibleEmbeddedSources(
      env,
      tenantId,
      entry.rawItems,
      options
    )));
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const entry = batch[batchIndex]!;
      const scan = scans[batchIndex]!;
      counts.set(entry.key, {
        count: Math.min(MAX_VISIBLE_SOURCE_COUNT, scan.candidates.length),
        partial: scan.partial
      });
    }
  }
  return counts;
}

async function collectionEvidenceSourceCounts(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  assertionIds: string[],
  options: { projectId?: string; principal: string | null }
): Promise<Map<string, SafeSourceCount>> {
  const counts = new Map<string, SafeSourceCount>();
  const uniqueIds = [...new Set(assertionIds)];
  for (let index = 0; index < uniqueIds.length; index += SOURCE_SCAN_CONCURRENCY) {
    const batch = uniqueIds.slice(index, index + SOURCE_SCAN_CONCURRENCY);
    const scans = await Promise.all(batch.map((assertionId) => scanVisibleEvidenceRows(
      env,
      tenantId,
      assertionId,
      { ...options, visibleLimit: MAX_VISIBLE_SOURCE_COUNT }
    )));
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const assertionId = batch[batchIndex]!;
      const scan = scans[batchIndex]!;
      counts.set(assertionId, {
        count: Math.min(MAX_VISIBLE_SOURCE_COUNT, scan.rows.length),
        partial: scan.partial
      });
    }
  }
  return counts;
}

function memorySummary(
  row: MemoryRow,
  now: number,
  safeSources: SafeSourceCount = { count: 0, partial: false }
): DashboardStrataChainSummary {
  const lane = mapMemoryStrataType({
    sourceType: "memory",
    kind: row.kind,
    lifecycleState: row.lifecycle_state,
    canonicalKey: row.canonical_key,
    tags: stringArray(row.tags_json)
  });
  const partialHistory = Number(row.partial_revision_count ?? 0) > 0;
  const partial = partialHistory || safeSources.partial;
  return {
    id: `strata:memory:${row.id}`,
    type: lane,
    source_type: "memory",
    source_id: row.id,
    title: compactText(row.summary, 200) ?? compactText(row.content, 200) ?? row.id,
    project_id: row.project_id,
    current_state: normalizeLifecycleState(row.lifecycle_state),
    confidence: finiteConfidence(row.confidence_score),
    valid_from: row.valid_from === null ? null : Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until),
    changed_at: Number(row.updated_at ?? row.created_at),
    partial,
    revision_count: Math.max(0, Number(row.revision_count ?? 0)),
    source_count: safeSources.count,
    attention: [
      ...(partialHistory ? ["partial_history"] : []),
      ...(row.valid_until !== null && row.valid_until < now ? ["expired"] : []),
      ...(safeSources.partial ? ["source_count_truncated"] : [])
    ]
  };
}

function decisionSummary(
  row: DecisionRow,
  now: number,
  safeSources: SafeSourceCount = { count: 0, partial: false }
): DashboardStrataChainSummary {
  const partialHistory = Number(row.partial_revision_count ?? 0) > 0;
  const partial = partialHistory || safeSources.partial;
  return {
    id: `strata:decision_memory:${row.id}`,
    type: "decision",
    source_type: "decision_memory",
    source_id: row.id,
    title: compactText(row.title, 200) ?? compactText(row.decision, 200) ?? row.id,
    project_id: row.project_id,
    current_state: row.status,
    confidence: finiteConfidence(row.confidence),
    valid_from: row.valid_from === null ? null : Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until),
    changed_at: Number(row.updated_at),
    partial,
    revision_count: Math.max(0, Number(row.revision_count ?? 0)),
    source_count: safeSources.count,
    attention: [
      ...(partialHistory ? ["partial_history"] : []),
      ...(row.valid_until !== null && row.valid_until < now ? ["expired"] : []),
      ...(row.status === "deprecated" || row.status === "superseded" ? ["not_current"] : []),
      ...(safeSources.partial ? ["source_count_truncated"] : [])
    ]
  };
}

function resourceSummary(row: ResourceRow): DashboardStrataChainSummary {
  return {
    id: `strata:knowledge_resource:${row.id}`,
    type: "source",
    source_type: "knowledge_resource",
    source_id: row.id,
    title: compactText(row.title, 200) ?? row.id,
    project_id: row.project_id,
    current_state: row.lifecycle_state,
    confidence: null,
    valid_from: null,
    valid_until: null,
    changed_at: Number(row.updated_at),
    partial: true,
    revision_count: Math.max(0, Number(row.revision_count ?? 0)),
    source_count: Math.max(0, Number(row.source_count ?? 0)),
    attention: row.lifecycle_state === "stale" || row.lifecycle_state === "retired" ? [row.lifecycle_state] : []
  };
}

function assertionSummary(
  row: AssertionRow,
  now: number,
  safeSources: SafeSourceCount = { count: 0, partial: false }
): DashboardStrataChainSummary {
  return {
    id: `strata:knowledge_assertion:${row.id}`,
    type: mapMemoryStrataType({ sourceType: "knowledge_assertion", confirmationState: row.confirmation_state }),
    source_type: "knowledge_assertion",
    source_id: row.id,
    title: compactText(`${row.subject_ref} ${row.predicate} ${row.object_ref ?? row.object_value ?? ""}`, 200) ?? row.id,
    project_id: row.project_id,
    current_state: row.confirmation_state,
    confidence: finiteConfidence(row.confidence),
    valid_from: Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until),
    changed_at: Number(row.updated_at),
    partial: safeSources.partial,
    revision_count: 1,
    source_count: safeSources.count,
    attention: [
      ...(row.confirmation_state === "proposal" ? ["needs_confirmation"] : []),
      ...(row.valid_until !== null && row.valid_until < now ? ["expired"] : []),
      ...(safeSources.partial ? ["source_count_truncated"] : [])
    ]
  };
}

async function assertionReadable(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  row: AssertionReadableRow,
  projectId: string | undefined,
  principal: string | null
): Promise<boolean> {
  return (await filterReadableAssertions(env, tenantId, [row], projectId, principal)).length === 1;
}

type CollectionPageCursor = { at: number; id: string };

async function scanCollectionTable<Row>(args: {
  target: number;
  queryPage: (cursor: CollectionPageCursor | null, limit: number) => Promise<Row[]>;
  filterReadable: (rows: Row[]) => Promise<Row[]>;
  matchesType: (row: Row) => boolean;
  changedAt: (row: Row) => number;
  rowId: (row: Row) => string;
}): Promise<Row[]> {
  const collected: Row[] = [];
  let cursor: CollectionPageCursor | null = null;
  while (collected.length < args.target) {
    const page = await args.queryPage(cursor, COLLECTION_SCAN_BATCH_SIZE);
    if (page.length === 0) break;
    const readable = await args.filterReadable(page);
    for (const row of readable) {
      if (!args.matchesType(row)) continue;
      collected.push(row);
      if (collected.length >= args.target) break;
    }
    const last = page[page.length - 1]!;
    const nextCursor = { at: args.changedAt(last), id: args.rowId(last) };
    if (cursor && cursor.at === nextCursor.at && cursor.id === nextCursor.id) break;
    cursor = nextCursor;
    if (page.length < COLLECTION_SCAN_BATCH_SIZE) break;
  }
  return collected;
}

function internalCollectionFilter(
  cursor: CollectionPageCursor | null,
  changedExpression: string,
  idExpression: string
): { sql: string; bindings: unknown[] } {
  if (!cursor) return { sql: "", bindings: [] };
  return {
    sql: `AND (${changedExpression} < ? OR (${changedExpression} = ? AND ${idExpression} < ?))`,
    bindings: [cursor.at, cursor.at, cursor.id]
  };
}

const memoryCanonicalTagSql = `(CASE
  WHEN json_valid(m.tags_json) = 1 THEN CASE
    WHEN json_type(m.tags_json) = 'array' THEN EXISTS (
      SELECT 1 FROM json_each(m.tags_json) tag
      WHERE typeof(tag.value) = 'text' AND lower(trim(tag.value)) = 'canonical-memory'
    ) ELSE 0 END
  ELSE 0 END)`;
const memoryAssumptionTagSql = `(CASE
  WHEN json_valid(m.tags_json) = 1 THEN CASE
    WHEN json_type(m.tags_json) = 'array' THEN EXISTS (
      SELECT 1 FROM json_each(m.tags_json) tag
      WHERE typeof(tag.value) = 'text' AND lower(trim(tag.value)) IN ('assumption', 'hypothesis')
    ) ELSE 0 END
  ELSE 0 END)`;
const memoryCanonicalSql = `(
  COALESCE(m.lifecycle_state, '') = 'promoted'
  OR length(trim(COALESCE(m.canonical_key, ''))) > 0
  OR ${memoryCanonicalTagSql}
)`;
const memoryDecisionKindSql = `(COALESCE(m.kind, '') IN ('decision', 'constraint'))`;
const memoryLearningKindSql = `(COALESCE(m.kind, '') IN ('semantic', 'org_knowledge', 'fact', 'preference', 'pitfall'))`;

function memoryTypeFilter(types: DashboardStrataType[] | undefined): string {
  if (types === undefined || new Set(types).size === 5) return "";
  const requested = new Set(types);
  const expressions: string[] = [];
  if (requested.has("canonical")) expressions.push(memoryCanonicalSql);
  if (requested.has("assumption")) {
    expressions.push(`(NOT ${memoryCanonicalSql} AND ${memoryAssumptionTagSql})`);
  }
  if (requested.has("decision")) {
    expressions.push(`(NOT ${memoryCanonicalSql} AND NOT ${memoryAssumptionTagSql} AND ${memoryDecisionKindSql})`);
  }
  if (requested.has("learning")) {
    expressions.push(`(NOT ${memoryCanonicalSql} AND NOT ${memoryAssumptionTagSql} AND ${memoryLearningKindSql})`);
  }
  if (requested.has("source")) {
    expressions.push(`(
      NOT ${memoryCanonicalSql}
      AND NOT ${memoryAssumptionTagSql}
      AND NOT ${memoryDecisionKindSql}
      AND NOT ${memoryLearningKindSql}
    )`);
  }
  return expressions.length ? `AND (${expressions.join(" OR ")})` : "AND 0 = 1";
}

function assertionTypeFilter(types: DashboardStrataType[] | undefined): string {
  if (types === undefined) return "";
  const requested = new Set(types);
  if (requested.has("assumption") && requested.has("learning")) return "";
  if (requested.has("assumption")) return "AND a.confirmation_state = 'proposal'";
  if (requested.has("learning")) return "AND COALESCE(a.confirmation_state, '') <> 'proposal'";
  return "AND 0 = 1";
}

async function queryCollectionRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedCollectionOptions
): Promise<{ chains: DashboardStrataChainSummary[] }> {
  const target = options.limit + 1;
  const memoryFilter = collectionFilter(options, "COALESCE(updated_at, created_at)", "('memory:' || id)");
  const decisionFilter = collectionFilter(options, "updated_at", "('decision_memory:' || id)");
  const resourceFilter = collectionFilter(options, "updated_at", "('knowledge_resource:' || id)");
  const assertionFilter = collectionFilter(options, "updated_at", "('knowledge_assertion:' || id)");
  const requestedTypes = options.types ? new Set(options.types) : null;
  const [memories, decisions, resources, assertions] = await Promise.all([
    options.types?.length === 0 ? Promise.resolve([] as MemoryRow[]) : scanCollectionTable<MemoryRow>({
      target,
      queryPage: async (cursor, limit) => {
        const internal = internalCollectionFilter(cursor, "COALESCE(m.updated_at, m.created_at)", "m.id");
        const result = await env.OPEN_BRAIN_DB.prepare(
          `SELECT m.id, m.project_id, m.content, m.summary, m.tags_json, m.kind, m.lifecycle_state,
                  m.confidence_score, m.canonical_key, m.current_version, m.source_refs_json,
                  m.evidence_json, m.permissions_json, m.valid_from, m.valid_until, m.root_memory_id,
                  m.created_at, m.updated_at,
                  (SELECT COUNT(*) FROM memory_versions v WHERE v.tenant_id = m.tenant_id AND v.memory_id = m.id) AS revision_count,
                  (SELECT COUNT(*) FROM memory_versions v WHERE v.tenant_id = m.tenant_id AND v.memory_id = m.id
                    AND CASE WHEN json_valid(v.snapshot_json) = 0 THEN 1 ELSE
                      (json_type(v.snapshot_json, '$.content') IS NULL OR json_type(v.snapshot_json, '$.kind') IS NULL
                        OR json_type(v.snapshot_json, '$.lifecycle_state') IS NULL) END) AS partial_revision_count
           FROM memories m WHERE m.tenant_id = ? ${memoryFilter.sql} ${memoryTypeFilter(options.types)} ${internal.sql}
           ORDER BY COALESCE(m.updated_at, m.created_at) DESC, m.id DESC LIMIT ?`
        ).bind(tenantId, ...memoryFilter.bindings, ...internal.bindings, limit).all<MemoryRow>();
        return result.results;
      },
      filterReadable: async (rows) => rows.filter((row) => stableResultReadable(row.permissions_json, options.principal)),
      matchesType: (row) => !requestedTypes || requestedTypes.has(mapMemoryStrataType({
        sourceType: "memory",
        kind: row.kind,
        lifecycleState: row.lifecycle_state,
        canonicalKey: row.canonical_key,
        tags: stringArray(row.tags_json)
      })),
      changedAt: (row) => Number(row.updated_at ?? row.created_at),
      rowId: (row) => row.id
    }),
    requestedTypes && !requestedTypes.has("decision") ? Promise.resolve([] as DecisionRow[]) : scanCollectionTable<DecisionRow>({
      target,
      queryPage: async (cursor, limit) => {
        const internal = internalCollectionFilter(cursor, "d.updated_at", "d.id");
        const result = await env.OPEN_BRAIN_DB.prepare(
          `SELECT d.id, d.project_id, d.title, d.decision, d.domain, d.status, d.confirmation_state,
                  d.confidence, d.visibility, d.allowed_principals_json, d.source_refs_json,
                  d.valid_from, d.valid_until, d.superseded_by, d.created_at, d.updated_at,
                  (SELECT COUNT(*) FROM decision_memory_versions v WHERE v.tenant_id = d.tenant_id AND v.decision_memory_id = d.id) AS revision_count,
                  (SELECT COUNT(*) FROM decision_memory_versions v WHERE v.tenant_id = d.tenant_id AND v.decision_memory_id = d.id
                    AND CASE WHEN json_valid(v.snapshot_json) = 0 THEN 1 ELSE
                      (json_type(v.snapshot_json, '$.title') IS NULL OR json_type(v.snapshot_json, '$.decision') IS NULL
                        OR json_type(v.snapshot_json, '$.rationale') IS NULL OR json_type(v.snapshot_json, '$.status') IS NULL) END) AS partial_revision_count
           FROM decision_memories d WHERE d.tenant_id = ? ${decisionFilter.sql} ${internal.sql}
           ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`
        ).bind(tenantId, ...decisionFilter.bindings, ...internal.bindings, limit).all<DecisionRow>();
        return result.results;
      },
      filterReadable: (rows) => filterReadableDecisions(env, tenantId, rows, options.principal),
      matchesType: () => true,
      changedAt: (row) => Number(row.updated_at),
      rowId: (row) => row.id
    }),
    requestedTypes && !requestedTypes.has("source") ? Promise.resolve([] as ResourceRow[]) : scanCollectionTable<ResourceRow>({
      target,
      queryPage: async (cursor, limit) => {
        const internal = internalCollectionFilter(cursor, "r.updated_at", "r.id");
        const result = await env.OPEN_BRAIN_DB.prepare(
          `SELECT r.id, r.project_id, r.resource_kind, r.title, r.source_system, r.media_type,
                  r.visibility, r.permissions_json, r.current_version_id, r.lifecycle_state,
                  r.created_by_principal, r.created_at, r.updated_at,
                  (SELECT COUNT(*) FROM knowledge_resource_versions v WHERE v.tenant_id = r.tenant_id AND v.resource_id = r.id) AS revision_count,
                  (SELECT COUNT(*) FROM knowledge_resource_locations l WHERE l.tenant_id = r.tenant_id AND l.resource_id = r.id) AS source_count
           FROM knowledge_resources r WHERE r.tenant_id = ? ${resourceFilter.sql} ${internal.sql}
           ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`
        ).bind(tenantId, ...resourceFilter.bindings, ...internal.bindings, limit).all<ResourceRow>();
        return result.results;
      },
      filterReadable: (rows) => filterReadableResources(env, tenantId, rows, options.project_id, options.principal),
      matchesType: () => true,
      changedAt: (row) => Number(row.updated_at),
      rowId: (row) => row.id
    }),
    requestedTypes && !requestedTypes.has("assumption") && !requestedTypes.has("learning")
      ? Promise.resolve([] as AssertionRow[])
      : scanCollectionTable<AssertionRow>({
        target,
        queryPage: async (cursor, limit) => {
          const internal = internalCollectionFilter(cursor, "a.updated_at", "a.id");
          const result = await env.OPEN_BRAIN_DB.prepare(
            `SELECT a.id, a.project_id, a.assertion_type, a.subject_type, a.subject_ref, a.predicate,
                    a.object_type, a.object_ref, a.resource_id, a.object_value, a.context_json,
                    a.confidence, a.confirmation_state, a.valid_from, a.valid_until,
                    a.actor_principal, a.reviewed_by_principal, a.created_at, a.updated_at,
                    (SELECT COUNT(*) FROM knowledge_assertion_evidence e WHERE e.tenant_id = a.tenant_id AND e.assertion_id = a.id) AS source_count
             FROM knowledge_assertions a WHERE a.tenant_id = ? ${assertionFilter.sql} ${assertionTypeFilter(options.types)} ${internal.sql}
             ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`
          ).bind(tenantId, ...assertionFilter.bindings, ...internal.bindings, limit).all<AssertionRow>();
          return result.results;
        },
        filterReadable: (rows) => filterReadableAssertions(
          env,
          tenantId,
          rows,
          options.project_id,
          options.principal
        ),
        matchesType: (row) => !requestedTypes || requestedTypes.has(mapMemoryStrataType({
          sourceType: "knowledge_assertion",
          confirmationState: row.confirmation_state
        })),
        changedAt: (row) => Number(row.updated_at),
        rowId: (row) => row.id
      })
  ]);
  const [embeddedSourceCounts, evidenceSourceCounts] = await Promise.all([
    collectionEmbeddedSourceCounts(env, tenantId, [
      ...memories.map((row) => ({
        key: `memory:${row.id}`,
        rawItems: [...jsonArray(row.source_refs_json), ...jsonArray(row.evidence_json)]
      })),
      ...decisions.map((row) => ({
        key: `decision_memory:${row.id}`,
        rawItems: jsonArray(row.source_refs_json)
      }))
    ], { projectId: options.project_id, principal: options.principal }),
    collectionEvidenceSourceCounts(
      env,
      tenantId,
      assertions.map((row) => row.id),
      { projectId: options.project_id, principal: options.principal }
    )
  ]);
  const chains = [
    ...memories.map((row) => memorySummary(
      row,
      options.now,
      embeddedSourceCounts.get(`memory:${row.id}`)
    )),
    ...decisions.map((row) => decisionSummary(
      row,
      options.now,
      embeddedSourceCounts.get(`decision_memory:${row.id}`)
    )),
    ...resources.map(resourceSummary),
    ...assertions.map((row) => assertionSummary(
      row,
      options.now,
      evidenceSourceCounts.get(row.id)
    ))
  ].filter((chain) => !options.types || options.types.includes(chain.type))
    .sort((left, right) => right.changed_at - left.changed_at || `${right.source_type}:${right.source_id}`.localeCompare(`${left.source_type}:${left.source_id}`));
  return { chains };
}

/** Lists bounded strata chain summaries using a stable descending cursor. */
export async function getMemoryStrata(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rawOptions: MemoryStrataOptions = {}
): Promise<DashboardStrataResponse> {
  const normalizedTenant = normalizeTenantId(tenantId);
  const options = parseCollectionOptions(rawOptions);
  const result = await queryCollectionRows(env, normalizedTenant, options);
  const chains = result.chains.slice(0, options.limit);
  // Only ACL-visible chains can influence pagination metadata. Raw scan caps
  // must not reveal the existence or volume of inaccessible rows.
  const hasMore = result.chains.length > chains.length;
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    chains,
    oldest_cursor: chains.length ? encodeMemoryStrataCursor(chains[chains.length - 1]!) : null,
    has_more: hasMore,
    generated_at: options.now,
    truncated: hasMore
  };
}

function requiredSourceId(value: string): string {
  const sourceId = value.trim();
  if (!sourceId || sourceId.length > 256) {
    throw new HttpError(400, "invalid_source_id", "source id must be between 1 and 256 characters");
  }
  return sourceId;
}

function projectMatches(rowProjectId: string | null, projectId: string | undefined): boolean {
  return projectId === undefined || rowProjectId === null || rowProjectId === projectId;
}

function parseSnapshot(raw: string | null, required: string[]): { snapshot: Record<string, unknown>; partial: boolean } {
  const parsed = recordValue(jsonValue(raw));
  if (!parsed) return { snapshot: {}, partial: true };
  const snapshot = boundedRecord(parsed);
  return {
    snapshot,
    partial: snapshot._truncated === true || required.some((field) => !Object.prototype.hasOwnProperty.call(parsed, field))
  };
}

function memoryRevision(row: MemoryVersionRow): DashboardStrataRevision {
  const parsed = row.snapshot_json
    ? parseSnapshot(row.snapshot_json, ["content", "kind", "lifecycle_state"])
    : {
      snapshot: boundedRecord({
        content: row.content,
        summary: row.summary,
        tags: jsonArray(row.tags_json),
        kind: row.kind,
        lifecycle_state: row.lifecycle_state,
        scope_type: row.scope_type,
        scope_key: row.scope_key,
        confidence_score: row.confidence_score,
        utility_score: row.utility_score,
        canonical_key: row.canonical_key,
        content_hash: row.content_hash
      }),
      // Legacy rows without snapshot_json can only be reconstructed from the
      // columns retained on memory_versions; fields absent from that schema are
      // unknown and must not be presented as a complete historical snapshot.
      partial: true
    };
  const snapshotState = typeof parsed.snapshot.lifecycle_state === "string" ? parsed.snapshot.lifecycle_state : row.lifecycle_state;
  return {
    id: row.id,
    operation: row.operation,
    recorded_at: Number(row.created_at),
    valid_from: finiteTimestamp(parsed.snapshot.valid_from),
    valid_until: finiteTimestamp(parsed.snapshot.valid_until),
    actor_id: row.actor_id,
    state: normalizeLifecycleState(snapshotState),
    summary: compactText(parsed.snapshot.summary ?? parsed.snapshot.content ?? row.summary ?? row.content, 240),
    partial: parsed.partial,
    snapshot: parsed.snapshot
  };
}

function actorId(raw: string | null): string | null {
  for (const item of jsonArray(raw)) {
    const record = recordValue(item);
    const id = compactText(record?.id, 128);
    if (id) return id;
  }
  return null;
}

function decisionRevision(row: DecisionVersionRow): DashboardStrataRevision {
  const parsed = parseSnapshot(row.snapshot_json, ["title", "decision", "rationale", "status"]);
  return {
    id: row.id,
    operation: row.operation,
    recorded_at: Number(row.created_at),
    valid_from: finiteTimestamp(parsed.snapshot.validFrom ?? parsed.snapshot.valid_from),
    valid_until: finiteTimestamp(parsed.snapshot.validUntil ?? parsed.snapshot.valid_until),
    actor_id: actorId(row.actor_refs_json),
    state: compactText(parsed.snapshot.status, 64) ?? "unknown",
    summary: compactText(parsed.snapshot.title ?? parsed.snapshot.decision ?? row.note, 240),
    partial: parsed.partial,
    snapshot: parsed.snapshot
  };
}

function resourceRevision(row: ResourceVersionRow): DashboardStrataRevision {
  return {
    id: row.id,
    operation: "capture",
    recorded_at: Number(row.created_at),
    valid_from: Number(row.captured_at),
    valid_until: null,
    actor_id: row.created_by_principal,
    state: row.extraction_state,
    summary: compactText(row.extracted_text, 240),
    partial: true,
    snapshot: boundedRecord({
      connector_id: row.connector_id,
      source_version: row.source_version,
      etag: row.etag,
      last_modified: row.last_modified,
      content_hash: row.content_hash,
      snapshot_object_ref: row.snapshot_object_ref,
      extracted_text_preview: compactText(row.extracted_text, 1_000),
      extracted_text_hash: row.extracted_text_hash,
      extraction_state: row.extraction_state,
      captured_at: row.captured_at
    })
  };
}

function assertionRevision(row: AssertionRow): DashboardStrataRevision {
  const snapshot = boundedRecord({
    assertion_type: row.assertion_type,
    subject_type: row.subject_type,
    subject_ref: row.subject_ref,
    predicate: row.predicate,
    object_type: row.object_type,
    object_ref: row.object_ref,
    object_value: row.object_value,
    resource_id: row.resource_id,
    context: jsonValue(row.context_json),
    confidence: row.confidence,
    confirmation_state: row.confirmation_state
  });
  return {
    id: `assertion_revision:${row.id}`,
    operation: "assert",
    recorded_at: Number(row.updated_at),
    valid_from: Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until),
    actor_id: row.reviewed_by_principal ?? row.actor_principal,
    state: row.confirmation_state,
    summary: compactText(`${row.subject_ref} ${row.predicate} ${row.object_ref ?? row.object_value ?? ""}`, 240),
    partial: snapshot._truncated === true,
    snapshot
  };
}

function assertionTypeAliases(sourceType: DashboardSourceType): string[] {
  if (sourceType === "decision_memory") return ["decision_memory", "decision"];
  if (sourceType === "knowledge_resource") return ["knowledge_resource", "resource"];
  return [sourceType];
}

function relationFromAssertion(row: AssertionRelationRow, sourceType: DashboardSourceType, sourceId: string): DashboardStrataRelation[] {
  const relations: DashboardStrataRelation[] = [];
  const sourceAliases = assertionTypeAliases(sourceType);
  if (sourceAliases.includes(row.subject_type)) {
    if (row.subject_ref === sourceId && row.object_type && row.object_ref) {
      relations.push({
        relation: row.predicate,
        target_type: row.object_type,
        target_id: row.object_ref,
        valid_from: Number(row.valid_from),
        valid_until: row.valid_until === null ? null : Number(row.valid_until)
      });
    }
  }
  if (sourceType === "knowledge_resource" && row.resource_id === sourceId && row.subject_ref !== sourceId) {
    relations.push({
      relation: `source_for:${row.predicate}`,
      target_type: row.subject_type,
      target_id: row.subject_ref,
      valid_from: Number(row.valid_from),
      valid_until: row.valid_until === null ? null : Number(row.valid_until)
    });
  }
  return relations;
}

async function confirmedAssertionRelations(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceType: DashboardSourceType,
  sourceId: string,
  now: number,
  options: { projectId?: string; principal: string | null }
): Promise<DashboardStrataRelation[]> {
  const relations: DashboardStrataRelation[] = [];
  let cursor: { updatedAt: number; id: string } | null = null;
  const projectSql = options.projectId ? "AND (project_id = ? OR project_id IS NULL)" : "";
  const projectBindings: string[] = options.projectId ? [options.projectId] : [];
  const sourceAliases = assertionTypeAliases(sourceType);
  const sourceAliasSql = sourceAliases.map(() => "?").join(", ");
  while (relations.length <= MAX_RELATIONS) {
    const cursorSql: string = cursor
      ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))"
      : "";
    const cursorBindings: Array<number | string> = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [];
    const rows: { results: AssertionRelationRow[] } = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, subject_type, subject_ref, predicate, object_type, object_ref, resource_id,
              valid_from, valid_until, updated_at
       FROM knowledge_assertions
       WHERE tenant_id = ? AND confirmation_state = 'confirmed'
         AND (valid_until IS NULL OR valid_until > ?)
         AND ((subject_type IN (${sourceAliasSql}) AND subject_ref = ?)
           OR resource_id = ?
           OR (object_type IN (${sourceAliasSql}) AND object_ref = ?))
         ${projectSql}
         ${cursorSql}
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).bind(
      tenantId,
      now,
      ...sourceAliases,
      sourceId,
      sourceId,
      ...sourceAliases,
      sourceId,
      ...projectBindings,
      ...cursorBindings,
      COLLECTION_SCAN_BATCH_SIZE
    ).all<AssertionRelationRow>();
    if (rows.results.length === 0) break;
    const readableAssertions = await filterReadableAssertions(
      env,
      tenantId,
      rows.results,
      options.projectId,
      options.principal
    );
    for (const relation of readableAssertions.flatMap((row) => relationFromAssertion(row, sourceType, sourceId))) {
      relations.push(relation);
      if (relations.length > MAX_RELATIONS) break;
    }
    const last: AssertionRelationRow = rows.results[rows.results.length - 1]!;
    const nextCursor: { updatedAt: number; id: string } = { updatedAt: Number(last.updated_at), id: last.id };
    if (cursor && cursor.updatedAt === nextCursor.updatedAt && cursor.id === nextCursor.id) break;
    cursor = nextCursor;
    if (rows.results.length < COLLECTION_SCAN_BATCH_SIZE) break;
  }
  return relations;
}

async function filterReadableRelations(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  relations: DashboardStrataRelation[],
  projectId: string | undefined,
  principal: string | null
): Promise<DashboardStrataRelation[]> {
  const memoryIds = [...new Set(relations.filter((item) => item.target_type === "memory").map((item) => item.target_id))];
  const decisionIds = [...new Set(relations
    .filter((item) => item.target_type === "decision_memory" || item.target_type === "decision")
    .map((item) => item.target_id))];
  const resourceIds = [...new Set(relations
    .filter((item) => item.target_type === "knowledge_resource" || item.target_type === "resource")
    .map((item) => item.target_id))];
  const readableMemories = new Set<string>();
  const readableDecisions = new Set<string>();
  const readableResources = new Set<string>();
  if (memoryIds.length) {
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, permissions_json FROM memories
       WHERE tenant_id = ?
         AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    ).bind(tenantId, JSON.stringify(memoryIds)).all<{ id: string; project_id: string | null; permissions_json: string | null }>();
    for (const row of rows.results) {
      if (projectMatches(row.project_id, projectId) && stableResultReadable(row.permissions_json, principal)) {
        readableMemories.add(row.id);
      }
    }
  }
  if (decisionIds.length) {
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, title, decision, domain, status, confirmation_state, confidence,
              visibility, allowed_principals_json, source_refs_json, valid_from, valid_until,
              superseded_by, created_at, updated_at, 0 AS revision_count, 0 AS partial_revision_count
       FROM decision_memories
       WHERE tenant_id = ?
         AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    ).bind(tenantId, JSON.stringify(decisionIds)).all<DecisionRow>();
    for (const row of await filterReadableDecisions(env, tenantId, rows.results, principal)) {
      if (projectMatches(row.project_id, projectId)) readableDecisions.add(row.id);
    }
  }
  if (resourceIds.length) {
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, resource_kind, title, source_system, media_type, visibility,
              permissions_json, current_version_id, lifecycle_state, created_by_principal,
              created_at, updated_at, 0 AS revision_count, 0 AS source_count
       FROM knowledge_resources
       WHERE tenant_id = ?
         AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    ).bind(tenantId, JSON.stringify(resourceIds)).all<ResourceRow>();
    for (const row of await filterReadableResources(env, tenantId, rows.results, projectId, principal)) {
      if (projectMatches(row.project_id, projectId)) readableResources.add(row.id);
    }
  }
  return relations.filter((relation) => {
    if (relation.target_type === "memory") return readableMemories.has(relation.target_id);
    if (relation.target_type === "decision_memory" || relation.target_type === "decision") {
      return readableDecisions.has(relation.target_id);
    }
    if (relation.target_type === "knowledge_resource" || relation.target_type === "resource") {
      return readableResources.has(relation.target_id);
    }
    return true;
  });
}

async function readableMemoryEdgeRelations(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceId: string,
  options: { projectId?: string; principal: string | null }
): Promise<DashboardStrataRelation[]> {
  const relations: DashboardStrataRelation[] = [];
  let cursor: { createdAt: number; id: string } | null = null;
  while (relations.length <= MAX_RELATIONS) {
    const cursorSql: string = cursor
      ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
      : "";
    const cursorBindings: Array<number | string> = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
    const rows: { results: MemoryRelationRow[] } = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, from_memory_id, to_memory_id, relation, created_at
       FROM memory_edges
       WHERE tenant_id = ? AND (from_memory_id = ? OR to_memory_id = ?) ${cursorSql}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).bind(
      tenantId,
      sourceId,
      sourceId,
      ...cursorBindings,
      COLLECTION_SCAN_BATCH_SIZE
    ).all<MemoryRelationRow>();
    if (rows.results.length === 0) break;
    const readable = await filterReadableRelations(
      env,
      tenantId,
      rows.results.map((item) => ({
        relation: item.from_memory_id === sourceId ? item.relation : `inverse:${item.relation}`,
        target_type: "memory",
        target_id: item.from_memory_id === sourceId ? item.to_memory_id : item.from_memory_id,
        valid_from: Number(item.created_at),
        valid_until: null
      })),
      options.projectId,
      options.principal
    );
    for (const relation of readable) {
      relations.push(relation);
      if (relations.length > MAX_RELATIONS) break;
    }
    const last: MemoryRelationRow = rows.results[rows.results.length - 1]!;
    const nextCursor: { createdAt: number; id: string } = { createdAt: Number(last.created_at), id: last.id };
    if (cursor && cursor.createdAt === nextCursor.createdAt && cursor.id === nextCursor.id) break;
    cursor = nextCursor;
    if (rows.results.length < COLLECTION_SCAN_BATCH_SIZE) break;
  }
  return relations;
}

function boundRelations(relations: DashboardStrataRelation[]): {
  relations: DashboardStrataRelation[];
  truncated: boolean;
} {
  return {
    relations: relations.slice(0, MAX_RELATIONS),
    truncated: relations.length > MAX_RELATIONS
  };
}

function refSource(item: unknown): EmbeddedSourceCandidate | null {
  const record = recordValue(item);
  if (!record) return null;
  const resourceId = compactText(record.resource_id ?? record.resourceId ?? record.id ?? record.ref, 256);
  if (!resourceId) return null;
  const locator = recordValue(record.locator) ?? (typeof record.uri === "string" ? { uri: record.uri } : null);
  const rawAllowed = record.allowedPrincipals ?? record.allowed_principals;
  const allowedPrincipals = Array.isArray(rawAllowed)
    ? rawAllowed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100)
    : [];
  return {
    source: {
      resource_id: resourceId,
      resource_version_id: compactText(record.resource_version_id ?? record.resourceVersionId ?? record.version_id, 256),
      title: compactText(record.title ?? record.label, 240) ?? resourceId,
      relation: compactText(record.relation ?? record.type, 128) ?? "source_ref",
      captured_at: finiteTimestamp(record.captured_at ?? record.capturedAt ?? record.updated_at ?? record.updatedAt),
      locator: locator ? boundedRecord(locator) : null,
      unresolved: true
    },
    allowedPrincipals
  };
}

async function scanVisibleEmbeddedSources(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rawItems: unknown[],
  options: { projectId?: string; principal: string | null }
): Promise<{ candidates: EmbeddedSourceCandidate[]; partial: boolean }> {
  const allowed = rawItems
    .map(refSource)
    .filter((item): item is EmbeddedSourceCandidate => Boolean(item))
    .filter((item) => sourceAllowed(item, options.principal));
  const candidates: EmbeddedSourceCandidate[] = [];
  for (let index = 0; index < allowed.length && candidates.length <= MAX_VISIBLE_SOURCE_COUNT; index += RESOURCE_ID_CHUNK_SIZE) {
    const chunk = allowed.slice(index, index + RESOURCE_ID_CHUNK_SIZE);
    const visibility = await loadResourceVisibility(
      env,
      tenantId,
      [...new Set(chunk.map((item) => item.source.resource_id))],
      options.projectId,
      options.principal
    );
    for (const candidate of chunk) {
      const resourceId = candidate.source.resource_id;
      if (visibility.existing.has(resourceId) && !visibility.readable.has(resourceId)) continue;
      const resource = visibility.resources.get(resourceId);
      candidates.push(resource
        ? { ...candidate, source: { ...candidate.source, title: resource.title, unresolved: false } }
        : candidate);
      if (candidates.length > MAX_VISIBLE_SOURCE_COUNT) break;
    }
  }
  return { candidates, partial: candidates.length > MAX_VISIBLE_SOURCE_COUNT };
}

function evidenceResourceRow(row: EvidenceRow): ResourceRow {
  return {
    id: row.resource_id,
    project_id: row.project_id,
    resource_kind: "other",
    title: row.title ?? row.resource_id,
    source_system: "unknown",
    media_type: "application/octet-stream",
    visibility: row.visibility ?? "restricted",
    permissions_json: row.permissions_json,
    current_version_id: null,
    lifecycle_state: "active",
    created_by_principal: "unknown",
    created_at: row.created_at,
    updated_at: row.created_at,
    revision_count: 0,
    source_count: 0
  };
}

async function filterReadableEvidenceRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: EvidenceRow[],
  options: { projectId?: string; principal: string | null }
): Promise<EvidenceRow[]> {
  const readableIds = new Set((await filterReadableResources(
    env,
    tenantId,
    rows.map(evidenceResourceRow),
    options.projectId,
    options.principal
  )).filter((row) => projectMatches(row.project_id, options.projectId)).map((row) => row.id));
  return rows.filter((row) => readableIds.has(row.resource_id));
}

async function scanVisibleEvidenceRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  assertionId: string,
  options: { projectId?: string; principal: string | null; visibleLimit: number }
): Promise<{ rows: EvidenceRow[]; partial: boolean }> {
  const visibleRows: EvidenceRow[] = [];
  let cursor: { createdAt: number; id: string } | null = null;
  while (visibleRows.length <= options.visibleLimit) {
    const cursorSql: string = cursor
      ? "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
      : "";
    const cursorBindings: Array<number | string> = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
    const result: { results: EvidenceRow[] } = await env.OPEN_BRAIN_DB.prepare(
      `SELECT e.id, e.assertion_id, e.resource_id, e.resource_version_id, e.locator_json, e.note, e.created_at,
              r.title, r.visibility, r.project_id, r.permissions_json
       FROM knowledge_assertion_evidence e
       JOIN knowledge_resources r ON r.tenant_id = e.tenant_id AND r.id = e.resource_id
       WHERE e.tenant_id = ? AND e.assertion_id = ? ${cursorSql}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`
    ).bind(tenantId, assertionId, ...cursorBindings, COLLECTION_SCAN_BATCH_SIZE).all<EvidenceRow>();
    if (result.results.length === 0) break;
    const readable = await filterReadableEvidenceRows(env, tenantId, result.results, options);
    for (const row of readable) {
      visibleRows.push(row);
      if (visibleRows.length > options.visibleLimit) break;
    }
    const last: EvidenceRow = result.results[result.results.length - 1]!;
    const nextCursor: { createdAt: number; id: string } = { createdAt: Number(last.created_at), id: last.id };
    if (cursor && cursor.createdAt === nextCursor.createdAt && cursor.id === nextCursor.id) break;
    cursor = nextCursor;
    if (result.results.length < COLLECTION_SCAN_BATCH_SIZE) break;
  }
  return { rows: visibleRows, partial: visibleRows.length > options.visibleLimit };
}

async function evidenceSources(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  assertionId: string,
  options: { projectId?: string; principal: string | null; limit: number }
): Promise<{
  sources: DashboardStrataSource[];
  truncated: boolean;
  visibleCount: number;
  partial: boolean;
}> {
  const scan = await scanVisibleEvidenceRows(
    env,
    tenantId,
    assertionId,
    { ...options, visibleLimit: MAX_VISIBLE_SOURCE_COUNT }
  );
  return {
    sources: scan.rows.slice(0, options.limit).map((row) => ({
      resource_id: row.resource_id,
      resource_version_id: row.resource_version_id,
      title: row.title ?? row.resource_id,
      relation: "evidence",
      captured_at: Number(row.created_at),
      locator: recordValue(jsonValue(row.locator_json)) ? boundedRecord(jsonValue(row.locator_json)) : null,
      unresolved: false
    })),
    truncated: scan.rows.length > options.limit,
    visibleCount: Math.min(MAX_VISIBLE_SOURCE_COUNT, scan.rows.length),
    partial: scan.partial
  };
}

async function resolveEmbeddedSources(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rawItems: unknown[],
  options: { projectId?: string; principal: string | null; limit: number }
): Promise<{
  sources: DashboardStrataSource[];
  truncated: boolean;
  visibleCount: number;
  partial: boolean;
}> {
  const scan = await scanVisibleEmbeddedSources(env, tenantId, rawItems, options);
  return {
    sources: scan.candidates.slice(0, options.limit).map((item) => item.source),
    truncated: scan.candidates.length > options.limit,
    visibleCount: Math.min(MAX_VISIBLE_SOURCE_COUNT, scan.candidates.length),
    partial: scan.partial
  };
}

async function memoryDetail(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceId: string,
  options: Required<Pick<MemoryStrataDetailOptions, "revision_limit" | "source_limit" | "now">> & {
    project_id?: string;
    principal: string | null;
  }
): Promise<DashboardStrataDetailResponse> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT m.id, m.project_id, m.content, m.summary, m.tags_json, m.kind, m.lifecycle_state,
            m.confidence_score, m.canonical_key, m.current_version, m.source_refs_json,
            m.evidence_json, m.permissions_json, m.valid_from, m.valid_until, m.root_memory_id,
            m.created_at, m.updated_at,
            (SELECT COUNT(*) FROM memory_versions v WHERE v.tenant_id = m.tenant_id AND v.memory_id = m.id) AS revision_count,
            0 AS partial_revision_count
     FROM memories m WHERE m.tenant_id = ? AND m.id = ?`
  ).bind(tenantId, sourceId).first<MemoryRow>();
  if (!row || !projectMatches(row.project_id, options.project_id) || !stableResultReadable(row.permissions_json, options.principal)) {
    throw new HttpError(404, "strata_source_not_found", "Memory strata source was not found");
  }
  const versionRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, version, operation, content, summary, tags_json, kind, lifecycle_state,
            scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score,
            canonical_key, snapshot_json, content_hash, created_at
     FROM memory_versions WHERE tenant_id = ? AND memory_id = ?
     ORDER BY version DESC, created_at DESC, id DESC LIMIT ?`
  ).bind(tenantId, sourceId, options.revision_limit + 1).all<MemoryVersionRow>();
  const edgeRelations = await readableMemoryEdgeRelations(
    env,
    tenantId,
    sourceId,
    { projectId: options.project_id, principal: options.principal }
  );
  const rootRelations = row.root_memory_id
    ? await filterReadableRelations(
      env,
      tenantId,
      [{
        relation: "root_memory",
        target_type: "memory",
        target_id: row.root_memory_id,
        valid_from: null,
        valid_until: null
      }],
      options.project_id,
      options.principal
    )
    : [];
  const boundedRelations = boundRelations([...edgeRelations, ...rootRelations]);
  const sources = await resolveEmbeddedSources(
    env,
    tenantId,
    [...jsonArray(row.source_refs_json), ...jsonArray(row.evidence_json)],
    { projectId: options.project_id, principal: options.principal, limit: options.source_limit }
  );
  const revisions = versionRows.results.slice(0, options.revision_limit).map(memoryRevision);
  const summary = memorySummary({
    ...row,
    partial_revision_count: revisions.filter((revision) => revision.partial).length
  }, options.now, { count: sources.visibleCount, partial: sources.partial });
  if (boundedRelations.truncated) summary.attention.push("relations_truncated");
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    chain: { ...summary, revisions, relations: boundedRelations.relations, sources: sources.sources },
    truncated: { revisions: versionRows.results.length > options.revision_limit, sources: sources.truncated }
  };
}

async function decisionDetail(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceId: string,
  options: Required<Pick<MemoryStrataDetailOptions, "revision_limit" | "source_limit" | "now">> & {
    project_id?: string;
    principal: string | null;
  }
): Promise<DashboardStrataDetailResponse> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.project_id, d.title, d.decision, d.domain, d.status, d.confirmation_state,
            d.confidence, d.visibility, d.allowed_principals_json, d.source_refs_json,
            d.valid_from, d.valid_until, d.superseded_by, d.created_at, d.updated_at,
            (SELECT COUNT(*) FROM decision_memory_versions v WHERE v.tenant_id = d.tenant_id AND v.decision_memory_id = d.id) AS revision_count,
            0 AS partial_revision_count
     FROM decision_memories d WHERE d.tenant_id = ? AND d.id = ?`
  ).bind(tenantId, sourceId).first<DecisionRow>();
  if (!row || !projectMatches(row.project_id, options.project_id) || !(await filterReadableDecisions(env, tenantId, [row], options.principal)).length) {
    throw new HttpError(404, "strata_source_not_found", "Memory strata source was not found");
  }
  const versionRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, operation, snapshot_json, actor_refs_json, reviewer_refs_json, note, created_at
     FROM decision_memory_versions WHERE tenant_id = ? AND decision_memory_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(tenantId, sourceId, options.revision_limit + 1).all<DecisionVersionRow>();
  const revisions = versionRows.results.slice(0, options.revision_limit).map(decisionRevision);
  const assertionRelations = await confirmedAssertionRelations(
    env,
    tenantId,
    "decision_memory",
    sourceId,
    options.now,
    { projectId: options.project_id, principal: options.principal }
  );
  const supersessionRelations = row.superseded_by
    ? await filterReadableRelations(
      env,
      tenantId,
      [{
        relation: "superseded_by",
        target_type: "decision_memory",
        target_id: row.superseded_by,
        valid_from: null,
        valid_until: null
      }],
      options.project_id,
      options.principal
    )
    : [];
  const boundedRelations = boundRelations([...supersessionRelations, ...assertionRelations]);
  const sources = await resolveEmbeddedSources(env, tenantId, jsonArray(row.source_refs_json), {
    projectId: options.project_id,
    principal: options.principal,
    limit: options.source_limit
  });
  const summary = decisionSummary({
    ...row,
    partial_revision_count: revisions.filter((revision) => revision.partial).length
  }, options.now, { count: sources.visibleCount, partial: sources.partial });
  if (boundedRelations.truncated) summary.attention.push("relations_truncated");
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    chain: { ...summary, revisions, relations: boundedRelations.relations, sources: sources.sources },
    truncated: { revisions: versionRows.results.length > options.revision_limit, sources: sources.truncated }
  };
}

async function resourceDetail(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceId: string,
  options: Required<Pick<MemoryStrataDetailOptions, "revision_limit" | "source_limit" | "now">> & {
    project_id?: string;
    principal: string | null;
  }
): Promise<DashboardStrataDetailResponse> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.id, r.project_id, r.resource_kind, r.title, r.source_system, r.media_type,
            r.visibility, r.permissions_json, r.current_version_id, r.lifecycle_state,
            r.created_by_principal, r.created_at, r.updated_at,
            (SELECT COUNT(*) FROM knowledge_resource_versions v WHERE v.tenant_id = r.tenant_id AND v.resource_id = r.id) AS revision_count,
            (SELECT COUNT(*) FROM knowledge_resource_locations l WHERE l.tenant_id = r.tenant_id AND l.resource_id = r.id) AS source_count
     FROM knowledge_resources r WHERE r.tenant_id = ? AND r.id = ?`
  ).bind(tenantId, sourceId).first<ResourceRow>();
  const readable = row ? await filterReadableResources(env, tenantId, [row], options.project_id, options.principal) : [];
  if (!row || !projectMatches(row.project_id, options.project_id) || readable.length === 0) {
    throw new HttpError(404, "strata_source_not_found", "Memory strata source was not found");
  }
  const [versionRows, locationRows, relationCandidates] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(
      `SELECT id, connector_id, source_version, etag, last_modified, content_hash,
              snapshot_object_ref, extracted_text, extracted_text_hash, extraction_state,
              captured_at, created_by_principal, created_at
       FROM knowledge_resource_versions WHERE tenant_id = ? AND resource_id = ?
       ORDER BY captured_at DESC, id DESC LIMIT ?`
    ).bind(tenantId, sourceId, options.revision_limit + 1).all<ResourceVersionRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT id, resource_id, uri, location_role, created_at
       FROM knowledge_resource_locations WHERE tenant_id = ? AND resource_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).bind(tenantId, sourceId, options.source_limit + 1).all<LocationRow>(),
    confirmedAssertionRelations(
      env,
      tenantId,
      "knowledge_resource",
      sourceId,
      options.now,
      { projectId: options.project_id, principal: options.principal }
    )
  ]);
  const boundedRelations = boundRelations(relationCandidates);
  const revisions = versionRows.results.slice(0, options.revision_limit).map(resourceRevision);
  const sources: DashboardStrataSource[] = locationRows.results.slice(0, options.source_limit).map((location) => ({
    resource_id: sourceId,
    resource_version_id: row.current_version_id,
    title: row.title,
    relation: location.location_role,
    captured_at: Number(location.created_at),
    locator: { uri: location.uri },
    unresolved: false
  }));
  const summary = resourceSummary(row);
  if (boundedRelations.truncated) summary.attention.push("relations_truncated");
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    chain: { ...summary, revisions, relations: boundedRelations.relations, sources },
    truncated: {
      revisions: versionRows.results.length > options.revision_limit,
      sources: locationRows.results.length > options.source_limit
    }
  };
}

async function assertionDetail(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceId: string,
  options: Required<Pick<MemoryStrataDetailOptions, "revision_limit" | "source_limit" | "now">> & {
    project_id?: string;
    principal: string | null;
  }
): Promise<DashboardStrataDetailResponse> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.id, a.project_id, a.assertion_type, a.subject_type, a.subject_ref, a.predicate,
            a.object_type, a.object_ref, a.resource_id, a.object_value, a.context_json,
            a.confidence, a.confirmation_state, a.valid_from, a.valid_until,
            a.actor_principal, a.reviewed_by_principal, a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM knowledge_assertion_evidence e WHERE e.tenant_id = a.tenant_id AND e.assertion_id = a.id) AS source_count
     FROM knowledge_assertions a WHERE a.tenant_id = ? AND a.id = ?`
  ).bind(tenantId, sourceId).first<AssertionRow>();
  if (!row || !projectMatches(row.project_id, options.project_id) || !(await assertionReadable(
    env,
    tenantId,
    row,
    options.project_id,
    options.principal
  ))) {
    throw new HttpError(404, "strata_source_not_found", "Memory strata source was not found");
  }
  const evidence = await evidenceSources(env, tenantId, sourceId, {
    projectId: options.project_id,
    principal: options.principal,
    limit: options.source_limit
  });
  const rawRelations: DashboardStrataRelation[] = [{
    relation: "subject",
    target_type: row.subject_type,
    target_id: row.subject_ref,
    valid_from: Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until)
  }];
  if (row.object_type && row.object_ref) rawRelations.push({
    relation: row.predicate,
    target_type: row.object_type,
    target_id: row.object_ref,
    valid_from: Number(row.valid_from),
    valid_until: row.valid_until === null ? null : Number(row.valid_until)
  });
  const relations = await filterReadableRelations(
    env,
    tenantId,
    rawRelations,
    options.project_id,
    options.principal
  );
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    chain: {
      ...assertionSummary(row, options.now, {
        count: evidence.visibleCount,
        partial: evidence.partial
      }),
      revisions: [assertionRevision(row)],
      relations,
      sources: evidence.sources
    },
    truncated: { revisions: false, sources: evidence.truncated }
  };
}

/** Returns one ACL-filtered, bounded chain with explicit per-section truncation. */
export async function getMemoryStrataDetail(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  sourceType: DashboardSourceType,
  sourceId: string,
  rawOptions: MemoryStrataDetailOptions = {}
): Promise<DashboardStrataDetailResponse> {
  const normalizedTenant = normalizeTenantId(tenantId);
  const normalizedSourceId = requiredSourceId(sourceId);
  const options = {
    project_id: rawOptions.project_id?.trim() || undefined,
    principal: optionalPrincipal(rawOptions.principal),
    revision_limit: parseLimit(
      rawOptions.revision_limit,
      "revision_limit",
      DEFAULT_REVISION_LIMIT,
      MAX_REVISION_LIMIT
    ),
    source_limit: parseLimit(
      rawOptions.source_limit,
      "source_limit",
      DEFAULT_SOURCE_LIMIT,
      MAX_SOURCE_LIMIT
    ),
    now: Number.isSafeInteger(rawOptions.now) && Number(rawOptions.now) >= 0 ? Number(rawOptions.now) : Date.now()
  };
  if (sourceType === "memory") return memoryDetail(env, normalizedTenant, normalizedSourceId, options);
  if (sourceType === "decision_memory") return decisionDetail(env, normalizedTenant, normalizedSourceId, options);
  if (sourceType === "knowledge_resource") return resourceDetail(env, normalizedTenant, normalizedSourceId, options);
  if (sourceType === "knowledge_assertion") return assertionDetail(env, normalizedTenant, normalizedSourceId, options);
  throw new HttpError(400, "invalid_source_type", "sourceType is not supported by dashboard/v1");
}

export type MemoryStrataChain = DashboardStrataChain;
