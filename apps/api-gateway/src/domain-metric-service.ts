import {
  dashboardDefinitionSchema,
  decisionDomainLinkSchema,
  managedObjectSchema,
  managedObjectTypeSchema,
  metricDefinitionSchema,
  metricSourceBindingSchema,
  metricSnapshotSchema,
  type MetricDefinitionV1,
  type MetricSourceBindingV1
} from "@org-brain/contracts";
import { canonicalJson, evaluateMetricFormula } from "@org-brain/core";
import { HttpError, sha256, ulid } from "@org-brain/shared";
import { z } from "zod";
import type { Env } from "./types";

type DefinitionRow = {
  id: string;
  tenant_id: string;
  metric_key: string;
  current_version: number;
  origin_type: "pack" | "custom";
  origin_pack_id: string | null;
  origin_pack_version: string | null;
  promoted_release_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  definition_json: string;
};

export type MetricSnapshotQueryRow = {
  id: string;
  metric_key: string;
  binding_id: string | null;
  source_binding_id: string | null;
  value: number | null;
  state: "measured" | "stale" | "unknown";
  freshness: "measured" | "stale" | "unknown";
  dimensions: Record<string, string>;
  observed_at: number;
  expires_at: number;
  evidence_ref: string | null;
  query_digest: string | null;
  recorded_by: string;
  created_at: number;
};

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function parseSchema<S extends { parse(raw: unknown): unknown }>(schema: S, raw: unknown): ReturnType<S["parse"]> {
  const parsed = (schema as unknown as { safeParse(value: unknown): { success: true; data: ReturnType<S["parse"]> } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } }).safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_payload", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function withoutTransportFields(raw: unknown): Record<string, unknown> {
  const body = { ...record(raw) };
  delete body.tenant_id;
  delete body.id;
  return body;
}

export function assertMetricsReadable(env: Env) {
  if (env.DOMAIN_METRICS_MODE === "off") {
    throw new HttpError(404, "domain_metrics_disabled", "domain metrics are disabled");
  }
}

export function assertMetricsWritable(env: Env) {
  assertMetricsReadable(env);
  if (env.DOMAIN_METRICS_MODE === "shadow") {
    throw new HttpError(409, "domain_metrics_shadow", "domain metrics are running in read-only shadow mode");
  }
}

async function definitionRow(env: Env, tenantId: string, definitionId: string): Promise<DefinitionRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.*, v.definition_json
     FROM metric_definitions d
     JOIN metric_definition_versions v
       ON v.metric_definition_id = d.id AND v.version = d.current_version
     WHERE d.tenant_id = ? AND d.id = ?`
  ).bind(tenantId, definitionId).first<DefinitionRow>();
  if (!row) throw new HttpError(404, "metric_definition_not_found", "metric definition not found");
  return row;
}

async function definitionByKey(env: Env, tenantId: string, metricKey: string): Promise<DefinitionRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.*, v.definition_json
     FROM metric_definitions d
     JOIN metric_definition_versions v
       ON v.metric_definition_id = d.id AND v.version = d.current_version
     WHERE d.tenant_id = ? AND d.metric_key = ?`
  ).bind(tenantId, metricKey).first<DefinitionRow>();
  if (!row) throw new HttpError(404, "metric_definition_not_found", `metric definition not found: ${metricKey}`);
  return row;
}

function definitionResponse(row: DefinitionRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    current_version: row.current_version,
    origin_type: row.origin_type,
    origin_pack_id: row.origin_pack_id,
    origin_pack_version: row.origin_pack_version,
    promoted_release_id: row.promoted_release_id,
    definition: JSON.parse(row.definition_json),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function createMetricDefinition(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const body = withoutTransportFields(raw);
  const definition = parseSchema(metricDefinitionSchema, { ...body, origin_type: "custom" });
  const now = Date.now();
  const id = typeof record(raw).id === "string" && record(raw).id ? String(record(raw).id).slice(0, 128) : ulid(now);
  const versionId = ulid(now + 1);
  const definitionJson = canonicalJson(definition);
  const digest = await sha256(definitionJson);
  try {
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definitions(
           id, tenant_id, metric_key, current_version, origin_type, origin_pack_id,
           origin_pack_version, promoted_release_id, created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, tenantId, definition.key, 1, "custom", null, null, null, principal, now, now),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definition_versions(
           id, tenant_id, metric_definition_id, version, definition_json,
           definition_digest, created_by, created_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      ).bind(versionId, tenantId, id, 1, definitionJson, digest, principal, now)
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "metric_key_conflict", "metric key already exists for tenant");
    throw error;
  }
  return definitionResponse({
    id,
    tenant_id: tenantId,
    metric_key: definition.key,
    current_version: 1,
    origin_type: "custom",
    origin_pack_id: null,
    origin_pack_version: null,
    promoted_release_id: null,
    created_by: principal,
    created_at: now,
    updated_at: now,
    definition_json: definitionJson
  });
}

export async function createMetricDefinitionVersion(env: Env, tenantId: string, principal: string, definitionId: string, raw: unknown) {
  assertMetricsWritable(env);
  const current = await definitionRow(env, tenantId, definitionId);
  if (current.origin_type !== "custom") {
    throw new HttpError(409, "pack_metric_immutable", "Pack metrics are updated only by a Pack upgrade");
  }
  const definition = parseSchema(metricDefinitionSchema, {
    ...withoutTransportFields(record(raw).definition ?? raw),
    key: current.metric_key,
    origin_type: "custom"
  });
  const version = current.current_version + 1;
  const now = Date.now();
  const definitionJson = canonicalJson(definition);
  const digest = await sha256(definitionJson);
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO metric_definition_versions(
         id, tenant_id, metric_definition_id, version, definition_json,
         definition_digest, created_by, created_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    ).bind(ulid(now), tenantId, definitionId, version, definitionJson, digest, principal, now),
    env.OPEN_BRAIN_DB.prepare(
      "UPDATE metric_definitions SET current_version = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND current_version = ?"
    ).bind(version, now, tenantId, definitionId, current.current_version)
  ]);
  return definitionResponse({ ...current, current_version: version, updated_at: now, definition_json: definitionJson });
}

export async function recordMetricPromotion(env: Env, tenantId: string, definitionId: string, raw: unknown) {
  assertMetricsWritable(env);
  const body = parseSchema(z.object({
    promoted_release_id: z.string().trim().min(1).max(128),
    metric_key: z.string().trim().min(1).max(128).optional()
  }).strict(), withoutTransportFields(raw));
  const current = await definitionRow(env, tenantId, definitionId);
  if (current.origin_type !== "custom") throw new HttpError(409, "promotion_requires_custom_metric", "Only custom metrics can record a promoted release");
  if (body.metric_key && body.metric_key !== current.metric_key) throw new HttpError(409, "promotion_metric_mismatch", "Promotion metric key does not match the source metric");
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE metric_definitions SET promoted_release_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
  ).bind(body.promoted_release_id, Date.now(), tenantId, definitionId).run();
  return { metric_definition_id: definitionId, metric_key: current.metric_key, promoted_release_id: body.promoted_release_id, source_unchanged: true };
}

const bindingSchema = z.object({
  scope_type: z.enum(["tenant", "project", "managed_object"]),
  scope_id: z.string().trim().min(1).max(128).nullable().default(null),
  dimensions: z.record(z.string(), z.string().max(256)).default({})
}).strict().superRefine((value, context) => {
  if (value.scope_type !== "tenant" && !value.scope_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope_id"], message: "scope_id is required for project and managed_object scopes" });
  }
});

export async function createMetricBinding(env: Env, tenantId: string, principal: string, definitionId: string, raw: unknown) {
  assertMetricsWritable(env);
  await definitionRow(env, tenantId, definitionId);
  const parsed = parseSchema(bindingSchema, withoutTransportFields(raw));
  const now = Date.now();
  const binding = {
    id: ulid(now), tenant_id: tenantId, metric_definition_id: definitionId,
    scope_type: parsed.scope_type, scope_id: parsed.scope_id,
    dimensions: parsed.dimensions, created_by: principal, created_at: now
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO metric_bindings(
       id, tenant_id, metric_definition_id, scope_type, scope_id, dimensions_json, created_by, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(binding.id, tenantId, definitionId, binding.scope_type, binding.scope_id, canonicalJson(binding.dimensions), principal, now).run();
  return binding;
}

const targetSchema = z.object({
  binding_id: z.string().trim().min(1).max(128).nullable().default(null),
  target_value: z.number().finite().nullable().default(null),
  target_min: z.number().finite().nullable().default(null),
  target_max: z.number().finite().nullable().default(null),
  direction: z.enum(["increase", "decrease", "range", "maintain"]),
  effective_from: z.number().int().nonnegative().default(() => Date.now()),
  effective_to: z.number().int().nonnegative().nullable().default(null),
  reason: z.string().trim().max(2_000).nullable().default(null)
}).strict().superRefine((value, context) => {
  if (value.direction === "range" && (value.target_min === null || value.target_max === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_min"], message: "range targets require target_min and target_max" });
  }
  if (value.direction !== "range" && value.target_value === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_value"], message: "target_value is required" });
  }
});

export async function setMetricTarget(env: Env, tenantId: string, principal: string, definitionId: string, raw: unknown) {
  assertMetricsWritable(env);
  await definitionRow(env, tenantId, definitionId);
  const target = parseSchema(targetSchema, withoutTransportFields(raw));
  const createdAt = Date.now();
  const result = { id: ulid(createdAt), tenant_id: tenantId, metric_definition_id: definitionId, ...target, set_by: principal, created_at: createdAt };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO metric_targets(
       id, tenant_id, metric_definition_id, binding_id, target_value, target_min,
       target_max, direction, effective_from, effective_to, reason, set_by, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(result.id, tenantId, definitionId, target.binding_id, target.target_value, target.target_min,
    target.target_max, target.direction, target.effective_from, target.effective_to, target.reason, principal, createdAt).run();
  return result;
}

async function deriveSnapshot(env: Env, tenantId: string, definition: MetricDefinitionV1) {
  if (!definition.formula) return { value: null, state: "unknown" as const };
  const series: Record<string, number[]> = {};
  for (const metricKey of definition.formula.metric_keys) {
    const source = await definitionByKey(env, tenantId, metricKey);
    const snapshot = await env.OPEN_BRAIN_DB.prepare(
      `SELECT value, state, expires_at FROM metric_snapshots
       WHERE tenant_id = ? AND metric_definition_id = ?
       ORDER BY observed_at DESC, created_at DESC LIMIT 1`
    ).bind(tenantId, source.id).first<{ value: number | null; state: string; expires_at: number }>();
    if (!snapshot || snapshot.state !== "measured" || snapshot.value === null || snapshot.expires_at < Date.now()) {
      return { value: null, state: "unknown" as const };
    }
    series[metricKey] = [snapshot.value];
  }
  const value = evaluateMetricFormula(definition.formula, series);
  return value === null ? { value: null, state: "unknown" as const } : { value, state: "measured" as const };
}

export async function createMetricSnapshot(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const body = withoutTransportFields(raw);
  const bindingId = typeof body.binding_id === "string" ? body.binding_id : null;
  delete body.binding_id;
  if (typeof body.metric_key !== "string") throw new HttpError(400, "metric_key_required", "metric_key is required");
  const row = await definitionByKey(env, tenantId, body.metric_key);
  const definition = JSON.parse(row.definition_json) as MetricDefinitionV1;
  if (definition.source_type === "derived" && (body.value === undefined || body.state === undefined)) {
    Object.assign(body, await deriveSnapshot(env, tenantId, definition));
  }
  const snapshot = parseSchema(metricSnapshotSchema, {
    ...body,
    scope_type: body.scope_type ?? definition.scope_type
  });
  if (snapshot.source_binding_id) {
    const sourceBinding = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM metric_source_bindings
       WHERE tenant_id = ? AND id = ? AND metric_definition_id = ?`
    ).bind(tenantId, snapshot.source_binding_id, row.id).first<{ id: string }>();
    if (!sourceBinding) {
      throw new HttpError(400, "metric_source_binding_not_found", "source binding must belong to the tenant and metric");
    }
  }
  const now = Date.now();
  const result = { id: ulid(now), tenant_id: tenantId, metric_definition_id: row.id, binding_id: bindingId, ...snapshot, recorded_by: principal, created_at: now };
  try {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO metric_snapshots(
         id, tenant_id, metric_definition_id, binding_id, value, state, dimensions_json,
         observed_at, expires_at, evidence_ref, query_digest, source_binding_id,
         idempotency_key, recorded_by, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(result.id, tenantId, row.id, bindingId, snapshot.value, snapshot.state, canonicalJson(snapshot.dimensions),
      snapshot.observed_at, snapshot.expires_at, snapshot.evidence_ref, snapshot.query_digest, snapshot.source_binding_id,
      snapshot.idempotency_key, principal, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "metric_snapshot_duplicate", "snapshot idempotency key already exists");
    throw error;
  }
  return result;
}

export async function queryMetricSnapshots(env: Env, tenantId: string, query: {
  metricKeys?: string[];
  scopeId?: string | null;
  from?: number;
  to?: number;
  limit?: number;
}): Promise<MetricSnapshotQueryRow[]> {
  assertMetricsReadable(env);
  const keys = [...new Set((query.metricKeys ?? []).filter(Boolean))].slice(0, 100);
  const where = ["s.tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  if (keys.length) {
    where.push(`d.metric_key IN (${keys.map(() => "?").join(",")})`);
    bindings.push(...keys);
  }
  if (query.scopeId) {
    where.push("b.scope_id = ?");
    bindings.push(query.scopeId);
  }
  if (Number.isFinite(query.from)) {
    where.push("s.observed_at >= ?");
    bindings.push(Number(query.from));
  }
  if (Number.isFinite(query.to)) {
    where.push("s.observed_at <= ?");
    bindings.push(Number(query.to));
  }
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 2_000);
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT s.id, d.metric_key, s.binding_id, s.source_binding_id, s.value, s.state,
            s.dimensions_json, s.observed_at, s.expires_at, s.evidence_ref,
            s.query_digest, s.recorded_by, s.created_at
     FROM metric_snapshots s
     JOIN metric_definitions d ON d.id = s.metric_definition_id AND d.tenant_id = s.tenant_id
     LEFT JOIN metric_bindings b ON b.id = s.binding_id AND b.tenant_id = s.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY s.observed_at ASC, s.created_at ASC
     LIMIT ?`
  ).bind(...bindings, limit).all<Record<string, unknown>>();
  const now = Date.now();
  return result.results.map((row) => {
    const state = row.state === "measured" || row.state === "stale" ? row.state : "unknown";
    return {
      id: String(row.id),
      metric_key: String(row.metric_key),
      binding_id: typeof row.binding_id === "string" ? row.binding_id : null,
      source_binding_id: typeof row.source_binding_id === "string" ? row.source_binding_id : null,
      value: typeof row.value === "number" ? row.value : null,
      state,
      freshness: state === "measured" && Number(row.expires_at) < now ? "stale" : state,
      dimensions: row.dimensions_json ? JSON.parse(String(row.dimensions_json)) as Record<string, string> : {},
      observed_at: Number(row.observed_at),
      expires_at: Number(row.expires_at),
      evidence_ref: typeof row.evidence_ref === "string" ? row.evidence_ref : null,
      query_digest: typeof row.query_digest === "string" ? row.query_digest : null,
      recorded_by: String(row.recorded_by),
      created_at: Number(row.created_at)
    };
  });
}

export async function listMetricSourceBindings(env: Env, tenantId: string, query: {
  metricDefinitionId?: string;
  status?: string;
}): Promise<MetricSourceBindingV1[]> {
  assertMetricsReadable(env);
  const where = ["s.tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  if (query.metricDefinitionId) {
    where.push("s.metric_definition_id = ?");
    bindings.push(query.metricDefinitionId);
  }
  if (query.status) {
    if (!["unconfigured", "configured", "active", "error", "paused"].includes(query.status)) {
      throw new HttpError(400, "invalid_metric_source_status", "unknown metric source binding status");
    }
    where.push("s.status = ?");
    bindings.push(query.status);
  }
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT s.id, s.tenant_id, s.metric_definition_id, s.metric_binding_id,
            s.adapter_id, s.query_template, s.connection_ref, s.external_scope_ref,
            s.status, s.last_attempt_at, s.last_success_at, s.last_error_code,
            s.created_at, s.updated_at, d.metric_key
     FROM metric_source_bindings s
     JOIN metric_definitions d ON d.id = s.metric_definition_id AND d.tenant_id = s.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY d.metric_key, s.binding_key`
  ).bind(...bindings).all<Record<string, unknown>>();
  return result.results.map((row) => metricSourceBindingSchema.parse({ contract_version: "metric/v1", ...row }));
}

export async function queryMetrics(env: Env, tenantId: string, query: { metricKeys?: string[]; scopeId?: string | null; limit?: number }) {
  assertMetricsReadable(env);
  const keys = (query.metricKeys ?? []).filter(Boolean).slice(0, 100);
  const where = ["d.tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  if (keys.length) {
    where.push(`d.metric_key IN (${keys.map(() => "?").join(",")})`);
    bindings.push(...keys);
  }
  if (query.scopeId) {
    where.push("(s.id IS NULL OR EXISTS (SELECT 1 FROM metric_bindings b WHERE b.id = s.binding_id AND b.tenant_id = d.tenant_id AND b.scope_id = ?))");
    bindings.push(query.scopeId);
  }
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.metric_key, d.current_version, d.origin_type, d.origin_pack_id,
            d.origin_pack_version, v.definition_json,
            s.id AS snapshot_id, s.value, s.state, s.observed_at, s.expires_at,
            s.evidence_ref, s.query_digest, s.dimensions_json,
            t.target_value, t.target_min, t.target_max, t.direction AS target_direction
     FROM metric_definitions d
     JOIN metric_definition_versions v ON v.metric_definition_id = d.id AND v.version = d.current_version
     LEFT JOIN metric_snapshots s ON s.id = (
       SELECT s2.id FROM metric_snapshots s2
       WHERE s2.tenant_id = d.tenant_id AND s2.metric_definition_id = d.id
       ORDER BY s2.observed_at DESC, s2.created_at DESC LIMIT 1
     )
     LEFT JOIN metric_targets t ON t.id = (
       SELECT t2.id FROM metric_targets t2
       WHERE t2.tenant_id = d.tenant_id AND t2.metric_definition_id = d.id
       ORDER BY t2.effective_from DESC, t2.created_at DESC LIMIT 1
     )
     WHERE ${where.join(" AND ")}
     ORDER BY d.metric_key LIMIT ?`
  ).bind(...bindings, Math.min(Math.max(query.limit ?? 100, 1), 500)).all<Record<string, unknown>>();
  const now = Date.now();
  return result.results.map((row) => {
    const expired = typeof row.expires_at === "number" && row.expires_at < now;
    const state = expired && row.state === "measured" ? "stale" : row.state ?? "unknown";
    return {
      id: row.id,
      metric_key: row.metric_key,
      current_version: row.current_version,
      origin_type: row.origin_type,
      origin_pack_id: row.origin_pack_id,
      origin_pack_version: row.origin_pack_version,
      definition: JSON.parse(String(row.definition_json)),
      latest: {
        id: row.snapshot_id ?? null,
        value: state === "measured" ? row.value : null,
        state,
        observed_at: row.observed_at ?? null,
        expires_at: row.expires_at ?? null,
        evidence_ref: row.evidence_ref ?? null,
        query_digest: row.query_digest ?? null,
        dimensions: row.dimensions_json ? JSON.parse(String(row.dimensions_json)) : {}
      },
      target: row.target_direction ? {
        direction: row.target_direction,
        value: row.target_value,
        min: row.target_min,
        max: row.target_max
      } : null
    };
  });
}

export async function createManagedObjectType(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const definition = parseSchema(managedObjectTypeSchema, withoutTransportFields(raw));
  const now = Date.now();
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO managed_object_types(
       id, tenant_id, type_key, label, description, attribute_schema_json,
       allowed_relations_json, origin_type, origin_pack_id, origin_pack_version,
       created_by, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, definition.key, definition.label, definition.description,
    canonicalJson(definition.attribute_schema), canonicalJson(definition.allowed_relations),
    "custom", null, null, principal, now, now).run();
  return { id, tenant_id: tenantId, ...definition, origin_type: "custom", created_by: principal, created_at: now, updated_at: now };
}

export async function createManagedObject(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const body = { ...record(raw) };
  delete body.tenant_id;
  const object = parseSchema(managedObjectSchema, { ...body, tenant_id: tenantId });
  const type = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM managed_object_types WHERE tenant_id = ? AND type_key = ?"
  ).bind(tenantId, object.object_type_key).first<{ id: string }>();
  if (!type) throw new HttpError(400, "managed_object_type_not_found", "managed object type not found");
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO managed_objects(
       id, tenant_id, project_id, object_type_id, object_key, name, attributes_json,
       visibility, owner_principal, created_by, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(object.id, tenantId, object.project_id ?? null, type.id, object.id, object.name,
    canonicalJson(object.attributes), object.visibility, object.owner_principal, principal, now, now).run();
  return { ...object, tenant_id: tenantId, created_by: principal, created_at: now, updated_at: now };
}

export async function searchManagedObjects(env: Env, tenantId: string, query: { q?: string; typeKey?: string; projectId?: string | null; limit?: number }) {
  assertMetricsReadable(env);
  const where = ["o.tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  if (query.q) {
    where.push("(LOWER(o.name) LIKE ? OR LOWER(o.object_key) LIKE ?)");
    const pattern = `%${query.q.toLowerCase().slice(0, 128)}%`;
    bindings.push(pattern, pattern);
  }
  if (query.typeKey) { where.push("t.type_key = ?"); bindings.push(query.typeKey); }
  if (query.projectId) { where.push("o.project_id = ?"); bindings.push(query.projectId); }
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT o.*, t.type_key, t.label AS type_label
     FROM managed_objects o JOIN managed_object_types t ON t.id = o.object_type_id
     WHERE ${where.join(" AND ")} ORDER BY o.updated_at DESC LIMIT ?`
  ).bind(...bindings, Math.min(Math.max(query.limit ?? 50, 1), 200)).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, attributes: JSON.parse(String(row.attributes_json)), attributes_json: undefined }));
}

export async function createManagedObjectRelation(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const relation = parseSchema(z.object({
    source_object_id: z.string().trim().min(1).max(128),
    relation_type: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*$/u).max(128),
    target_object_id: z.string().trim().min(1).max(128),
    attributes: z.record(z.string(), z.unknown()).default({})
  }).strict(), withoutTransportFields(raw));
  const objects = await env.OPEN_BRAIN_DB.prepare(
    `SELECT o.id, t.allowed_relations_json FROM managed_objects o
     JOIN managed_object_types t ON t.id = o.object_type_id
     WHERE o.tenant_id = ? AND o.id IN (?, ?)`
  ).bind(tenantId, relation.source_object_id, relation.target_object_id).all<{ id: string; allowed_relations_json: string }>();
  if (objects.results.length !== 2) throw new HttpError(400, "managed_object_not_found", "source and target objects must belong to the tenant");
  const source = objects.results.find((item) => item.id === relation.source_object_id)!;
  const allowed = JSON.parse(source.allowed_relations_json) as string[];
  if (allowed.length && !allowed.includes(relation.relation_type)) throw new HttpError(400, "managed_object_relation_not_allowed", "relation is not allowed by the source object type");
  const now = Date.now();
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO managed_object_relations(
       id, tenant_id, source_object_id, relation_type, target_object_id,
       attributes_json, created_by, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, relation.source_object_id, relation.relation_type, relation.target_object_id,
    canonicalJson(relation.attributes), principal, now).run();
  return { id, tenant_id: tenantId, ...relation, created_by: principal, created_at: now };
}

export async function createManagedObjectExternalRef(env: Env, tenantId: string, raw: unknown) {
  assertMetricsWritable(env);
  const ref = parseSchema(z.object({
    managed_object_id: z.string().trim().min(1).max(128),
    adapter_id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u).max(128),
    external_id: z.string().trim().min(1).max(512),
    url: z.string().url().max(2_048).nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).default({})
  }).strict(), withoutTransportFields(raw));
  const object = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM managed_objects WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, ref.managed_object_id).first<{ id: string }>();
  if (!object) throw new HttpError(400, "managed_object_not_found", "managed object not found");
  const now = Date.now();
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO managed_object_external_refs(
       id, tenant_id, managed_object_id, adapter_id, external_id, url, metadata_json, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, ref.managed_object_id, ref.adapter_id, ref.external_id, ref.url, canonicalJson(ref.metadata), now).run();
  return { id, tenant_id: tenantId, ...ref, created_at: now };
}

export async function createDecisionDomainLink(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const link = parseSchema(decisionDomainLinkSchema, { ...withoutTransportFields(raw), tenant_id: tenantId });
  const now = Date.now();
  const id = ulid(now);
  const idempotencyKey = await sha256(canonicalJson({ tenantId, ...link }));
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO knowledge_assertions(
       id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
       object_type, object_ref, resource_id, object_value, context_json, confidence,
       confirmation_state, idempotency_key, valid_from, valid_until, actor_principal,
       reviewed_by_principal, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, null, "relation", link.decision_source_type, link.decision_source_id,
    link.relation, link.object_type, link.object_id, link.evidence_resource_id, null,
    canonicalJson({ evidence_resource_version_id: link.evidence_resource_version_id }), 1,
    link.confirmation_state, idempotencyKey, now, null, principal,
    link.confirmation_state === "confirmed" ? principal : null, now, now).run();
  return { id, ...link, actor_principal: principal, created_at: now };
}

export async function upsertDomainDashboard(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertMetricsWritable(env);
  const dashboard = parseSchema(dashboardDefinitionSchema, withoutTransportFields(raw));
  const metricKeys = [...new Set(dashboard.widgets.flatMap((widget) => widget.metric_keys))];
  if (metricKeys.length) {
    const result = await env.OPEN_BRAIN_DB.prepare(
      `SELECT metric_key FROM metric_definitions WHERE tenant_id = ? AND metric_key IN (${metricKeys.map(() => "?").join(",")})`
    ).bind(tenantId, ...metricKeys).all<{ metric_key: string }>();
    const found = new Set(result.results.map((row) => row.metric_key));
    const missing = metricKeys.filter((key) => !found.has(key));
    if (missing.length) throw new HttpError(400, "dashboard_metric_not_found", `dashboard references unknown metrics: ${missing.join(", ")}`);
  }
  const current = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, origin_type FROM domain_dashboards WHERE tenant_id = ? AND dashboard_key = ?"
  ).bind(tenantId, dashboard.key).first<{ id: string; origin_type: string }>();
  if (current?.origin_type === "pack") throw new HttpError(409, "pack_dashboard_immutable", "Pack dashboards are updated only by Pack upgrade");
  const now = Date.now();
  const id = current?.id ?? ulid(now);
  if (current) {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE domain_dashboards SET title = ?, definition_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
    ).bind(dashboard.title, canonicalJson(dashboard), now, tenantId, id).run();
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO domain_dashboards(
         id, tenant_id, dashboard_key, title, definition_json, origin_type,
         origin_pack_id, origin_pack_version, created_by, created_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, tenantId, dashboard.key, dashboard.title, canonicalJson(dashboard), "custom", null, null, principal, now, now).run();
  }
  for (const widget of dashboard.widgets) {
    const metric = widget.metric_keys[0] ? await definitionByKey(env, tenantId, widget.metric_keys[0]) : null;
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO dashboard_metric_widgets(id, tenant_id, dashboard_id, widget_key, metric_definition_id, widget_json, created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(dashboard_id, widget_key) DO UPDATE SET metric_definition_id = excluded.metric_definition_id, widget_json = excluded.widget_json`
    ).bind(ulid(now + widget.layout.x + widget.layout.y), tenantId, id, widget.key,
      metric?.id ?? null, canonicalJson(widget), now).run();
  }
  return { id, tenant_id: tenantId, origin_type: "custom", definition: dashboard, created_by: principal, updated_at: now };
}

export async function listDomainDashboards(env: Env, tenantId: string) {
  assertMetricsReadable(env);
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, dashboard_key, title, definition_json, origin_type, origin_pack_id,
            origin_pack_version, created_by, created_at, updated_at
     FROM domain_dashboards WHERE tenant_id = ? ORDER BY title`
  ).bind(tenantId).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, definition: JSON.parse(String(row.definition_json)), definition_json: undefined }));
}

export async function getDomainContext(env: Env, tenantId: string, input: { objectId?: string; metricKey?: string; decisionId?: string }) {
  assertMetricsReadable(env);
  const object = input.objectId
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT o.*, t.type_key, t.label AS type_label FROM managed_objects o
       JOIN managed_object_types t ON t.id = o.object_type_id
       WHERE o.tenant_id = ? AND o.id = ?`
    ).bind(tenantId, input.objectId).first<Record<string, unknown>>()
    : null;
  const metrics = await queryMetrics(env, tenantId, { metricKeys: input.metricKey ? [input.metricKey] : [], scopeId: input.objectId, limit: input.metricKey ? 1 : 100 });
  const refs = [input.objectId, input.decisionId].filter((item): item is string => Boolean(item));
  let assertions: Record<string, unknown>[] = [];
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(",");
    const result = await env.OPEN_BRAIN_DB.prepare(
      `SELECT * FROM knowledge_assertions WHERE tenant_id = ?
       AND (subject_ref IN (${placeholders}) OR object_ref IN (${placeholders}))
       ORDER BY updated_at DESC LIMIT 200`
    ).bind(tenantId, ...refs, ...refs).all<Record<string, unknown>>();
    assertions = result.results;
  }
  return {
    object: object ? { ...object, attributes: JSON.parse(String(object.attributes_json)), attributes_json: undefined } : null,
    metrics,
    assertions
  };
}
