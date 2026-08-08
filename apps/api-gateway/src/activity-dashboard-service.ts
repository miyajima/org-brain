import {
  DASHBOARD_CONTRACT_VERSION,
  type DashboardActivityEvent,
  type DashboardActivityResponse,
  type DashboardAttention,
  type DashboardObservedAgent
} from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import { normalizeDecisionTopic } from "./context-engine-service";
import { stableResultReadable } from "./memory-service";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = DAY_MS;
const MAX_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const STALLED_TASK_MS = 30 * 60_000;
const UNACKED_HANDOFF_MS = 30 * 60_000;
const UNREPORTED_IMPACT_MS = 30 * 60_000;
const DORMANT_MEMORY_MS = 30 * DAY_MS;
const AUXILIARY_ACL_SCAN_BATCH = 250;
const MEMORY_ATTENTION_OUTPUT_LIMIT = 25;
const DECISION_CONFLICT_OUTPUT_LIMIT = 25;
const ACL_EVENT_SCAN_BATCH_MIN = 64;
const ACL_EVENT_SCAN_BATCH_MAX = 250;

export type ActivityEvent = DashboardActivityEvent;
export type ObservedAgent = DashboardObservedAgent;
export type ActivityAttention = DashboardAttention;
export type ActivityDashboardResponse = DashboardActivityResponse;
type ActivityActor = ActivityEvent["actor"];

export type ActivityDashboardOptions = {
  projectId?: unknown;
  from?: unknown;
  to?: unknown;
  before?: unknown;
  after?: unknown;
  limit?: unknown;
  principal?: string | null;
  now?: number;
};

type Cursor = { v: 1; at: number; key: string };
type Direction = "before" | "after";
type KeysetEventRow = { event_key: string; occurred_at: number };

type ParsedOptions = {
  projectId: string | null;
  from: number;
  to: number;
  limit: number;
  cursor: Cursor | null;
  direction: Direction;
  principal: string | null;
  now: number;
};

type TaskEventRow = {
  event_key: string;
  source_id: string;
  kind: string;
  occurred_at: number;
  project_id: string | null;
  task_id: string;
  trace_id: string | null;
  capability: string;
  task_status: string;
  created_by_principal: string | null;
};

type UsageEventRow = {
  event_key: string;
  usage_event_id: string;
  usage_item_id: string;
  occurred_at: number;
  project_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  capability: string | null;
  access_path: string;
  request_source: string;
  actor_principal: string | null;
  source_type: "memory" | "decision_memory";
  source_id: string;
  reference_type: string;
  used_state: string;
  memory_label: string | null;
  memory_exists: number;
  memory_permissions_json: string | null;
  decision_title: string | null;
  decision_exists: number;
  decision_visibility: string | null;
  decision_allowed_principals_json: string | null;
  reporter_principal: string | null;
  agent_name: string | null;
  model: string | null;
};

type MemoryVersionRow = {
  event_key: string;
  source_id: string;
  occurred_at: number;
  project_id: string | null;
  version: number;
  operation: string;
  summary: string | null;
  kind: string;
  lifecycle_state: string;
  actor_type: string | null;
  actor_id: string | null;
  permissions_json: string | null;
};

type DecisionVersionRow = {
  event_key: string;
  source_id: string;
  occurred_at: number;
  project_id: string | null;
  operation: string;
  actor_refs_json: string | null;
  title: string;
  status: string;
  visibility: string | null;
  allowed_principals_json: string | null;
};

type ImpactEventRow = {
  event_key: string;
  source_id: string;
  occurred_at: number;
  project_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  external_run_id: string;
  event_type: "eligible" | "assessed" | "failed";
  memory_used: number | null;
  avoided_lookup: string | null;
  confidence: string | null;
  reporter_principal: string;
  agent_name: string | null;
  model: string | null;
};

type EffectEventRow = {
  event_key: string;
  source_id: string;
  usage_event_id: string;
  occurred_at: number;
  project_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  effect_outcome: string;
  evidence_level: string;
  net_saved_tokens_estimate: number;
  failure_avoided: number;
  request_source: string;
  capability: string | null;
  actor_principal: string | null;
  reporter_principal: string | null;
  agent_name: string | null;
  model: string | null;
};

type UsageAclRow = {
  source_type: "memory" | "decision_memory";
  source_id: string;
  memory_exists: number;
  memory_permissions_json: string | null;
  decision_exists: number;
  decision_visibility: string | null;
  decision_allowed_principals_json: string | null;
};

type EffectAclItemRow = UsageAclRow & {
  usage_event_id: string;
};

type RetrievalEventRow = {
  event_key: string;
  source_id: string;
  occurred_at: number;
  project_id: string | null;
  task_id: string;
  capability: string;
  search_strategy: string;
  matched_count: number;
  returned_count: number;
  fallback_used: number;
  latency_ms: number;
};

type MessageEventRow = {
  event_key: string;
  source_id: string;
  occurred_at: number;
  project_id: string | null;
  sender_principal: string;
  target_type: string;
  target_key: string;
  status: string;
};

type ObservedAgentRow = {
  reporter_principal: string;
  agent_name: string | null;
  model: string | null;
  last_seen_at: number;
  active_task_count: number;
  read_count: number;
  write_count: number;
  failure_count: number;
};

type TaskAttentionRow = {
  id: string;
  project_id: string | null;
  capability: string;
  status: string;
  updated_at: number;
};

type MessageAttentionRow = {
  id: string;
  project_id: string | null;
  sender_principal: string;
  target_type: string;
  target_key: string;
  status: string;
  created_at: number;
};

type ImpactAttentionRow = {
  id: string;
  external_run_id: string;
  project_id: string | null;
  occurred_at: number;
};

type DormantMemoryRow = {
  id: string;
  project_id: string | null;
  label: string;
  utility_score: number;
  last_activity_at: number;
  permissions_json: string | null;
};

type ExpiredMemoryRow = {
  id: string;
  project_id: string | null;
  label: string;
  valid_until: number;
  permissions_json: string | null;
};

type DecisionConflictRow = {
  id: string;
  title: string;
  project_id: string | null;
  status: string;
  superseded_by: string | null;
  valid_until: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  updated_at: number;
};

type DormantMemoryCursor = {
  utilityScore: number;
  lastActivityAt: number;
  id: string;
};

type ExpiredMemoryCursor = {
  validUntil: number;
  id: string;
};

type DecisionConflictCursor = {
  updatedAt: number;
  id: string;
};

function parseOptionalProject(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_project_id", "project_id must be a string");
  }
  const projectId = value.trim();
  if (projectId.length > 256) {
    throw new HttpError(400, "invalid_project_id", "project_id must not exceed 256 characters");
  }
  return projectId;
}

function parseTimestamp(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `invalid_${field}`, `${field} must be a non-negative integer timestamp`);
  }
  return parsed;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new HttpError(400, "invalid_limit", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
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
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function encodeActivityCursor(event: Pick<ActivityEvent, "id" | "occurred_at">): string {
  return encodeBase64Url(JSON.stringify({ v: 1, at: event.occurred_at, key: event.id } satisfies Cursor));
}

function parseCursor(value: unknown, field: string): Cursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024) {
    throw new HttpError(400, "invalid_cursor", `${field} cursor is invalid`);
  }
  try {
    const parsed = JSON.parse(decodeBase64Url(value)) as Partial<Cursor>;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.at) ||
      Number(parsed.at) < 0 ||
      typeof parsed.key !== "string" ||
      !parsed.key ||
      parsed.key.length > 512
    ) throw new Error("invalid cursor fields");
    return { v: 1, at: Number(parsed.at), key: parsed.key };
  } catch {
    throw new HttpError(400, "invalid_cursor", `${field} cursor is invalid`);
  }
}

function parseOptions(options: ActivityDashboardOptions): ParsedOptions {
  const now = Number.isSafeInteger(options.now) ? Number(options.now) : Date.now();
  const to = parseTimestamp(options.to, "to", now);
  const from = parseTimestamp(options.from, "from", Math.max(0, to - DEFAULT_WINDOW_MS));
  if (from > to) throw new HttpError(400, "invalid_range", "from must be before to");
  if (to - from > MAX_WINDOW_MS) {
    throw new HttpError(400, "activity_window_too_large", "activity window must not exceed 7 days");
  }
  if (options.before && options.after) {
    throw new HttpError(400, "ambiguous_cursor", "before and after cursors are mutually exclusive");
  }
  const direction: Direction = options.after ? "after" : "before";
  const cursor = parseCursor(options.after ?? options.before, direction);
  if (cursor && (cursor.at < from || cursor.at > to)) {
    throw new HttpError(400, "cursor_outside_window", "cursor timestamp is outside the requested window");
  }
  const principal = options.principal?.trim().slice(0, 128) || null;
  return {
    projectId: parseOptionalProject(options.projectId),
    from,
    to,
    limit: parseLimit(options.limit),
    cursor,
    direction,
    principal,
    now
  };
}

function buildWindowFilter(
  options: ParsedOptions,
  timeExpression: string,
  keyExpression: string,
  projectExpression: string | null
): { sql: string; bindings: unknown[]; order: "ASC" | "DESC" } {
  const clauses = [`${timeExpression} >= ?`, `${timeExpression} <= ?`];
  const bindings: unknown[] = [options.from, options.to];
  if (options.projectId && projectExpression) {
    clauses.push(`${projectExpression} = ?`);
    bindings.push(options.projectId);
  }
  const operator = options.direction === "after" ? ">" : "<";
  if (options.cursor) {
    clauses.push(`(${timeExpression} ${operator} ? OR (${timeExpression} = ? AND ${keyExpression} ${operator} ?))`);
    bindings.push(options.cursor.at, options.cursor.at, options.cursor.key);
  }
  return {
    sql: clauses.join(" AND "),
    bindings,
    order: options.direction === "after" ? "ASC" : "DESC"
  };
}

function jsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function actorRefs(raw: string | null): Array<{ id?: string; name?: string; type?: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { id?: string; name?: string; type?: string } =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  } catch {
    return [];
  }
}

function directDecisionReadable(
  visibility: string | null,
  allowedPrincipalsJson: string | null,
  principal: string | null
): boolean {
  const allowed = jsonStringArray(allowedPrincipalsJson);
  if (visibility !== "restricted" && allowed.length === 0) return true;
  if (!principal) return false;
  return allowed.includes(principal) || allowed.includes(`user:${principal}`) || allowed.includes(`agent:${principal}`);
}

async function allowedRestrictedDecisionIds(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  principal: string | null,
  ids: string[]
): Promise<Set<string>> {
  if (!principal || ids.length === 0) return new Set();
  const authz = await buildAuthzContext(env as Env, tenantId, principal);
  return loadReadableResourceIds(env as Env, {
    tenantId,
    resourceType: "decision_memory",
    resourceIds: ids,
    authz
  });
}

function systemActor(id: string, label: string): ActivityActor {
  return { id: `system:${id}`, label, kind: "system" };
}

function unknownSystemActor(): ActivityActor {
  return systemActor("unknown", "System / Unknown");
}

function actorToken(value: string): string {
  return value.trim().toLocaleLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96) || "unknown";
}

function capabilityActor(capability: string | null | undefined): ActivityActor {
  const value = capability?.trim();
  return value ? systemActor(`capability:${actorToken(value)}`, value) : unknownSystemActor();
}

function namedActor(args: {
  principal?: string | null;
  name?: string | null;
  actorType?: string | null;
  capability?: string | null;
}): ActivityActor {
  const principal = args.principal?.trim();
  const name = args.name?.trim();
  if (principal) {
    return {
      id: principal,
      label: name || principal,
      kind: name || args.actorType === "agent" || principal.startsWith("agent:") ? "agent" : "principal"
    };
  }
  if (name) return { id: `agent-name:${actorToken(name)}`, label: name, kind: "agent" };
  if (args.capability?.trim()) return capabilityActor(args.capability);
  // Legacy/pre-attribution records with no known source use one deterministic
  // identity rather than guessing from request_source or another payload field.
  return unknownSystemActor();
}

async function queryTaskEvents(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<TaskEventRow[]> {
  const key = "('task:' || e.id)";
  const filter = buildWindowFilter(options, "e.created_at", key, "t.project_id");
  return (await db.prepare(
    `/* activity:task-events */
     SELECT ${key} AS event_key, e.id AS source_id, e.kind, e.created_at AS occurred_at,
            t.project_id, t.id AS task_id, t.trace_id, t.capability, t.status AS task_status,
            t.created_by_principal
     FROM task_events e
     JOIN tasks t ON t.tenant_id = e.tenant_id AND t.id = e.task_id
     WHERE e.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<TaskEventRow>()).results;
}

async function queryUsageEvents(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<UsageEventRow[]> {
  const key = "('memory-usage:' || ui.id)";
  const filter = buildWindowFilter(options, "ue.created_at", key, "ue.project_id");
  return (await db.prepare(
    `/* activity:memory-usage */
     SELECT ${key} AS event_key, ue.id AS usage_event_id, ui.id AS usage_item_id,
            ue.created_at AS occurred_at, ue.project_id, ue.task_id, ue.trace_id,
            ue.capability, ue.access_path, ue.request_source, ue.actor_principal,
            ui.source_type, ui.source_id, ui.reference_type, ui.used_state,
            COALESCE(m.summary, 'Memory ' || ui.source_id) AS memory_label,
            CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END AS memory_exists,
            m.permissions_json AS memory_permissions_json,
            d.title AS decision_title,
            CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS decision_exists,
            d.visibility AS decision_visibility,
            d.allowed_principals_json AS decision_allowed_principals_json,
            impact.reporter_principal, impact.agent_name, impact.model
     FROM memory_usage_events ue
     JOIN memory_usage_items ui ON ui.tenant_id = ue.tenant_id AND ui.usage_event_id = ue.id
     LEFT JOIN memories m ON ui.source_type = 'memory' AND m.tenant_id = ui.tenant_id AND m.id = ui.source_id
     LEFT JOIN decision_memories d ON ui.source_type = 'decision_memory' AND d.tenant_id = ui.tenant_id AND d.id = ui.source_id
     LEFT JOIN memory_impact_events impact
       ON impact.tenant_id = ue.tenant_id AND impact.external_run_id = ue.external_run_id
      AND impact.event_type = 'eligible'
     WHERE ue.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<UsageEventRow>()).results;
}

async function queryMemoryVersions(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<MemoryVersionRow[]> {
  const key = "('memory-write:' || v.id)";
  const filter = buildWindowFilter(options, "v.created_at", key, "m.project_id");
  return (await db.prepare(
    `/* activity:memory-versions */
     SELECT ${key} AS event_key, v.memory_id AS source_id, v.created_at AS occurred_at,
            m.project_id, v.version, v.operation, v.summary, v.kind, v.lifecycle_state,
            v.actor_type, v.actor_id, m.permissions_json
     FROM memory_versions v
     JOIN memories m ON m.tenant_id = v.tenant_id AND m.id = v.memory_id
     WHERE v.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<MemoryVersionRow>()).results;
}

async function queryDecisionVersions(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<DecisionVersionRow[]> {
  const key = "('decision-write:' || v.id)";
  const filter = buildWindowFilter(options, "v.created_at", key, "d.project_id");
  return (await db.prepare(
    `/* activity:decision-versions */
     SELECT ${key} AS event_key, v.decision_memory_id AS source_id, v.created_at AS occurred_at,
            d.project_id, v.operation, v.actor_refs_json, d.title, d.status,
            d.visibility, d.allowed_principals_json
     FROM decision_memory_versions v
     JOIN decision_memories d ON d.tenant_id = v.tenant_id AND d.id = v.decision_memory_id
     WHERE v.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<DecisionVersionRow>()).results;
}

async function queryImpactEvents(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<ImpactEventRow[]> {
  const key = "('impact:' || e.id)";
  const filter = buildWindowFilter(options, "e.occurred_at", key, "e.project_id");
  return (await db.prepare(
    `/* activity:impact-events */
     SELECT ${key} AS event_key, e.id AS source_id, e.occurred_at, e.project_id,
            e.task_id, e.trace_id, e.external_run_id, e.event_type, e.memory_used,
            e.avoided_lookup, e.confidence, e.reporter_principal, e.agent_name, e.model
     FROM memory_impact_events e
     WHERE e.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<ImpactEventRow>()).results;
}

async function queryEffectEvents(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions,
  scanLimit: number,
  effectOutcome?: "negative"
): Promise<EffectEventRow[]> {
  const key = "('memory-effect:' || e.id)";
  const filter = buildWindowFilter(options, "e.created_at", key, "ue.project_id");
  const outcomeSql = effectOutcome ? "AND e.effect_outcome = ?" : "";
  const marker = effectOutcome ? "activity:negative-effect-attention" : "activity:effect-events";
  return (await db.prepare(
    `/* ${marker} */
     SELECT ${key} AS event_key, e.id AS source_id, e.usage_event_id,
            e.created_at AS occurred_at,
            ue.project_id, ue.task_id, ue.trace_id, e.effect_outcome, e.evidence_level,
            e.net_saved_tokens_estimate, e.failure_avoided, ue.request_source, ue.capability,
            ue.actor_principal,
            impact.reporter_principal, impact.agent_name, impact.model
     FROM memory_effect_events e
     JOIN memory_usage_events ue ON ue.tenant_id = e.tenant_id AND ue.id = e.usage_event_id
     LEFT JOIN memory_impact_events impact
       ON impact.tenant_id = ue.tenant_id AND impact.external_run_id = ue.external_run_id
      AND impact.event_type = 'eligible'
     WHERE e.tenant_id = ? AND NOT EXISTS (
       SELECT 1 FROM memory_effect_events child
       WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
     ) ${outcomeSql} AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(
    tenantId,
    ...(effectOutcome ? [effectOutcome] : []),
    ...filter.bindings,
    scanLimit
  ).all<EffectEventRow>()).results;
}

async function queryEffectAclItems(
  db: D1Database,
  tenantId: string,
  usageEventIds: string[]
): Promise<EffectAclItemRow[]> {
  const ids = [...new Set(usageEventIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return (await db.prepare(
    `/* activity:effect-acl-items */
     WITH requested_usage_events(usage_event_id) AS (
       SELECT CAST(value AS TEXT) FROM json_each(?)
     )
     SELECT ui.usage_event_id, ui.source_type, ui.source_id,
            CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END AS memory_exists,
            m.permissions_json AS memory_permissions_json,
            CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS decision_exists,
            d.visibility AS decision_visibility,
            d.allowed_principals_json AS decision_allowed_principals_json
     FROM memory_usage_items ui
     JOIN requested_usage_events requested
       ON requested.usage_event_id = ui.usage_event_id
     LEFT JOIN memories m
       ON ui.source_type = 'memory'
      AND m.tenant_id = ui.tenant_id AND m.id = ui.source_id
     LEFT JOIN decision_memories d
       ON ui.source_type = 'decision_memory'
      AND d.tenant_id = ui.tenant_id AND d.id = ui.source_id
     WHERE ui.tenant_id = ?`
  ).bind(JSON.stringify(ids), tenantId).all<EffectAclItemRow>()).results;
}

async function queryRetrievalEvents(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<RetrievalEventRow[]> {
  const key = "('retrieval:' || e.id)";
  const filter = buildWindowFilter(options, "e.created_at", key, "e.project_id");
  return (await db.prepare(
    `/* activity:retrieval-events */
     SELECT ${key} AS event_key, e.id AS source_id, e.created_at AS occurred_at,
            e.project_id, e.task_id, e.capability, e.search_strategy,
            e.matched_count, e.returned_count, e.fallback_used, e.latency_ms
     FROM retrieval_events e
     WHERE e.tenant_id = ? AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, scanLimit).all<RetrievalEventRow>()).results;
}

async function queryRetrievalAttention(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions
): Promise<RetrievalEventRow[]> {
  const key = "('retrieval:' || e.id)";
  const filter = buildWindowFilter(options, "e.created_at", key, "e.project_id");
  return (await db.prepare(
    `/* activity:retrieval-attention */
     SELECT ${key} AS event_key, e.id AS source_id, e.created_at AS occurred_at,
            e.project_id, e.task_id, e.capability, e.search_strategy,
            e.matched_count, e.returned_count, e.fallback_used, e.latency_ms
     FROM retrieval_events e
     WHERE e.tenant_id = ?
       AND (e.matched_count = 0 OR e.fallback_used = 1)
       AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, 100).all<RetrievalEventRow>()).results;
}

async function queryMessageEvents(db: D1Database, tenantId: string, options: ParsedOptions, scanLimit: number): Promise<MessageEventRow[]> {
  if (!options.principal) return [];
  const key = "('handoff:' || m.id)";
  const filter = buildWindowFilter(options, "m.created_at", key, "m.project_id");
  return (await db.prepare(
    `/* activity:agent-messages */
     SELECT ${key} AS event_key, m.id AS source_id, m.created_at AS occurred_at,
            m.project_id, m.sender_principal, m.target_type, m.target_key, m.status
     FROM agent_messages m
     WHERE m.tenant_id = ?
       AND (m.sender_principal = ? OR (m.target_type = 'principal' AND m.target_key = ?))
       AND ${filter.sql}
     ORDER BY occurred_at ${filter.order}, event_key ${filter.order}
     LIMIT ?`
  ).bind(
    tenantId,
    options.principal,
    options.principal,
    ...filter.bindings,
    scanLimit
  ).all<MessageEventRow>()).results;
}

async function queryVisibleEventRows<T extends KeysetEventRow>(args: {
  options: ParsedOptions;
  visibleLimit: number;
  queryPage: (options: ParsedOptions, batchSize: number) => Promise<T[]>;
  filterPage: (rows: T[]) => Promise<T[]> | T[];
}): Promise<T[]> {
  const batchSize = Math.min(
    ACL_EVENT_SCAN_BATCH_MAX,
    Math.max(ACL_EVENT_SCAN_BATCH_MIN, args.visibleLimit)
  );
  const visible: T[] = [];
  let scanCursor = args.options.cursor;

  // ACL filtering happens after each bounded keyset page. Advancing with the
  // last raw row prevents a dense run of hidden records from crowding older
  // readable events out of the response while keeping response cursors and
  // has_more derived exclusively from readable events.
  while (visible.length < args.visibleLimit) {
    const rawRows = await args.queryPage({ ...args.options, cursor: scanCursor }, batchSize);
    if (rawRows.length === 0) break;

    const readableRows = await args.filterPage(rawRows);
    visible.push(...readableRows.slice(0, args.visibleLimit - visible.length));
    if (visible.length >= args.visibleLimit || rawRows.length < batchSize) break;

    const tail = rawRows[rawRows.length - 1]!;
    const nextCursor: Cursor = {
      v: 1,
      at: Number(tail.occurred_at),
      key: tail.event_key
    };
    if (scanCursor && scanCursor.at === nextCursor.at && scanCursor.key === nextCursor.key) {
      throw new Error("activity event keyset scan did not advance");
    }
    scanCursor = nextCursor;
  }

  return visible;
}

function compareEvents(left: ActivityEvent, right: ActivityEvent, direction: Direction): number {
  const ascending = left.occurred_at - right.occurred_at || left.id.localeCompare(right.id);
  return direction === "after" ? ascending : -ascending;
}

function eventPassesCursor(event: ActivityEvent, cursor: Cursor | null, direction: Direction): boolean {
  if (!cursor) return true;
  const comparison = event.occurred_at - cursor.at || event.id.localeCompare(cursor.key);
  return direction === "after" ? comparison > 0 : comparison < 0;
}

function mapTaskEvent(row: TaskEventRow): ActivityEvent {
  const failed = row.kind === "failed" || row.task_status === "failed" || row.task_status === "dead_letter";
  const label = row.capability || `Task ${row.task_id}`;
  const actor = row.kind === "created"
    ? namedActor({
      principal: row.created_by_principal,
      capability: row.capability
    })
    : systemActor("cap-runner", "Capability runner");
  return {
    id: row.event_key,
    type: `task.${row.kind.replaceAll("_", ".")}`,
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    actor,
    subject: { type: "task", id: row.task_id, label },
    target: null,
    severity: failed ? "critical" : "info",
    status: row.task_status,
    summary: failed ? `Task failed: ${label}` : `Task ${row.kind}: ${label}`,
    metadata: { capability: row.capability, event_kind: row.kind }
  };
}

function mapUsageEvent(row: UsageEventRow): ActivityEvent {
  const isDecision = row.source_type === "decision_memory";
  const actor = namedActor({
    principal: row.actor_principal || row.reporter_principal,
    name: row.agent_name,
    capability: row.capability
  });
  const label = isDecision ? row.decision_title || `Decision ${row.source_id}` : row.memory_label || `Memory ${row.source_id}`;
  return {
    id: row.event_key,
    type: "memory.read",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    actor,
    subject: { type: isDecision ? "decision" : "memory", id: row.source_id, label },
    target: row.task_id ? { type: "task", id: row.task_id, label: `Task ${row.task_id}` } : null,
    severity: "info",
    status: row.used_state,
    summary: `${actor.label} read ${label}`,
    metadata: {
      access_path: row.access_path,
      request_source: row.request_source,
      reference_type: row.reference_type,
      used_state: row.used_state,
      capability: row.capability,
      model: row.model
    }
  };
}

function mapMemoryVersion(row: MemoryVersionRow): ActivityEvent {
  const actor = namedActor({
    principal: row.actor_id,
    actorType: row.actor_type
  });
  const label = row.summary?.trim() || `Memory ${row.source_id}`;
  return {
    id: row.event_key,
    type: "memory.write",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: null,
    trace_id: null,
    actor,
    subject: { type: "memory", id: row.source_id, label },
    target: null,
    severity: row.lifecycle_state === "suppressed" ? "warning" : "info",
    status: row.lifecycle_state,
    summary: `${actor.label} performed ${row.operation} on ${label}`,
    metadata: {
      operation: row.operation,
      version: Number(row.version),
      memory_kind: row.kind,
      lifecycle_state: row.lifecycle_state
    }
  };
}

function mapDecisionVersion(row: DecisionVersionRow): ActivityEvent {
  const ref = actorRefs(row.actor_refs_json)[0];
  const actor = namedActor({
    principal: ref?.id,
    name: ref?.name,
    actorType: ref?.type
  });
  return {
    id: row.event_key,
    type: "decision.write",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: null,
    trace_id: null,
    actor,
    subject: { type: "decision", id: row.source_id, label: row.title },
    target: null,
    severity: row.status === "uncertain" || row.status === "deprecated" ? "warning" : "info",
    status: row.status,
    summary: `${actor.label} performed ${row.operation} on decision ${row.title}`,
    metadata: { operation: row.operation }
  };
}

function mapImpactEvent(row: ImpactEventRow): ActivityEvent {
  const actor = namedActor({
    principal: row.reporter_principal,
    name: row.agent_name,
    actorType: "agent"
  });
  const type = row.event_type === "eligible" ? "agent.run.started" : row.event_type === "assessed" ? "agent.run.completed" : "agent.run.failed";
  return {
    id: row.event_key,
    type,
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    actor,
    subject: { type: "agent_run", id: row.external_run_id, label: `Run ${row.external_run_id}` },
    target: row.task_id ? { type: "task", id: row.task_id, label: `Task ${row.task_id}` } : null,
    severity: row.event_type === "failed" ? "critical" : "info",
    status: row.event_type,
    summary: row.event_type === "failed" ? `${actor.label} run failed` : `${actor.label} run ${row.event_type === "eligible" ? "started" : "completed"}`,
    metadata: {
      model: row.model,
      memory_used: row.memory_used === null ? null : row.memory_used === 1,
      avoided_lookup: row.avoided_lookup,
      confidence: row.confidence
    }
  };
}

function mapEffectEvent(row: EffectEventRow): ActivityEvent {
  const actor = namedActor({
    principal: row.actor_principal || row.reporter_principal,
    name: row.agent_name,
    capability: row.capability
  });
  return {
    id: row.event_key,
    type: "memory.effect",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    actor,
    subject: { type: "memory_usage", id: row.source_id, label: `Memory usage ${row.source_id}` },
    target: row.task_id ? { type: "task", id: row.task_id, label: `Task ${row.task_id}` } : null,
    severity: row.effect_outcome === "negative" ? "critical" : row.effect_outcome === "unknown" ? "warning" : "info",
    status: row.effect_outcome,
    summary: `Memory effect reported as ${row.effect_outcome}`,
    metadata: {
      evidence_level: row.evidence_level,
      model: row.model,
      net_saved_tokens_estimate: Number(row.net_saved_tokens_estimate),
      failure_avoided: row.failure_avoided === 1
    }
  };
}

function mapRetrievalEvent(row: RetrievalEventRow): ActivityEvent {
  const warning = Number(row.matched_count) === 0 || row.fallback_used === 1;
  return {
    id: row.event_key,
    type: "memory.retrieval",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: row.task_id,
    trace_id: null,
    actor: capabilityActor(row.capability),
    subject: { type: "task", id: row.task_id, label: row.capability || `Task ${row.task_id}` },
    target: null,
    severity: warning ? "warning" : "info",
    status: warning ? "degraded" : "completed",
    summary: `${Number(row.returned_count)} memories returned for ${row.capability}`,
    metadata: {
      search_strategy: row.search_strategy,
      matched_count: Number(row.matched_count),
      returned_count: Number(row.returned_count),
      fallback_used: row.fallback_used === 1,
      latency_ms: Number(row.latency_ms)
    }
  };
}

function mapMessageEvent(row: MessageEventRow): ActivityEvent {
  const actor = namedActor({
    principal: row.sender_principal
  });
  return {
    id: row.event_key,
    type: "handoff.sent",
    occurred_at: Number(row.occurred_at),
    project_id: row.project_id,
    task_id: null,
    trace_id: null,
    actor,
    subject: { type: "handoff", id: row.source_id, label: "Agent handoff" },
    target: { type: row.target_type, id: row.target_key, label: row.target_key },
    severity: "info",
    status: row.status,
    summary: `${actor.label} sent a handoff to ${row.target_key}`,
    metadata: { target_type: row.target_type, status: row.status }
  };
}

async function filterUsageAclRows<T extends UsageAclRow>(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: T[],
  principal: string | null
): Promise<T[]> {
  const restrictedDecisionIds = rows
    .filter((row) => row.source_type === "decision_memory")
    .filter((row) => row.decision_exists === 1 && row.decision_visibility === "restricted")
    .filter((row) => !directDecisionReadable(row.decision_visibility, row.decision_allowed_principals_json, principal))
    .map((row) => row.source_id);
  const aclAllowed = await allowedRestrictedDecisionIds(env, tenantId, principal, restrictedDecisionIds);
  return rows.filter((row) => {
    if (row.source_type === "memory") {
      return row.memory_exists === 1 && stableResultReadable(row.memory_permissions_json, principal);
    }
    if (row.decision_exists !== 1) return false;
    return directDecisionReadable(row.decision_visibility, row.decision_allowed_principals_json, principal)
      || (row.decision_visibility === "restricted" && aclAllowed.has(row.source_id));
  });
}

async function filterUsageRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: UsageEventRow[],
  principal: string | null
): Promise<UsageEventRow[]> {
  return filterUsageAclRows(env, tenantId, rows, principal);
}

async function filterEffectRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: EffectEventRow[],
  principal: string | null
): Promise<EffectEventRow[]> {
  const items = await queryEffectAclItems(
    env.OPEN_BRAIN_DB,
    tenantId,
    rows.map((row) => row.usage_event_id)
  );
  const readableItems = await filterUsageAclRows(env, tenantId, items, principal);
  const itemCounts = new Map<string, number>();
  const readableItemCounts = new Map<string, number>();
  for (const item of items) {
    itemCounts.set(item.usage_event_id, (itemCounts.get(item.usage_event_id) ?? 0) + 1);
  }
  for (const item of readableItems) {
    readableItemCounts.set(
      item.usage_event_id,
      (readableItemCounts.get(item.usage_event_id) ?? 0) + 1
    );
  }
  return rows.filter((row) => {
    const itemCount = itemCounts.get(row.usage_event_id) ?? 0;
    return itemCount > 0 && readableItemCounts.get(row.usage_event_id) === itemCount;
  });
}

async function filterDecisionVersionRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: DecisionVersionRow[],
  principal: string | null
): Promise<DecisionVersionRow[]> {
  const restrictedIds = rows
    .filter((row) => row.visibility === "restricted")
    .filter((row) => !directDecisionReadable(row.visibility, row.allowed_principals_json, principal))
    .map((row) => row.source_id);
  const aclAllowed = await allowedRestrictedDecisionIds(env, tenantId, principal, restrictedIds);
  return rows.filter((row) =>
    directDecisionReadable(row.visibility, row.allowed_principals_json, principal)
    || (row.visibility === "restricted" && aclAllowed.has(row.source_id))
  );
}

async function queryVisibleUsageEvents(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  visibleLimit: number
): Promise<UsageEventRow[]> {
  return queryVisibleEventRows({
    options,
    visibleLimit,
    queryPage: (pageOptions, batchSize) =>
      queryUsageEvents(env.OPEN_BRAIN_DB, tenantId, pageOptions, batchSize),
    filterPage: (rows) => filterUsageRows(env, tenantId, rows, options.principal)
  });
}

async function queryVisibleEffectEvents(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  visibleLimit: number
): Promise<EffectEventRow[]> {
  return queryVisibleEventRows({
    options,
    visibleLimit,
    queryPage: (pageOptions, batchSize) =>
      queryEffectEvents(env.OPEN_BRAIN_DB, tenantId, pageOptions, batchSize),
    filterPage: (rows) => filterEffectRows(env, tenantId, rows, options.principal)
  });
}

async function queryVisibleNegativeEffectAttention(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<EffectEventRow[]> {
  return queryVisibleEventRows({
    options,
    visibleLimit: 100,
    queryPage: (pageOptions, batchSize) =>
      queryEffectEvents(env.OPEN_BRAIN_DB, tenantId, pageOptions, batchSize, "negative"),
    filterPage: (rows) => filterEffectRows(env, tenantId, rows, options.principal)
  });
}

async function queryVisibleMemoryVersions(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  visibleLimit: number
): Promise<MemoryVersionRow[]> {
  return queryVisibleEventRows({
    options,
    visibleLimit,
    queryPage: (pageOptions, batchSize) =>
      queryMemoryVersions(env.OPEN_BRAIN_DB, tenantId, pageOptions, batchSize),
    filterPage: (rows) => rows.filter((row) =>
      stableResultReadable(row.permissions_json, options.principal)
    )
  });
}

async function queryVisibleDecisionVersions(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  visibleLimit: number
): Promise<DecisionVersionRow[]> {
  return queryVisibleEventRows({
    options,
    visibleLimit,
    queryPage: (pageOptions, batchSize) =>
      queryDecisionVersions(env.OPEN_BRAIN_DB, tenantId, pageOptions, batchSize),
    filterPage: (rows) => filterDecisionVersionRows(env, tenantId, rows, options.principal)
  });
}

async function queryObservedAgents(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<ObservedAgentRow[]> {
  const authz = options.principal
    ? await buildAuthzContext(env as Env, tenantId, options.principal)
    : null;
  const subjects = authz?.subjects ?? [];
  const bindings: unknown[] = [
    tenantId,
    options.projectId,
    options.from,
    options.to,
    options.principal,
    JSON.stringify(subjects.map((subject) => ({
      subject_type: subject.subjectType,
      subject_id: subject.subjectId
    })))
  ];
  const usageProjectSql = options.projectId ? "AND usage.project_id = p.project_id" : "";
  const impactProjectSql = options.projectId ? "AND impact.project_id = p.project_id" : "";
  const memoryProjectSql = options.projectId ? "AND memory.project_id = p.project_id" : "";
  const taskProjectSql = options.projectId ? "AND task.project_id = p.project_id" : "";
  const decisionAllowedJson = `CASE
    WHEN decision.allowed_principals_json IS NULL OR decision.allowed_principals_json = '' THEN '[]'
    WHEN json_valid(decision.allowed_principals_json) = 0 THEN '[]'
    WHEN json_type(decision.allowed_principals_json) != 'array' THEN '[]'
    ELSE decision.allowed_principals_json
  END`;
  const memoryReadableSql = `CASE
    WHEN memory.id IS NULL THEN 0
    WHEN memory.permissions_json IS NULL OR memory.permissions_json = '' THEN 1
    WHEN json_valid(memory.permissions_json) = 0 THEN 0
    WHEN json_type(memory.permissions_json) != 'array' THEN 1
    WHEN json_array_length(memory.permissions_json) = 0 THEN 1
    WHEN p.principal IS NULL THEN 0
    ELSE EXISTS (
      SELECT 1
      FROM json_each(memory.permissions_json) permission_entry
      WHERE json_extract(
              CASE WHEN permission_entry.type = 'object' THEN permission_entry.value ELSE '{}' END,
              '$.principal_type'
            ) = 'principal'
        AND json_extract(
              CASE WHEN permission_entry.type = 'object' THEN permission_entry.value ELSE '{}' END,
              '$.principal_id'
            ) = p.principal
        AND EXISTS (
          SELECT 1
          FROM json_each(
            CASE WHEN permission_entry.type = 'object' THEN
              CASE WHEN json_type(permission_entry.value, '$.permissions') = 'array'
                THEN json_extract(permission_entry.value, '$.permissions')
                ELSE '[]'
              END
            ELSE '[]' END
          ) permission_value
          WHERE permission_value.value = 'read'
        )
    )
  END = 1`;
  const decisionReadableSql = `decision.id IS NOT NULL AND (
    ((decision.visibility IS NULL OR decision.visibility != 'restricted')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(${decisionAllowedJson}) allowed
        WHERE allowed.type = 'text'
      ))
    OR (p.principal IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(${decisionAllowedJson}) allowed
      WHERE allowed.type = 'text' AND allowed.value IN (
        p.principal,
        'user:' || p.principal,
        'agent:' || p.principal
      )
    ))
    OR (decision.visibility = 'restricted' AND EXISTS (
      SELECT 1
      FROM resource_acl acl
      JOIN authz_subjects subject
        ON subject.subject_type = acl.subject_type
       AND subject.subject_id = acl.subject_id
      WHERE acl.tenant_id = p.tenant_id
        AND acl.resource_type = 'decision_memory'
        AND acl.resource_id = decision.id
        AND acl.permission = 'read'
    ))
  )`;

  return (await env.OPEN_BRAIN_DB.prepare(
    `/* activity:observed-agents */
     WITH params AS (
       SELECT ? AS tenant_id, ? AS project_id, ? AS from_at, ? AS to_at, ? AS principal
     ),
     authz_subjects(subject_type, subject_id) AS (
       SELECT json_extract(value, '$.subject_type'),
              json_extract(value, '$.subject_id')
       FROM json_each(?)
     ),
     visible_usage_events AS (
       SELECT DISTINCT
              usage.id AS observation_key,
              COALESCE(NULLIF(TRIM(usage.actor_principal), ''),
                       NULLIF(TRIM(identity.reporter_principal), '')) AS principal,
              NULLIF(TRIM(identity.agent_name), '') AS agent_name,
              NULLIF(TRIM(identity.model), '') AS model,
              usage.created_at AS occurred_at,
              usage.task_id,
              1 AS read_count,
              0 AS write_count,
              0 AS failure_count,
              4 AS source_rank
       FROM memory_usage_events usage
       JOIN memory_usage_items item
         ON item.tenant_id = usage.tenant_id AND item.usage_event_id = usage.id
       LEFT JOIN memories memory
         ON item.source_type = 'memory'
        AND memory.tenant_id = item.tenant_id AND memory.id = item.source_id
       LEFT JOIN decision_memories decision
         ON item.source_type = 'decision_memory'
        AND decision.tenant_id = item.tenant_id AND decision.id = item.source_id
       LEFT JOIN memory_impact_events identity
         ON identity.tenant_id = usage.tenant_id
        AND identity.external_run_id = usage.external_run_id
        AND identity.event_type = 'eligible'
       CROSS JOIN params p
       WHERE usage.tenant_id = p.tenant_id
         AND usage.created_at >= p.from_at AND usage.created_at <= p.to_at
         ${usageProjectSql}
         AND ((item.source_type = 'memory' AND ${memoryReadableSql})
           OR (item.source_type = 'decision_memory' AND ${decisionReadableSql}))
     ),
     observations AS (
       SELECT * FROM visible_usage_events
       UNION ALL
       SELECT impact.id, NULLIF(TRIM(impact.reporter_principal), ''),
              NULLIF(TRIM(impact.agent_name), ''), NULLIF(TRIM(impact.model), ''),
              impact.occurred_at, impact.task_id, 0, 0,
              CASE WHEN impact.event_type = 'failed' THEN 1 ELSE 0 END, 3
       FROM memory_impact_events impact
       CROSS JOIN params p
       WHERE impact.tenant_id = p.tenant_id
         AND impact.occurred_at >= p.from_at AND impact.occurred_at <= p.to_at
         ${impactProjectSql}
       UNION ALL
       SELECT version.id, NULLIF(TRIM(version.actor_id), ''), NULL, NULL,
              version.created_at, NULL, 0, 1, 0, 2
       FROM memory_versions version
       JOIN memories memory
         ON memory.tenant_id = version.tenant_id AND memory.id = version.memory_id
       CROSS JOIN params p
       WHERE version.tenant_id = p.tenant_id
         AND version.created_at >= p.from_at AND version.created_at <= p.to_at
         ${memoryProjectSql}
         AND ${memoryReadableSql}
       UNION ALL
       SELECT event.id, NULLIF(TRIM(task.created_by_principal), ''), NULL, NULL,
              event.created_at, task.id, 0, 0, 0, 1
       FROM task_events event
       JOIN tasks task ON task.tenant_id = event.tenant_id AND task.id = event.task_id
       CROSS JOIN params p
       WHERE event.tenant_id = p.tenant_id AND event.kind = 'created'
         AND event.created_at >= p.from_at AND event.created_at <= p.to_at
         ${taskProjectSql}
     ),
     eligible_observations AS (
       SELECT observation.*,
              CASE WHEN task.status IN ('created', 'queued', 'running')
                   THEN observation.task_id ELSE NULL END AS active_task_id
       FROM observations observation
       CROSS JOIN params p
       LEFT JOIN tasks task
         ON task.tenant_id = p.tenant_id AND task.id = observation.task_id
       WHERE observation.principal IS NOT NULL
         AND (substr(observation.principal, 1, 6) = 'agent:' OR observation.agent_name IS NOT NULL)
     ),
     aggregates AS (
       SELECT principal AS reporter_principal,
              MAX(occurred_at) AS last_seen_at,
              COUNT(DISTINCT active_task_id) AS active_task_count,
              SUM(read_count) AS read_count,
              SUM(write_count) AS write_count,
              SUM(failure_count) AS failure_count
       FROM eligible_observations
       GROUP BY principal
     ),
     ranked_names AS (
       SELECT principal, agent_name,
              ROW_NUMBER() OVER (
                PARTITION BY principal
                ORDER BY occurred_at DESC, source_rank DESC, observation_key DESC
              ) AS rank
       FROM eligible_observations
       WHERE agent_name IS NOT NULL
     ),
     ranked_models AS (
       SELECT principal, model,
              ROW_NUMBER() OVER (
                PARTITION BY principal
                ORDER BY occurred_at DESC, source_rank DESC, observation_key DESC
              ) AS rank
       FROM eligible_observations
       WHERE model IS NOT NULL
     )
     SELECT aggregate.reporter_principal, name.agent_name, model.model,
            aggregate.last_seen_at, aggregate.active_task_count,
            aggregate.read_count, aggregate.write_count, aggregate.failure_count
     FROM aggregates aggregate
     LEFT JOIN ranked_names name
       ON name.principal = aggregate.reporter_principal AND name.rank = 1
     LEFT JOIN ranked_models model
       ON model.principal = aggregate.reporter_principal AND model.rank = 1
     ORDER BY aggregate.last_seen_at DESC, aggregate.reporter_principal ASC
     LIMIT 100`
  ).bind(...bindings).all<ObservedAgentRow>()).results;
}

async function queryTaskAttention(db: D1Database, tenantId: string, options: ParsedOptions): Promise<TaskAttentionRow[]> {
  const projectSql = options.projectId ? "AND project_id = ?" : "";
  const bindings: unknown[] = [tenantId, options.now - STALLED_TASK_MS, options.from, options.to];
  if (options.projectId) bindings.push(options.projectId);
  return (await db.prepare(
    `/* activity:task-attention */
     SELECT id, project_id, capability, status, updated_at
     FROM tasks
     WHERE tenant_id = ? AND (
       (status IN ('created', 'queued', 'running') AND updated_at <= ?)
       OR (status IN ('failed', 'dead_letter') AND updated_at >= ? AND updated_at <= ?)
     ) ${projectSql}
     ORDER BY updated_at DESC LIMIT 100`
  ).bind(...bindings).all<TaskAttentionRow>()).results;
}

async function queryMessageAttention(db: D1Database, tenantId: string, options: ParsedOptions): Promise<MessageAttentionRow[]> {
  if (!options.principal) return [];
  const projectSql = options.projectId ? "AND project_id = ?" : "";
  const bindings: unknown[] = [
    tenantId,
    options.principal,
    options.principal,
    options.from,
    options.now - UNACKED_HANDOFF_MS
  ];
  if (options.projectId) bindings.push(options.projectId);
  return (await db.prepare(
    `/* activity:message-attention */
     SELECT id, project_id, sender_principal, target_type, target_key, status, created_at
     FROM agent_messages
     WHERE tenant_id = ?
       AND (sender_principal = ? OR (target_type = 'principal' AND target_key = ?))
       AND status IN ('unread', 'read') AND created_at >= ? AND created_at <= ? ${projectSql}
     ORDER BY created_at ASC LIMIT 100`
  ).bind(...bindings).all<MessageAttentionRow>()).results;
}

async function queryImpactAttention(db: D1Database, tenantId: string, options: ParsedOptions): Promise<ImpactAttentionRow[]> {
  const projectSql = options.projectId ? "AND eligible.project_id = ?" : "";
  const bindings: unknown[] = [tenantId, options.from, options.now - UNREPORTED_IMPACT_MS];
  if (options.projectId) bindings.push(options.projectId);
  return (await db.prepare(
    `/* activity:impact-attention */
     SELECT eligible.id, eligible.external_run_id, eligible.project_id, eligible.occurred_at
     FROM memory_impact_events eligible
     WHERE eligible.tenant_id = ? AND eligible.event_type = 'eligible'
       AND eligible.occurred_at >= ? AND eligible.occurred_at <= ? ${projectSql}
       AND NOT EXISTS (
         SELECT 1 FROM memory_impact_events terminal
         WHERE terminal.tenant_id = eligible.tenant_id
           AND terminal.external_run_id = eligible.external_run_id
           AND terminal.event_type IN ('assessed', 'failed')
       )
     ORDER BY eligible.occurred_at ASC LIMIT 100`
  ).bind(...bindings).all<ImpactAttentionRow>()).results;
}

async function queryAclFilteredAuxiliaryRows<T, TCursor>(args: {
  visibleLimit: number | null;
  queryPage: (cursor: TCursor | null, batchSize: number) => Promise<T[]>;
  filterPage: (rows: T[]) => Promise<T[]> | T[];
  cursorFromRow: (row: T) => TCursor;
}): Promise<T[]> {
  const visible: T[] = [];
  let cursor: TCursor | null = null;
  let cursorSignature: string | null = null;

  while (args.visibleLimit === null || visible.length < args.visibleLimit) {
    const rawRows = await args.queryPage(cursor, AUXILIARY_ACL_SCAN_BATCH);
    if (rawRows.length === 0) break;

    const readableRows = await args.filterPage(rawRows);
    const remaining = args.visibleLimit === null
      ? readableRows.length
      : Math.max(0, args.visibleLimit - visible.length);
    visible.push(...readableRows.slice(0, remaining));
    if (args.visibleLimit !== null && visible.length >= args.visibleLimit) break;
    if (rawRows.length < AUXILIARY_ACL_SCAN_BATCH) break;

    const nextCursor = args.cursorFromRow(rawRows[rawRows.length - 1]!);
    const nextSignature = JSON.stringify(nextCursor);
    if (cursorSignature === nextSignature) {
      throw new Error("activity auxiliary keyset scan did not advance");
    }
    cursor = nextCursor;
    cursorSignature = nextSignature;
  }

  return visible;
}

async function queryDormantMemoryPage(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions,
  cursor: DormantMemoryCursor | null,
  pageSize: number
): Promise<DormantMemoryRow[]> {
  const projectSql = options.projectId ? "AND project_id = ?" : "";
  const bindings: unknown[] = [tenantId, options.now - DORMANT_MEMORY_MS];
  if (options.projectId) bindings.push(options.projectId);
  const lastActivity = "COALESCE(last_accessed_at, updated_at, created_at)";
  const cursorSql = cursor
    ? `AND /* activity:dormant-cursor */ (
         utility_score < ? OR (utility_score = ? AND (
           ${lastActivity} > ? OR (${lastActivity} = ? AND id > ?)
         ))
       )`
    : "";
  if (cursor) {
    bindings.push(
      cursor.utilityScore,
      cursor.utilityScore,
      cursor.lastActivityAt,
      cursor.lastActivityAt,
      cursor.id
    );
  }
  bindings.push(pageSize);
  return (await db.prepare(
    `/* activity:dormant-memories */
     SELECT id, project_id, COALESCE(summary, 'Memory ' || id) AS label,
            utility_score, ${lastActivity} AS last_activity_at,
            permissions_json
     FROM memories
     WHERE tenant_id = ? AND lifecycle_state = 'active' AND utility_score >= 0.8
       AND ${lastActivity} <= ? ${projectSql} ${cursorSql}
     ORDER BY utility_score DESC, last_activity_at ASC, id ASC
     LIMIT ?`
  ).bind(...bindings).all<DormantMemoryRow>()).results;
}

async function queryVisibleDormantMemories(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions
): Promise<DormantMemoryRow[]> {
  return queryAclFilteredAuxiliaryRows<DormantMemoryRow, DormantMemoryCursor>({
    visibleLimit: MEMORY_ATTENTION_OUTPUT_LIMIT,
    queryPage: (cursor, batchSize) =>
      queryDormantMemoryPage(db, tenantId, options, cursor, batchSize),
    filterPage: (rows) => rows.filter((row) =>
      stableResultReadable(row.permissions_json, options.principal)
    ),
    cursorFromRow: (row) => ({
      utilityScore: Number(row.utility_score),
      lastActivityAt: Number(row.last_activity_at),
      id: row.id
    })
  });
}

async function queryExpiredMemoryPage(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions,
  cursor: ExpiredMemoryCursor | null,
  pageSize: number
): Promise<ExpiredMemoryRow[]> {
  const projectSql = options.projectId ? "AND project_id = ?" : "";
  const bindings: unknown[] = [tenantId, options.now];
  if (options.projectId) bindings.push(options.projectId);
  const cursorSql = cursor
    ? "AND /* activity:expired-cursor */ (valid_until < ? OR (valid_until = ? AND id > ?))"
    : "";
  if (cursor) bindings.push(cursor.validUntil, cursor.validUntil, cursor.id);
  bindings.push(pageSize);
  return (await db.prepare(
    `/* activity:expired-memories */
     SELECT id, project_id, COALESCE(summary, 'Memory ' || id) AS label,
            valid_until, permissions_json
     FROM memories
     WHERE tenant_id = ? AND valid_until IS NOT NULL AND valid_until <= ?
       AND lifecycle_state != 'suppressed' ${projectSql} ${cursorSql}
     ORDER BY valid_until DESC, id ASC
     LIMIT ?`
  ).bind(...bindings).all<ExpiredMemoryRow>()).results;
}

async function queryVisibleExpiredMemories(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions
): Promise<ExpiredMemoryRow[]> {
  return queryAclFilteredAuxiliaryRows<ExpiredMemoryRow, ExpiredMemoryCursor>({
    visibleLimit: MEMORY_ATTENTION_OUTPUT_LIMIT,
    queryPage: (cursor, batchSize) =>
      queryExpiredMemoryPage(db, tenantId, options, cursor, batchSize),
    filterPage: (rows) => rows.filter((row) =>
      stableResultReadable(row.permissions_json, options.principal)
    ),
    cursorFromRow: (row) => ({ validUntil: Number(row.valid_until), id: row.id })
  });
}

async function queryDecisionConflictPage(
  db: D1Database,
  tenantId: string,
  options: ParsedOptions,
  cursor: DecisionConflictCursor | null,
  pageSize: number
): Promise<DecisionConflictRow[]> {
  const projectSql = options.projectId ? "AND (project_id = ? OR project_id IS NULL)" : "";
  const bindings: unknown[] = [tenantId];
  if (options.projectId) bindings.push(options.projectId);
  const cursorSql = cursor
    ? "AND /* activity:decision-conflict-cursor */ (updated_at < ? OR (updated_at = ? AND id < ?))"
    : "";
  if (cursor) bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  bindings.push(pageSize);
  return (await db.prepare(
    `/* activity:decision-conflicts */
     SELECT id, title, project_id, status, superseded_by, valid_until,
            visibility, allowed_principals_json, updated_at
     FROM decision_memories
     WHERE tenant_id = ? ${projectSql} ${cursorSql}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`
  ).bind(...bindings).all<DecisionConflictRow>()).results;
}

async function filterDecisionConflictRows(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: DecisionConflictRow[],
  principal: string | null
): Promise<DecisionConflictRow[]> {
  const directIds = new Set(rows.filter((row) =>
    directDecisionReadable(row.visibility, row.allowed_principals_json, principal)
  ).map((row) => row.id));
  const restrictedIds = rows
    .filter((row) => row.visibility === "restricted" && !directIds.has(row.id))
    .map((row) => row.id);
  const aclIds = await allowedRestrictedDecisionIds(env, tenantId, principal, restrictedIds);
  return rows.filter((row) => directIds.has(row.id) || aclIds.has(row.id));
}

async function queryVisibleDecisionConflictCandidates(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<DecisionConflictRow[]> {
  return queryAclFilteredAuxiliaryRows<DecisionConflictRow, DecisionConflictCursor>({
    // A conflict may pair a recent decision with an arbitrarily old readable
    // revision. Exhaust the keyset so hidden decisions cannot crowd that pair
    // out before the 25-signal response cap is applied.
    visibleLimit: null,
    queryPage: (cursor, batchSize) =>
      queryDecisionConflictPage(env.OPEN_BRAIN_DB, tenantId, options, cursor, batchSize),
    filterPage: (rows) => filterDecisionConflictRows(
      env,
      tenantId,
      rows,
      options.principal
    ),
    cursorFromRow: (row) => ({ updatedAt: Number(row.updated_at), id: row.id })
  });
}

function safeDecisionTitle(value: string): string {
  const title = value.replace(/\s+/gu, " ").trim();
  if (!title) return "Untitled decision";
  return title.length <= 160 ? title : `${title.slice(0, 159)}…`;
}

function normalizedDecisionStatus(value: string): "active" | "deprecated" | "superseded" | "uncertain" {
  return value === "deprecated" || value === "superseded" || value === "uncertain" ? value : "active";
}

function decisionConflictAttention(rows: DecisionConflictRow[], now: number): ActivityAttention[] {
  const byTopic = new Map<string, DecisionConflictRow[]>();
  for (const row of rows) {
    const topic = normalizeDecisionTopic(row.title);
    if (!topic) continue;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), row]);
  }
  const attention: ActivityAttention[] = [];
  for (const [topic, items] of [...byTopic.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (items.length < 2) continue;
    const hasInactive = items.some((item) =>
      normalizedDecisionStatus(item.status) !== "active" ||
      Boolean(item.superseded_by) ||
      Boolean(item.valid_until && item.valid_until < now)
    );
    const active = items
      .filter((item) =>
        normalizedDecisionStatus(item.status) === "active"
        && !item.superseded_by
        && (!item.valid_until || item.valid_until >= now)
      )
      .sort((left, right) => right.updated_at - left.updated_at || left.id.localeCompare(right.id));
    const hasSimultaneousCurrent = active.length >= 2;
    if ((!hasInactive && !hasSimultaneousCurrent) || active.length === 0) continue;
    const preferred = active[0]!;
    attention.push({
      id: `attention:decision:${preferred.id}:conflict`,
      kind: "decision_conflict",
      severity: hasSimultaneousCurrent ? "critical" : "warning",
      detected_at: now,
      subject_type: "decision_memory",
      subject_id: preferred.id,
      reason: hasSimultaneousCurrent
        ? `Decision topic "${safeDecisionTitle(preferred.title)}" has multiple simultaneous current active records.`
        : `Decision topic "${safeDecisionTitle(preferred.title)}" has active/current and inactive, superseded, or expired records.`
    });
    if (attention.length >= DECISION_CONFLICT_OUTPUT_LIMIT) break;
  }
  return attention;
}

function buildAttention(args: {
  tasks: TaskAttentionRow[];
  messages: MessageAttentionRow[];
  impacts: ImpactAttentionRow[];
  retrievals: RetrievalEventRow[];
  effects: EffectEventRow[];
  dormantMemories: DormantMemoryRow[];
  expiredMemories: ExpiredMemoryRow[];
  decisionConflicts: DecisionConflictRow[];
  now: number;
}): ActivityAttention[] {
  const attention: ActivityAttention[] = [];
  for (const task of args.tasks) {
    const failed = task.status === "failed" || task.status === "dead_letter";
    attention.push({
      id: `attention:task:${task.id}:${failed ? "failed" : "stalled"}`,
      kind: failed ? "task_failed" : "task_stalled",
      severity: failed ? "critical" : "warning",
      detected_at: failed ? Number(task.updated_at) : args.now,
      subject_type: "task",
      subject_id: task.id,
      reason: failed ? `Task failed: ${task.capability}` : `Task has not changed for at least 30 minutes: ${task.capability}`
    });
  }
  for (const message of args.messages) {
    attention.push({
      id: `attention:handoff:${message.id}`,
      kind: "handoff_unacked",
      severity: "warning",
      detected_at: args.now,
      subject_type: "handoff",
      subject_id: message.id,
      reason: `Handoff to ${message.target_key} has not been acknowledged for at least 30 minutes`
    });
  }
  for (const impact of args.impacts) {
    attention.push({
      id: `attention:impact:${impact.id}`,
      kind: "impact_unreported",
      severity: "warning",
      detected_at: args.now,
      subject_type: "agent_run",
      subject_id: impact.external_run_id,
      reason: "Agent run has no terminal memory-impact report after 30 minutes"
    });
  }
  for (const retrieval of args.retrievals) {
    if (Number(retrieval.matched_count) > 0 && retrieval.fallback_used !== 1) continue;
    attention.push({
      id: `attention:retrieval:${retrieval.source_id}`,
      kind: "retrieval_miss",
      severity: "warning",
      detected_at: Number(retrieval.occurred_at),
      subject_type: "task",
      subject_id: retrieval.task_id,
      reason: retrieval.fallback_used === 1 ? "Memory retrieval required fallback" : "Memory retrieval returned no matches"
    });
  }
  for (const effect of args.effects) {
    if (effect.effect_outcome !== "negative") continue;
    attention.push({
      id: `attention:effect:${effect.source_id}`,
      kind: "negative_memory_effect",
      severity: "critical",
      detected_at: Number(effect.occurred_at),
      subject_type: "memory_usage",
      subject_id: effect.source_id,
      reason: "A negative memory effect was reported"
    });
  }
  for (const memory of args.dormantMemories) {
    attention.push({
      id: `attention:memory:${memory.id}:dormant`,
      kind: "memory_dormant",
      severity: "warning",
      detected_at: args.now,
      subject_type: "memory",
      subject_id: memory.id,
      reason: `High-utility memory has not been accessed for at least 30 days: ${memory.label}`
    });
  }
  for (const memory of args.expiredMemories) {
    attention.push({
      id: `attention:memory:${memory.id}:expired`,
      kind: "memory_expired",
      severity: "warning",
      detected_at: args.now,
      subject_type: "memory",
      subject_id: memory.id,
      reason: `Memory validity expired at ${memory.valid_until}: ${memory.label}`
    });
  }
  attention.push(...decisionConflictAttention(args.decisionConflicts, args.now));
  const severity = { critical: 0, warning: 1 } as const;
  return attention
    .sort((left, right) => severity[left.severity] - severity[right.severity] || right.detected_at - left.detected_at || left.id.localeCompare(right.id))
    .slice(0, 100);
}

function buildObservedAgents(rows: ObservedAgentRow[]): ObservedAgent[] {
  return rows.map((row) => {
    const id = row.reporter_principal;
    return {
      id,
      label: row.agent_name?.trim() || id,
      model: row.model?.trim() || null,
      // Presence is deliberately not inferred. Every row was observed inside
      // the caller's requested window, so its only supported state is active.
      state: "active",
      last_seen_at: Number(row.last_seen_at),
      active_task_count: Number(row.active_task_count ?? 0),
      read_count: Number(row.read_count ?? 0),
      write_count: Number(row.write_count ?? 0),
      failure_count: Number(row.failure_count ?? 0)
    };
  });
}

export async function getActivityDashboard(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rawOptions: ActivityDashboardOptions = {}
): Promise<ActivityDashboardResponse> {
  const normalizedTenant = tenantId.trim();
  if (!normalizedTenant) throw new HttpError(400, "invalid_tenant_id", "tenant_id must not be empty");
  const options = parseOptions(rawOptions);
  const scanLimit = Math.min(1_000, options.limit * 3 + 1);
  const visibleEventScanLimit = options.limit + 1;
  const attentionOptions: ParsedOptions = { ...options, cursor: null, direction: "before" };

  const [
      taskRows,
      usageRows,
      visibleMemoryVersions,
      decisionVersionRows,
      impactRows,
      effectRows,
      retrievalRows,
      messageRows,
      taskAttentionRows,
      messageAttentionRows,
      impactAttentionRows,
      retrievalAttentionRows,
      negativeEffectAttentionRows,
      dormantMemoryRows,
      expiredMemoryRows,
      decisionConflictRows,
      observedAgentRows
  ] = await Promise.all([
      queryTaskEvents(env.OPEN_BRAIN_DB, normalizedTenant, options, scanLimit),
      queryVisibleUsageEvents(env, normalizedTenant, options, visibleEventScanLimit),
      queryVisibleMemoryVersions(env, normalizedTenant, options, visibleEventScanLimit),
      queryVisibleDecisionVersions(env, normalizedTenant, options, visibleEventScanLimit),
      queryImpactEvents(env.OPEN_BRAIN_DB, normalizedTenant, options, scanLimit),
      queryVisibleEffectEvents(env, normalizedTenant, options, scanLimit),
      queryRetrievalEvents(env.OPEN_BRAIN_DB, normalizedTenant, options, scanLimit),
      queryMessageEvents(env.OPEN_BRAIN_DB, normalizedTenant, options, scanLimit),
      queryTaskAttention(env.OPEN_BRAIN_DB, normalizedTenant, options),
      queryMessageAttention(env.OPEN_BRAIN_DB, normalizedTenant, options),
      queryImpactAttention(env.OPEN_BRAIN_DB, normalizedTenant, options),
      queryRetrievalAttention(env.OPEN_BRAIN_DB, normalizedTenant, attentionOptions),
      queryVisibleNegativeEffectAttention(env, normalizedTenant, attentionOptions),
      queryVisibleDormantMemories(env.OPEN_BRAIN_DB, normalizedTenant, options),
      queryVisibleExpiredMemories(env.OPEN_BRAIN_DB, normalizedTenant, options),
      queryVisibleDecisionConflictCandidates(env, normalizedTenant, options),
      // Timeline cursors do not narrow this SQL-side aggregate. It describes
      // the complete requested window while returning only 100 grouped rows.
      queryObservedAgents(env, normalizedTenant, options)
  ]);

  const candidates = [
    ...taskRows.map(mapTaskEvent),
    ...usageRows.map(mapUsageEvent),
    ...visibleMemoryVersions.map(mapMemoryVersion),
    ...decisionVersionRows.map(mapDecisionVersion),
    ...impactRows.map(mapImpactEvent),
    ...effectRows.map(mapEffectEvent),
    ...retrievalRows.map(mapRetrievalEvent),
    ...messageRows.map(mapMessageEvent)
  ]
    .filter((event) => eventPassesCursor(event, options.cursor, options.direction))
    .sort((left, right) => compareEvents(left, right, options.direction));
  const events = candidates.slice(0, options.limit);
  const oldest = [...events].sort((left, right) => left.occurred_at - right.occurred_at || left.id.localeCompare(right.id))[0];
  const newest = [...events].sort((left, right) => right.occurred_at - left.occurred_at || right.id.localeCompare(left.id))[0];

  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    events,
    observed_agents: buildObservedAgents(observedAgentRows),
    attention: buildAttention({
      tasks: taskAttentionRows,
      messages: messageAttentionRows,
      impacts: impactAttentionRows,
      retrievals: retrievalAttentionRows,
      effects: negativeEffectAttentionRows,
      dormantMemories: dormantMemoryRows,
      expiredMemories: expiredMemoryRows,
      decisionConflicts: decisionConflictRows,
      now: options.now
    }),
    oldest_cursor: oldest ? encodeActivityCursor(oldest) : null,
    newest_cursor: newest ? encodeActivityCursor(newest) : null,
    has_more: candidates.length > options.limit,
    generated_at: options.now
  };
}
