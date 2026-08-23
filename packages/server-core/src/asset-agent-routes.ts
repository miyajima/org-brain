import { agentContextPreviewSchema } from "@org-brain/contracts";
import { HttpError } from "./errors.js";
import type { AssetAgentPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerAssetAgentRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: AssetAgentPort<TEnv>
): void {
const routes = withRouteContracts(app, "asset-agent");
routes.post("/v1/memory-collectors/keys", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return ports.jsonOk(c, await ports.registerCollectorKey(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.post("/v1/memory-collectors/keys/:id/revoke", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return ports.jsonOk(c, await ports.revokeCollectorKey(c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c)));
});

routes.get("/v1/memory-collectors/keys/:id/manifests", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return ports.jsonOk(c, await ports.listVerifiedManifestsByCollector(c.env, tenantId, c.req.param("id")));
});

routes.post("/v1/memory-ingestions/verified", async (c) => {
  const body = await c.req.json<unknown>();
  const bundle = body && typeof body === "object" && !Array.isArray(body) && "bundle" in body
    ? (body as Record<string, unknown>).bundle
    : body;
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(bundle));
  const principal = ports.getApiPrincipal(c);
  const projectId = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? ((bundle as Record<string, unknown>).project_id as string | null | undefined) ?? null
    : null;
  const publish = await ports.authorizePermission(c.env, {
    tenantId,
    projectId,
    principal,
    permission: "memory:attest",
    fallbackRole: ports.getApiAuthContext(c).defaultRole
  });
  return ports.jsonOk(c, await ports.ingestVerifiedKnowledgeBundle(c.env, tenantId, body, principal, {
    publishAuthorized: publish.allowed,
    allowShadow: false
  }), 202);
});

routes.get("/v1/memory-ingestions/verified/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getVerifiedIngestionManifest(c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c)));
});

routes.get("/v1/skill-providers", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, { providers: ports.availableSkillProviders(c.env) });
});

routes.post("/v1/skills/generate", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? { ...body as Record<string, unknown>, idempotency_key: ports.requireIdempotencyKey(c) }
    : body;
  return ports.jsonOk(c, await ports.generateSkillAsset(c.env, payload, {
    tenantId,
    actorPrincipal: ports.getApiPrincipal(c)
  }), 202);
});

routes.get("/v1/skills", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listSkillAssets(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    q: c.req.query("q") ?? null,
    status: c.req.query("status") ?? null,
    limit: Number(c.req.query("limit") ?? 50)
  }));
});

routes.post("/v1/skills", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createSkillAsset(c.env, body, {
    tenantId,
    actorPrincipal: ports.getApiPrincipal(c)
  }), 201);
});

routes.get("/v1/skills/:id/export", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.exportSkillAsset(c.env, {
    tenantId,
    assetId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    versionId: c.req.query("version_id") ?? null
  }));
});

routes.get("/v1/skills/:id", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getSkillAsset(c.env, {
    tenantId,
    assetId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

routes.post("/v1/skills/:id/versions", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.createSkillVersion(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: ports.getApiPrincipal(c),
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }), 201);
});

routes.post("/v1/skills/:id/publish", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.publishSkillAsset(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: ports.getApiPrincipal(c),
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.post("/v1/skills/:id/retire", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.retireSkillAsset(c.env, tenantId, c.req.param("id"), {
    actorPrincipal: ports.getApiPrincipal(c),
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.get("/v1/agents", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listAgents(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    limit: Number(c.req.query("limit") ?? 50)
  }));
});

routes.post("/v1/agents", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createAgent(c.env, body, {
    tenantId,
    actorPrincipal: ports.getApiPrincipal(c)
  }), 201);
});

routes.get("/v1/agents/:id", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getAgent(c.env, {
    tenantId,
    agentId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

routes.patch("/v1/agents/:id", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.updateAgent(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: ports.getApiPrincipal(c),
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.put("/v1/agents/:id/loadouts/:loadoutId", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.updateAgentLoadout(
    c.env,
    tenantId,
    c.req.param("id"),
    c.req.param("loadoutId"),
    body,
    { actorPrincipal: ports.getApiPrincipal(c), isAdmin: await ports.isTenantAdmin(c, tenantId) }
  ));
});

routes.post("/v1/agents/:id/context-preview", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const parsed = agentContextPreviewSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid preview request");
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id ?? c.req.query("tenant_id"));
  const agent = await ports.getAgent(c.env, {
    tenantId,
    agentId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  });
  return ports.jsonOk(c, await ports.resolveAgentLoadoutContext(c.env, {
    tenantId,
    agentKey: agent.agent.agent_key,
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    taskText: parsed.data.task_text,
    maxTokens: parsed.data.max_tokens,
    recordUsage: parsed.data.record_usage,
    usageEvent: "previewed"
  }));
});
}
