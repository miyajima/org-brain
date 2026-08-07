import {
  memoryImpactReportSchema,
  memoryImpactStartSchema,
  summarizeMemoryImpact,
  HttpError,
  sha256,
  ulid,
  type MemoryImpactObservation
} from "@org-brain/shared";
import type { Env } from "./types";

type ImpactEventRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  external_run_id: string;
  event_type: "eligible" | "assessed" | "failed";
  memory_used: number | null;
  avoided_lookup: "source_search" | "web_search" | "past_context" | "none" | null;
  memory_basis_ids_json: string;
  confidence: "low" | "medium" | "high" | null;
  failure_category: string | null;
  reporter_principal: string;
  agent_name: string | null;
  model: string | null;
  idempotency_key: string;
  occurred_at: number;
  created_at: number;
};

const eventColumns = `id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
  memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
  reporter_principal, agent_name, model, idempotency_key, occurred_at, created_at`;

function parseBasis(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function serializeEvent(row: ImpactEventRow) {
  return {
    ...row,
    memory_used: row.memory_used == null ? null : row.memory_used === 1,
    memory_basis_ids: parseBasis(row.memory_basis_ids_json),
    memory_basis_ids_json: undefined
  };
}

async function findIdempotency(env: Env, tenantId: string, principal: string, key: string) {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT ${eventColumns}, payload_hash FROM memory_impact_events
     WHERE tenant_id = ? AND reporter_principal = ? AND idempotency_key = ?`
  ).bind(tenantId, principal, key).first<ImpactEventRow & { payload_hash: string }>();
}

async function assertTaskExists(env: Env, tenantId: string, taskId: string | undefined): Promise<void> {
  if (!taskId) return;
  const task = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM tasks WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, taskId).first<{ id: string }>();
  if (!task) throw new HttpError(400, "invalid_task", "task_id does not exist in this tenant");
}

async function assertMemoryBasisExists(env: Env, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
  ).bind(tenantId, ...ids).all<{ id: string }>();
  if (new Set(rows.results.map((row) => row.id)).size !== new Set(ids).size) {
    throw new HttpError(400, "invalid_memory_basis", "memory_basis_ids contains an unknown memory for this tenant");
  }
}

async function insertEvent(
  env: Env,
  input: {
    tenantId: string;
    projectId?: string;
    taskId?: string;
    traceId?: string;
    externalRunId: string;
    eventType: "eligible" | "assessed" | "failed";
    memoryUsed?: boolean;
    avoidedLookup?: "source_search" | "web_search" | "past_context" | "none";
    memoryBasisIds?: string[];
    confidence?: "low" | "medium" | "high" | null;
    failureCategory?: string;
    principal: string;
    agentName?: string;
    model?: string;
    idempotencyKey: string;
    occurredAt: number;
  }
) {
  const { occurredAt: _occurredAt, ...hashableInput } = input;
  const payloadHash = await sha256(JSON.stringify(hashableInput));
  const existing = await findIdempotency(env, input.tenantId, input.principal, input.idempotencyKey);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new HttpError(409, "idempotency_conflict", "idempotency_key was already used with a different payload");
    }
    return { event: serializeEvent(existing), deduped: true };
  }

  const sameType = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${eventColumns} FROM memory_impact_events
     WHERE tenant_id = ? AND external_run_id = ? AND event_type = ?`
  ).bind(input.tenantId, input.externalRunId, input.eventType).first<ImpactEventRow>();
  if (sameType) throw new HttpError(409, "event_conflict", `${input.eventType} was already reported for this run`);
  if (input.eventType !== "eligible") {
    const terminal = await env.OPEN_BRAIN_DB.prepare(
      `SELECT event_type FROM memory_impact_events
       WHERE tenant_id = ? AND external_run_id = ? AND event_type IN ('assessed', 'failed')`
    ).bind(input.tenantId, input.externalRunId).first<{ event_type: string }>();
    if (terminal) throw new HttpError(409, "event_conflict", `${terminal.event_type} was already reported for this run`);
  }

  const now = Date.now();
  const id = ulid();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_impact_events(
      id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
      memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
      reporter_principal, agent_name, model, idempotency_key, payload_hash, occurred_at, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    input.tenantId,
    input.projectId ?? null,
    input.taskId ?? null,
    input.traceId ?? null,
    input.externalRunId,
    input.eventType,
    input.memoryUsed == null ? null : input.memoryUsed ? 1 : 0,
    input.avoidedLookup ?? null,
    JSON.stringify(input.memoryBasisIds ?? []),
    input.confidence ?? null,
    input.failureCategory ?? null,
    input.principal,
    input.agentName ?? null,
    input.model ?? null,
    input.idempotencyKey,
    payloadHash,
    input.occurredAt,
    now
  ).run();

  const event = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${eventColumns} FROM memory_impact_events WHERE tenant_id = ? AND id = ?`
  ).bind(input.tenantId, id).first<ImpactEventRow>();
  return { event: event ? serializeEvent(event) : { id, ...input }, deduped: false };
}

export async function startMemoryImpact(env: Env, tenantId: string, raw: unknown, principal: string) {
  const parsed = memoryImpactStartSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid payload");
  const body = parsed.data;
  if (body.tenant_id && body.tenant_id !== tenantId) throw new HttpError(403, "tenant_mismatch", "tenant_id does not match authenticated tenant");
  await assertTaskExists(env, tenantId, body.task_id);
  return insertEvent(env, {
    tenantId,
    projectId: body.project_id,
    taskId: body.task_id,
    traceId: body.trace_id,
    externalRunId: body.external_run_id,
    eventType: "eligible",
    principal,
    agentName: body.agent_name,
    model: body.model,
    idempotencyKey: body.idempotency_key,
    occurredAt: body.occurred_at ?? Date.now()
  });
}

export async function reportMemoryImpact(
  env: Env,
  tenantId: string,
  externalRunId: string,
  raw: unknown,
  principal: string
) {
  const parsed = memoryImpactReportSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid payload");
  const body = parsed.data;
  if (body.tenant_id && body.tenant_id !== tenantId) throw new HttpError(403, "tenant_mismatch", "tenant_id does not match authenticated tenant");

  let eligible = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${eventColumns} FROM memory_impact_events
     WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
  ).bind(tenantId, externalRunId).first<ImpactEventRow>();
  if (!eligible) {
    await insertEvent(env, {
      tenantId,
      externalRunId,
      eventType: "eligible",
      principal,
      idempotencyKey: `${body.idempotency_key}:auto-start`,
      occurredAt: body.occurred_at ?? Date.now()
    });
    eligible = await env.OPEN_BRAIN_DB.prepare(
      `SELECT ${eventColumns} FROM memory_impact_events
       WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
    ).bind(tenantId, externalRunId).first<ImpactEventRow>();
  }

  if (body.outcome === "failed") {
    return insertEvent(env, {
      tenantId,
      projectId: eligible?.project_id ?? undefined,
      taskId: eligible?.task_id ?? undefined,
      traceId: eligible?.trace_id ?? undefined,
      externalRunId,
      eventType: "failed",
      failureCategory: body.failure_category,
      principal,
      agentName: eligible?.agent_name ?? undefined,
      model: eligible?.model ?? undefined,
      idempotencyKey: body.idempotency_key,
      occurredAt: body.occurred_at ?? Date.now()
    });
  }

  await assertMemoryBasisExists(env, tenantId, body.memory_basis_ids);
  return insertEvent(env, {
    tenantId,
    projectId: eligible?.project_id ?? undefined,
    taskId: eligible?.task_id ?? undefined,
    traceId: eligible?.trace_id ?? undefined,
    externalRunId,
    eventType: "assessed",
    memoryUsed: body.memory_used,
    avoidedLookup: body.avoided_lookup,
    memoryBasisIds: body.memory_basis_ids,
    confidence: body.confidence,
    principal,
    agentName: eligible?.agent_name ?? undefined,
    model: eligible?.model ?? undefined,
    idempotencyKey: body.idempotency_key,
    occurredAt: body.occurred_at ?? Date.now()
  });
}

export async function getMemoryImpactExecution(env: Env, tenantId: string, externalRunId: string) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${eventColumns} FROM memory_impact_events
     WHERE tenant_id = ? AND external_run_id = ? ORDER BY created_at ASC`
  ).bind(tenantId, externalRunId).all<ImpactEventRow>();
  if (rows.results.length === 0) throw new HttpError(404, "impact_run_not_found", "Memory impact run not found");
  return { external_run_id: externalRunId, events: rows.results.map(serializeEvent) };
}

export async function getMemoryImpactSummary(
  env: Env,
  tenantId: string,
  options: { from?: number; to?: number; projectId?: string }
) {
  const from = options.from ?? Date.now() - 30 * 86_400_000;
  const to = options.to ?? Date.now();
  if (from > to) throw new HttpError(400, "invalid_range", "from must be before to");
  const projectSql = options.projectId ? "AND project_id = ?" : "";
  const statement = env.OPEN_BRAIN_DB.prepare(
    `SELECT event_type, external_run_id, memory_used, avoided_lookup
     FROM memory_impact_events
     WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ? ${projectSql}
     ORDER BY occurred_at ASC`
  );
  type StoredObservation = Omit<MemoryImpactObservation, "memory_used"> & { memory_used?: number | null };
  const rows = options.projectId
    ? await statement.bind(tenantId, from, to, options.projectId).all<StoredObservation>()
    : await statement.bind(tenantId, from, to).all<StoredObservation>();
  const observations: MemoryImpactObservation[] = rows.results.map((row) => ({
    ...row,
    memory_used: row.memory_used === 1
  }));
  return { tenant_id: tenantId, from, to, project_id: options.projectId ?? null, ...summarizeMemoryImpact(observations) };
}
