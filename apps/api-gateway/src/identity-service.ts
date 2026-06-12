import { HttpError } from "@org-brain/shared";
import { listGroups } from "./group-service";
import type { ApiAuthContext } from "./auth";
import type { Env } from "./types";

type ProfileRow = {
  tenant_id: string;
  principal: string;
  display_name: string | null;
  email: string | null;
  company_name: string | null;
  organization_name: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
};

function parseOptionalString(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function toProfile(row: ProfileRow | null, tenantId: string, auth: ApiAuthContext) {
  return {
    tenant_id: tenantId,
    principal: auth.principal,
    display_name: row?.display_name ?? auth.displayName ?? null,
    email: row?.email ?? auth.email ?? null,
    company_name: row?.company_name ?? null,
    organization_name: row?.organization_name ?? null,
    avatar_url: row?.avatar_url ?? null,
    created_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null
  };
}

export async function getUserProfile(env: Env, tenantId: string, auth: ApiAuthContext) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, principal, display_name, email, company_name, organization_name, avatar_url, created_at, updated_at
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
    email: body.email === undefined ? current.email : parseOptionalString(body.email, "email", 200),
    company_name: body.company_name === undefined ? current.company_name : parseOptionalString(body.company_name, "company_name", 160),
    organization_name: body.organization_name === undefined ? current.organization_name : parseOptionalString(body.organization_name, "organization_name", 160),
    avatar_url: body.avatar_url === undefined ? current.avatar_url : parseOptionalString(body.avatar_url, "avatar_url", 500)
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO user_profiles(
       tenant_id, principal, display_name, email, company_name, organization_name, avatar_url, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, principal) DO UPDATE SET
       display_name = excluded.display_name,
       email = excluded.email,
       company_name = excluded.company_name,
       organization_name = excluded.organization_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`
  )
    .bind(
      tenantId,
      auth.principal,
      profile.display_name,
      profile.email,
      profile.company_name,
      profile.organization_name,
      profile.avatar_url,
      current.created_at ?? now,
      now
    )
    .run();
  return getUserProfile(env, tenantId, auth);
}

export async function getMyIdentity(env: Env, tenantId: string, auth: ApiAuthContext) {
  const profile = await getUserProfile(env, tenantId, auth);
  const groups = await listGroups(env, tenantId, auth.principal);
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
    groups: groups.groups
  };
}
