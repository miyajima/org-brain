import {
  registerIdentityRoutes as registerSharedIdentityRoutes,
  type IdentityPort
} from "@org-brain/server-core";
import { appendAuditEvent } from "./audit-service";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import {
  logoutSession,
  requestEmailCode,
  revokeAllSessions,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  verifyEmailCode
} from "./email-auth-service";
import {
  createUser,
  getOrganization,
  listDirectory,
  listUsers,
  updateOrganization,
  updateUser
} from "./organization-user-service";
import {
  createMcpClientInstallation,
  listMcpClientInstallations,
  revokeMcpClientInstallation
} from "./mcp-client-installation-service";
import {
  assertPermission,
  authorizePermission,
  deleteRoleAssignment,
  listRoleAssignments,
  upsertRoleAssignment
} from "./rbac-service";
import { issueScopedToken, listScopedTokens, revokeScopedToken } from "./token-service";
import type { Hono } from "hono";

const identityPort = {
  sessionCookie: SESSION_COOKIE,
  sessionCookieMaxAge: SESSION_COOKIE_MAX_AGE,
  appendAuditEvent,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  logoutSession,
  requestEmailCode,
  revokeAllSessions,
  verifyEmailCode,
  createUser,
  getOrganization,
  listDirectory,
  listUsers,
  updateOrganization,
  updateUser,
  createMcpClientInstallation,
  listMcpClientInstallations,
  revokeMcpClientInstallation,
  assertPermission,
  authorizePermission: (env, input) => authorizePermission(env, input),
  deleteRoleAssignment,
  listRoleAssignments,
  upsertRoleAssignment,
  issueScopedToken,
  listScopedTokens,
  revokeScopedToken
} satisfies IdentityPort<ApiContextEnv>;

export function registerIdentityRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedIdentityRoutes(app, identityPort);
}
