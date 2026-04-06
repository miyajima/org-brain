import {
  type CapabilityName,
  type Envelope,
  type TaskCreatedPayload,
  type TaskResultPayload,
  ulid,
  validateEnvelope
} from "@org-brain/shared";
import { runCapability } from "./capabilities/runtime";
import { LeaseDO } from "./do/lease";
import { MailboxDO } from "./do/mailbox";
import { runScheduledMemoryMaintenance } from "./memory-maintenance";
import { previousUtcDay, pruneRetrievalEvents, rawRetentionCutoff, rollupRetrievalMetricsForDay } from "./retrieval-metrics";
import type { CapabilityContext, Env } from "./types";

export { LeaseDO, MailboxDO };

const METRICS_CRON = "5 0 * * *";
const MEMORY_MAINTENANCE_CRON = "30 18 * * *";

async function getCapabilityLimit(env: Env, tenantId: string, capability: CapabilityName): Promise<number> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT max_concurrency FROM capabilities WHERE tenant_id = ? AND name = ?"
  )
    .bind(tenantId, capability)
    .first<{ max_concurrency?: number }>();

  return row?.max_concurrency ?? 2;
}

async function acquireLease(
  env: Env,
  tenantId: string,
  capability: CapabilityName,
  taskId: string
): Promise<{ ok: true } | { ok: false; reason: "capacity" | "duplicate" | "unknown" }> {
  const max = await getCapabilityLimit(env, tenantId, capability);
  const id = env.LEASES.idFromName(`${tenantId}:${capability}`);
  const stub = env.LEASES.get(id);
  const res = await stub.fetch("https://leases/acquire", {
    method: "POST",
    body: JSON.stringify({ task_id: taskId, ttl_ms: 60_000, max_concurrency: max })
  });

  if (res.ok) return { ok: true };

  const payload = (await res.json().catch(() => null)) as { reason?: string } | null;
  if (payload?.reason === "capacity" || payload?.reason === "duplicate") {
    return { ok: false, reason: payload.reason };
  }

  return { ok: false, reason: "unknown" };
}

async function releaseLease(env: Env, tenantId: string, capability: CapabilityName, taskId: string): Promise<void> {
  const id = env.LEASES.idFromName(`${tenantId}:${capability}`);
  const stub = env.LEASES.get(id);
  await stub.fetch("https://leases/release", {
    method: "POST",
    body: JSON.stringify({ task_id: taskId })
  });
}

async function pushMailbox(
  env: Env,
  tenantId: string,
  workerId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const id = env.MAILBOX.idFromName(`${tenantId}:${workerId}`);
  const stub = env.MAILBOX.get(id);
  await stub.fetch("https://mailbox/push", {
    method: "POST",
    body: JSON.stringify({ type, payload, ts: Date.now() })
  });
}

async function markRunning(env: Env, tenantId: string, taskId: string): Promise<void> {
  const now = Date.now();
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").bind(
      "running",
      now,
      tenantId,
      taskId
    ),
    env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
    ).bind(ulid(), tenantId, taskId, "started", JSON.stringify({}), now)
  ]);
}

async function publishResult(
  env: Env,
  envelope: Envelope<TaskCreatedPayload>,
  payload: TaskResultPayload
): Promise<void> {
  const out: Envelope<TaskResultPayload> = {
    message_id: ulid(),
    tenant_id: envelope.tenant_id,
    project_id: envelope.project_id,
    trace_id: envelope.trace_id,
    type: "task.result",
    ts: Date.now(),
    idempotency_key: envelope.idempotency_key,
    payload
  };

  await env.ORG_BUS_OUT.send(out, { contentType: "json" });
}

function toContext(env: Env, envelope: Envelope<TaskCreatedPayload>): CapabilityContext {
  return {
    env,
    tenantId: envelope.tenant_id,
    projectId: envelope.project_id,
    taskId: envelope.payload.task_id,
    capability: envelope.payload.capability,
    inputRef: envelope.payload.input_ref
  };
}

async function processMessage(env: Env, raw: unknown): Promise<void> {
  if (!validateEnvelope(raw)) {
    throw new Error("invalid envelope");
  }

  const envelope = raw as Envelope<TaskCreatedPayload>;
  if (envelope.type !== "task.created") {
    return;
  }

  const { tenant_id: tenantId } = envelope;
  const { task_id: taskId, capability } = envelope.payload;

  const lease = await acquireLease(env, tenantId, capability, taskId);
  if (!lease.ok) {
    // Queue redelivery for the same task can happen. Drop duplicate runs safely.
    if (lease.reason === "duplicate") return;
    if (lease.reason === "unknown") throw new Error("lease acquire failed");
    throw new Error("capacity");
  }

  try {
    await markRunning(env, tenantId, taskId);
    const result = await runCapability(toContext(env, envelope));

    await publishResult(env, envelope, {
      task_id: taskId,
      capability,
      status: "succeeded",
      output_ref: result.outputRef,
      wait_event_type: envelope.payload.wait_event_type
    });

    await pushMailbox(env, tenantId, "runner", "task.completed", {
      task_id: taskId,
      capability,
      output_ref: result.outputRef
    });
  } catch (error) {
    await pushMailbox(env, tenantId, "runner", "task.failed", {
      task_id: taskId,
      capability,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  } finally {
    await releaseLease(env, tenantId, capability, taskId);
  }
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "capacity" ||
    error.message === "lease acquire failed" ||
    error.message.includes("not found")
  );
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processMessage(env, msg.body);
        msg.ack();
      } catch (error) {
        if (shouldRetry(error) && msg.attempts < 3) {
          msg.retry({ delaySeconds: Math.min(30 * (2 ** msg.attempts), 300) });
          continue;
        }

        const envelope = msg.body as Envelope<TaskCreatedPayload>;
        if (validateEnvelope(envelope) && envelope.type === "task.created") {
          await publishResult(env, envelope, {
            task_id: envelope.payload.task_id,
            capability: envelope.payload.capability,
            status: "failed",
            error: {
              code: "capability_error",
              message: error instanceof Error ? error.message : String(error)
            },
            wait_event_type: envelope.payload.wait_event_type
          });
        }

        msg.ack();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = controller.scheduledTime ?? Date.now();
    const cron = controller.cron ?? METRICS_CRON;

    if (cron === METRICS_CRON) {
      await rollupRetrievalMetricsForDay(env.OPEN_BRAIN_DB, previousUtcDay(now), now);
      await pruneRetrievalEvents(env.OPEN_BRAIN_DB, rawRetentionCutoff(now));
      return;
    }

    if (cron === MEMORY_MAINTENANCE_CRON) {
      await runScheduledMemoryMaintenance(env.OPEN_BRAIN_DB, now);
    }
  },

  async fetch(): Promise<Response> {
    return new Response("ok");
  }
};
