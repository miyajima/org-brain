import {
  agentMessageActionSchema,
  AGENT_MESSAGE_STATUSES,
  AGENT_MESSAGE_TARGET_TYPES,
  HttpError,
  listAgentMessagesSchema,
  sendAgentMessageSchema,
  ulid,
  type AgentMessageStatus,
  type AgentMessageTargetType
} from "@org-brain/shared";
import type { Env } from "./types";

type AgentMessageRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  thread_id: string;
  reply_to_message_id: string | null;
  sender_principal: string;
  target_type: AgentMessageTargetType;
  target_key: string;
  subject: string | null;
  body: string;
  metadata_json: string | null;
  idempotency_key: string | null;
  status: AgentMessageStatus;
  created_at: number;
  read_at: number | null;
  acked_at: number | null;
  archived_at: number | null;
};

type Target = {
  targetType: AgentMessageTargetType;
  targetKey: string;
};

type PrincipalOptions = {
  principal: string;
};

export type AgentMessage = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  thread_id: string;
  reply_to_message_id: string | null;
  sender_principal: string;
  target_type: AgentMessageTargetType;
  target_key: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  idempotency_key: string | null;
  status: AgentMessageStatus;
  created_at: number;
  read_at: number | null;
  acked_at: number | null;
  archived_at: number | null;
};

export type SendAgentMessageResult = {
  message_id: string;
  thread_id: string;
  status: AgentMessageStatus;
  deduped: boolean;
};

export type ListAgentMessagesResult = {
  tenant_id: string;
  target_type: AgentMessageTargetType;
  target_key: string;
  status: AgentMessageStatus | "active";
  items: AgentMessage[];
  next_cursor: number | null;
};

type SchemaParser<T> = {
  parse(raw: unknown): T;
};

type SchemaError = {
  issues: Array<{ message: string }>;
};

function isSchemaError(error: unknown): error is SchemaError {
  return typeof error === "object"
    && error !== null
    && Array.isArray((error as { issues?: unknown }).issues);
}

function badRequestFromSchema(error: SchemaError): HttpError {
  return new HttpError(400, "invalid_payload", error.issues.map((issue) => issue.message).join("; "));
}

function parseWithHttpError<T>(parser: SchemaParser<T>, raw: unknown): T {
  try {
    return parser.parse(raw);
  } catch (error) {
    if (isSchemaError(error)) {
      throw badRequestFromSchema(error);
    }
    throw error;
  }
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toAgentMessage(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    reply_to_message_id: row.reply_to_message_id,
    sender_principal: row.sender_principal,
    target_type: row.target_type,
    target_key: row.target_key,
    subject: row.subject,
    body: row.body,
    metadata: parseMetadata(row.metadata_json),
    idempotency_key: row.idempotency_key,
    status: row.status,
    created_at: row.created_at,
    read_at: row.read_at,
    acked_at: row.acked_at,
    archived_at: row.archived_at
  };
}

function resolveTarget(input: { target_type?: AgentMessageTargetType; target_key?: string }, principal: string): Target {
  const targetType = input.target_type;
  const targetKey = input.target_key?.trim() ?? "";
  const hasType = typeof targetType === "string" && targetType.length > 0;
  const hasKey = targetKey.length > 0;

  if (!hasType && !hasKey) {
    return { targetType: "principal", targetKey: principal };
  }

  if (!hasType || !hasKey) {
    throw new HttpError(400, "invalid_payload", "target_type and target_key must be supplied together");
  }

  if (!AGENT_MESSAGE_TARGET_TYPES.includes(targetType as AgentMessageTargetType)) {
    throw new HttpError(400, "invalid_payload", "invalid target_type");
  }

  return {
    targetType: targetType as AgentMessageTargetType,
    targetKey
  };
}

async function findExistingByIdempotencyKey(env: Env, tenantId: string, idempotencyKey: string | null) {
  if (!idempotencyKey) return null;
  return env.OPEN_BRAIN_DB.prepare(
    "SELECT id, thread_id, status FROM agent_messages WHERE tenant_id = ? AND idempotency_key = ?"
  )
    .bind(tenantId, idempotencyKey)
    .first<{ id: string; thread_id: string; status: AgentMessageStatus }>();
}

async function resolveReplyThreadId(env: Env, tenantId: string, messageId: string, explicitThreadId?: string) {
  const parent = await env.OPEN_BRAIN_DB.prepare(
    "SELECT thread_id FROM agent_messages WHERE tenant_id = ? AND id = ?"
  )
    .bind(tenantId, messageId)
    .first<{ thread_id: string }>();

  if (!parent) {
    throw new HttpError(404, "message_not_found", "Reply target message not found");
  }

  if (explicitThreadId && explicitThreadId !== parent.thread_id) {
    throw new HttpError(400, "invalid_payload", "thread_id must match the reply target thread");
  }

  return parent.thread_id;
}

export async function sendAgentMessage(
  env: Env,
  rawBody: unknown,
  options: PrincipalOptions
): Promise<SendAgentMessageResult> {
  const body = parseWithHttpError(sendAgentMessageSchema, rawBody);
  const tenantId = body.tenant_id ?? "default";
  const projectId = normalizeNullable(body.project_id ?? null);
  const idempotencyKey = normalizeNullable(body.idempotency_key);
  const existing = await findExistingByIdempotencyKey(env, tenantId, idempotencyKey);

  if (existing) {
    return {
      message_id: existing.id,
      thread_id: existing.thread_id,
      status: existing.status,
      deduped: true
    };
  }

  const now = Date.now();
  const messageId = ulid();
  const threadId = body.reply_to_message_id
    ? await resolveReplyThreadId(env, tenantId, body.reply_to_message_id, body.thread_id)
    : body.thread_id ?? messageId;

  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO agent_messages(
      id, tenant_id, project_id, thread_id, reply_to_message_id, sender_principal,
      target_type, target_key, subject, body, metadata_json, idempotency_key,
      status, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      messageId,
      tenantId,
      projectId,
      threadId,
      normalizeNullable(body.reply_to_message_id),
      options.principal,
      body.target_type,
      body.target_key.trim(),
      normalizeNullable(body.subject ?? null),
      body.body,
      body.metadata ? JSON.stringify(body.metadata) : null,
      idempotencyKey,
      "unread",
      now
    )
    .run();

  return {
    message_id: messageId,
    thread_id: threadId,
    status: "unread",
    deduped: false
  };
}

export async function listAgentMessages(
  env: Env,
  rawQuery: unknown,
  options: PrincipalOptions
): Promise<ListAgentMessagesResult> {
  const input = parseWithHttpError(listAgentMessagesSchema, rawQuery);
  const tenantId = input.tenant_id ?? "default";
  const target = resolveTarget(input, options.principal);
  const limit = input.limit ?? 50;
  const status = input.status ?? "active";
  const projectId = normalizeNullable(input.project_id ?? null);
  const clauses = ["tenant_id = ?", "target_type = ?", "target_key = ?"];
  const args: unknown[] = [tenantId, target.targetType, target.targetKey];

  if (status === "active") {
    clauses.push("status IN ('unread', 'read')");
  } else {
    clauses.push("status = ?");
    args.push(status);
  }

  if (projectId) {
    clauses.push("project_id = ?");
    args.push(projectId);
  }

  if (input.cursor) {
    clauses.push("created_at < ?");
    args.push(input.cursor);
  }

  args.push(limit);
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, thread_id, reply_to_message_id, sender_principal,
            target_type, target_key, subject, body, metadata_json, idempotency_key,
            status, created_at, read_at, acked_at, archived_at
     FROM agent_messages
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(...args)
    .all<AgentMessageRow>();

  const items = result.results.map(toAgentMessage);
  return {
    tenant_id: tenantId,
    target_type: target.targetType,
    target_key: target.targetKey,
    status,
    items,
    next_cursor: items.length === limit ? items[items.length - 1].created_at : null
  };
}

async function getTargetedMessage(
  env: Env,
  tenantId: string,
  messageId: string,
  target: Target
): Promise<AgentMessageRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, thread_id, reply_to_message_id, sender_principal,
            target_type, target_key, subject, body, metadata_json, idempotency_key,
            status, created_at, read_at, acked_at, archived_at
     FROM agent_messages
     WHERE tenant_id = ? AND id = ? AND target_type = ? AND target_key = ?`
  )
    .bind(tenantId, messageId, target.targetType, target.targetKey)
    .first<AgentMessageRow>();

  if (!row) {
    throw new HttpError(404, "message_not_found", "Agent message not found");
  }

  return row;
}

export async function getAgentMessage(
  env: Env,
  tenantId: string,
  messageId: string,
  rawQuery: unknown,
  options: PrincipalOptions
): Promise<AgentMessage> {
  const input = parseWithHttpError(agentMessageActionSchema, rawQuery);
  const target = resolveTarget(input, options.principal);
  return toAgentMessage(await getTargetedMessage(env, tenantId, messageId, target));
}

export async function markAgentMessageRead(
  env: Env,
  tenantId: string,
  messageId: string,
  rawBody: unknown,
  options: PrincipalOptions
): Promise<AgentMessage> {
  const input = parseWithHttpError(agentMessageActionSchema, rawBody);
  const target = resolveTarget(input, options.principal);
  const current = await getTargetedMessage(env, tenantId, messageId, target);

  if (current.status !== "unread") {
    return toAgentMessage(current);
  }

  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE agent_messages SET status = ?, read_at = ? WHERE tenant_id = ? AND id = ?"
  )
    .bind("read", now, tenantId, messageId)
    .run();

  return toAgentMessage({
    ...current,
    status: "read",
    read_at: now
  });
}

export async function ackAgentMessage(
  env: Env,
  tenantId: string,
  messageId: string,
  rawBody: unknown,
  options: PrincipalOptions
): Promise<AgentMessage> {
  const input = parseWithHttpError(agentMessageActionSchema, rawBody);
  const target = resolveTarget(input, options.principal);
  const current = await getTargetedMessage(env, tenantId, messageId, target);

  if (current.status === "acked") {
    return toAgentMessage(current);
  }

  if (!AGENT_MESSAGE_STATUSES.includes(current.status)) {
    throw new HttpError(500, "invalid_state", "Agent message has an invalid status");
  }

  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE agent_messages SET status = ?, acked_at = ?, read_at = COALESCE(read_at, ?) WHERE tenant_id = ? AND id = ?"
  )
    .bind("acked", now, now, tenantId, messageId)
    .run();

  return toAgentMessage({
    ...current,
    status: "acked",
    read_at: current.read_at ?? now,
    acked_at: now
  });
}
