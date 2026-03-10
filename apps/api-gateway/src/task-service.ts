import {
  createTaskSchema,
  type CreateTaskInput,
  HttpError,
  sha256,
  ulid,
  validateTaskCreateBody
} from "@org-brain/shared";
import type { Envelope, TaskCreatedPayload } from "@org-brain/shared";
import type { Env } from "./types";

export type CreatedTaskResult = {
  task_id: string;
  status: string;
  deduped: boolean;
};

export async function createTask(env: Env, rawBody: unknown): Promise<CreatedTaskResult> {
  if (!validateTaskCreateBody(rawBody)) {
    throw new HttpError(400, "invalid_payload", "Request body does not match task_create.schema.json");
  }

  const body = createTaskSchema.parse(rawBody) as CreateTaskInput;

  const now = Date.now();
  const tenantId = body.tenant_id ?? "default";
  const projectId = body.project_id ?? null;
  const idem = body.idempotency_key ?? `${tenantId}:${body.capability}:${await sha256(body.input_ref)}`;

  const existing = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, status FROM tasks WHERE tenant_id = ? AND idempotency_key = ?"
  )
    .bind(tenantId, idem)
    .first<{ id: string; status: string }>();

  if (existing) {
    return { task_id: existing.id, status: existing.status, deduped: true };
  }

  const taskId = ulid();
  const insertTask = env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO tasks(id, tenant_id, project_id, capability, status, priority, input_ref, idempotency_key, trace_id, wait_event_type, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    taskId,
    tenantId,
    projectId,
    body.capability,
    "created",
    body.priority ?? 0,
    body.input_ref,
    idem,
    body.trace_id ?? null,
    body.wait_event_type ?? null,
    now,
    now
  );

  const insertCreatedEvent = env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
  ).bind(ulid(), tenantId, taskId, "created", JSON.stringify(body), now);

  await env.OPEN_BRAIN_DB.batch([insertTask, insertCreatedEvent]);

  const envelope: Envelope<TaskCreatedPayload> = {
    message_id: ulid(),
    tenant_id: tenantId,
    project_id: body.project_id,
    trace_id: body.trace_id,
    type: "task.created",
    ts: now,
    idempotency_key: idem,
    payload: {
      task_id: taskId,
      capability: body.capability,
      priority: body.priority ?? 0,
      input_ref: body.input_ref,
      wait_event_type: body.wait_event_type
    }
  };

  await env.ORG_BUS_OUT.send(envelope, { contentType: "json" });

  return { task_id: taskId, status: "created", deduped: false };
}

export async function getTask(env: Env, tenantId: string, taskId: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, tenant_id, project_id, capability, status, priority, input_ref, output_ref, trace_id, wait_event_type, created_at, updated_at FROM tasks WHERE tenant_id = ? AND id = ?"
  )
    .bind(tenantId, taskId)
    .first();

  if (!row) {
    throw new HttpError(404, "task_not_found", "Task not found");
  }

  return row;
}

export async function getTaskEvents(env: Env, tenantId: string, taskId: string, limit = 50, cursor?: number) {
  const cursorSql = cursor ? "AND created_at > ?" : "";
  const stmt = env.OPEN_BRAIN_DB.prepare(
    `SELECT id, kind, payload, created_at FROM task_events WHERE tenant_id = ? AND task_id = ? ${cursorSql} ORDER BY created_at ASC LIMIT ?`
  );

  const bound = cursor
    ? stmt.bind(tenantId, taskId, cursor, limit)
    : stmt.bind(tenantId, taskId, limit);

  const result = await bound.all<{ id: string; kind: string; payload: string; created_at: number }>();
  return result.results;
}

export async function listTasks(
  env: Env,
  tenantId: string,
  limit = 50,
  status?: string
): Promise<Array<Record<string, unknown>>> {
  const hasStatus = typeof status === "string" && status.length > 0;
  const sql = hasStatus
    ? "SELECT id, tenant_id, project_id, capability, status, priority, input_ref, output_ref, trace_id, wait_event_type, created_at, updated_at FROM tasks WHERE tenant_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?"
    : "SELECT id, tenant_id, project_id, capability, status, priority, input_ref, output_ref, trace_id, wait_event_type, created_at, updated_at FROM tasks WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?";

  const stmt = env.OPEN_BRAIN_DB.prepare(sql);
  const bound = hasStatus ? stmt.bind(tenantId, status, limit) : stmt.bind(tenantId, limit);
  const result = await bound.all<Record<string, unknown>>();
  return result.results;
}
