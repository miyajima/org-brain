import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

const GROUP_ROLES = ["owner", "admin", "member"] as const;
type GroupRole = (typeof GROUP_ROLES)[number];

type GroupRow = {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_by_principal: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  role?: GroupRole | null;
};

type MemberRow = {
  principal: string;
  role: GroupRole;
  created_at: number;
  updated_at: number;
};

function parseString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
}

function parseOptionalString(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  return parseString(value, field, maxLength);
}

function parseRole(value: unknown): GroupRole {
  if (typeof value !== "string") return "member";
  if (!GROUP_ROLES.includes(value as GroupRole)) {
    throw new HttpError(400, "invalid_payload", `role must be one of ${GROUP_ROLES.join(", ")}`);
  }
  return value as GroupRole;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toGroup(row: GroupRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    created_by_principal: row.created_by_principal,
    role: row.role ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getGroupRow(env: Env, tenantId: string, groupId: string): Promise<GroupRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, slug, name, description, created_by_principal, created_at, updated_at, deleted_at
     FROM groups
     WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
  )
    .bind(tenantId, groupId)
    .first<GroupRow>();
  if (!row) throw new HttpError(404, "group_not_found", "Group not found");
  return row;
}

async function getMembership(env: Env, tenantId: string, groupId: string, principal: string): Promise<MemberRow | null> {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT principal, role, created_at, updated_at
     FROM group_members
     WHERE tenant_id = ? AND group_id = ? AND principal = ?`
  )
    .bind(tenantId, groupId, principal)
    .first<MemberRow>();
}

async function assertGroupAdmin(env: Env, tenantId: string, groupId: string, principal: string): Promise<void> {
  const membership = await getMembership(env, tenantId, groupId, principal);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new HttpError(403, "forbidden", "Group admin role is required");
  }
}

export async function listGroups(env: Env, tenantId: string, principal: string) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT g.id, g.tenant_id, g.slug, g.name, g.description, g.created_by_principal,
            g.created_at, g.updated_at, g.deleted_at, gm.role
     FROM groups g
     JOIN group_members gm
       ON gm.tenant_id = g.tenant_id
      AND gm.group_id = g.id
     WHERE g.tenant_id = ?
       AND gm.principal = ?
       AND g.deleted_at IS NULL
     ORDER BY g.updated_at DESC`
  )
    .bind(tenantId, principal)
    .all<GroupRow>();
  return { tenant_id: tenantId, groups: rows.results.map(toGroup) };
}

export async function createGroup(env: Env, tenantId: string, principal: string, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const name = parseString(body.name, "name", 120);
  const slug = slugify(parseOptionalString(body.slug, "slug", 100) ?? name);
  if (!slug) throw new HttpError(400, "invalid_payload", "slug must contain letters, numbers, hyphens, or underscores");
  const description = parseOptionalString(body.description, "description", 500);
  const now = Date.now();
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO groups(id, tenant_id, slug, name, description, created_by_principal, created_at, updated_at, deleted_at)
       VALUES(?,?,?,?,?,?,?,?,NULL)`
    ).bind(id, tenantId, slug, name, description, principal, now, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO group_members(tenant_id, group_id, principal, role, created_at, updated_at)
       VALUES(?,?,?,?,?,?)`
    ).bind(tenantId, id, principal, "owner", now, now)
  ]);
  return { group: toGroup({ id, tenant_id: tenantId, slug, name, description, created_by_principal: principal, created_at: now, updated_at: now, deleted_at: null, role: "owner" }) };
}

export async function getGroup(env: Env, tenantId: string, groupId: string, principal: string) {
  const row = await getGroupRow(env, tenantId, groupId);
  const membership = await getMembership(env, tenantId, groupId, principal);
  if (!membership) throw new HttpError(403, "forbidden", "Group membership is required");
  const members = await env.OPEN_BRAIN_DB.prepare(
    `SELECT principal, role, created_at, updated_at
     FROM group_members
     WHERE tenant_id = ? AND group_id = ?
     ORDER BY role, principal`
  )
    .bind(tenantId, groupId)
    .all<MemberRow>();
  return { group: toGroup({ ...row, role: membership.role }), members: members.results };
}

export async function updateGroup(env: Env, tenantId: string, groupId: string, principal: string, rawBody: unknown) {
  await assertGroupAdmin(env, tenantId, groupId, principal);
  const current = await getGroupRow(env, tenantId, groupId);
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const name = body.name === undefined ? current.name : parseString(body.name, "name", 120);
  const slug = body.slug === undefined ? current.slug : slugify(parseString(body.slug, "slug", 100));
  const description = body.description === undefined ? current.description : parseOptionalString(body.description, "description", 500);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE groups
     SET slug = ?, name = ?, description = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
  )
    .bind(slug, name, description, now, tenantId, groupId)
    .run();
  return { group: toGroup({ ...current, slug, name, description, updated_at: now }) };
}

export async function addGroupMember(env: Env, tenantId: string, groupId: string, principal: string, rawBody: unknown) {
  await assertGroupAdmin(env, tenantId, groupId, principal);
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const memberPrincipal = parseString(body.principal, "principal", 128);
  const role = parseRole(body.role);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO group_members(tenant_id, group_id, principal, role, created_at, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, group_id, principal) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`
  )
    .bind(tenantId, groupId, memberPrincipal, role, now, now)
    .run();
  return getGroup(env, tenantId, groupId, principal);
}

export async function removeGroupMember(env: Env, tenantId: string, groupId: string, principal: string, memberPrincipal: string) {
  await assertGroupAdmin(env, tenantId, groupId, principal);
  const membership = await getMembership(env, tenantId, groupId, memberPrincipal);
  if (membership?.role === "owner" && memberPrincipal === principal) {
    throw new HttpError(400, "invalid_payload", "Group owner cannot remove themselves");
  }
  await env.OPEN_BRAIN_DB.prepare(
    "DELETE FROM group_members WHERE tenant_id = ? AND group_id = ? AND principal = ?"
  )
    .bind(tenantId, groupId, memberPrincipal)
    .run();
  return getGroup(env, tenantId, groupId, principal);
}
