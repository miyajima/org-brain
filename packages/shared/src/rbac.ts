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
  "export"
] as const;

export type OrgRole = (typeof ORG_ROLES)[number];
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<OrgRole, readonly OrgPermission[]>> = {
  tenant_admin: ORG_PERMISSIONS,
  project_owner: ORG_PERMISSIONS,
  contributor: ["read", "write", "share"],
  reader: ["read"],
  service_agent: ["read", "write"],
  auditor: ["read", "export"]
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && ORG_ROLES.includes(value as OrgRole);
}

export function roleAllows(role: OrgRole, permission: OrgPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
