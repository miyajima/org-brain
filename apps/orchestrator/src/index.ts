import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { createTaskSchema, sha256, type CapabilityName, type Envelope, type TaskCreatedPayload, ulid } from "@org-brain/shared";

type Env = {
  OPEN_BRAIN_DB: D1Database;
  ORG_BUS_OUT: Queue<Envelope<TaskCreatedPayload>>;
};

type WorkflowInput = {
  tenant_id: string;
  project_id: string;
  spec_ref: string;
};

type TaskResultEvent = {
  task_id: string;
  status: "succeeded" | "failed";
  output_ref?: string;
  error?: {
    code: string;
    message: string;
  };
};

type CreatedTask = {
  task_id: string;
  wait_event_type: string;
};

async function createTaskInternal(
  env: Env,
  input: {
    tenant_id: string;
    project_id: string;
    capability: CapabilityName;
    input_ref: string;
    trace_id: string;
    wait_event_type: string;
  }
): Promise<CreatedTask> {
  createTaskSchema.parse(input);
  const tenantId = input.tenant_id;
  const projectId = input.project_id;
  const capability = input.capability;
  const inputRef = input.input_ref;
  const traceId = input.trace_id;
  const waitEventType = input.wait_event_type;
  const now = Date.now();
  const idem = `${tenantId}:${capability}:${await sha256(`${inputRef}:${traceId}:${waitEventType}`)}`;

  const existing = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM tasks WHERE tenant_id = ? AND idempotency_key = ?"
  )
    .bind(tenantId, idem)
    .first<{ id: string }>();

  const taskId = existing?.id ?? ulid();

  if (!existing) {
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO tasks(id, tenant_id, project_id, capability, status, priority, input_ref, idempotency_key, trace_id, wait_event_type, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        taskId,
        tenantId,
        projectId,
        capability,
        "created",
        0,
        inputRef,
        idem,
        traceId,
        waitEventType,
        now,
        now
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)"
      ).bind(ulid(), tenantId, taskId, "created", JSON.stringify(input), now)
    ]);

    await env.ORG_BUS_OUT.send(
      {
        message_id: ulid(),
        tenant_id: tenantId,
        project_id: projectId,
        trace_id: traceId,
        type: "task.created",
        ts: now,
        idempotency_key: idem,
        payload: {
          task_id: taskId,
          capability,
          priority: 0,
          input_ref: inputRef,
          wait_event_type: waitEventType
        }
      },
      { contentType: "json" }
    );
  }

  return { task_id: taskId, wait_event_type: waitEventType };
}

function waitEventName(instanceId: string, stage: "plan" | "code" | "review"): string {
  return `task.${instanceId}.${stage}.done`;
}

function ensureSucceeded(stage: string, data: TaskResultEvent): string {
  if (data.status === "failed") {
    throw new Error(`${stage} failed: ${data.error?.message ?? "unknown error"}`);
  }

  if (!data.output_ref) {
    throw new Error(`${stage} missing output_ref`);
  }

  return data.output_ref;
}

async function fetchTaskState(env: Env, tenantId: string, taskId: string): Promise<{
  status: string;
  output_ref: string | null;
  wait_event_type: string | null;
}> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT status, output_ref, wait_event_type FROM tasks WHERE tenant_id = ? AND id = ?"
  )
    .bind(tenantId, taskId)
    .first<{ status: string; output_ref: string | null; wait_event_type: string | null }>();

  if (!row) {
    throw new Error(`task not found: ${taskId}`);
  }

  return row;
}

async function waitForTaskTerminal(
  step: WorkflowStep,
  env: Env,
  tenantId: string,
  taskId: string,
  waitEventType: string,
  label: "plan" | "code" | "review",
): Promise<string> {
  const initialState = await step.do(`${label}-status-initial`, async () =>
    fetchTaskState(env, tenantId, taskId)
  );
  if (initialState.status === "succeeded") {
    if (!initialState.output_ref) {
      throw new Error(`${label} succeeded but output_ref missing`);
    }
    return initialState.output_ref;
  }
  if (initialState.status === "failed" || initialState.status === "canceled") {
    throw new Error(`${label} task ended with status=${initialState.status}`);
  }

  const event = await step.waitForEvent<TaskResultEvent>(`${label}-wait-for-event`, {
    type: waitEventType,
    timeout: label === "plan" ? "30 minutes" : "2 hours"
  });
  const data = event.payload;
  if (data.task_id !== taskId) {
    throw new Error(`${label} got mismatched event task_id=${data.task_id}`);
  }

  return ensureSucceeded(label, data);
}

export class SpecToCodeWorkflow extends WorkflowEntrypoint<Env, WorkflowInput> {
  async run(event: WorkflowEvent<WorkflowInput>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const { tenant_id, project_id, spec_ref } = event.payload;

    const planTask = await step.do("create-plan-task", async () =>
      createTaskInternal(this.env, {
        tenant_id,
        project_id,
        capability: "plan_writer",
        input_ref: spec_ref,
        trace_id: event.instanceId,
        wait_event_type: waitEventName(event.instanceId, "plan")
      })
    );

    const planRef = await waitForTaskTerminal(
      step,
      this.env,
      tenant_id,
      planTask.task_id,
      planTask.wait_event_type,
      "plan"
    );

    const codeTask = await step.do("create-code-task", async () =>
      createTaskInternal(this.env, {
        tenant_id,
        project_id,
        capability: "code_gen",
        input_ref: planRef,
        trace_id: event.instanceId,
        wait_event_type: waitEventName(event.instanceId, "code")
      })
    );

    const codeRef = await waitForTaskTerminal(
      step,
      this.env,
      tenant_id,
      codeTask.task_id,
      codeTask.wait_event_type,
      "code"
    );

    const reviewTask = await step.do("create-review-task", async () =>
      createTaskInternal(this.env, {
        tenant_id,
        project_id,
        capability: "code_review",
        input_ref: codeRef,
        trace_id: event.instanceId,
        wait_event_type: waitEventName(event.instanceId, "review")
      })
    );

    const reviewRef = await waitForTaskTerminal(
      step,
      this.env,
      tenant_id,
      reviewTask.task_id,
      reviewTask.wait_event_type,
      "review"
    );

    return {
      ok: true,
      outputs: {
        plan: planRef,
        code: codeRef,
        review: reviewRef
      },
      tasks: {
        planTask,
        codeTask,
        reviewTask
      }
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
};
