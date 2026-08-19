import {
  ACCESS_POLICY_CONTRACT_VERSION,
  resourceAccessPolicyUpdateSchema,
  type AccessPolicyResourceType,
  type AccessPolicyScope,
  type AccessPolicyStorageLocation
} from "@org-brain/contracts";
import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export type AccessPolicySubject = {
  subject_type: "principal" | "group";
  subject_id: string;
};

export type ResourceAccessPolicy = {
  id: string;
  tenant_id: string;
  resource_type: AccessPolicyResourceType;
  resource_id: string;
  scope: AccessPolicyScope;
  owner_principal: string;
  project_id: string | null;
  group_ids: string[];
  restricted_subjects: AccessPolicySubject[];
  storage_location: AccessPolicyStorageLocation;
  policy_version: number;
  created_at: number;
  updated_at: number;
};

type PolicyRow = Omit<ResourceAccessPolicy, "group_ids" | "restricted_subjects"> & {
  group_ids_json: string;
  restricted_subjects_json: string;
};

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function toPolicy(row: PolicyRow): ResourceAccessPolicy {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    scope: row.scope,
    owner_principal: row.owner_principal,
    project_id: row.project_id,
    group_ids: parseJsonArray<string>(row.group_ids_json).filter((item) => typeof item === "string"),
    restricted_subjects: parseJsonArray<AccessPolicySubject>(row.restricted_subjects_json).filter((item) =>
      item?.subject_type === "principal" || item?.subject_type === "group"
    ),
    storage_location: row.storage_location,
    policy_version: Number(row.policy_version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at)
  };
}

export async function loadAccessPolicy(
  env: Env,
  tenantId: string,
  resourceType: AccessPolicyResourceType,
  resourceId: string
): Promise<ResourceAccessPolicy | null> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
            group_ids_json, restricted_subjects_json, storage_location, policy_version,
            created_at, updated_at
     FROM resource_access_policies
     WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`
  ).bind(tenantId, resourceType, resourceId).first<PolicyRow>();
  return row ? toPolicy(row) : null;
}

export async function loadPrincipalGroupIds(env: Env, tenantId: string, principal: string): Promise<Set<string>> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT group_id FROM group_members WHERE tenant_id = ? AND principal = ?`
  ).bind(tenantId, principal).all<{ group_id: string }>();
  return new Set(rows.results.map((row) => row.group_id));
}

export async function loadAccessPolicies(
  env: Env,
  tenantId: string,
  resourceType: AccessPolicyResourceType,
  resourceIds: string[]
): Promise<Map<string, ResourceAccessPolicy>> {
  const ids = [...new Set(resourceIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
            group_ids_json, restricted_subjects_json, storage_location, policy_version,
            created_at, updated_at
     FROM resource_access_policies
     WHERE tenant_id = ? AND resource_type = ?
       AND resource_id IN (SELECT value FROM json_each(?))`
  ).bind(tenantId, resourceType, JSON.stringify(ids)).all<PolicyRow>();
  return new Map(rows.results.map((row) => [row.resource_id, toPolicy(row)]));
}

const LEGACY_SHADOW_TYPES = new Set<AccessPolicyResourceType>([
  "memory",
  "decision_memory",
  "knowledge_doc",
  "knowledge_resource"
]);

async function legacyAclReadable(
  env: Env,
  policy: ResourceAccessPolicy,
  principal: string,
  groupIds: Set<string>
): Promise<boolean> {
  const subjects = [
    { type: "principal", id: principal },
    { type: "tenant", id: policy.tenant_id },
    ...[...groupIds].map((id) => ({ type: "group", id }))
  ];
  if (subjects.length === 0) return false;
  const predicates = subjects.map(() => "(subject_type = ? AND subject_id = ?)").join(" OR ");
  const bindings = subjects.flatMap((subject) => [subject.type, subject.id]);
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT 1 AS readable FROM resource_acl
     WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND permission = 'read'
       AND (${predicates}) LIMIT 1`
  ).bind(policy.tenant_id, policy.resource_type, policy.resource_id, ...bindings).first<{ readable: number }>();
  return Boolean(row);
}

async function legacyReadable(
  env: Env,
  policy: ResourceAccessPolicy,
  options: { tenantId: string; principal: string; projectId?: string | null; isAdmin?: boolean },
  groupIds: Set<string>
): Promise<boolean> {
  if (options.isAdmin || policy.owner_principal === options.principal) return true;
  const aclReadable = await legacyAclReadable(env, policy, options.principal, groupIds);
  if (policy.resource_type === "decision_memory") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT visibility, project_id, allowed_principals_json FROM decision_memories
       WHERE tenant_id = ? AND id = ?`
    ).bind(policy.tenant_id, policy.resource_id).first<{ visibility: string; project_id: string | null; allowed_principals_json: string }>();
    if (!row) return false;
    if (row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && options.projectId === row.project_id);
    return parseJsonArray<string>(row.allowed_principals_json).includes(options.principal) || aclReadable;
  }
  if (policy.resource_type === "knowledge_doc") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT visibility, owner_principal, project_id FROM knowledge_docs WHERE tenant_id = ? AND id = ?`
    ).bind(policy.tenant_id, policy.resource_id).first<{ visibility: string; owner_principal: string | null; project_id: string | null }>();
    if (!row) return false;
    if (row.owner_principal === options.principal || row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && options.projectId === row.project_id);
    return aclReadable;
  }
  if (policy.resource_type === "knowledge_resource") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT visibility, project_id, permissions_json FROM knowledge_resources WHERE tenant_id = ? AND id = ?`
    ).bind(policy.tenant_id, policy.resource_id).first<{ visibility: string; project_id: string | null; permissions_json: string }>();
    if (!row) return false;
    if (row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && options.projectId === row.project_id);
    return parseJsonArray<string>(row.permissions_json).includes(options.principal) || aclReadable;
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT scope_type, scope_key, project_id, owner_principal, permissions_json
     FROM memories WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
  ).bind(policy.tenant_id, policy.resource_id).first<{
    scope_type: string;
    scope_key: string | null;
    project_id: string | null;
    owner_principal: string | null;
    permissions_json: string;
  }>();
  if (!row) return false;
  if (row.owner_principal === options.principal) return true;
  if (row.scope_type === "user" || row.scope_type === "agent") return row.scope_key === options.principal;
  if (row.scope_type === "project" && row.project_id) return options.projectId === row.project_id;
  const grants = parseJsonArray<Record<string, unknown>>(row.permissions_json);
  if (grants.length === 0) return true;
  return grants.some((grant) => {
    const permissions = Array.isArray(grant.permissions) ? grant.permissions : [];
    if (!permissions.includes("read")) return false;
    if (grant.principal_type === "principal") return grant.principal_id === options.principal;
    if (grant.principal_type === "group" && typeof grant.principal_id === "string") return groupIds.has(grant.principal_id);
    return grant.principal_type === "tenant" && grant.principal_id === options.tenantId;
  }) || aclReadable;
}

async function recordShadowComparison(
  env: Env,
  policy: ResourceAccessPolicy,
  options: { tenantId: string; principal: string; projectId?: string | null; isAdmin?: boolean },
  groupIds: Set<string>,
  unifiedReadable: boolean
): Promise<void> {
  if (env.ACCESS_POLICY_SHADOW_MODE !== "on" || !LEGACY_SHADOW_TYPES.has(policy.resource_type)) return;
  try {
    const legacy = await legacyReadable(env, policy, options, groupIds);
    const now = Date.now();
    const projectKey = options.projectId ?? "";
    if (legacy === unifiedReadable) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE access_policy_shadow_diffs SET resolved_at = ?
         WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?
           AND principal = ? AND project_key = ? AND resolved_at IS NULL`
      ).bind(now, policy.tenant_id, policy.resource_type, policy.resource_id, options.principal, projectKey).run();
      return;
    }
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO access_policy_shadow_diffs(
        id, tenant_id, resource_type, resource_id, principal, project_key,
        policy_version, unified_readable, legacy_readable, sample_count,
        first_seen_at, last_seen_at, resolved_at
      ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,NULL)
      ON CONFLICT(tenant_id, resource_type, resource_id, principal, project_key) DO UPDATE SET
        policy_version = excluded.policy_version,
        unified_readable = excluded.unified_readable,
        legacy_readable = excluded.legacy_readable,
        sample_count = access_policy_shadow_diffs.sample_count + 1,
        last_seen_at = excluded.last_seen_at,
        resolved_at = NULL`
    ).bind(
      ulid(), policy.tenant_id, policy.resource_type, policy.resource_id,
      options.principal, projectKey, policy.policy_version,
      unifiedReadable ? 1 : 0, legacy ? 1 : 0, now, now
    ).run();
  } catch (error) {
    console.warn({
      event: "orgbrain.access_policy.shadow_failed",
      tenant_id: policy.tenant_id,
      resource_type: policy.resource_type,
      resource_id: policy.resource_id,
      error_code: error instanceof Error ? error.name : "unknown"
    });
  }
}

export async function canReadResource(
  env: Env,
  policy: ResourceAccessPolicy | null,
  options: { tenantId: string; principal: string; projectId?: string | null; isAdmin?: boolean }
): Promise<boolean> {
  if (!policy || policy.tenant_id !== options.tenantId) return false;
  const groupIds = await loadPrincipalGroupIds(env, options.tenantId, options.principal);
  return canReadResourceWithGroups(env, policy, options, groupIds);
}

export async function canReadResourceWithGroups(
  env: Env,
  policy: ResourceAccessPolicy | null,
  options: { tenantId: string; principal: string; projectId?: string | null; isAdmin?: boolean },
  groupIds: Set<string>
): Promise<boolean> {
  if (!policy || policy.tenant_id !== options.tenantId) return false;
  let readable = false;
  if (options.isAdmin || policy.owner_principal === options.principal || policy.scope === "tenant") {
    readable = true;
  } else if (policy.scope === "project") {
    readable = Boolean(policy.project_id && options.projectId && policy.project_id === options.projectId);
  } else if (policy.scope === "group") {
    readable = policy.group_ids.some((groupId) => groupIds.has(groupId));
  } else if (policy.scope === "restricted") {
    readable = policy.restricted_subjects.some((subject) =>
      subject.subject_type === "principal"
        ? subject.subject_id === options.principal
        : groupIds.has(subject.subject_id)
    ) || policy.group_ids.some((groupId) => groupIds.has(groupId));
  }
  await recordShadowComparison(env, policy, options, groupIds, readable);
  return readable;
}

export async function assertResourceReadable(
  env: Env,
  args: {
    tenantId: string;
    resourceType: AccessPolicyResourceType;
    resourceId: string;
    principal: string;
    projectId?: string | null;
    isAdmin?: boolean;
  }
): Promise<ResourceAccessPolicy> {
  const policy = await loadAccessPolicy(env, args.tenantId, args.resourceType, args.resourceId);
  if (!await canReadResource(env, policy, args)) {
    throw new HttpError(404, "resource_not_found", "Resource not found");
  }
  return policy!;
}

async function assertGroupsManageable(
  env: Env,
  tenantId: string,
  groupIds: string[],
  actorPrincipal: string,
  isAdmin: boolean
): Promise<void> {
  if (isAdmin) return;
  for (const groupId of groupIds) {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT role FROM group_members WHERE tenant_id = ? AND group_id = ? AND principal = ?`
    ).bind(tenantId, groupId, actorPrincipal).first<{ role: string }>();
    if (!row || !["owner", "admin"].includes(row.role)) {
      throw new HttpError(403, "forbidden", "Group owner or admin role is required");
    }
  }
}

function legacyVisibility(scope: AccessPolicyScope): "tenant" | "project" | "restricted" {
  if (scope === "tenant") return "tenant";
  if (scope === "project") return "project";
  return "restricted";
}

async function mirrorLegacyColumns(env: Env, policy: ResourceAccessPolicy): Promise<void> {
  const principals = policy.restricted_subjects
    .filter((subject) => subject.subject_type === "principal")
    .map((subject) => subject.subject_id);
  if (policy.resource_type === "decision_memory") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE decision_memories SET visibility = ?, allowed_principals_json = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(legacyVisibility(policy.scope), JSON.stringify(principals), policy.updated_at, policy.tenant_id, policy.resource_id).run();
  } else if (policy.resource_type === "knowledge_doc") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_docs SET visibility = ?, project_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(legacyVisibility(policy.scope), policy.project_id, policy.updated_at, policy.tenant_id, policy.resource_id).run();
  } else if (policy.resource_type === "knowledge_resource") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_resources SET visibility = ?, permissions_json = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(legacyVisibility(policy.scope), JSON.stringify(principals), policy.updated_at, policy.tenant_id, policy.resource_id).run();
  } else if (policy.resource_type === "memory") {
    const grants = [
      ...policy.restricted_subjects.map((subject) => ({
        principal_type: subject.subject_type,
        principal_id: subject.subject_id,
        permissions: ["read"]
      })),
      ...policy.group_ids.map((groupId) => ({
        principal_type: "group",
        principal_id: groupId,
        permissions: ["read"]
      }))
    ];
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE memories SET permissions_json = ?, scope_type = ?, scope_key = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(
      JSON.stringify(grants),
      policy.scope === "project" ? "project" : policy.scope === "private" ? "user" : "tenant",
      policy.scope === "project" ? policy.project_id : policy.scope === "private" ? policy.owner_principal : policy.tenant_id,
      policy.updated_at,
      policy.tenant_id,
      policy.resource_id
    ).run();
  } else if (policy.resource_type === "skill_asset") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE skill_assets SET owner_principal = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(policy.owner_principal, policy.updated_at, policy.tenant_id, policy.resource_id).run();
  } else if (policy.resource_type === "agent") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE agents SET owner_principal = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(policy.owner_principal, policy.updated_at, policy.tenant_id, policy.resource_id).run();
  } else if (policy.resource_type === "agent_loadout") {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE agent_loadouts SET owner_principal = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(policy.owner_principal, policy.updated_at, policy.tenant_id, policy.resource_id).run();
  }
}

async function mirrorLegacyAcl(env: Env, policy: ResourceAccessPolicy, actorPrincipal: string): Promise<void> {
  const now = policy.updated_at;
  const subjects: AccessPolicySubject[] = [
    { subject_type: "principal", subject_id: policy.owner_principal },
    ...(policy.scope === "tenant" ? [{ subject_type: "principal" as const, subject_id: `__tenant__:${policy.tenant_id}` }] : []),
    ...(policy.scope === "group" ? policy.group_ids.map((groupId) => ({ subject_type: "group" as const, subject_id: groupId })) : []),
    ...(policy.scope === "restricted" ? policy.restricted_subjects : [])
  ];
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM resource_acl WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`
    ).bind(policy.tenant_id, policy.resource_type, policy.resource_id)
  ];
  const seen = new Set<string>();
  for (const subject of subjects) {
    const normalized = subject.subject_id.startsWith("__tenant__:")
      ? { subject_type: "tenant" as const, subject_id: policy.tenant_id }
      : subject;
    const key = `${normalized.subject_type}:${normalized.subject_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO resource_acl(
        id, tenant_id, resource_type, resource_id, subject_type, subject_id,
        permission, created_by_principal, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(
      ulid(), policy.tenant_id, policy.resource_type, policy.resource_id,
      normalized.subject_type, normalized.subject_id, "read", actorPrincipal, now
    ));
  }
  await env.OPEN_BRAIN_DB.batch(statements);
}

export async function ensureAccessPolicy(
  env: Env,
  args: {
    tenantId: string;
    resourceType: AccessPolicyResourceType;
    resourceId: string;
    scope?: AccessPolicyScope;
    ownerPrincipal: string;
    projectId?: string | null;
    groupIds?: string[];
    restrictedSubjects?: AccessPolicySubject[];
    storageLocation?: AccessPolicyStorageLocation;
    actorPrincipal: string;
  }
): Promise<ResourceAccessPolicy> {
  const existing = await loadAccessPolicy(env, args.tenantId, args.resourceType, args.resourceId);
  if (existing) return existing;
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO resource_access_policies(
      id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
      group_ids_json, restricted_subjects_json, storage_location, policy_version,
      created_by_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    ulid(), args.tenantId, args.resourceType, args.resourceId, args.scope ?? "private",
    args.ownerPrincipal, args.projectId ?? null, JSON.stringify(args.groupIds ?? []),
    JSON.stringify(args.restrictedSubjects ?? []), args.storageLocation ?? "d1", 1,
    args.actorPrincipal, now, now
  ).run();
  return (await loadAccessPolicy(env, args.tenantId, args.resourceType, args.resourceId))!;
}

export async function updateAccessPolicy(
  env: Env,
  rawBody: unknown,
  options: { tenantId: string; actorPrincipal: string; isAdmin: boolean }
) {
  const parsed = resourceAccessPolicyUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid access policy");
  }
  const input = parsed.data;
  const current = await loadAccessPolicy(env, options.tenantId, input.resource_type, input.resource_id);
  if (!current) throw new HttpError(404, "resource_not_found", "Resource not found");
  if (!options.isAdmin && current.owner_principal !== options.actorPrincipal) {
    throw new HttpError(403, "forbidden", "Only the owner or tenant admin can update access");
  }
  if (!options.isAdmin && input.owner_principal && input.owner_principal !== current.owner_principal) {
    throw new HttpError(403, "forbidden", "Only a tenant admin can transfer ownership");
  }
  await assertGroupsManageable(
    env,
    options.tenantId,
    [...new Set([...input.group_ids, ...input.restricted_subjects.filter((item) => item.subject_type === "group").map((item) => item.subject_id)])],
    options.actorPrincipal,
    options.isAdmin
  );
  const now = Date.now();
  const expectedVersion = input.expected_policy_version ?? current.policy_version;
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE resource_access_policies
     SET scope = ?, owner_principal = ?, project_id = ?, group_ids_json = ?,
         restricted_subjects_json = ?, policy_version = policy_version + 1, updated_at = ?
     WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND policy_version = ?`
  ).bind(
    input.scope,
    input.owner_principal ?? current.owner_principal,
    input.project_id === undefined ? current.project_id : input.project_id,
    JSON.stringify([...new Set(input.group_ids)]),
    JSON.stringify(input.restricted_subjects),
    now,
    options.tenantId,
    input.resource_type,
    input.resource_id,
    expectedVersion
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "policy_conflict", "Access policy changed; reload before saving");
  }
  const policy = (await loadAccessPolicy(env, options.tenantId, input.resource_type, input.resource_id))!;
  await mirrorLegacyColumns(env, policy);
  await mirrorLegacyAcl(env, policy, options.actorPrincipal);
  return { contract_version: ACCESS_POLICY_CONTRACT_VERSION, policy };
}

export async function getAccessPolicy(
  env: Env,
  args: {
    tenantId: string;
    resourceType: AccessPolicyResourceType;
    resourceId: string;
    principal: string;
    projectId?: string | null;
    isAdmin?: boolean;
  }
) {
  const policy = await assertResourceReadable(env, args);
  const agentCandidates = args.resourceType === "skill_asset"
    ? (await env.OPEN_BRAIN_DB.prepare(
      `SELECT DISTINCT a.id, a.agent_key, a.name, a.status, l.id AS loadout_id
       FROM agent_loadout_bindings b
       JOIN agent_loadouts l ON l.tenant_id = b.tenant_id AND l.id = b.loadout_id AND l.status = 'active'
       JOIN agents a ON a.tenant_id = l.tenant_id AND a.id = l.agent_id AND a.status <> 'retired'
       WHERE b.tenant_id = ? AND b.skill_asset_id = ?
       ORDER BY a.name LIMIT 100`
    ).bind(args.tenantId, args.resourceId).all<{
      id: string;
      agent_key: string;
      name: string;
      status: string;
      loadout_id: string;
    }>()).results
    : [];
  const agents: Array<{ id: string; agent_key: string; name: string; status: string }> = [];
  if (agentCandidates.length > 0) {
    const [agentPolicies, loadoutPolicies, groupIds] = await Promise.all([
      loadAccessPolicies(env, args.tenantId, "agent", agentCandidates.map((agent) => agent.id)),
      loadAccessPolicies(env, args.tenantId, "agent_loadout", agentCandidates.map((agent) => agent.loadout_id)),
      loadPrincipalGroupIds(env, args.tenantId, args.principal)
    ]);
    for (const agent of agentCandidates) {
      const options = {
        tenantId: args.tenantId,
        principal: args.principal,
        projectId: args.projectId,
        isAdmin: args.isAdmin
      };
      if (
        await canReadResourceWithGroups(env, agentPolicies.get(agent.id) ?? null, options, groupIds) &&
        await canReadResourceWithGroups(env, loadoutPolicies.get(agent.loadout_id) ?? null, options, groupIds)
      ) {
        agents.push({
          id: agent.id,
          agent_key: agent.agent_key,
          name: agent.name,
          status: agent.status
        });
      }
    }
  }
  return { contract_version: ACCESS_POLICY_CONTRACT_VERSION, policy, utilizing_agents: agents };
}

export async function getAccessPolicyShadowSummary(
  env: Env,
  tenantId: string,
  options: { limit?: number; includeResolved?: boolean } = {}
) {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
  const resolvedClause = options.includeResolved ? "" : "AND resolved_at IS NULL";
  const [counts, diffs] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
         COALESCE(SUM(sample_count), 0) AS samples
       FROM access_policy_shadow_diffs WHERE tenant_id = ?`
    ).bind(tenantId).first<{ total: number; open: number; resolved: number; samples: number }>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT resource_type, resource_id, principal, project_key, policy_version,
              unified_readable, legacy_readable, sample_count, first_seen_at,
              last_seen_at, resolved_at
       FROM access_policy_shadow_diffs
       WHERE tenant_id = ? ${resolvedClause}
       ORDER BY last_seen_at DESC, resource_type, resource_id
       LIMIT ?`
    ).bind(tenantId, limit).all<{
      resource_type: AccessPolicyResourceType;
      resource_id: string;
      principal: string;
      project_key: string;
      policy_version: number;
      unified_readable: number;
      legacy_readable: number;
      sample_count: number;
      first_seen_at: number;
      last_seen_at: number;
      resolved_at: number | null;
    }>()
  ]);
  return {
    contract_version: ACCESS_POLICY_CONTRACT_VERSION,
    shadow_mode: env.ACCESS_POLICY_SHADOW_MODE ?? "off",
    counts: {
      total: Number(counts?.total ?? 0),
      open: Number(counts?.open ?? 0),
      resolved: Number(counts?.resolved ?? 0),
      samples: Number(counts?.samples ?? 0)
    },
    diffs: diffs.results.map((row) => ({
      ...row,
      project_id: row.project_key || null,
      unified_readable: Boolean(row.unified_readable),
      legacy_readable: Boolean(row.legacy_readable)
    }))
  };
}
