import {
  HttpError,
  ORG_ROLES,
  isOrgRole,
  roleAllows,
  ulid,
  type OrgPermission,
  type OrgRole
} from "@org-brain/shared";
import type { Env } from "./types";

export type RoleAssignment = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  principal: string;
  role: OrgRole;
  created_by_principal: string;
  created_at: number;
  updated_at: number;
};

export type AuthorizationDecision = {
  allowed: boolean;
  tenant_id: string;
  project_id: string | null;
  principal: string;
  permission: OrgPermission;
  matched_roles: OrgRole[];
  source: "assignment" | "auth-default" | "none";
};

function parseString(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", `${field} must be a non-empty string`);
  }
  return value.trim().slice(0, maxLength);
}

function parseProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return parseString(value, "project_id");
}

function parseRole(value: unknown): OrgRole {
  if (!isOrgRole(value)) {
    throw new HttpError(400, "invalid_payload", `role must be one of ${ORG_ROLES.join(", ")}`);
  }
  return value;
}

export async function listRoleAssignments(
  env: Env,
  tenantId: string,
  options: { principal?: string | null; projectId?: string | null } = {}
): Promise<RoleAssignment[]> {
  const clauses = ["tenant_id = ?"];
  const bindings: unknown[] = [tenantId];
  if (options.principal) {
    clauses.push("principal = ?");
    bindings.push(options.principal);
  }
  if (options.projectId !== undefined) {
    if (options.projectId === null) clauses.push("project_id IS NULL");
    else {
      clauses.push("(project_id IS NULL OR project_id = ?)");
      bindings.push(options.projectId);
    }
  }
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, principal, role, created_by_principal, created_at, updated_at
     FROM principal_role_assignments
     WHERE ${clauses.join(" AND ")}
     ORDER BY principal, project_id, role`
  )
    .bind(...bindings)
    .all<RoleAssignment>();
  return rows.results.filter((row) => isOrgRole(row.role));
}

export async function authorizePermission(
  env: Env,
  args: {
    tenantId: string;
    projectId?: string | null;
    principal: string;
    permission: OrgPermission;
    fallbackRole?: OrgRole;
  }
): Promise<AuthorizationDecision> {
  const projectId = args.projectId?.trim() || null;
  const assignments = await listRoleAssignments(env, args.tenantId, {
    principal: args.principal,
    projectId
  });
  const matchedRoles = assignments
    .filter((assignment) => assignment.project_id === null || assignment.project_id === projectId)
    .map((assignment) => assignment.role)
    .filter((role, index, roles) => roles.indexOf(role) === index);
  if (matchedRoles.length > 0) {
    return {
      allowed: matchedRoles.some((role) => roleAllows(role, args.permission)),
      tenant_id: args.tenantId,
      project_id: projectId,
      principal: args.principal,
      permission: args.permission,
      matched_roles: matchedRoles,
      source: "assignment"
    };
  }
  const fallbackRole = args.fallbackRole;
  return {
    allowed: Boolean(fallbackRole && roleAllows(fallbackRole, args.permission)),
    tenant_id: args.tenantId,
    project_id: projectId,
    principal: args.principal,
    permission: args.permission,
    matched_roles: fallbackRole ? [fallbackRole] : [],
    source: fallbackRole ? "auth-default" : "none"
  };
}

export async function assertPermission(
  env: Env,
  args: Parameters<typeof authorizePermission>[1]
): Promise<AuthorizationDecision> {
  const decision = await authorizePermission(env, args);
  if (!decision.allowed) {
    throw new HttpError(
      403,
      "forbidden",
      `Principal "${args.principal}" lacks ${args.permission} permission for tenant "${args.tenantId}"`
    );
  }
  return decision;
}

export async function upsertRoleAssignment(
  env: Env,
  tenantId: string,
  raw: unknown,
  actorPrincipal: string
): Promise<RoleAssignment> {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = raw as Record<string, unknown>;
  const principal = parseString(body.principal, "principal");
  const projectId = parseProjectId(body.project_id);
  const role = parseRole(body.role);
  if (role === "project_owner" && !projectId) {
    throw new HttpError(400, "invalid_payload", "project_owner requires project_id");
  }
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM principal_role_assignments
     WHERE tenant_id = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND principal = ? AND role = ?`
  )
    .bind(tenantId, projectId, principal, role)
    .first<{ id: string }>();
  const now = Date.now();
  const id = existing?.id ?? ulid();
  if (existing) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE principal_role_assignments
       SET updated_at = ?, created_by_principal = ?
       WHERE id = ? AND tenant_id = ?`
    ).bind(now, actorPrincipal, id, tenantId).run();
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO principal_role_assignments(
        id, tenant_id, project_id, principal, role, created_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`
    ).bind(id, tenantId, projectId, principal, role, actorPrincipal, now, now).run();
  }
  return {
    id,
    tenant_id: tenantId,
    project_id: projectId,
    principal,
    role,
    created_by_principal: actorPrincipal,
    created_at: now,
    updated_at: now
  };
}

export async function deleteRoleAssignment(
  env: Env,
  tenantId: string,
  assignmentId: string
): Promise<{ deleted: boolean; id: string }> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    "DELETE FROM principal_role_assignments WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, assignmentId).run();
  return { deleted: Boolean(result.meta.changes), id: assignmentId };
}
