import { HttpError } from "@org-brain/shared";
import { listAuditEvents, parseAuditLimit, verifyAuditChain } from "./audit-service";
import { backfillV3RetrievalUnits, backfillV4RetrievalUnits, rebuildSemanticIndex } from "./retrieval-index-service";
import { getOperationsStatus } from "./operations-service";
import { applyRetentionPolicies, listRetentionPolicies, upsertRetentionPolicy } from "./retention-service";
import { cancelRetentionQueue, listRetentionQueue, type RetentionQueueStatus } from "./retention-queue-service";
import { assertApiTenantAccess, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { backfillDecisionRetrievalUnits } from "./context-engine-service";
import { replayFailedTask } from "./task-service";
import type { Hono } from "hono";

export function registerOperationsRoutes(app: Hono<ApiContextEnv>): void {
app.get("/v1/retention-policies", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listRetentionPolicies(c.env, tenantId));
});

app.put("/v1/retention-policies", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertRetentionPolicy(c.env, tenantId, body, getApiPrincipal(c)));
});

app.post("/v1/retention-policies/apply", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await applyRetentionPolicies(c.env, tenantId, body, getApiPrincipal(c)));
});

app.get("/v1/retention-queue", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const rawStatus = c.req.query("status");
  const statuses: RetentionQueueStatus[] = ["pending", "deleted", "cancelled", "failed", "manual_review"];
  if (rawStatus && !statuses.includes(rawStatus as RetentionQueueStatus)) {
    throw new HttpError(400, "invalid_payload", "invalid retention queue status");
  }
  const rawLimit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    throw new HttpError(400, "invalid_payload", "limit must be between 1 and 500");
  }
  return jsonOk(c, await listRetentionQueue(c.env, tenantId, {
    status: rawStatus as RetentionQueueStatus | undefined,
    limit: rawLimit
  }));
});

app.post("/v1/retention-queue/cancel", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; ids?: unknown }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    throw new HttpError(400, "invalid_payload", "ids must be an array of strings");
  }
  return jsonOk(c, await cancelRetentionQueue(c.env, tenantId, body.ids));
});

app.get("/v1/audit-events", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listAuditEvents(c.env, tenantId, parseAuditLimit(c.req.query("limit"))));
});

app.get("/v1/audit-events/verify", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await verifyAuditChain(c.env, tenantId));
});

app.post("/v1/retrieval-index/rebuild", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; project_id?: string | null }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await rebuildSemanticIndex(c.env, tenantId, body.project_id));
});

app.post("/v1/retrieval-index/v3/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillV3RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.post("/v1/retrieval-index/v4/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillV4RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.post("/v1/retrieval-index/v4/decisions/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillDecisionRetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.get("/v1/ops/status", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getOperationsStatus(c.env, tenantId));
});

app.post("/v1/ops/tasks/:id/replay", async (c) => {
  const body: { tenant_id?: string } = await c.req.json<{ tenant_id?: string }>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, body.tenant_id);
  return jsonOk(c, await replayFailedTask(
    c.env,
    tenantId,
    c.req.param("id"),
    getApiPrincipal(c)
  ), 201);
});
}
