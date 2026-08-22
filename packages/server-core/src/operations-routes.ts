import { HttpError } from "./errors.js";
import type { OperationsPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

type RetentionQueueStatus = "pending" | "deleted" | "cancelled" | "failed" | "manual_review";

export function registerOperationsRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: OperationsPort<TEnv>
): void {
const routes = withRouteContracts(app, "operations");
routes.get("/v1/retention-policies", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listRetentionPolicies(c.env, tenantId));
});

routes.put("/v1/retention-policies", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.upsertRetentionPolicy(c.env, tenantId, body, ports.getApiPrincipal(c)));
});

routes.post("/v1/retention-policies/apply", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.applyRetentionPolicies(c.env, tenantId, body, ports.getApiPrincipal(c)));
});

routes.get("/v1/retention-queue", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const rawStatus = c.req.query("status");
  const statuses: RetentionQueueStatus[] = ["pending", "deleted", "cancelled", "failed", "manual_review"];
  if (rawStatus && !statuses.includes(rawStatus as RetentionQueueStatus)) {
    throw new HttpError(400, "invalid_payload", "invalid retention queue status");
  }
  const rawLimit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    throw new HttpError(400, "invalid_payload", "limit must be between 1 and 500");
  }
  return ports.jsonOk(c, await ports.listRetentionQueue(c.env, tenantId, {
    status: rawStatus as RetentionQueueStatus | undefined,
    limit: rawLimit
  }));
});

routes.post("/v1/retention-queue/cancel", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; ids?: unknown }>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    throw new HttpError(400, "invalid_payload", "ids must be an array of strings");
  }
  return ports.jsonOk(c, await ports.cancelRetentionQueue(c.env, tenantId, body.ids));
});

routes.get("/v1/audit-events", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listAuditEvents(c.env, tenantId, ports.parseAuditLimit(c.req.query("limit"))));
});

routes.get("/v1/audit-events/verify", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.verifyAuditChain(c.env, tenantId));
});

routes.post("/v1/retrieval-index/rebuild", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; project_id?: string | null }>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.rebuildSemanticIndex(c.env, tenantId, body.project_id));
});

routes.post("/v1/retrieval-index/v3/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillV3RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

routes.post("/v1/retrieval-index/v4/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillV4RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

routes.post("/v1/retrieval-index/v4/decisions/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillDecisionRetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

routes.get("/v1/ops/status", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getOperationsStatus(c.env, tenantId));
});

routes.post("/v1/ops/tasks/:id/replay", async (c) => {
  const body: { tenant_id?: string } = await c.req.json<{ tenant_id?: string }>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, body.tenant_id);
  return ports.jsonOk(c, await ports.replayFailedTask(
    c.env,
    tenantId,
    c.req.param("id"),
    ports.getApiPrincipal(c)
  ), 201);
});
}
