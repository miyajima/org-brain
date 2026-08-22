import { z } from "zod";

export const ORG_ROLES = [
  "tenant_admin",
  "project_owner",
  "contributor",
  "reader",
  "service_agent",
  "auditor"
] as const;

export const ORG_PERMISSIONS = [
  "read",
  "write",
  "share",
  "admin",
  "delete",
  "export",
  "memory:attest"
] as const;

export const ORGBRAIN_OAUTH_SCOPES = [
  "orgbrain:read",
  "orgbrain:write",
  "orgbrain:share",
  "orgbrain:attest",
  "orgbrain:export",
  "orgbrain:admin"
] as const;

export const PROFILE_FIELD_SOURCES = ["oidc", "scim", "local", "legacy"] as const;
export const AUTH_SOURCES = [
  "api-key",
  "session",
  "oidc",
  "oauth-access-token",
  "service-credential",
  "cloudflare-access"
] as const;

export type OrgRole = (typeof ORG_ROLES)[number];
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];
export type OrgBrainOAuthScope = (typeof ORGBRAIN_OAUTH_SCOPES)[number];
export type ProfileFieldSource = (typeof PROFILE_FIELD_SOURCES)[number];
export type AuthSource = (typeof AUTH_SOURCES)[number];

export const orgRoleSchema = z.enum(ORG_ROLES);
export const orgPermissionSchema = z.enum(ORG_PERMISSIONS);
export const orgBrainOAuthScopeSchema = z.enum(ORGBRAIN_OAUTH_SCOPES);
export const profileFieldSourceSchema = z.enum(PROFILE_FIELD_SOURCES);

export const principalContextSchema = z.object({
  principal: z.string().trim().min(1).max(256),
  tenant_id: z.string().trim().min(1).max(128),
  role: orgRoleSchema,
  permissions: z.array(orgPermissionSchema).max(ORG_PERMISSIONS.length),
  auth_source: z.enum(AUTH_SOURCES),
  client_id: z.string().trim().min(1).max(2048).nullable().default(null),
  scopes: z.array(orgBrainOAuthScopeSchema).max(ORGBRAIN_OAUTH_SCOPES.length).default([])
});

export const mcpAuthContextSchema = principalContextSchema.extend({
  token_id: z.string().trim().min(1).max(256),
  expires_at: z.number().int().positive(),
  allowed_tools: z.array(z.string().trim().min(1).max(256)).max(512).nullable().default(null)
});

export type PrincipalContext = z.infer<typeof principalContextSchema>;
export type McpAuthContext = z.infer<typeof mcpAuthContextSchema>;
