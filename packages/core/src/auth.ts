import {
  ORG_PERMISSIONS,
  type OrgBrainOAuthScope,
  type OrgPermission,
  type OrgRole
} from "@org-brain/contracts";

export const ROLE_PERMISSIONS: Readonly<Record<OrgRole, readonly OrgPermission[]>> = {
  tenant_admin: ORG_PERMISSIONS,
  project_owner: ["read", "write", "share", "delete", "export", "memory:attest"],
  contributor: ["read", "write", "share", "memory:attest"],
  reader: ["read"],
  service_agent: ["read", "write", "memory:attest"],
  auditor: ["read", "export"]
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && Object.hasOwn(ROLE_PERMISSIONS, value);
}

export function roleAllows(role: OrgRole, permission: OrgPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

const SCOPE_PERMISSION: Record<OrgBrainOAuthScope, OrgPermission> = {
  "orgbrain:read": "read",
  "orgbrain:write": "write",
  "orgbrain:share": "share",
  "orgbrain:attest": "memory:attest",
  "orgbrain:export": "export",
  "orgbrain:admin": "admin"
};

export function permissionsForRole(role: OrgRole): OrgPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function permissionsForScopes(scopes: readonly OrgBrainOAuthScope[]): OrgPermission[] {
  return [...new Set(scopes.map((scope) => SCOPE_PERMISSION[scope]))];
}

export function effectivePermissions(
  role: OrgRole,
  scopes?: readonly OrgBrainOAuthScope[] | null
): OrgPermission[] {
  const rolePermissions = new Set(ROLE_PERMISSIONS[role]);
  if (!scopes) return [...rolePermissions];
  const scoped = new Set(permissionsForScopes(scopes));
  return ORG_PERMISSIONS.filter((permission) => rolePermissions.has(permission) && scoped.has(permission));
}

export function hasPermission(permissions: readonly OrgPermission[], required: OrgPermission): boolean {
  return permissions.includes(required);
}
