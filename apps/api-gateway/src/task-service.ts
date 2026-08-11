import {
  createTaskSchema,
  type CreateTaskInput,
  type Envelope,
  HttpError,
  sha256,
  type TaskCreatedPayload,
  ulid,
  validateTaskCreateBody
} from "@org-brain/shared";
import type { Env } from "./types";

export type CreatedTaskResult = {
  task_id: string;
  status: string;
  deduped: boolean;
  measurement_run_id?: string;
  variants?: Array<{ variant: "control" | "treatment"; task_id: string; status: string }>;
};

export async function replayFailedTask(
  env: Env,
  tenantId: string,
  taskId: string,
  actorPrincipal?: string | null
): Promise<CreatedTaskResult & { replayed_from_task_id: string }> {
  const task = await env.OPEN_BRAIN_DB.prepare(
    "SELECT status FROM tasks WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, taskId).first<{ status: string }>();
  if (!task) throw new HttpError(404, "task_not_found", `Task not found: ${taskId}`);
  if (!["failed", "dead_letter"].includes(task.status)) {
    throw new HttpError(409, "task_not_replayable", "Only failed or dead-letter tasks can be replayed");
  }
  const event = await env.OPEN_BRAIN_DB.prepare(
    `SELECT payload FROM task_events
     WHERE tenant_id = ? AND task_id = ? AND kind = 'created'
     ORDER BY created_at ASC
     LIMIT 1`
  ).bind(tenantId, taskId).first<{ payload: string | null }>();
  if (!event?.payload) {
    throw new HttpError(409, "task_not_replayable", "Original task input is unavailable");
  }
  let original: unknown;
  try {
    original = JSON.parse(event.payload);
  } catch {
    throw new HttpError(409, "task_not_replayable", "Original task input is invalid");
  }
  if (!original || typeof original !== "object") {
    throw new HttpError(409, "task_not_replayable", "Original task input is invalid");
  }
  const replayId = ulid();
  const created = await createTask(env, {
    ...(original as Record<string, unknown>),
    tenant_id: tenantId,
    idempotency_key: `replay:${taskId}:${replayId}`
  }, { actorPrincipal });
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
  ).bind(
    ulid(),
    tenantId,
    taskId,
    "replayed",
    JSON.stringify({ replay_task_id: created.task_id }),
    Date.now()
  ).run();
  return { ...created, replayed_from_task_id: taskId };
}

export async function createTask(
  env: Env,
  rawBody: unknown,
  options: { actorPrincipal?: string | null } = {}
): Promise<CreatedTaskResult> {
  if (!validateTaskCreateBody(rawBody)) {
    throw new HttpError(400, "invalid_payload", "Request body does not match task_create.schema.json");
  }

  const body = createTaskSchema.parse(rawBody) as CreateTaskInput;
  if (body.measurement_mode) {
    return createMeasurementTask(env, body, options.actorPrincipal);
  }

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
  const actorPrincipal = options.actorPrincipal?.trim().slice(0, 128) || null;
  const insertTask = env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO tasks(id, tenant_id, project_id, capability, status, priority, input_ref, idempotency_key, trace_id, wait_event_type, created_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
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
    actorPrincipal,
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
      constraints: body.constraints,
      wait_event_type: body.wait_event_type
    }
  };

  await env.ORG_BUS_OUT.send(envelope, { contentType: "json" });

  return { task_id: taskId, status: "created", deduped: false };
}

async function createMeasurementTask(
  env: Env,
  body: CreateTaskInput,
  actorPrincipalInput?: string | null
): Promise<CreatedTaskResult> {
  const now = Date.now();
  const tenantId = body.tenant_id ?? "default";
  const projectId = body.project_id ?? null;
  const referenceModel = body.measurement_reference_model ?? "estimated_tokens_v1";
  const measurementUnit = body.measurement_unit ?? "task";
  const sessionId = body.measurement_session_id ?? null;
  const actorPrincipal = actorPrincipalInput?.trim().slice(0, 128) || null;
  const pairKey = body.idempotency_key ?? `${tenantId}:${body.capability}:measurement:${await sha256(body.input_ref)}`;

  const existingRun = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM measurement_runs WHERE tenant_id = ? AND pair_key = ?"
  )
    .bind(tenantId, pairKey)
    .first<{ id: string }>();

  if (existingRun) {
    const variants = await env.OPEN_BRAIN_DB.prepare(
      "SELECT variant, task_id, status FROM measurement_variants WHERE tenant_id = ? AND run_id = ? ORDER BY variant ASC"
    )
      .bind(tenantId, existingRun.id)
      .all<{ variant: "control" | "treatment"; task_id: string; status: string }>();

    return {
      task_id: existingRun.id,
      status: "created",
      deduped: true,
      measurement_run_id: existingRun.id,
      variants: variants.results
    };
  }

  const runId = ulid();
  const variants = [
    { variant: "control" as const, memoryEnabled: false },
    { variant: "treatment" as const, memoryEnabled: true }
  ];

  const taskRows = variants.map((item) => ({
    ...item,
    taskId: ulid(),
    idempotencyKey: `${pairKey}:${item.variant}`
  }));

  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO measurement_runs(
        id, tenant_id, project_id, capability, input_ref, reference_model, pair_key,
        measurement_session_id, measurement_unit, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).bind(runId, tenantId, projectId, body.capability, body.input_ref, referenceModel, pairKey, sessionId, measurementUnit, now)
  ];

  for (const row of taskRows) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO tasks(id, tenant_id, project_id, capability, status, priority, input_ref, idempotency_key, trace_id, wait_event_type, created_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        row.taskId,
        tenantId,
        projectId,
        body.capability,
        "created",
        body.priority ?? 0,
        body.input_ref,
        row.idempotencyKey,
        body.trace_id ?? null,
        body.wait_event_type ?? null,
        actorPrincipal,
        now,
        now
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
      ).bind(
        ulid(),
        tenantId,
        row.taskId,
        "created",
        JSON.stringify({ ...body, measurement_mode: true, measurement_run_id: runId, measurement_variant: row.variant }),
        now
      ),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO measurement_variants(
          run_id, tenant_id, variant, task_id, status, memory_enabled, memory_write_enabled, created_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      ).bind(runId, tenantId, row.variant, row.taskId, "created", row.memoryEnabled ? 1 : 0, 0, now)
    );
  }

  await env.OPEN_BRAIN_DB.batch(statements);

  for (const row of taskRows) {
    const envelope: Envelope<TaskCreatedPayload> = {
      message_id: ulid(),
      tenant_id: tenantId,
      project_id: body.project_id,
      trace_id: body.trace_id,
      type: "task.created",
      ts: now,
      idempotency_key: row.idempotencyKey,
      payload: {
        task_id: row.taskId,
        capability: body.capability,
        priority: body.priority ?? 0,
        input_ref: body.input_ref,
        constraints: body.constraints,
        wait_event_type: body.wait_event_type,
        measurement: {
          run_id: runId,
          session_id: sessionId ?? undefined,
          unit: measurementUnit,
          variant: row.variant,
          reference_model: referenceModel,
          memory_enabled: row.memoryEnabled,
          memory_write_enabled: false
        }
      }
    };
    await env.ORG_BUS_OUT.send(envelope, { contentType: "json" });
  }

  return {
    task_id: runId,
    status: "created",
    deduped: false,
    measurement_run_id: runId,
    variants: taskRows.map((row) => ({ variant: row.variant, task_id: row.taskId, status: "created" }))
  };
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
  status?: string,
  query?: string,
  offset = 0
): Promise<Array<Record<string, unknown>>> {
  const filters = ["tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  const normalizedStatus = typeof status === "string" ? status.trim().slice(0, 64) : "";
  const normalizedQuery = typeof query === "string" ? query.trim().slice(0, 120) : "";
  if (normalizedStatus) {
    filters.push("status = ?");
    bindings.push(normalizedStatus);
  }
  if (normalizedQuery) {
    filters.push("(id LIKE ? OR capability LIKE ? OR COALESCE(project_id, '') LIKE ?)");
    const pattern = `%${normalizedQuery}%`;
    bindings.push(pattern, pattern, pattern);
  }
  const safeLimit = Math.min(101, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 50)));
  const safeOffset = Math.min(100_000, Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0)));
  const sql = `SELECT id, tenant_id, project_id, capability, status, priority, input_ref, output_ref, trace_id, wait_event_type, created_at, updated_at
    FROM tasks WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;

  const stmt = env.OPEN_BRAIN_DB.prepare(sql);
  const bound = stmt.bind(...bindings, safeLimit, safeOffset);
  const result = await bound.all<Record<string, unknown>>();
  return result.results;
}
