import { parseLimitParam } from "./limit-param.js";
import { HttpError } from "./errors.js";
import type { OperationsPort, TypedOperationsPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";
import type { RetrievalBackfillOptions } from "@org-brain/contracts";

type RetentionQueueStatus = "pending" | "deleted" | "cancelled" | "failed" | "manual_review";

function requestObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_payload", "request body must be an object");
  return body as Record<string, unknown>;
}

function backfillOptions(tenantId: string, body: Record<string, unknown>): RetrievalBackfillOptions {
  const { project_id: projectId, cursor, limit } = body;
  if (projectId != null && typeof projectId !== "string") throw new HttpError(400, "invalid_payload", "project_id must be a string or null");
  if (cursor != null && typeof cursor !== "string") throw new HttpError(400, "invalid_payload", "cursor must be a string or null");
  return { tenantId, projectId, cursor, limit };
}

export function registerOperationsRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  legacyPorts: OperationsPort<TEnv>
): void {
const ports: TypedOperationsPort<TEnv> = legacyPorts;
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
  const rawLimit = parseLimitParam(c.req.query("limit"), { field: "limit", min: 1, max: 500, fallback: 100 });
  return ports.jsonOk(c, await ports.listRetentionQueue(c.env, tenantId, {
    status: rawStatus as RetentionQueueStatus | undefined,
    limit: rawLimit
  }));
});

routes.post("/v1/retention-queue/cancel", async (c) => {
  const rawBody = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(rawBody));
  const body = requestObject(rawBody);
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
  const rawBody = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(rawBody));
  const projectId = requestObject(rawBody).project_id;
  if (projectId != null && typeof projectId !== "string") throw new HttpError(400, "invalid_payload", "project_id must be a string or null");
  return ports.jsonOk(c, await ports.rebuildSemanticIndex(c.env, tenantId, projectId));
});

routes.post("/v1/retrieval-index/v3/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillV3RetrievalUnits(c.env, backfillOptions(tenantId, requestObject(body))));
});

routes.post("/v1/retrieval-index/v4/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillV4RetrievalUnits(c.env, backfillOptions(tenantId, requestObject(body))));
});

routes.post("/v1/retrieval-index/v4/decisions/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillDecisionRetrievalUnits(c.env, backfillOptions(tenantId, requestObject(body))));
});

routes.get("/v1/ops/status", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getOperationsStatus(c.env, tenantId));
});

routes.post("/v1/ops/tasks/:id/replay", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const requested = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).tenant_id : undefined;
  const tenantId = ports.assertApiTenantAccess(c, typeof requested === "string" ? requested : undefined);
  requestObject(body);
  if (requested != null && typeof requested !== "string") throw new HttpError(400, "invalid_payload", "tenant_id must be a string or null");
  return ports.jsonOk(c, await ports.replayFailedTask(
    c.env,
    tenantId,
    c.req.param("id"),
    ports.getApiPrincipal(c)
  ), 201);
});
}
