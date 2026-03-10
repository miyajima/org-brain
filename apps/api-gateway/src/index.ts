import { HttpError, workflowStartSchema } from "@org-brain/shared";
import { Hono } from "hono";
import { apiKeyAuth, jsonOk } from "./auth";
import { listMemories, upsertMemories } from "./memory-service";
import { mountMcp, OrgBrainMCP } from "./mcp";
import { createTask, getTask, getTaskEvents, listTasks } from "./task-service";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

mountMcp(app);

app.use("/v1/*", apiKeyAuth);

app.post("/v1/tasks", async (c) => {
  const body = await c.req.json<unknown>();
  const created = await createTask(c.env, body);
  return jsonOk(c, created, 201);
});

app.get("/v1/tasks", async (c) => {
  const tenantId = c.req.query("tenant_id") ?? "default";
  const status = c.req.query("status");
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const tasks = await listTasks(c.env, tenantId, Number.isNaN(limit) ? 50 : limit, status);
  return jsonOk(c, tasks);
});

app.get("/v1/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = c.req.query("tenant_id") ?? "default";
  const task = await getTask(c.env, tenantId, taskId);
  return jsonOk(c, task);
});

app.get("/v1/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = c.req.query("tenant_id") ?? "default";
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const events = await getTaskEvents(c.env, tenantId, taskId, Number.isNaN(limit) ? 50 : limit, cursor);
  return jsonOk(c, events);
});

app.get("/v1/memories", async (c) => {
  const tenantId = c.req.query("tenant_id") ?? "default";
  const source = c.req.query("source");
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const memories = await listMemories(c.env, tenantId, Number.isNaN(limit) ? 100 : limit, source);
  return jsonOk(c, memories);
});

app.post("/v1/memories/upsert", async (c) => {
  const body = await c.req.json<unknown>();
  const result = await upsertMemories(c.env, body);
  return jsonOk(c, result, 201);
});

app.post("/v1/workflows/spec-to-code", async (c) => {
  const body = workflowStartSchema.parse(await c.req.json<unknown>());
  const instance = await c.env.WF_SPEC2CODE.create({
    id: `${body.project_id}-${Date.now()}`,
    params: {
      tenant_id: body.tenant_id ?? "default",
      project_id: body.project_id,
      spec_ref: body.spec_ref
    }
  });

  return jsonOk(c, { instance_id: instance.id }, 201);
});

app.get("/v1/workflows/spec-to-code/:instanceId", async (c) => {
  const instanceId = c.req.param("instanceId");
  const instance = await c.env.WF_SPEC2CODE.get(instanceId);
  const status = await instance.status();
  return jsonOk(c, status);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { ok: false, error: { code: err.code, message: err.message } },
      { status: err.status as 500 }
    );
  }

  return c.json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: err instanceof Error ? err.message : "Unexpected error"
      }
    },
    { status: 500 }
  );
});

app.notFound((c) =>
  c.json({ ok: false, error: { code: "not_found", message: "Route not found" } }, { status: 404 })
);

export default app;
export { OrgBrainMCP };
