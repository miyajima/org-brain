import { HttpError } from "@org-brain/shared";
import {
  listResourceAcl,
  parseAclEntries,
  parseResourceType,
  replaceResourceAcl,
  type ResourceAclEntry
} from "./authz-service";
import type { Env } from "./types";

type KnowledgeOwnerRow = {
  owner_principal: string | null;
};

type DecisionOwnerRow = {
  owner_refs_json: string | null;
};

function parseString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
}

function tenantFromBody(rawBody: unknown): string {
  if (!rawBody || typeof rawBody !== "object") return "default";
  const value = (rawBody as Record<string, unknown>).tenant_id;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : "default";
}

function ownerRefsContainPrincipal(raw: string | null, principal: string): boolean {
  if (!raw) return false;
  try {
    const refs = JSON.parse(raw);
    return Array.isArray(refs) && refs.some((ref) => ref && typeof ref === "object" && (ref as { id?: unknown }).id === principal);
  } catch {
    return false;
  }
}

async function assertActorCanShareResource(env: Env, args: {
  tenantId: string;
  resourceType: "decision_memory" | "knowledge_doc";
  resourceId: string;
  actorPrincipal: string;
}) {
  if (args.resourceType === "knowledge_doc") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT owner_principal
       FROM knowledge_docs
       WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
    )
      .bind(args.tenantId, args.resourceId)
      .first<KnowledgeOwnerRow>();
    if (!row) throw new HttpError(404, "resource_not_found", "Knowledge doc not found");
    if (row.owner_principal && row.owner_principal !== args.actorPrincipal) {
      throw new HttpError(403, "forbidden", "Only the resource owner can update sharing");
    }
    return;
  }

  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT owner_refs_json
     FROM decision_memories
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(args.tenantId, args.resourceId)
    .first<DecisionOwnerRow>();
  if (!row) throw new HttpError(404, "resource_not_found", "Decision memory not found");
  if (!ownerRefsContainPrincipal(row.owner_refs_json, args.actorPrincipal)) {
    throw new HttpError(403, "forbidden", "Only the resource owner can update sharing");
  }
}

async function assertActorCanShareWithGroups(env: Env, tenantId: string, entries: ResourceAclEntry[], actorPrincipal: string) {
  const groupIds = [...new Set(entries.filter((entry) => entry.subject_type === "group").map((entry) => entry.subject_id))];
  for (const groupId of groupIds) {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT role
       FROM group_members
       WHERE tenant_id = ? AND group_id = ? AND principal = ?`
    )
      .bind(tenantId, groupId, actorPrincipal)
      .first<{ role: string }>();
    if (!row || (row.role !== "owner" && row.role !== "admin")) {
      throw new HttpError(403, "forbidden", "Group owner or admin role is required to share with a group");
    }
  }
}

export async function updateResourceShare(env: Env, rawBody: unknown, actorPrincipal: string) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const tenantId = tenantFromBody(body);
  const resourceType = parseResourceType(body.resource_type);
  const resourceId = parseString(body.resource_id, "resource_id", 128);
  const entries = parseAclEntries(body.entries) as ResourceAclEntry[];
  await assertActorCanShareResource(env, { tenantId, resourceType, resourceId, actorPrincipal });
  await assertActorCanShareWithGroups(env, tenantId, entries, actorPrincipal);
  const acl = await replaceResourceAcl(env, {
    tenantId,
    resourceType,
    resourceId,
    entries,
    actorPrincipal
  });
  return {
    tenant_id: tenantId,
    resource_type: resourceType,
    resource_id: resourceId,
    acl
  };
}

export async function getResourceShare(env: Env, tenantId: string, rawType: string, resourceId: string) {
  const resourceType = parseResourceType(rawType);
  const acl = await listResourceAcl(env, tenantId, resourceType, resourceId);
  return {
    tenant_id: tenantId,
    resource_type: resourceType,
    resource_id: resourceId,
    acl
  };
}
