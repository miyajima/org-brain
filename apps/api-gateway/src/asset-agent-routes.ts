import { agentContextPreviewSchema } from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import { createAgent, getAgent, listAgents, resolveAgentLoadoutContext, updateAgent, updateAgentLoadout } from "./agent-loadout-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { availableSkillProviders, createSkillAsset, createSkillVersion, exportSkillAsset, generateSkillAsset, getSkillAsset, listSkillAssets, publishSkillAsset, retireSkillAsset } from "./skill-asset-service";
import { authorizePermission } from "./rbac-service";
import { getVerifiedIngestionManifest, ingestVerifiedKnowledgeBundle, listVerifiedManifestsByCollector, registerCollectorKey, revokeCollectorKey } from "./verified-ingestion-service";
import type { Hono } from "hono";
import { assertDecisionConsoleEnabled, isTenantAdmin, requireIdempotencyKey } from "./route-support";

export function registerAssetAgentRoutes(app: Hono<ApiContextEnv>): void {
app.post("/v1/memory-collectors/keys", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  if (!await isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return jsonOk(c, await registerCollectorKey(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.post("/v1/memory-collectors/keys/:id/revoke", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  if (!await isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return jsonOk(c, await revokeCollectorKey(c.env, tenantId, c.req.param("id"), getApiPrincipal(c)));
});

app.get("/v1/memory-collectors/keys/:id/manifests", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await isTenantAdmin(c, tenantId)) throw new HttpError(403, "forbidden", "Tenant admin role is required");
  return jsonOk(c, await listVerifiedManifestsByCollector(c.env, tenantId, c.req.param("id")));
});

app.post("/v1/memory-ingestions/verified", async (c) => {
  const body = await c.req.json<unknown>();
  const bundle = body && typeof body === "object" && !Array.isArray(body) && "bundle" in body
    ? (body as Record<string, unknown>).bundle
    : body;
  const tenantId = assertApiTenantAccess(c, tenantFromBody(bundle));
  const principal = getApiPrincipal(c);
  const projectId = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? ((bundle as Record<string, unknown>).project_id as string | null | undefined) ?? null
    : null;
  const publish = await authorizePermission(c.env, {
    tenantId,
    projectId,
    principal,
    permission: "memory:attest",
    fallbackRole: getApiAuthContext(c).defaultRole
  });
  return jsonOk(c, await ingestVerifiedKnowledgeBundle(c.env, tenantId, body, principal, {
    publishAuthorized: publish.allowed,
    allowShadow: false
  }), 202);
});

app.get("/v1/memory-ingestions/verified/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getVerifiedIngestionManifest(c.env, tenantId, c.req.param("id"), getApiPrincipal(c)));
});

app.get("/v1/skill-providers", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, { providers: availableSkillProviders(c.env) });
});

app.post("/v1/skills/generate", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? { ...body as Record<string, unknown>, idempotency_key: requireIdempotencyKey(c) }
    : body;
  return jsonOk(c, await generateSkillAsset(c.env, payload, {
    tenantId,
    actorPrincipal: getApiPrincipal(c)
  }), 202);
});

app.get("/v1/skills", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listSkillAssets(c.env, {
    tenantId,
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    q: c.req.query("q") ?? null,
    status: c.req.query("status") ?? null,
    limit: Number(c.req.query("limit") ?? 50)
  }));
});

app.post("/v1/skills", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createSkillAsset(c.env, body, {
    tenantId,
    actorPrincipal: getApiPrincipal(c)
  }), 201);
});

app.get("/v1/skills/:id/export", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await exportSkillAsset(c.env, {
    tenantId,
    assetId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    versionId: c.req.query("version_id") ?? null
  }));
});

app.get("/v1/skills/:id", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getSkillAsset(c.env, {
    tenantId,
    assetId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

app.post("/v1/skills/:id/versions", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  return jsonOk(c, await createSkillVersion(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: getApiPrincipal(c),
    isAdmin: await isTenantAdmin(c, tenantId)
  }), 201);
});

app.post("/v1/skills/:id/publish", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  return jsonOk(c, await publishSkillAsset(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: getApiPrincipal(c),
    isAdmin: await isTenantAdmin(c, tenantId)
  }));
});

app.post("/v1/skills/:id/retire", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  return jsonOk(c, await retireSkillAsset(c.env, tenantId, c.req.param("id"), {
    actorPrincipal: getApiPrincipal(c),
    isAdmin: await isTenantAdmin(c, tenantId)
  }));
});

app.get("/v1/agents", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listAgents(c.env, {
    tenantId,
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    limit: Number(c.req.query("limit") ?? 50)
  }));
});

app.post("/v1/agents", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createAgent(c.env, body, {
    tenantId,
    actorPrincipal: getApiPrincipal(c)
  }), 201);
});

app.get("/v1/agents/:id", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getAgent(c.env, {
    tenantId,
    agentId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

app.patch("/v1/agents/:id", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  return jsonOk(c, await updateAgent(c.env, tenantId, c.req.param("id"), body, {
    actorPrincipal: getApiPrincipal(c),
    isAdmin: await isTenantAdmin(c, tenantId)
  }));
});

app.put("/v1/agents/:id/loadouts/:loadoutId", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body) ?? c.req.query("tenant_id"));
  return jsonOk(c, await updateAgentLoadout(
    c.env,
    tenantId,
    c.req.param("id"),
    c.req.param("loadoutId"),
    body,
    { actorPrincipal: getApiPrincipal(c), isAdmin: await isTenantAdmin(c, tenantId) }
  ));
});

app.post("/v1/agents/:id/context-preview", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const parsed = agentContextPreviewSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid preview request");
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id ?? c.req.query("tenant_id"));
  const agent = await getAgent(c.env, {
    tenantId,
    agentId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  });
  return jsonOk(c, await resolveAgentLoadoutContext(c.env, {
    tenantId,
    agentKey: agent.agent.agent_key,
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    taskText: parsed.data.task_text,
    maxTokens: parsed.data.max_tokens,
    recordUsage: parsed.data.record_usage,
    usageEvent: "previewed"
  }));
});
}
