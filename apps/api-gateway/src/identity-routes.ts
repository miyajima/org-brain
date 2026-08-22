import { appendAuditEvent } from "./audit-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { logoutSession, requestEmailCode, revokeAllSessions, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE, verifyEmailCode } from "./email-auth-service";
import { createUser, getOrganization, listDirectory, listUsers, updateOrganization, updateUser } from "./organization-user-service";
import { createMcpClientInstallation, listMcpClientInstallations, revokeMcpClientInstallation } from "./mcp-client-installation-service";
import { assertPermission, authorizePermission, deleteRoleAssignment, listRoleAssignments, upsertRoleAssignment } from "./rbac-service";
import { issueScopedToken, listScopedTokens, revokeScopedToken } from "./token-service";
import type { Hono } from "hono";

export function registerIdentityRoutes(app: Hono<ApiContextEnv>): void {
app.post("/v1/auth/email/request-code", async (c) => {
  const body = await c.req.json<unknown>();
  const requestIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const result = await requestEmailCode(c.env, body, requestIp);
  return c.json({ ok: true as const, data: result }, 202);
});

app.post("/v1/auth/email/verify", async (c) => {
  const body = await c.req.json<unknown>();
  const result = await verifyEmailCode(c.env, body);
  await appendAuditEvent(c.env, {
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
    `${SESSION_COOKIE}=${encodeURIComponent(result.session_token)}; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`
  );
  return jsonOk(c, {
    csrf_token: result.csrf_token,
    expires_at: result.expires_at,
    user: result.user
  });
});

app.post("/v1/auth/logout", async (c) => {
  const result = await logoutSession(c.env, getApiAuthContext(c));
  c.header("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return jsonOk(c, result);
});

app.post("/v1/ops/auth-sessions/revoke-all", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await revokeAllSessions(c.env, tenantId));
});

app.get("/v1/organization", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getOrganization(c.env, tenantId));
});

app.patch("/v1/organization", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateOrganization(c.env, tenantId, body));
});

app.get("/v1/users", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, { users: await listUsers(c.env, tenantId, c.req.query("q")) });
});

app.post("/v1/users", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createUser(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.patch("/v1/users/:principal{.+}", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateUser(c.env, tenantId, decodeURIComponent(c.req.param("principal")), body, getApiPrincipal(c)));
});

app.get("/v1/directory", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, { users: await listDirectory(c.env, tenantId, c.req.query("q")) });
});

app.get("/v1/role-assignments", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await listRoleAssignments(c.env, tenantId, {
    principal: c.req.query("principal"),
    projectId: c.req.query("project_id")
  });
  return jsonOk(c, result);
});

app.put("/v1/role-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertRoleAssignment(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.delete("/v1/role-assignments/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await deleteRoleAssignment(c.env, tenantId, c.req.param("id")));
});

app.get("/v1/scoped-tokens", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listScopedTokens(c.env, tenantId));
});

app.post("/v1/scoped-tokens", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await issueScopedToken(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.delete("/v1/scoped-tokens/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await revokeScopedToken(c.env, tenantId, c.req.param("id")));
});

app.get("/v1/mcp-client-installations", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const auth = getApiAuthContext(c);
  const tenantScope = c.req.query("scope") === "tenant";
  if (tenantScope) {
    await assertPermission(c.env, {
      tenantId,
      principal: auth.principal,
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  return jsonOk(c, {
    installations: await listMcpClientInstallations(
      c.env,
      tenantId,
      tenantScope ? undefined : auth.principal
    )
  });
});

app.post("/v1/mcp-client-installations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(
    c,
    await createMcpClientInstallation(c.env, tenantId, getApiPrincipal(c), body),
    201
  );
});

app.delete("/v1/mcp-client-installations/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const auth = getApiAuthContext(c);
  const adminDecision = await authorizePermission(c.env, {
    tenantId,
    principal: auth.principal,
    permission: "admin",
    fallbackRole: auth.defaultRole
  });
  return jsonOk(c, await revokeMcpClientInstallation(
    c.env,
    tenantId,
    c.req.param("id"),
    auth.principal,
    adminDecision.allowed
  ));
});
}
