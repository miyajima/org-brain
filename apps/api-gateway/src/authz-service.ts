import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export const RESOURCE_TYPES = ["decision_memory", "knowledge_doc"] as const;
export const SUBJECT_TYPES = ["principal", "group", "tenant"] as const;
export const ACL_PERMISSIONS = ["read", "write"] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type AclPermission = (typeof ACL_PERMISSIONS)[number];

export type AuthzContext = {
  tenantId: string;
  principal: string;
  groupIds: string[];
  subjects: Array<{ subjectType: SubjectType; subjectId: string }>;
};

export type ResourceAclEntry = {
  subject_type: SubjectType;
  subject_id: string;
  permission: AclPermission;
};

function parseEnum<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
}

export function parseResourceType(value: unknown): ResourceType {
  return parseEnum(value, "resource_type", RESOURCE_TYPES);
}

export async function loadPrincipalGroupIds(env: Env, tenantId: string, principal: string): Promise<string[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT group_id
     FROM group_members
     WHERE tenant_id = ? AND principal = ?`
  )
    .bind(tenantId, principal)
    .all<{ group_id: string }>();
  return [...new Set(rows.results.map((row) => row.group_id))];
}

export async function buildAuthzContext(env: Env, tenantId: string, principal: string): Promise<AuthzContext> {
  const groupIds = await loadPrincipalGroupIds(env, tenantId, principal);
  return {
    tenantId,
    principal,
    groupIds,
    subjects: [
      { subjectType: "principal", subjectId: principal },
      ...groupIds.map((groupId) => ({ subjectType: "group" as const, subjectId: groupId })),
      { subjectType: "tenant", subjectId: tenantId }
    ]
  };
}

export async function loadReadableResourceIds(
  env: Env,
  args: { tenantId: string; resourceType: ResourceType; resourceIds: string[]; authz: AuthzContext }
): Promise<Set<string>> {
  const ids = [...new Set(args.resourceIds.filter(Boolean))];
  if (ids.length === 0 || args.authz.subjects.length === 0) return new Set();
  const idPlaceholders = ids.map(() => "?").join(", ");
  const subjectClauses = args.authz.subjects.map(() => "(subject_type = ? AND subject_id = ?)").join(" OR ");
  const subjectBindings = args.authz.subjects.flatMap((subject) => [subject.subjectType, subject.subjectId]);
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT resource_id
     FROM resource_acl
     WHERE tenant_id = ?
       AND resource_type = ?
       AND resource_id IN (${idPlaceholders})
       AND permission = 'read'
       AND (${subjectClauses})`
  )
    .bind(args.tenantId, args.resourceType, ...ids, ...subjectBindings)
    .all<{ resource_id: string }>();
  return new Set(rows.results.map((row) => row.resource_id));
}

export async function listResourceAcl(
  env: Env,
  tenantId: string,
  resourceType: ResourceType,
  resourceId: string
): Promise<ResourceAclEntry[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT subject_type, subject_id, permission
     FROM resource_acl
     WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?
     ORDER BY subject_type, subject_id`
  )
    .bind(tenantId, resourceType, resourceId)
    .all<ResourceAclEntry>();
  return rows.results;
}

export function parseAclEntries(raw: unknown): ResourceAclEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_payload", "entries must be an array");
  return raw.slice(0, 100).map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new HttpError(400, "invalid_payload", `entries[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      subject_type: parseEnum(record.subject_type, `entries[${index}].subject_type`, SUBJECT_TYPES),
      subject_id: parseString(record.subject_id, `entries[${index}].subject_id`, 128),
      permission: parseEnum(record.permission ?? "read", `entries[${index}].permission`, ACL_PERMISSIONS)
    };
  });
}

export async function replaceResourceAcl(
  env: Env,
  args: {
    tenantId: string;
    resourceType: ResourceType;
    resourceId: string;
    entries: ResourceAclEntry[];
    actorPrincipal: string;
  }
): Promise<ResourceAclEntry[]> {
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM resource_acl WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?"
    ).bind(args.tenantId, args.resourceType, args.resourceId)
  ];
  const seen = new Set<string>();
  for (const entry of args.entries) {
    const key = `${entry.subject_type}:${entry.subject_id}:${entry.permission}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO resource_acl(
          id, tenant_id, resource_type, resource_id, subject_type, subject_id, permission, created_by_principal, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`
      ).bind(
        ulid(),
        args.tenantId,
        args.resourceType,
        args.resourceId,
        entry.subject_type,
        entry.subject_id,
        entry.permission,
        args.actorPrincipal,
        Date.now()
      )
    );
  }
  await env.OPEN_BRAIN_DB.batch(statements);
  return listResourceAcl(env, args.tenantId, args.resourceType, args.resourceId);
}
