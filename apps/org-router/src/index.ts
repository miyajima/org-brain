import {
  ulid,
  type Envelope,
  type TaskCreatedPayload,
  type TaskResultPayload,
  validateEnvelope,
  validateTaskResultPayload
} from "@org-brain/shared";
import type { Env } from "./types";

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    return !error.message.includes("invalid");
  }
  return false;
}

async function appendEvent(
  env: Env,
  tenantId: string,
  taskId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
  )
    .bind(ulid(), tenantId, taskId, kind, JSON.stringify(payload), Date.now())
    .run();
}

async function routeCreated(env: Env, message: Envelope<TaskCreatedPayload>) {
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE tasks SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
  )
    .bind("queued", Date.now(), message.tenant_id, message.payload.task_id)
    .run();

  await appendEvent(env, message.tenant_id, message.payload.task_id, "queued", {
    capability: message.payload.capability
  });

  await env.CAP_PLAN_OUT.send(message, { contentType: "json" });
}

async function handleResult(env: Env, message: Envelope<TaskResultPayload>) {
  if (!validateTaskResultPayload(message.payload)) {
    throw new Error("invalid task.result payload");
  }

  const now = Date.now();
  if (message.payload.status === "succeeded") {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE tasks SET status = ?, output_ref = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
    )
      .bind("succeeded", message.payload.output_ref, now, message.tenant_id, message.payload.task_id)
      .run();

    await appendEvent(env, message.tenant_id, message.payload.task_id, "completed", {
      output_ref: message.payload.output_ref
    });
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
    )
      .bind("failed", now, message.tenant_id, message.payload.task_id)
      .run();

    await appendEvent(env, message.tenant_id, message.payload.task_id, "failed", {
      error: message.payload.error
    });
  }
}

export async function handleEnvelope(env: Env, raw: unknown): Promise<void> {
  if (!validateEnvelope(raw)) {
    throw new Error("invalid envelope");
  }

  const message = raw as Envelope<TaskCreatedPayload | TaskResultPayload>;
  if (message.type === "task.created") {
    await routeCreated(env, message as Envelope<TaskCreatedPayload>);
  } else if (message.type === "task.result") {
    await handleResult(env, message as Envelope<TaskResultPayload>);
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleEnvelope(env, msg.body);
        msg.ack();
      } catch (error) {
        if (isRetryableError(error)) {
          msg.retry({ delaySeconds: Math.min(60 * (2 ** msg.attempts), 600) });
        } else {
          msg.ack();
        }
      }
    }
  },

  async fetch(): Promise<Response> {
    return new Response("ok");
  }
};
