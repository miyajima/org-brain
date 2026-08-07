import {
  HttpError,
  isOrgRole,
  ulid,
  type OrgRole,
  type UserProvisionSource,
  type UserStatus
} from "@org-brain/shared";
import type { ApiAuthContext } from "./auth";
import type { Env } from "./types";

type UserRow = {
  tenant_id: string;
  principal: string;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
  email_verified: number;
  company_name: string | null;
  organization_name: string | null;
  avatar_url: string | null;
  status: UserStatus;
  provision_source: UserProvisionSource;
  full_name_source: UserProvisionSource;
  created_at: number;
  updated_at: number;
  role?: OrgRole | null;
};

type OrganizationRow = {
  tenant_id: string;
  slug: string;
  display_name: string;
  allowed_email_domains_json: string;
  email_self_registration_enabled: number;
  created_at: number;
  updated_at: number;
};

function bodyObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", `${field} must be a non-empty string`);
  }
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
}

export function normalizeEmail(value: unknown): string {
  const email = requiredText(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new HttpError(400, "invalid_email", "email must be valid");
  }
  return email;
}

function parseJsonList(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function publicUser(row: UserRow) {
  return {
    principal: row.principal,
    display_name: row.display_name || row.email?.split("@")[0] || row.principal,
    avatar_url: row.avatar_url,
    status: row.status
  };
}

function privateUser(row: UserRow) {
  return {
    ...publicUser(row),
    tenant_id: row.tenant_id,
    full_name: row.full_name,
    email: row.email,
    email_verified: Boolean(row.email_verified),
    provision_source: row.provision_source,
    full_name_source: row.full_name_source,
    role: row.role ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function getOrganization(env: Env, tenantId: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, slug, display_name, allowed_email_domains_json,
            email_self_registration_enabled, created_at, updated_at
     FROM organizations WHERE tenant_id = ?`
  ).bind(tenantId).first<OrganizationRow>();
  if (!row) {
    return {
      tenant_id: tenantId,
      slug: tenantId.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").slice(0, 80) || "default",
      display_name: tenantId,
      allowed_email_domains: [],
      email_self_registration_enabled: false,
      configured: false
    };
  }
  return {
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    allowed_email_domains: parseJsonList(row.allowed_email_domains_json),
    email_self_registration_enabled: Boolean(row.email_self_registration_enabled),
    configured: true,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function findOrganizationBySlug(env: Env, slug: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, slug, display_name, allowed_email_domains_json,
            email_self_registration_enabled, created_at, updated_at
     FROM organizations WHERE slug = ?`
  ).bind(slug.trim().toLowerCase()).first<OrganizationRow>();
  return row ? {
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    allowed_email_domains: parseJsonList(row.allowed_email_domains_json),
    email_self_registration_enabled: Boolean(row.email_self_registration_enabled)
  } : null;
}

export async function updateOrganization(env: Env, tenantId: string, raw: unknown) {
  const body = bodyObject(raw);
  const current = await getOrganization(env, tenantId);
  const slug = body.slug === undefined ? current.slug : requiredText(body.slug, "slug", 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(slug)) {
    throw new HttpError(400, "invalid_slug", "slug must use lowercase letters, digits, underscore, or hyphen");
  }
  const displayName = body.display_name === undefined
    ? current.display_name
    : requiredText(body.display_name, "display_name", 160);
  const domains = body.allowed_email_domains === undefined
    ? current.allowed_email_domains
    : Array.isArray(body.allowed_email_domains)
      ? [...new Set(body.allowed_email_domains.map((item) => requiredText(item, "allowed_email_domains", 253).toLowerCase()))]
      : (() => { throw new HttpError(400, "invalid_payload", "allowed_email_domains must be an array"); })();
  const enabled = body.email_self_registration_enabled === undefined
    ? current.email_self_registration_enabled
    : Boolean(body.email_self_registration_enabled);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO organizations(tenant_id, slug, display_name, allowed_email_domains_json,
      email_self_registration_enabled, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET slug=excluded.slug, display_name=excluded.display_name,
       allowed_email_domains_json=excluded.allowed_email_domains_json,
       email_self_registration_enabled=excluded.email_self_registration_enabled,
       updated_at=excluded.updated_at`
  ).bind(tenantId, slug, displayName, JSON.stringify(domains), enabled ? 1 : 0,
    "created_at" in current ? current.created_at : now, now).run();
  return getOrganization(env, tenantId);
}

export async function getUserByEmail(env: Env, tenantId: string, email: string) {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
            company_name, organization_name, avatar_url, status, provision_source,
            full_name_source, created_at, updated_at
     FROM user_profiles WHERE tenant_id = ? AND lower(email) = lower(?)`
  ).bind(tenantId, email).first<UserRow>();
}

export async function getUserByPrincipal(env: Env, tenantId: string, principal: string) {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
            company_name, organization_name, avatar_url, status, provision_source,
            full_name_source, created_at, updated_at
     FROM user_profiles WHERE tenant_id = ? AND principal = ?`
  ).bind(tenantId, principal).first<UserRow>();
}

export async function listDirectory(env: Env, tenantId: string, query = "") {
  const normalized = `%${query.trim().toLowerCase().slice(0, 120)}%`;
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
            company_name, organization_name, avatar_url, status, provision_source,
            full_name_source, created_at, updated_at
     FROM user_profiles
     WHERE tenant_id = ? AND status = 'active'
       AND (? = '%%' OR lower(display_name) LIKE ? OR lower(principal) LIKE ?)
     ORDER BY display_name, principal LIMIT 100`
  ).bind(tenantId, normalized, normalized, normalized).all<UserRow>();
  return rows.results.map(publicUser);
}

export async function listUsers(env: Env, tenantId: string, query = "") {
  const normalized = `%${query.trim().toLowerCase().slice(0, 120)}%`;
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
            company_name, organization_name, avatar_url, status, provision_source,
            full_name_source, created_at, updated_at,
            (SELECT role FROM principal_role_assignments pra
             WHERE pra.tenant_id=user_profiles.tenant_id AND pra.principal=user_profiles.principal
               AND pra.project_id IS NULL ORDER BY pra.updated_at DESC LIMIT 1) AS role
     FROM user_profiles
     WHERE tenant_id = ?
       AND (? = '%%' OR lower(display_name) LIKE ? OR lower(email) LIKE ? OR lower(principal) LIKE ?)
     ORDER BY status, display_name, principal LIMIT 200`
  ).bind(tenantId, normalized, normalized, normalized, normalized).all<UserRow>();
  return rows.results.map(privateUser);
}

export async function createUser(env: Env, tenantId: string, raw: unknown, actorPrincipal: string) {
  const body = bodyObject(raw);
  const email = normalizeEmail(body.email);
  if (await getUserByEmail(env, tenantId, email)) {
    throw new HttpError(409, "user_email_conflict", "a user with this email already exists");
  }
  const displayName = requiredText(body.display_name, "display_name", 120);
  const fullName = optionalText(body.full_name, "full_name", 200);
  const role: OrgRole = isOrgRole(body.role) ? body.role : "reader";
  const now = Date.now();
  const principal = `user:${ulid(now).toLowerCase()}`;
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
        email_verified, company_name, organization_name, avatar_url, status,
        provision_source, full_name_source, created_at, updated_at)
       VALUES(?,?,?,?,?,0,NULL,NULL,NULL,'invited','email','email',?,?)`
    ).bind(tenantId, principal, displayName, fullName, email, now, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_identities(id, tenant_id, principal, provider_type, issuer,
        subject, external_id, created_at, updated_at) VALUES(?,?,?,'email','',?,NULL,?,?)`
    ).bind(ulid(now + 1), tenantId, principal, email, now, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
        created_by_principal, created_at, updated_at, source, source_ref)
       VALUES(?,?,NULL,?,?,?,?,?,'local',NULL)`
    ).bind(ulid(now + 2), tenantId, principal, role, actorPrincipal, now, now)
  ]);
  return privateUser((await getUserByPrincipal(env, tenantId, principal))!);
}

export async function updateUser(env: Env, tenantId: string, principal: string, raw: unknown, actorPrincipal: string) {
  const body = bodyObject(raw);
  const current = await getUserByPrincipal(env, tenantId, principal);
  if (!current) throw new HttpError(404, "user_not_found", "user not found");
  const displayName = body.display_name === undefined ? current.display_name : requiredText(body.display_name, "display_name", 120);
  const fullName = body.full_name === undefined ? current.full_name : optionalText(body.full_name, "full_name", 200);
  if (current.full_name_source === "scim" && body.full_name !== undefined && fullName !== current.full_name) {
    throw new HttpError(409, "scim_managed_field", "full_name is managed by SCIM");
  }
  const status = body.status === undefined ? current.status : requiredText(body.status, "status", 32) as UserStatus;
  if (!["invited", "active", "suspended", "deprovisioned"].includes(status)) {
    throw new HttpError(400, "invalid_status", "unsupported user status");
  }
  const now = Date.now();
  const role = body.role === undefined ? null : isOrgRole(body.role) ? body.role : (() => {
    throw new HttpError(400, "invalid_role", "unsupported role");
  })();
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE user_profiles SET display_name=?, full_name=?, status=?, updated_at=?
       WHERE tenant_id=? AND principal=?`
    ).bind(displayName, fullName, status, now, tenantId, principal),
    ...(status === "active" ? [] : [env.OPEN_BRAIN_DB.prepare(
      `UPDATE auth_sessions SET revoked_at=? WHERE tenant_id=? AND principal=? AND revoked_at IS NULL`
    ).bind(now, tenantId, principal)]),
    ...(role ? [
      env.OPEN_BRAIN_DB.prepare(
        `DELETE FROM principal_role_assignments
         WHERE tenant_id=? AND principal=? AND project_id IS NULL AND source='local'`
      ).bind(tenantId, principal),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
          created_by_principal, created_at, updated_at, source, source_ref)
         VALUES(?,?,NULL,?,?,?,?,?,'local','admin')`
      ).bind(ulid(now + 1), tenantId, principal, role, actorPrincipal, now, now)
    ] : [])
  ]);
  const updated = (await getUserByPrincipal(env, tenantId, principal))!;
  return { ...privateUser(updated), role: role ?? current.role ?? null };
}

export function canViewFullName(auth: ApiAuthContext, subjectPrincipal: string, isAdmin: boolean) {
  return auth.principal === subjectPrincipal || isAdmin;
}

export { privateUser, publicUser };
