import { HttpError, runRecordedScheduledJob, type OrgPermission } from "@org-brain/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { appendAuditEvent } from "./audit-service";
import { runOpsWatchdog } from "./ops-watchdog-service";
import { assertRequestRateLimit } from "./rate-limit-service";
import { runScheduledRetentionSweep } from "./retention-queue-service";
import { apiKeyAuth, assertApiTenantAccess, getApiAuthContext, tenantFromBody, type ApiContextEnv } from "./auth";
import { assertSessionCsrf } from "./email-auth-service";
import { mountMcp } from "./mcp";
import { assertPermission } from "./rbac-service";
import type { Env } from "./types";
import { registerDomainRoutes } from "./domain-routes";
import { registerAssetAgentRoutes } from "./asset-agent-routes";
import { registerDashboardAccessRoutes } from "./dashboard-access-routes";
import { registerIdentityRoutes } from "./identity-routes";
import { registerOperationsRoutes } from "./operations-routes";
import { registerCollaborationRoutes } from "./collaboration-routes";
import { registerMemoryRoutes } from "./memory-routes";
import { registerDecisionContextRoutes } from "./decision-context-routes";

const app = new Hono<ApiContextEnv>();

app.post("/internal/ops/watchdog/run", async (c) => {
  const expected = c.env.OPS_WATCHDOG_TOKEN?.trim();
  if (!expected) throw new HttpError(503, "watchdog_not_configured", "OPS_WATCHDOG_TOKEN is not configured");
  if (c.req.header("authorization") !== `Bearer ${expected}`) {
    throw new HttpError(401, "unauthorized", "Invalid watchdog token");
  }
  return c.json(await runOpsWatchdog(c.env));
});

mountMcp(app);

app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization", "x-idempotency-key", "x-csrf-token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization", "x-idempotency-key", "x-csrf-token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);

app.use("/v1/*", apiKeyAuth);
app.use("/api/*", apiKeyAuth);

function permissionForRequest(method: string, path: string): OrgPermission {
  if (path.startsWith("/v1/auth/")) return method === "GET" ? "read" : "write";
  if (path.startsWith("/v1/mcp-client-installations")) return "read";
  if (
    path === "/v1/organization" ||
    path.startsWith("/v1/users") ||
    path.startsWith("/v1/role-assignments") ||
    path.startsWith("/v1/groups") ||
    path.startsWith("/v1/scoped-tokens") ||
    path.startsWith("/v1/retention-policies") ||
    path.startsWith("/v1/retention-queue") ||
    path.startsWith("/v1/ops/") ||
    path.startsWith("/v1/retrieval-index") ||
    path.startsWith("/v1/retrieval-ranking-profiles") ||
    path.startsWith("/v1/retrieval-generations") ||
    path.startsWith("/v1/retrieval-generation-assignments") ||
    (path.startsWith("/v1/domain-packs/installations") && method !== "GET") ||
    path.startsWith("/v1/portable-imports") ||
    path.endsWith("/promotion") ||
    path === "/v1/resources/backfill" ||
    path.startsWith("/v1/memory-collectors/keys")
  ) return "admin";
  if (path.startsWith("/v1/business-categories")) return method === "GET" ? "read" : "admin";
  if (path.startsWith("/v1/resource-shares")) return method === "GET" ? "read" : "share";
  if (path.startsWith("/v1/access-policies")) return method === "GET" ? "read" : "share";
  if (path.startsWith("/v1/audit-events")) return "export";
  if (
    path.endsWith("/search") ||
    path.endsWith("/profile") ||
    path.endsWith("/context") ||
    path.endsWith("/context-preview") ||
    path.endsWith("/review-queue") ||
    path.startsWith("/v1/context/") ||
    path === "/api/context/enrich"
  ) return "read";
  if (method === "DELETE") return "delete";
  if (path.includes("/export")) return "export";
  if (method === "GET") return "read";
  return "write";
}

const rbacAuditMiddleware: MiddlewareHandler<ApiContextEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }
  if (c.req.path === "/v1/auth/email/request-code" || c.req.path === "/v1/auth/email/verify") {
    await next();
    return;
  }
  const clonedBody = !["GET", "HEAD", "DELETE"].includes(c.req.method)
    ? await c.req.raw.clone().json().catch(() => ({}))
    : {};
  const tenantId = assertApiTenantAccess(
    c,
    c.req.query("tenant_id") || tenantFromBody(clonedBody)
  );
  const bodyRecord = clonedBody && typeof clonedBody === "object"
    ? clonedBody as Record<string, unknown>
    : {};
  const projectId = (
    c.req.query("project_id") ||
    (typeof bodyRecord.project_id === "string" ? bodyRecord.project_id : null)
  )?.trim() || null;
  const auth = getApiAuthContext(c);
  const permission = permissionForRequest(c.req.method, c.req.path);
  const auditBase = {
    tenantId,
    projectId,
    principal: auth.principal,
    action: `${c.req.method} ${c.req.path}`,
    resourceType: c.req.path.split("/").filter(Boolean)[1] ?? "api",
    resourceId: c.req.param("memoryId") || c.req.param("id") || null,
    requestId: c.req.header("x-request-id") || c.req.header("cf-ray") || null,
    metadata: { permission }
  } as const;
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (auth.source === "session") {
        const allowedOrigin = c.env.SESSION_ALLOWED_ORIGIN?.trim();
        if (!allowedOrigin) throw new HttpError(500, "misconfigured", "SESSION_ALLOWED_ORIGIN is required for session mutations");
        if (c.req.header("origin") !== allowedOrigin) throw new HttpError(403, "origin_failed", "Request origin is not allowed");
      }
      await assertSessionCsrf(auth, c.req.header("x-csrf-token"));
    }
    await assertRequestRateLimit(c.env, {
      tenantId,
      principal: auth.principal,
      path: c.req.path
    });
    if (auth.scopes && !auth.scopes.includes(permission)) {
      throw new HttpError(403, "forbidden", `Scoped token lacks ${permission} permission`);
    }
    if (auth.projectId && auth.projectId !== projectId) {
      throw new HttpError(403, "forbidden", `Scoped token is restricted to project "${auth.projectId}"`);
    }
    await assertPermission(c.env, {
      tenantId,
      projectId,
      principal: auth.principal,
      permission,
      fallbackRole: auth.defaultRole
    });
  } catch (error) {
    await appendAuditEvent(c.env, { ...auditBase, outcome: "denied" });
    throw error;
  }
  try {
    await next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      await appendAuditEvent(c.env, {
        ...auditBase,
        outcome: c.res.status < 400 ? "succeeded" : "failed",
        metadata: { permission, status: c.res.status }
      });
    }
  } catch (error) {
    await appendAuditEvent(c.env, { ...auditBase, outcome: "failed" });
    throw error;
  }
};

app.use("/v1/*", rbacAuditMiddleware);
app.use("/api/*", rbacAuditMiddleware);

registerDomainRoutes(app);
registerAssetAgentRoutes(app);
registerDashboardAccessRoutes(app);
registerIdentityRoutes(app);
registerOperationsRoutes(app);
registerCollaborationRoutes(app);
registerMemoryRoutes(app);
registerDecisionContextRoutes(app);

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

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledFor = controller.scheduledTime ?? Date.now();
    await runRecordedScheduledJob(env.OPEN_BRAIN_DB, {
      jobName: "retention-sweep",
      scheduledFor,
      now: scheduledFor
    }, async () => runScheduledRetentionSweep(env, scheduledFor));
  }
};
