export type MemoryReadAccess = {
  principal: string;
  isAdmin?: boolean;
  allowedProjectId?: string | null;
  scope?: "mine" | "org";
};

// Only values are quoted here; aliases are internal constants, never request input.
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Apply before LIMIT/COUNT, with canonical policies taking precedence over legacy ACLs. */
export function memoryReadAccessSql(alias: string, access?: MemoryReadAccess): string {
  if (!access) return "1 = 1"; // Trusted internal callers retain their existing contract.
  const principal = quote(access.principal);
  const member = (project: string) => `(${access.allowedProjectId ? `${project} = ${quote(access.allowedProjectId)} OR ` : ""}EXISTS (SELECT 1 FROM principal_role_assignments ra
    WHERE ra.tenant_id = ${alias}.tenant_id AND ra.principal = ${principal}
      AND (ra.project_id IS NULL OR ra.project_id = ${project})
      AND ra.role IN ('tenant_admin', 'project_owner', 'contributor', 'reader', 'service_agent', 'auditor')))`;
  const group = (id: string) => `EXISTS (SELECT 1 FROM group_members gm
    WHERE gm.tenant_id = ${alias}.tenant_id AND gm.principal = ${principal} AND gm.group_id = ${id})`;
  const subject = (type: string, id: string) => `((${type} = 'principal' AND ${id} = ${principal})
    OR (${type} = 'group' AND ${group(id)}))`;
  const policy = `p.tenant_id = ${alias}.tenant_id AND p.resource_type = 'memory' AND p.resource_id = ${alias}.id`;
  const canonical = `EXISTS (SELECT 1 FROM resource_access_policies p WHERE ${policy} AND (
    p.owner_principal = ${principal} OR p.scope = 'tenant'
    OR (p.scope = 'project' AND p.project_id IS NOT NULL AND ${member("p.project_id")})
    OR (p.scope IN ('group', 'restricted') AND EXISTS (SELECT 1 FROM json_each(p.group_ids_json) g WHERE ${group("g.value")}))
    OR (p.scope = 'restricted' AND EXISTS (SELECT 1 FROM json_each(p.restricted_subjects_json) s
      WHERE ${subject("json_extract(s.value, '$.subject_type')", "json_extract(s.value, '$.subject_id')")}))))`;
  const acl = `EXISTS (SELECT 1 FROM resource_acl a WHERE a.tenant_id = ${alias}.tenant_id
    AND a.resource_type = 'memory' AND a.resource_id = ${alias}.id AND a.permission = 'read'
    AND (${subject("a.subject_type", "a.subject_id")} OR (a.subject_type = 'tenant' AND a.subject_id = ${alias}.tenant_id)))`;
  const grants = `COALESCE(${alias}.permissions_json, '[]')`;
  const legacy = `(${alias}.owner_principal = ${principal}
    OR CASE WHEN ${alias}.scope_type IN ('user', 'agent') THEN ${alias}.scope_key = ${principal}
      WHEN ${alias}.scope_type = 'project' AND ${alias}.project_id IS NOT NULL THEN ${member(`${alias}.project_id`)}
      ELSE (${acl} OR CASE WHEN json_valid(${grants}) THEN
        (json_array_length(${grants}) = 0 OR EXISTS (SELECT 1 FROM json_each(${grants}) g
          WHERE EXISTS (SELECT 1 FROM json_each(json_extract(g.value, '$.permissions')) r WHERE r.value = 'read')
          AND (${subject("json_extract(g.value, '$.principal_type')", "json_extract(g.value, '$.principal_id')")}
            OR (json_extract(g.value, '$.principal_type') = 'tenant' AND json_extract(g.value, '$.principal_id') = ${alias}.tenant_id))))
        ELSE 0 END) END)`;
  const admin = `EXISTS (SELECT 1 FROM principal_role_assignments ar WHERE ar.tenant_id = ${alias}.tenant_id AND ar.principal = ${principal} AND ar.project_id IS NULL AND ar.role = 'tenant_admin')`;
  const readable = access.isAdmin ? "1 = 1" : `(${admin} OR ${canonical} OR (NOT EXISTS (SELECT 1 FROM resource_access_policies p WHERE ${policy}) AND ${legacy}))`;
  const projectBoundary = access.allowedProjectId ? `${alias}.project_id = ${quote(access.allowedProjectId)}` : "1 = 1";
  const authorized = `(${projectBoundary} AND ${readable})`;
  return access.scope === "mine" ? `(${alias}.owner_principal = ${principal} AND ${authorized})` : authorized;
}
