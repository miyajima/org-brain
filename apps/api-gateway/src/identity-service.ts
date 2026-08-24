import { HttpError, ROLE_PERMISSIONS, type OrgPermission, type OrgRole } from "@org-brain/shared";
import { listGroups } from "./group-service";
import type { ApiAuthContext } from "./auth";
import { listRoleAssignments } from "./rbac-service";
import { parseOptionalNullableString as parseOptionalString } from "./request-value-utils";
import type { Env } from "./types";

type ProfileRow = {
  tenant_id: string;
  principal: string;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
  company_name: string | null;
  organization_name: string | null;
  avatar_url: string | null;
  status: "invited" | "active" | "suspended" | "deprovisioned";
  provision_source: "email" | "oidc" | "scim" | "legacy";
  full_name_source: "email" | "oidc" | "scim" | "legacy";
  email_verified: number;
  created_at: number;
  updated_at: number;
};

function toProfile(row: ProfileRow | null, tenantId: string, auth: ApiAuthContext) {
  return {
    tenant_id: tenantId,
    principal: auth.principal,
    display_name: row?.display_name ?? auth.displayName ?? null,
    full_name: row?.full_name ?? null,
    email: row?.email ?? auth.email ?? null,
    company_name: row?.company_name ?? null,
    organization_name: row?.organization_name ?? null,
    avatar_url: row?.avatar_url ?? null,
    status: row?.status ?? "active",
    provision_source: row?.provision_source ?? "legacy",
    full_name_source: row?.full_name_source ?? "legacy",
    email_verified: Boolean(row?.email_verified),
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null
  };
}

export async function getUserProfile(env: Env, tenantId: string, auth: ApiAuthContext) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, full_name, email, email_verified, company_name, organization_name, avatar_url,
            status, provision_source, full_name_source, created_at, updated_at
     FROM user_profiles
     WHERE tenant_id = ? AND principal = ?`
  )
    .bind(tenantId, auth.principal)
    .first<ProfileRow>();
  return toProfile(row, tenantId, auth);
}

export async function updateUserProfile(env: Env, tenantId: string, auth: ApiAuthContext, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const current = await getUserProfile(env, tenantId, auth);
  const now = Date.now();
  const profile = {
    display_name: body.display_name === undefined ? current.display_name : parseOptionalString(body.display_name, "display_name", 120),
    full_name: body.full_name === undefined ? current.full_name : parseOptionalString(body.full_name, "full_name", 200),
    email: body.email === undefined ? current.email : parseOptionalString(body.email, "email", 200),
    company_name: body.company_name === undefined ? current.company_name : parseOptionalString(body.company_name, "company_name", 160),
    organization_name: body.organization_name === undefined ? current.organization_name : parseOptionalString(body.organization_name, "organization_name", 160),
    avatar_url: body.avatar_url === undefined ? current.avatar_url : parseOptionalString(body.avatar_url, "avatar_url", 500)
  };
  if (!profile.display_name) throw new HttpError(400, "display_name_required", "display_name is required");
  if (current.full_name_source === "scim" && body.full_name !== undefined && profile.full_name !== current.full_name) {
    throw new HttpError(409, "scim_managed_field", "full_name is managed by SCIM");
  }
  const emailVerified = profile.email === current.email ? current.email_verified : false;
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO user_profiles(
       tenant_id, principal, display_name, full_name, email, email_verified, company_name, organization_name, avatar_url,
       status, provision_source, full_name_source, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,'active','legacy','legacy',?,?)
     ON CONFLICT(tenant_id, principal) DO UPDATE SET
       display_name = excluded.display_name,
       full_name = excluded.full_name,
       email = excluded.email,
       email_verified = excluded.email_verified,
       company_name = excluded.company_name,
       organization_name = excluded.organization_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`
  )
    .bind(
      tenantId,
      auth.principal,
      profile.display_name,
      profile.full_name,
      profile.email,
      emailVerified ? 1 : 0,
      profile.company_name,
      profile.organization_name,
      profile.avatar_url,
      current.created_at ?? now,
      now
    )
    .run();
  return getUserProfile(env, tenantId, auth);
}

type CountRow = { count: number };

async function getConsoleContext(env: Env, tenantId: string, auth: ApiAuthContext, projectId: string | null) {
  const [assignments, organization, activeUsers, activeGroups, activeProjects, otherProjectPrincipals] = await Promise.all([
    listRoleAssignments(env, tenantId, { principal: auth.principal, projectId }),
    env.OPEN_BRAIN_DB.prepare(
      "SELECT tenant_id FROM organizations WHERE tenant_id = ?"
    ).bind(tenantId).first<{ tenant_id: string }>(),
    env.OPEN_BRAIN_DB.prepare(
      "SELECT COUNT(*) AS count FROM user_profiles WHERE tenant_id = ? AND status = 'active'"
    ).bind(tenantId).first<CountRow>(),
    env.OPEN_BRAIN_DB.prepare(
      "SELECT COUNT(*) AS count FROM groups WHERE tenant_id = ? AND deleted_at IS NULL"
    ).bind(tenantId).first<CountRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(DISTINCT project_id) AS count FROM (
         SELECT project_id FROM principal_role_assignments WHERE tenant_id = ? AND project_id IS NOT NULL
         UNION ALL
         SELECT project_id FROM memories WHERE tenant_id = ? AND project_id IS NOT NULL
       )`
    ).bind(tenantId, tenantId).first<CountRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS count FROM principal_role_assignments
       WHERE tenant_id = ? AND project_id IS NOT NULL AND principal <> ?`
    ).bind(tenantId, auth.principal).first<CountRow>()
  ]);
  const matchedRoles = assignments
    .filter((assignment) => assignment.project_id === null || assignment.project_id === projectId)
    .map((assignment) => assignment.role)
    .filter((role, index, roles) => roles.indexOf(role) === index);
  const effectiveRoles: OrgRole[] = matchedRoles.length > 0 ? matchedRoles : [auth.defaultRole];
  let permissions = [...new Set(effectiveRoles.flatMap((role) => ROLE_PERMISSIONS[role]))] as OrgPermission[];
  if (auth.scopes?.length) permissions = permissions.filter((permission) => auth.scopes!.includes(permission));
  const activeUserCount = Number(activeUsers?.count ?? 0);
  const activeGroupCount = Number(activeGroups?.count ?? 0);
  const activeProjectCount = Number(activeProjects?.count ?? 0);
  const personal = !organization
    && activeUserCount <= 1
    && activeGroupCount === 0
    && Number(otherProjectPrincipals?.count ?? 0) === 0;
  const canAdminister = permissions.includes("admin");
  return {
    mode: personal ? "personal" as const : "team" as const,
    effective_permissions: permissions,
    can_manage_users: canAdminister,
    can_manage_groups: canAdminister,
    can_manage_clients: canAdminister,
    tenant: { id: tenantId },
    project: projectId ? { id: projectId } : null,
    counts: {
      active_users: activeUserCount,
      active_groups: activeGroupCount,
      active_projects: activeProjectCount
    }
  };
}

export async function getMyIdentity(env: Env, tenantId: string, auth: ApiAuthContext, projectId: string | null = null) {
  const [profile, groups, consoleContext] = await Promise.all([
    getUserProfile(env, tenantId, auth),
    listGroups(env, tenantId, auth.principal),
    getConsoleContext(env, tenantId, auth, projectId)
  ]);
  return {
    tenant_id: tenantId,
    auth: {
      principal: auth.principal,
      source: auth.source,
      allowed_tenants: auth.allowedTenants,
      email: auth.email ?? null,
      display_name: auth.displayName ?? null
    },
    profile,
    groups: groups.groups,
    console_context: consoleContext
  };
}
