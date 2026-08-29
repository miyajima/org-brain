import { canonicalJson, sha256Hex } from "@org-brain/core";
import { HttpError, ulid } from "@org-brain/shared";
import {
  ACCESS_POLICY_RESOLVER_VERSION,
  evaluateResourceRead,
  loadPoliciesReferencingGroup
} from "./access-policy-service";
import { parseOptionalStrictString as parseOptionalString } from "./request-value-utils";
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
  source: "local" | "scim";
  external_id: string | null;
  role?: GroupRole | null;
};

type MemberRow = {
  principal: string;
  role: GroupRole;
  created_at: number;
  updated_at: number;
  source: "local" | "scim";
  display_name?: string | null;
  avatar_url?: string | null;
  status?: string | null;
};

function parseString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
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
    source: row.source,
    external_id: row.external_id,
    created_by_principal: row.created_by_principal,
    role: row.role ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getGroupRow(env: Env, tenantId: string, groupId: string): Promise<GroupRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, slug, name, description, created_by_principal, created_at, updated_at, deleted_at, source, external_id
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
    `SELECT principal, role, created_at, updated_at, source
     FROM group_members
     WHERE tenant_id = ? AND group_id = ? AND principal = ?`
  )
    .bind(tenantId, groupId, principal)
    .first<MemberRow>();
}

async function assertGroupAdmin(env: Env, tenantId: string, groupId: string, principal: string, tenantAdmin = false): Promise<void> {
  const group = await getGroupRow(env, tenantId, groupId);
  if (group.source === "scim") throw new HttpError(409, "scim_managed", "SCIM groups are read-only");
  if (tenantAdmin) return;
  const membership = await getMembership(env, tenantId, groupId, principal);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new HttpError(403, "forbidden", "Group admin role is required");
  }
}

export async function listGroups(env: Env, tenantId: string, principal: string, includeAll = false) {
  const rows = await env.OPEN_BRAIN_DB.prepare(includeAll
    ? `SELECT g.id, g.tenant_id, g.slug, g.name, g.description, g.created_by_principal,
              g.created_at, g.updated_at, g.deleted_at, g.source, g.external_id, gm.role
       FROM groups g
       LEFT JOIN group_members gm ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id AND gm.principal=?
       WHERE g.tenant_id=? AND g.deleted_at IS NULL ORDER BY g.updated_at DESC`
    :
    `SELECT g.id, g.tenant_id, g.slug, g.name, g.description, g.created_by_principal,
            g.created_at, g.updated_at, g.deleted_at, g.source, g.external_id, gm.role
     FROM groups g
     JOIN group_members gm
       ON gm.tenant_id = g.tenant_id
      AND gm.group_id = g.id
     WHERE g.tenant_id = ?
       AND gm.principal = ?
       AND g.deleted_at IS NULL
     ORDER BY g.updated_at DESC`
  )
    .bind(includeAll ? principal : tenantId, includeAll ? tenantId : principal)
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
  return { group: toGroup({ id, tenant_id: tenantId, slug, name, description, created_by_principal: principal, created_at: now, updated_at: now, deleted_at: null, source: "local", external_id: null, role: "owner" }) };
}

export async function getGroup(env: Env, tenantId: string, groupId: string, principal: string, tenantAdmin = false) {
  const row = await getGroupRow(env, tenantId, groupId);
  const membership = await getMembership(env, tenantId, groupId, principal);
  if (!membership && !tenantAdmin) throw new HttpError(403, "forbidden", "Group membership is required");
  const members = await env.OPEN_BRAIN_DB.prepare(
    `SELECT gm.principal, gm.role, gm.created_at, gm.updated_at, gm.source,
            up.display_name, up.avatar_url, up.status
     FROM group_members gm
     LEFT JOIN user_profiles up ON up.tenant_id = gm.tenant_id AND up.principal = gm.principal
     WHERE gm.tenant_id = ? AND gm.group_id = ?
     ORDER BY gm.role, COALESCE(up.display_name, gm.principal), gm.principal`
  )
    .bind(tenantId, groupId)
    .all<MemberRow>();
  return {
    group: toGroup({ ...row, role: membership?.role ?? null }),
    members: members.results.map((member) => ({
      ...member,
      can_remove: !(member.role === "owner" && member.principal === principal),
      removal_block_reason: member.role === "owner" && member.principal === principal ? "self_owner" : null
    }))
  };
}

async function principalIsTenantAdmin(env: Env, tenantId: string, principal: string): Promise<boolean> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT 1 AS allowed FROM principal_role_assignments
     WHERE tenant_id = ? AND principal = ? AND project_id IS NULL AND role = 'tenant_admin' LIMIT 1`
  ).bind(tenantId, principal).first<{ allowed: number }>();
  return Boolean(row);
}

export async function getGroupMemberImpact(
  env: Env,
  tenantId: string,
  groupId: string,
  principal: string,
  memberPrincipal: string,
  tenantAdmin = false
) {
  await assertGroupAdmin(env, tenantId, groupId, principal, tenantAdmin);
  const membership = await getMembership(env, tenantId, groupId, memberPrincipal);
  if (!membership) throw new HttpError(404, "group_membership_not_found", "Group membership not found");
  const [policies, groupMemberships, isAdmin] = await Promise.all([
    loadPoliciesReferencingGroup(env, tenantId, groupId),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT group_id, role, source, updated_at
       FROM group_members
       WHERE tenant_id = ? AND principal = ?
       ORDER BY group_id`
    ).bind(tenantId, memberPrincipal).all<{ group_id: string; role: GroupRole; source: string; updated_at: number }>(),
    principalIsTenantAdmin(env, tenantId, memberPrincipal)
  ]);
  const currentGroupIds = new Set(groupMemberships.results.map((row) => row.group_id));
  const remainingGroupIds = new Set(currentGroupIds);
  remainingGroupIds.delete(groupId);
  const lostByType: Record<string, number> = {};
  const retainedByType: Record<string, number> = {};
  const lostResources: Array<{ resource_type: string; resource_id: string; policy_id: string }> = [];
  const retainedResources: Array<{ resource_type: string; resource_id: string; policy_id: string }> = [];
  for (const policy of policies) {
    const options = { tenantId, principal: memberPrincipal, projectId: policy.project_id, isAdmin };
    const before = evaluateResourceRead(policy, options, currentGroupIds);
    if (!before) continue;
    const retained = evaluateResourceRead(policy, options, remainingGroupIds);
    const bucket = retained ? retainedByType : lostByType;
    bucket[policy.resource_type] = (bucket[policy.resource_type] ?? 0) + 1;
    (retained ? retainedResources : lostResources).push({
      resource_type: policy.resource_type,
      resource_id: policy.resource_id,
      policy_id: policy.id
    });
  }
  const canonicalPolicies = policies.map((policy) => ({
    id: policy.id,
    resource_type: policy.resource_type,
    resource_id: policy.resource_id,
    scope: policy.scope,
    owner_principal: policy.owner_principal,
    project_id: policy.project_id,
    group_ids: [...policy.group_ids].sort(),
    restricted_subjects: [...policy.restricted_subjects]
      .map((subject) => ({ subject_type: subject.subject_type, subject_id: subject.subject_id }))
      .sort((left, right) => `${left.subject_type}:${left.subject_id}`.localeCompare(`${right.subject_type}:${right.subject_id}`)),
    policy_version: policy.policy_version,
    updated_at: policy.updated_at
  }));
  const digestInput = {
    membership: { principal: memberPrincipal, role: membership.role, updated_at: membership.updated_at, source: membership.source },
    principal_access_state: {
      tenant_admin: isAdmin,
      group_memberships: groupMemberships.results.map((row) => ({
        group_id: row.group_id,
        role: row.role,
        source: row.source,
        updated_at: Number(row.updated_at)
      }))
    },
    policies: canonicalPolicies,
    resolved_access: { lost: lostResources, retained: retainedResources },
    resolver_version: ACCESS_POLICY_RESOLVER_VERSION
  };
  return {
    group_id: groupId,
    membership: digestInput.membership,
    impact: {
      lost_count: Object.values(lostByType).reduce((sum, value) => sum + value, 0),
      retained_count: Object.values(retainedByType).reduce((sum, value) => sum + value, 0),
      lost_by_resource_type: lostByType,
      retained_by_resource_type: retainedByType
    },
    policy_versions: canonicalPolicies.map((policy) => ({ id: policy.id, policy_version: policy.policy_version, updated_at: policy.updated_at })),
    resolver_version: ACCESS_POLICY_RESOLVER_VERSION,
    impact_digest: await sha256Hex(canonicalJson(digestInput))
  };
}

export async function updateGroup(env: Env, tenantId: string, groupId: string, principal: string, rawBody: unknown, tenantAdmin = false) {
  await assertGroupAdmin(env, tenantId, groupId, principal, tenantAdmin);
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

export async function addGroupMember(env: Env, tenantId: string, groupId: string, principal: string, rawBody: unknown, tenantAdmin = false) {
  await assertGroupAdmin(env, tenantId, groupId, principal, tenantAdmin);
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
  return getGroup(env, tenantId, groupId, principal, tenantAdmin);
}

export async function removeGroupMember(env: Env, tenantId: string, groupId: string, principal: string, memberPrincipal: string, expectedImpactDigest: string | null, tenantAdmin = false) {
  await assertGroupAdmin(env, tenantId, groupId, principal, tenantAdmin);
  if (!expectedImpactDigest) throw new HttpError(428, "impact_preview_required", "Impact preview is required before removal");
  const membership = await getMembership(env, tenantId, groupId, memberPrincipal);
  if (!membership) throw new HttpError(404, "group_membership_not_found", "Group membership not found");
  if (membership?.role === "owner" && memberPrincipal === principal) {
    throw new HttpError(400, "invalid_payload", "Group owner cannot remove themselves");
  }
  const preview = await getGroupMemberImpact(env, tenantId, groupId, principal, memberPrincipal, tenantAdmin);
  if (preview.impact_digest !== expectedImpactDigest) {
    throw new HttpError(409, "impact_changed", "Membership impact changed; review the latest preview");
  }
  const result = await env.OPEN_BRAIN_DB.prepare(
    "DELETE FROM group_members WHERE tenant_id = ? AND group_id = ? AND principal = ? AND updated_at = ?"
  )
    .bind(tenantId, groupId, memberPrincipal, membership.updated_at)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "impact_changed", "Membership changed; review the latest preview");
  }
  return getGroup(env, tenantId, groupId, principal, tenantAdmin);
}

export async function archiveGroup(env: Env, tenantId: string, groupId: string, principal: string, tenantAdmin = false) {
  await assertGroupAdmin(env, tenantId, groupId, principal, tenantAdmin);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE groups SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL"
  ).bind(now, now, tenantId, groupId).run();
  return { archived: true, group_id: groupId };
}
