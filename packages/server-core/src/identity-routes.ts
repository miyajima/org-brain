import type { IdentityPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerIdentityRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: IdentityPort<TEnv>
): void {
const routes = withRouteContracts(app, "identity");
routes.post("/v1/auth/email/request-code", async (c) => {
  const body = await c.req.json<unknown>();
  const requestIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const result = await ports.requestEmailCode(c.env, body, requestIp);
  return c.json({ ok: true as const, data: result }, 202);
});

routes.post("/v1/auth/email/verify", async (c) => {
  const body = await c.req.json<unknown>();
  const result = await ports.verifyEmailCode(c.env, body);
  await ports.appendAuditEvent(c.env, {
    tenantId: result.user.tenant_id,
    principal: result.user.principal,
    action: "auth.email.verify",
    resourceType: "session",
    outcome: "succeeded",
    requestId: c.req.header("x-request-id") || c.req.header("cf-ray") || null,
    metadata: { auth_source: "email" }
  });
  c.header(
    "set-cookie",
    `${ports.sessionCookie}=${encodeURIComponent(result.session_token)}; Max-Age=${ports.sessionCookieMaxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`
  );
  return ports.jsonOk(c, {
    csrf_token: result.csrf_token,
    expires_at: result.expires_at,
    user: result.user
  });
});

routes.post("/v1/auth/logout", async (c) => {
  const result = await ports.logoutSession(c.env, ports.getApiAuthContext(c));
  c.header("set-cookie", `${ports.sessionCookie}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return ports.jsonOk(c, result);
});

routes.post("/v1/ops/auth-sessions/revoke-all", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.revokeAllSessions(c.env, tenantId));
});

routes.get("/v1/organization", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getOrganization(c.env, tenantId));
});

routes.patch("/v1/organization", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateOrganization(c.env, tenantId, body));
});

routes.get("/v1/users", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, { users: await ports.listUsers(c.env, tenantId, c.req.query("q")) });
});

routes.post("/v1/users", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createUser(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.patch("/v1/users/:principal{.+}", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateUser(c.env, tenantId, decodeURIComponent(c.req.param("principal")), body, ports.getApiPrincipal(c)));
});

routes.get("/v1/directory", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, { users: await ports.listDirectory(c.env, tenantId, c.req.query("q")) });
});

routes.get("/v1/role-assignments", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.listRoleAssignments(c.env, tenantId, {
    principal: c.req.query("principal"),
    projectId: c.req.query("project_id")
  });
  return ports.jsonOk(c, result);
});

routes.put("/v1/role-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.upsertRoleAssignment(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.delete("/v1/role-assignments/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.deleteRoleAssignment(c.env, tenantId, c.req.param("id")));
});

routes.get("/v1/scoped-tokens", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listScopedTokens(c.env, tenantId));
});

routes.post("/v1/scoped-tokens", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.issueScopedToken(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.delete("/v1/scoped-tokens/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.revokeScopedToken(c.env, tenantId, c.req.param("id")));
});

routes.get("/v1/mcp-client-installations", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const auth = ports.getApiAuthContext(c);
  const tenantScope = c.req.query("scope") === "tenant";
  if (tenantScope) {
    await ports.assertPermission(c.env, {
      tenantId,
      principal: auth.principal,
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  return ports.jsonOk(c, {
    installations: await ports.listMcpClientInstallations(
      c.env,
      tenantId,
      tenantScope ? undefined : auth.principal
    )
  });
});

routes.post("/v1/mcp-client-installations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(
    c,
    await ports.createMcpClientInstallation(c.env, tenantId, ports.getApiPrincipal(c), body),
    201
  );
});

routes.delete("/v1/mcp-client-installations/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const auth = ports.getApiAuthContext(c);
  const adminDecision = await ports.authorizePermission(c.env, {
    tenantId,
    principal: auth.principal,
    permission: "admin",
    fallbackRole: auth.defaultRole
  });
  return ports.jsonOk(c, await ports.revokeMcpClientInstallation(
    c.env,
    tenantId,
    c.req.param("id"),
    auth.principal,
    adminDecision.allowed
  ));
});
}
