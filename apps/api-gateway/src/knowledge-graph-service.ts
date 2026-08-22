import {
  DASHBOARD_CONTRACT_VERSION,
  dashboardKnowledgeGraphQuerySchema,
  type DashboardKnowledgeCluster,
  type DashboardKnowledgeEdge,
  type DashboardKnowledgeGraphQuery,
  type DashboardKnowledgeGraphResponse,
  type DashboardKnowledgeNode,
  type DashboardNodeType
} from "@org-brain/contracts";
import { HttpError, normalizeLifecycleState, normalizeMemoryKind } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import { stableResultReadable } from "./memory-service";
import { compactText, finiteConfidence, normalizeTenantId } from "./request-value-utils";
import type { Env } from "./types";

const CANDIDATE_MULTIPLIER = 3;
const MAX_QUERY_ROWS = 900;
const CANDIDATE_PAGE_SIZE = 450;
const MIN_CANDIDATE_PAGE_SIZE = 100;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export type KnowledgeGraphOptions = Partial<DashboardKnowledgeGraphQuery> & {
  principal?: string | null;
  now?: number;
};

type ParsedOptions = DashboardKnowledgeGraphQuery & {
  principal: string | null;
  now: number;
};

type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  kind: string | null;
  lifecycle_state: string | null;
  confidence_score: number | null;
  permissions_json: string | null;
  updated_at: number | null;
  created_at: number;
  last_accessed_at: number | null;
};

type DecisionRow = {
  id: string;
  project_id: string | null;
  domain: string;
  title: string;
  decision: string;
  status: string;
  confirmation_state: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  superseded_by: string | null;
  updated_at: number;
  created_at: number;
};

type ResourceRow = {
  id: string;
  project_id: string | null;
  resource_kind: string;
  title: string;
  source_system: string;
  lifecycle_state: string;
  visibility: string;
  permissions_json: string | null;
  updated_at: number;
  created_at: number;
};

type TaskRow = {
  id: string;
  project_id: string | null;
  capability: string;
  status: string;
  priority: number | null;
  updated_at: number;
  created_at: number;
};

type MemoryEdgeRow = {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation: string;
  created_at: number;
};

type EntityLinkRow = {
  id: string;
  memory_id: string;
  entity_id: string;
  role: string;
  confidence_score: number | null;
  created_at: number;
  entity_type: string;
  canonical_name: string;
};

type AssertionRow = {
  id: string;
  subject_type: string;
  subject_ref: string;
  predicate: string;
  object_type: string | null;
  object_ref: string | null;
  resource_id: string | null;
  confidence: number | null;
};

type UsageEdgeRow = {
  item_id: string;
  source_type: "memory" | "decision_memory";
  source_id: string;
  task_id: string;
  reference_type: string;
  used_state: string;
  score: number | null;
  created_at: number;
};

type UsageStatRow = {
  source_type: "memory" | "decision_memory";
  source_id: string;
  usage_count: number;
  last_used_at: number | null;
};

type CandidateNode = DashboardKnowledgeNode & { sort_at: number };

type CandidateRows = {
  memories: MemoryRow[];
  decisions: DecisionRow[];
  resources: ResourceRow[];
  tasks: TaskRow[];
};

type CandidateCursor = {
  sortAt: number;
  id: string;
};

type BoundedRows<Row> = {
  rows: Row[];
  truncated: boolean;
};

type ExplicitEdgeResult = {
  edges: DashboardKnowledgeEdge[];
  truncated: boolean;
};

type RelatedRow = {
  relation_at: number;
  relation_id: string;
};

type RelatedMemoryRow = MemoryRow & RelatedRow;
type RelatedDecisionRow = DecisionRow & RelatedRow;
type RelatedResourceRow = ResourceRow & RelatedRow;
type RelatedTaskRow = TaskRow & RelatedRow;

type EntityNeighborRow = RelatedRow & {
  node_id: string;
};

type DirectEntityRow = {
  id: string;
  entity_type: string;
  canonical_name: string;
  matched_at: number;
};

type DirectEntityMemoryLinkRow = MemoryRow & {
  memory_id: string;
  link_id: string;
  entity_id: string;
  role: string;
  link_confidence_score: number | null;
  link_created_at: number;
  entity_type: string;
  canonical_name: string;
  entity_priority: number;
  per_entity_rank: number;
};

type DirectEntitySearchResult = {
  memories: MemoryRow[];
  links: EntityLinkRow[];
  hydratedNodeIds: Set<string>;
  priorityNodeIds: string[];
  truncated: boolean;
};

type HydrationCandidate =
  | { nodeId: string; type: "memory"; row: RelatedMemoryRow }
  | { nodeId: string; type: "decision"; row: RelatedDecisionRow }
  | { nodeId: string; type: "resource"; row: RelatedResourceRow }
  | { nodeId: string; type: "task"; row: RelatedTaskRow }
  | { nodeId: string; type: "entity"; row: EntityNeighborRow };

type FocusNeighborResult = {
  candidates: HydrationCandidate[];
  truncated: boolean;
};

type FocusHydrationResult = {
  nodeIds: string[];
  edgeIds: string[];
  truncated: boolean;
};

type CountRow = {
  count: number;
};

type ProjectIdRow = {
  project_id: string | null;
};

function parseOptions(raw: KnowledgeGraphOptions): ParsedOptions {
  const parsed = dashboardKnowledgeGraphQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "invalid_dashboard_query", parsed.error.issues[0]?.message ?? "Invalid knowledge graph query");
  }
  const principal = typeof raw.principal === "string" && raw.principal.trim()
    ? raw.principal.trim().slice(0, 128)
    : null;
  return {
    ...parsed.data,
    principal,
    now: Number.isSafeInteger(raw.now) && Number(raw.now) >= 0 ? Number(raw.now) : Date.now()
  };
}

function finiteWeight(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function projectClause(projectId: string | undefined): { sql: string; bindings: string[] } {
  return projectId
    ? { sql: "AND (project_id = ? OR project_id IS NULL)", bindings: [projectId] }
    : { sql: "", bindings: [] };
}

function substringSearchClause(query: string | undefined, columns: string[]): { sql: string; bindings: string[] } {
  const matches = substringMatchExpression(query, columns);
  return matches.sql === "1"
    ? { sql: "", bindings: [] }
    : { sql: `AND ${matches.sql}`, bindings: matches.bindings as string[] };
}

function substringMatchExpression(query: string | undefined, columns: string[]): SqlClause {
  if (!query) return { sql: "1", bindings: [] };
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const pattern = `%${escaped}%`;
  return {
    sql: `(${columns.map((column) => `COALESCE(${column}, '') LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    bindings: columns.map(() => pattern)
  };
}

type SqlClause = {
  sql: string;
  bindings: Array<string | number | null>;
};

function safeJsonArray(column: string): string {
  return `CASE
    WHEN json_valid(${column}) THEN
      CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END
    ELSE '[]'
  END`;
}

function stringArrayMembership(column: string, principal: string | null): SqlClause {
  if (!principal) return { sql: "0", bindings: [] };
  return {
    sql: `EXISTS (
      SELECT 1 FROM json_each(${safeJsonArray(column)}) AS allowed
      WHERE allowed.type = 'text' AND trim(CAST(allowed.value AS TEXT)) = ?
    )`,
    bindings: [principal]
  };
}

function stringArrayEmpty(column: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM json_each(${safeJsonArray(column)}) AS allowed
    WHERE allowed.type = 'text' AND trim(CAST(allowed.value AS TEXT)) != ''
  )`;
}

function resourceAclMembership(
  tenantId: string,
  principal: string | null,
  resourceType: "decision_memory" | "knowledge_resource",
  outerId: string
): SqlClause {
  if (!principal) return { sql: "0", bindings: [] };
  return {
    sql: `EXISTS (
      SELECT 1
      FROM resource_acl ra
      WHERE ra.tenant_id = ?
        AND ra.resource_type = ?
        AND ra.resource_id = ${outerId}
        AND ra.permission = 'read'
        AND (
          (ra.subject_type = 'principal' AND ra.subject_id = ?)
          OR (ra.subject_type = 'tenant' AND ra.subject_id = ?)
          OR (
            ra.subject_type = 'group'
            AND EXISTS (
              SELECT 1
              FROM group_members gm
              WHERE gm.tenant_id = ?
                AND gm.group_id = ra.subject_id
                AND gm.principal = ?
            )
          )
        )
    )`,
    bindings: [tenantId, resourceType, principal, tenantId, tenantId, principal]
  };
}

function memoryReadabilityClause(principal: string | null, column = "permissions_json"): SqlClause {
  const directGrant = principal
    ? `OR EXISTS (
        SELECT 1
        FROM json_each(${safeJsonArray(column)}) AS grant_entry
        WHERE grant_entry.type = 'object'
          AND json_type(grant_entry.value, '$.principal_type') = 'text'
          AND json_extract(grant_entry.value, '$.principal_type') = 'principal'
          AND json_type(grant_entry.value, '$.principal_id') = 'text'
          AND json_extract(grant_entry.value, '$.principal_id') = ?
          AND (
            (
              json_type(grant_entry.value, '$.permissions') = 'array'
              AND EXISTS (
                SELECT 1
                FROM json_each(json_extract(grant_entry.value, '$.permissions')) AS permission
                WHERE permission.value = 'read'
              )
            )
            OR (
              json_type(grant_entry.value, '$.permissions') = 'text'
              AND instr(json_extract(grant_entry.value, '$.permissions'), 'read') > 0
            )
          )
      )`
    : "";
  return {
    sql: `AND (
      ${column} IS NULL
      OR ${column} = ''
      OR (
        json_valid(${column})
        AND (
          json_type(${column}) != 'array'
          OR json_array_length(${column}) = 0
          ${directGrant}
        )
      )
    )`,
    bindings: principal ? [principal] : []
  };
}

function decisionReadabilityClause(
  tenantId: string,
  principal: string | null,
  tablePrefix = ""
): SqlClause {
  const column = (name: string) => tablePrefix ? `${tablePrefix}.${name}` : name;
  const direct = stringArrayMembership(column("allowed_principals_json"), principal);
  const acl = resourceAclMembership(
    tenantId,
    principal,
    "decision_memory",
    tablePrefix ? `${tablePrefix}.id` : "decision_memories.id"
  );
  return {
    sql: `AND (
      (COALESCE(${column("visibility")}, '') != 'restricted'
        AND ${stringArrayEmpty(column("allowed_principals_json"))})
      OR ${direct.sql}
      OR (${column("visibility")} = 'restricted' AND ${acl.sql})
    )`,
    bindings: [...direct.bindings, ...acl.bindings]
  };
}

function resourceReadabilityClause(
  tenantId: string,
  projectId: string | undefined,
  principal: string | null,
  tablePrefix = ""
): SqlClause {
  const column = (name: string) => tablePrefix ? `${tablePrefix}.${name}` : name;
  const direct = stringArrayMembership(column("permissions_json"), principal);
  const acl = resourceAclMembership(
    tenantId,
    principal,
    "knowledge_resource",
    tablePrefix ? `${tablePrefix}.id` : "knowledge_resources.id"
  );
  const project = projectId
    ? { sql: `OR (${column("visibility")} = 'project' AND ${column("project_id")} = ?)`, bindings: [projectId] }
    : { sql: "", bindings: [] };
  return {
    sql: `AND (
      ${column("visibility")} = 'tenant'
      ${project.sql}
      OR ${direct.sql}
      OR (${column("visibility")} = 'restricted' AND ${acl.sql})
    )`,
    bindings: [...project.bindings, ...direct.bindings, ...acl.bindings]
  };
}

function assertionResourcesReadabilityClause(
  tenantId: string,
  projectId: string | undefined,
  principal: string | null,
  assertionAlias = "a"
): SqlClause {
  const readableResource = (idExpression: string, resourceAlias: string): SqlClause => {
    const scoped = projectId
      ? { sql: `AND (${resourceAlias}.project_id = ? OR ${resourceAlias}.project_id IS NULL)`, bindings: [projectId] }
      : { sql: "", bindings: [] };
    const readable = resourceReadabilityClause(tenantId, projectId, principal, resourceAlias);
    return {
      sql: `EXISTS (
        SELECT 1
        FROM knowledge_resources ${resourceAlias}
        WHERE ${resourceAlias}.tenant_id = ${assertionAlias}.tenant_id
          AND ${resourceAlias}.id = ${idExpression}
          ${scoped.sql}
          ${readable.sql}
      )`,
      bindings: [...scoped.bindings, ...readable.bindings]
    };
  };
  const attached = readableResource(`${assertionAlias}.resource_id`, "attached_resource");
  const subject = readableResource(`${assertionAlias}.subject_ref`, "subject_resource");
  const object = readableResource(`${assertionAlias}.object_ref`, "object_resource");
  return {
    sql: `AND (
      (${assertionAlias}.resource_id IS NULL OR ${assertionAlias}.resource_id = '' OR ${attached.sql})
      AND (${assertionAlias}.subject_type != 'knowledge_resource'
        OR ${assertionAlias}.subject_ref IS NULL OR ${assertionAlias}.subject_ref = '' OR ${subject.sql})
      AND (${assertionAlias}.object_type != 'knowledge_resource'
        OR ${assertionAlias}.object_ref IS NULL OR ${assertionAlias}.object_ref = '' OR ${object.sql})
    )`,
    bindings: [...attached.bindings, ...subject.bindings, ...object.bindings]
  };
}

function textMatches(node: CandidateNode, query: string | undefined): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return [node.label, node.summary, node.kind, node.status, node.project_id]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
}

function nodeKey(type: DashboardNodeType, sourceId: string): string {
  return `${type}:${sourceId}`;
}

function sourceTypeToNodeType(value: string | null): DashboardNodeType | null {
  switch (value) {
    case "project": return "project";
    case "memory": return "memory";
    case "decision":
    case "decision_memory": return "decision";
    case "resource":
    case "knowledge_resource": return "resource";
    case "entity": return "entity";
    case "task": return "task";
    default: return null;
  }
}

function candidateSort(left: CandidateNode, right: CandidateNode): number {
  const projectPriority = Number(right.type === "project") - Number(left.type === "project");
  return projectPriority || right.sort_at - left.sort_at || left.type.localeCompare(right.type) || left.source_id.localeCompare(right.source_id);
}

function edgeCandidateLimit(edgeLimit: number): number {
  return Math.min(MAX_QUERY_ROWS, Math.max(edgeLimit * CANDIDATE_MULTIPLIER, edgeLimit + 1));
}

function storedNodeKeySql(typeColumn: string, idColumn: string): string {
  return `CASE ${typeColumn}
    WHEN 'project' THEN 'project:' || ${idColumn}
    WHEN 'memory' THEN 'memory:' || ${idColumn}
    WHEN 'decision' THEN 'decision:' || ${idColumn}
    WHEN 'decision_memory' THEN 'decision:' || ${idColumn}
    WHEN 'resource' THEN 'resource:' || ${idColumn}
    WHEN 'knowledge_resource' THEN 'resource:' || ${idColumn}
    WHEN 'entity' THEN 'entity:' || ${idColumn}
    WHEN 'task' THEN 'task:' || ${idColumn}
    ELSE NULL
  END`;
}

function assertionTargetNodeKeySql(alias: string): string {
  return `CASE
    WHEN ${alias}.object_type = 'project'
      THEN 'project:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.object_type = 'memory'
      THEN 'memory:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.object_type IN ('decision', 'decision_memory')
      THEN 'decision:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.object_type IN ('resource', 'knowledge_resource')
      THEN 'resource:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.object_type = 'entity'
      THEN 'entity:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.object_type = 'task'
      THEN 'task:' || COALESCE(${alias}.object_ref, ${alias}.resource_id)
    WHEN ${alias}.resource_id IS NOT NULL THEN 'resource:' || ${alias}.resource_id
    ELSE NULL
  END`;
}

function explicitNeighborCte(
  tenantId: string,
  options: ParsedOptions,
  frontier: string[]
): SqlClause {
  const assertionSource = storedNodeKeySql("a.subject_type", "a.subject_ref");
  const assertionTarget = assertionTargetNodeKeySql("a");
  const usageTarget = storedNodeKeySql("i.source_type", "i.source_id");
  const assertionProjectSql = options.project_id
    ? "AND (a.project_id = ? OR a.project_id IS NULL)"
    : "";
  const usageProjectSql = options.project_id ? "AND ue.project_id = ?" : "";
  const assertionResourcesReadable = assertionResourcesReadabilityClause(
    tenantId,
    options.project_id,
    options.principal,
    "a"
  );
  return {
    sql: `WITH frontier(node_id) AS (SELECT value FROM json_each(?)),
    neighbor_rows(node_id, relation_at, relation_id) AS (
      SELECT CASE
               WHEN ('memory:' || me.from_memory_id) IN (SELECT node_id FROM frontier)
                 THEN 'memory:' || me.to_memory_id
               ELSE 'memory:' || me.from_memory_id
             END,
             me.created_at,
             'memory_edge:' || me.id
      FROM memory_edges me
      WHERE me.tenant_id = ?
        AND (
          ('memory:' || me.from_memory_id) IN (SELECT node_id FROM frontier)
          OR ('memory:' || me.to_memory_id) IN (SELECT node_id FROM frontier)
        )
      UNION ALL
      SELECT CASE
               WHEN ('memory:' || ml.memory_id) IN (SELECT node_id FROM frontier)
                 THEN 'entity:' || ml.entity_id
               ELSE 'memory:' || ml.memory_id
             END,
             ml.created_at,
             'memory_entity:' || ml.id
      FROM memory_entities ml
      WHERE ml.tenant_id = ?
        AND (
          ('memory:' || ml.memory_id) IN (SELECT node_id FROM frontier)
          OR ('entity:' || ml.entity_id) IN (SELECT node_id FROM frontier)
        )
      UNION ALL
      SELECT CASE
               WHEN ('decision:' || d.id) IN (SELECT node_id FROM frontier)
                 THEN 'decision:' || d.superseded_by
               ELSE 'decision:' || d.id
             END,
             d.updated_at,
             'decision_supersession:' || d.id || ':' || d.superseded_by
      FROM decision_memories d
      WHERE d.tenant_id = ? AND d.superseded_by IS NOT NULL
        AND (
          ('decision:' || d.id) IN (SELECT node_id FROM frontier)
          OR ('decision:' || d.superseded_by) IN (SELECT node_id FROM frontier)
        )
      UNION ALL
      SELECT CASE
               WHEN (${assertionSource}) IN (SELECT node_id FROM frontier)
                 THEN ${assertionTarget}
               ELSE ${assertionSource}
             END,
             a.updated_at,
             'knowledge_assertion:' || a.id
      FROM knowledge_assertions a
      WHERE a.tenant_id = ? AND a.confirmation_state = 'confirmed'
        AND (a.valid_until IS NULL OR a.valid_until > ?)
        ${assertionProjectSql}
        ${assertionResourcesReadable.sql}
        AND (
          (${assertionSource}) IN (SELECT node_id FROM frontier)
          OR (${assertionTarget}) IN (SELECT node_id FROM frontier)
        )
      UNION ALL
      SELECT CASE
               WHEN ('task:' || ue.task_id) IN (SELECT node_id FROM frontier)
                 THEN ${usageTarget}
               ELSE 'task:' || ue.task_id
             END,
             i.created_at,
             'memory_usage:' || i.id
      FROM memory_usage_items i
      JOIN memory_usage_events ue
        ON ue.tenant_id = i.tenant_id AND ue.id = i.usage_event_id
      WHERE i.tenant_id = ? AND ue.task_id IS NOT NULL
        ${usageProjectSql}
        AND (
          ('task:' || ue.task_id) IN (SELECT node_id FROM frontier)
          OR (${usageTarget}) IN (SELECT node_id FROM frontier)
        )
    ),
    neighbor_keys(node_id, relation_at, relation_id) AS (
      SELECT node_id, MAX(relation_at), MIN(relation_id)
      FROM neighbor_rows
      WHERE node_id IS NOT NULL AND node_id NOT IN (SELECT node_id FROM frontier)
      GROUP BY node_id
    )`,
    bindings: [
      JSON.stringify(frontier),
      tenantId,
      tenantId,
      tenantId,
      tenantId,
      options.now,
      ...(options.project_id ? [options.project_id] : []),
      ...assertionResourcesReadable.bindings,
      tenantId,
      ...(options.project_id ? [options.project_id] : [])
    ]
  };
}

async function queryFocusNeighbors(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  frontier: string[],
  limit: number
): Promise<FocusNeighborResult> {
  const cte = explicitNeighborCte(tenantId, options, frontier);
  const project = projectClause(options.project_id);
  const memoryReadable = memoryReadabilityClause(options.principal, "m.permissions_json");
  const decisionReadable = decisionReadabilityClause(tenantId, options.principal, "d");
  const resourceReadable = resourceReadabilityClause(tenantId, options.project_id, options.principal, "r");
  const [memoryResult, decisionResult, resourceResult, taskResult, entityResult] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(
      `${cte.sql}
       SELECT m.id, m.project_id, m.content, m.summary, m.kind, m.lifecycle_state,
              m.confidence_score, m.permissions_json, m.updated_at, m.created_at,
              m.last_accessed_at, n.relation_at, n.relation_id
       FROM neighbor_keys n
       JOIN memories m ON n.node_id = ('memory:' || m.id)
       WHERE m.tenant_id = ? AND m.lifecycle_state != 'suppressed'
         ${project.sql.replaceAll("project_id", "m.project_id")} ${memoryReadable.sql}
       ORDER BY n.relation_at DESC, n.relation_id, m.id
       LIMIT ?`
    ).bind(
      ...cte.bindings,
      tenantId,
      ...project.bindings,
      ...memoryReadable.bindings,
      limit + 1
    ).all<RelatedMemoryRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `${cte.sql}
       SELECT d.id, d.project_id, d.domain, d.title, d.decision, d.status,
              d.confirmation_state, d.confidence, d.visibility,
              d.allowed_principals_json, d.superseded_by, d.updated_at, d.created_at,
              n.relation_at, n.relation_id
       FROM neighbor_keys n
       JOIN decision_memories d ON n.node_id = ('decision:' || d.id)
       WHERE d.tenant_id = ?
         ${project.sql.replaceAll("project_id", "d.project_id")} ${decisionReadable.sql}
       ORDER BY n.relation_at DESC, n.relation_id, d.id
       LIMIT ?`
    ).bind(
      ...cte.bindings,
      tenantId,
      ...project.bindings,
      ...decisionReadable.bindings,
      limit + 1
    ).all<RelatedDecisionRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `${cte.sql}
       SELECT r.id, r.project_id, r.resource_kind, r.title, r.source_system,
              r.lifecycle_state, r.visibility, r.permissions_json, r.updated_at,
              r.created_at, n.relation_at, n.relation_id
       FROM neighbor_keys n
       JOIN knowledge_resources r ON n.node_id = ('resource:' || r.id)
       WHERE r.tenant_id = ?
         ${project.sql.replaceAll("project_id", "r.project_id")} ${resourceReadable.sql}
       ORDER BY n.relation_at DESC, n.relation_id, r.id
       LIMIT ?`
    ).bind(
      ...cte.bindings,
      tenantId,
      ...project.bindings,
      ...resourceReadable.bindings,
      limit + 1
    ).all<RelatedResourceRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `${cte.sql}
       SELECT t.id, t.project_id, t.capability, t.status, t.priority, t.updated_at,
              t.created_at, n.relation_at, n.relation_id
       FROM neighbor_keys n
       JOIN tasks t ON n.node_id = ('task:' || t.id)
       WHERE t.tenant_id = ? ${project.sql.replaceAll("project_id", "t.project_id")}
       ORDER BY n.relation_at DESC, n.relation_id, t.id
       LIMIT ?`
    ).bind(...cte.bindings, tenantId, ...project.bindings, limit + 1).all<RelatedTaskRow>(),
    env.OPEN_BRAIN_DB.prepare(
      `${cte.sql}
       SELECT n.node_id, n.relation_at, n.relation_id
       FROM neighbor_keys n
       JOIN entities e ON e.tenant_id = ? AND n.node_id = ('entity:' || e.id)
       ORDER BY n.relation_at DESC, n.relation_id, n.node_id
       LIMIT ?`
    ).bind(...cte.bindings, tenantId, limit + 1).all<EntityNeighborRow>()
  ]);

  const memoryRows = memoryResult.results.filter((row) =>
    stableResultReadable(row.permissions_json, options.principal)
  );
  const readableDecisionIds = new Set((await filterReadableDecisions(
    env,
    tenantId,
    decisionResult.results,
    options.principal
  )).map((row) => row.id));
  const decisionRows = decisionResult.results.filter((row) => readableDecisionIds.has(row.id));
  const readableResourceIds = new Set((await filterReadableResources(
    env,
    tenantId,
    resourceResult.results,
    options
  )).map((row) => row.id));
  const resourceRows = resourceResult.results.filter((row) => readableResourceIds.has(row.id));
  const candidates: HydrationCandidate[] = [
    ...memoryRows.map((row) => ({ nodeId: nodeKey("memory", row.id), type: "memory" as const, row })),
    ...decisionRows.map((row) => ({ nodeId: nodeKey("decision", row.id), type: "decision" as const, row })),
    ...resourceRows.map((row) => ({ nodeId: nodeKey("resource", row.id), type: "resource" as const, row })),
    ...taskResult.results.map((row) => ({ nodeId: nodeKey("task", row.id), type: "task" as const, row })),
    ...entityResult.results.map((row) => ({ nodeId: row.node_id, type: "entity" as const, row }))
  ].sort((left, right) =>
    right.row.relation_at - left.row.relation_at ||
    left.row.relation_id.localeCompare(right.row.relation_id) ||
    left.nodeId.localeCompare(right.nodeId)
  );
  return {
    candidates,
    truncated: memoryRows.length > limit || decisionRows.length > limit ||
      resourceRows.length > limit || taskResult.results.length > limit ||
      entityResult.results.length > limit
  };
}

async function hydrateFocusNeighborhood(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  rows: CandidateRows
): Promise<FocusHydrationResult> {
  if (!options.focus_type || !options.focus_id || options.focus_type === "project") {
    return {
      nodeIds: options.focus_type && options.focus_id ? [nodeKey(options.focus_type, options.focus_id)] : [],
      edgeIds: [],
      truncated: false
    };
  }
  const hydrationLimit = Math.min(MAX_QUERY_ROWS, options.node_limit + 1);
  const known = new Set<string>();
  for (const row of rows.memories) known.add(nodeKey("memory", row.id));
  for (const row of rows.decisions) known.add(nodeKey("decision", row.id));
  for (const row of rows.resources) known.add(nodeKey("resource", row.id));
  for (const row of rows.tasks) known.add(nodeKey("task", row.id));
  const traversed = new Set<string>();
  const focusNodeId = nodeKey(options.focus_type, options.focus_id);
  traversed.add(focusNodeId);
  const traversalEdgeIds: string[] = [];
  const seenTraversalEdges = new Set<string>();
  let frontier = [focusNodeId];
  let remainingNewNodes = hydrationLimit;
  let truncated = false;
  for (let hop = 0; hop < options.depth && frontier.length > 0; hop += 1) {
    const neighborResult = await queryFocusNeighbors(env, tenantId, options, frontier, hydrationLimit);
    truncated ||= neighborResult.truncated;
    const next: string[] = [];
    for (const candidate of neighborResult.candidates) {
      if (traversed.has(candidate.nodeId)) continue;
      if (next.length >= hydrationLimit) {
        truncated = true;
        break;
      }
      if (!known.has(candidate.nodeId)) {
        if (remainingNewNodes <= 0) {
          truncated = true;
          continue;
        }
        remainingNewNodes -= 1;
        known.add(candidate.nodeId);
        if (candidate.type === "memory") {
          const { relation_at: _relationAt, relation_id: _relationId, ...row } = candidate.row;
          rows.memories.push(row);
        } else if (candidate.type === "decision") {
          const { relation_at: _relationAt, relation_id: _relationId, ...row } = candidate.row;
          rows.decisions.push(row);
        } else if (candidate.type === "resource") {
          const { relation_at: _relationAt, relation_id: _relationId, ...row } = candidate.row;
          rows.resources.push(row);
        } else if (candidate.type === "task") {
          const { relation_at: _relationAt, relation_id: _relationId, ...row } = candidate.row;
          rows.tasks.push(row);
        }
      }
      traversed.add(candidate.nodeId);
      if (!seenTraversalEdges.has(candidate.row.relation_id)) {
        seenTraversalEdges.add(candidate.row.relation_id);
        traversalEdgeIds.push(candidate.row.relation_id);
      }
      next.push(candidate.nodeId);
    }
    frontier = next;
  }
  return { nodeIds: [...traversed], edgeIds: traversalEdgeIds, truncated };
}

async function filterReadableDecisions(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: DecisionRow[],
  principal: string | null
): Promise<DecisionRow[]> {
  const directIds = new Set(rows.filter((row) => {
    const allowed = stringArray(row.allowed_principals_json);
    if (row.visibility !== "restricted" && allowed.length === 0) return true;
    return Boolean(principal && allowed.includes(principal));
  }).map((row) => row.id));
  const restricted = rows.filter((row) => row.visibility === "restricted" && !directIds.has(row.id));
  if (!principal || restricted.length === 0) return rows.filter((row) => directIds.has(row.id));
  const authz = await buildAuthzContext(env as Env, tenantId, principal);
  const readable = await loadReadableResourceIds(env as Env, {
    tenantId,
    resourceType: "decision_memory",
    resourceIds: restricted.map((row) => row.id),
    authz
  });
  return rows.filter((row) => directIds.has(row.id) || readable.has(row.id));
}

async function filterReadableResources(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rows: ResourceRow[],
  options: ParsedOptions
): Promise<ResourceRow[]> {
  const directIds = new Set(rows.filter((row) => {
    if (row.visibility === "tenant") return true;
    if (row.visibility === "project") return Boolean(row.project_id && row.project_id === options.project_id);
    return Boolean(options.principal && stringArray(row.permissions_json).includes(options.principal));
  }).map((row) => row.id));
  const restricted = rows.filter((row) => row.visibility === "restricted" && !directIds.has(row.id));
  if (!options.principal || restricted.length === 0) return rows.filter((row) => directIds.has(row.id));
  const authz = await buildAuthzContext(env as Env, tenantId, options.principal);
  const readable = await loadReadableResourceIds(env as Env, {
    tenantId,
    resourceType: "knowledge_resource",
    resourceIds: restricted.map((row) => row.id),
    authz
  });
  return rows.filter((row) => directIds.has(row.id) || readable.has(row.id));
}

async function scanReadableCandidates<Row extends { id: string }>(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  options: {
    baseSql: string;
    bindings: Array<string | number | null>;
    sortExpression: string;
    idExpression?: string;
    visibleLimit: number;
    sortAt: (row: Row) => number;
    filterReadable: (rows: Row[]) => Promise<Row[]> | Row[];
  }
): Promise<Row[]> {
  const visible: Row[] = [];
  let scanned = 0;
  let cursor: CandidateCursor | null = null;
  while (visible.length < options.visibleLimit && scanned < MAX_QUERY_ROWS) {
    const pageLimit = Math.min(
      CANDIDATE_PAGE_SIZE,
      MAX_QUERY_ROWS - scanned,
      Math.max(MIN_CANDIDATE_PAGE_SIZE, options.visibleLimit - visible.length)
    );
    const idExpression = options.idExpression ?? "id";
    const cursorSql: string = cursor
      ? `AND (${options.sortExpression} < ? OR (${options.sortExpression} = ? AND ${idExpression} < ?))`
      : "";
    const cursorBindings: Array<string | number> = cursor
      ? [cursor.sortAt, cursor.sortAt, cursor.id]
      : [];
    const page: Row[] = (await env.OPEN_BRAIN_DB.prepare(
      `${options.baseSql}
       ${cursorSql}
       ORDER BY ${options.sortExpression} DESC, ${idExpression} DESC LIMIT ?`
    ).bind(...options.bindings, ...cursorBindings, pageLimit).all<Row>()).results;
    if (page.length === 0) break;
    scanned += page.length;
    visible.push(...await options.filterReadable(page));
    const last: Row = page[page.length - 1]!;
    cursor = { sortAt: options.sortAt(last), id: last.id };
    if (page.length < pageLimit) break;
  }
  return visible.slice(0, options.visibleLimit);
}

async function queryCandidates(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<CandidateRows> {
  const scoped = projectClause(options.project_id);
  const memorySearch = substringSearchClause(options.q, ["content", "summary", "kind", "lifecycle_state", "project_id"]);
  const decisionSearch = substringSearchClause(options.q, ["title", "decision", "domain", "status", "project_id"]);
  const resourceSearch = substringSearchClause(options.q, ["title", "source_system", "resource_kind", "lifecycle_state", "project_id"]);
  const taskSearch = substringSearchClause(options.q, ["capability", "status", "project_id"]);
  const memoryReadable = memoryReadabilityClause(options.principal);
  const decisionReadable = decisionReadabilityClause(tenantId, options.principal);
  const resourceReadable = resourceReadabilityClause(tenantId, options.project_id, options.principal);
  const visibleLimit = Math.min(
    MAX_QUERY_ROWS,
    Math.max(options.node_limit * CANDIDATE_MULTIPLIER, options.node_limit + 1)
  );
  const [memories, decisions, resources, tasks] = await Promise.all([
    scanReadableCandidates<MemoryRow>(env, {
      baseSql: `SELECT id, project_id, content, summary, kind, lifecycle_state, confidence_score,
              permissions_json, updated_at, created_at, last_accessed_at
       FROM memories
       WHERE tenant_id = ? AND lifecycle_state != 'suppressed'
         ${scoped.sql} ${memorySearch.sql} ${memoryReadable.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...memorySearch.bindings, ...memoryReadable.bindings],
      sortExpression: "COALESCE(updated_at, created_at)",
      visibleLimit,
      sortAt: (row) => Number(row.updated_at ?? row.created_at),
      filterReadable: (rows) => rows.filter((row) => stableResultReadable(row.permissions_json, options.principal))
    }),
    scanReadableCandidates<DecisionRow>(env, {
      baseSql: `SELECT id, project_id, domain, title, decision, status, confirmation_state,
              confidence, visibility, allowed_principals_json, superseded_by,
              updated_at, created_at
       FROM decision_memories
       WHERE tenant_id = ? ${scoped.sql} ${decisionSearch.sql} ${decisionReadable.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...decisionSearch.bindings, ...decisionReadable.bindings],
      sortExpression: "updated_at",
      visibleLimit,
      sortAt: (row) => Number(row.updated_at),
      filterReadable: (rows) => filterReadableDecisions(env, tenantId, rows, options.principal)
    }),
    scanReadableCandidates<ResourceRow>(env, {
      baseSql: `SELECT id, project_id, resource_kind, title, source_system, lifecycle_state,
              visibility, permissions_json, updated_at, created_at
       FROM knowledge_resources
       WHERE tenant_id = ? ${scoped.sql} ${resourceSearch.sql} ${resourceReadable.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...resourceSearch.bindings, ...resourceReadable.bindings],
      sortExpression: "updated_at",
      visibleLimit,
      sortAt: (row) => Number(row.updated_at),
      filterReadable: (rows) => filterReadableResources(env, tenantId, rows, options)
    }),
    scanReadableCandidates<TaskRow>(env, {
      baseSql: `SELECT id, project_id, capability, status, priority, updated_at, created_at
       FROM tasks WHERE tenant_id = ? ${scoped.sql} ${taskSearch.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...taskSearch.bindings],
      sortExpression: "updated_at",
      visibleLimit,
      sortAt: (row) => Number(row.updated_at),
      filterReadable: (rows) => rows
    })
  ]);
  return { memories, decisions, resources, tasks };
}

function readableNodeCtes(
  tenantId: string,
  options: ParsedOptions,
  preserveNonMatchingForTraversal: boolean
): SqlClause {
  const scoped = projectClause(options.project_id);
  const memoryReadable = memoryReadabilityClause(options.principal, "m.permissions_json");
  const decisionReadable = decisionReadabilityClause(tenantId, options.principal, "d");
  const resourceReadable = resourceReadabilityClause(tenantId, options.project_id, options.principal, "r");
  const memoryMatch = substringMatchExpression(options.q, [
    "m.content", "m.summary", "m.kind", "m.lifecycle_state", "m.project_id"
  ]);
  const decisionMatch = substringMatchExpression(options.q, [
    "d.title", "d.decision", "d.domain", "d.status", "d.project_id"
  ]);
  const resourceMatch = substringMatchExpression(options.q, [
    "r.title", "r.source_system", "r.resource_kind", "r.lifecycle_state", "r.project_id"
  ]);
  const taskMatch = substringMatchExpression(options.q, ["t.capability", "t.status", "t.project_id"]);
  const entityMatch = substringMatchExpression(options.q, ["e.canonical_name", "e.entity_type"]);
  const linkedEntityMatch = substringMatchExpression(options.q, [
    "linked_entity.canonical_name", "linked_entity.entity_type"
  ]);
  const memoryPopulationMatch: SqlClause = preserveNonMatchingForTraversal || !options.q
    ? memoryMatch
    : {
        sql: `(${memoryMatch.sql} OR EXISTS (
          SELECT 1
          FROM memory_entities linked_entity_relation
          JOIN entities linked_entity
            ON linked_entity.tenant_id = linked_entity_relation.tenant_id
           AND linked_entity.id = linked_entity_relation.entity_id
          WHERE linked_entity_relation.tenant_id = m.tenant_id
            AND linked_entity_relation.memory_id = m.id
            AND ${linkedEntityMatch.sql}
        ))`,
        bindings: [...memoryMatch.bindings, ...linkedEntityMatch.bindings]
      };
  const projectMatch = substringMatchExpression(options.q, ["project_id"]);
  const matchSelect = (clause: SqlClause): string => preserveNonMatchingForTraversal ? clause.sql : "1";
  const matchWhere = (clause: SqlClause): string => preserveNonMatchingForTraversal ? "" : `AND ${clause.sql}`;
  const matchBindings = (
    clause: SqlClause,
    beforeWhere: Array<string | number | null>,
    afterWhere: Array<string | number | null> = []
  ): Array<string | number | null> => preserveNonMatchingForTraversal
    ? [...clause.bindings, ...beforeWhere, ...afterWhere]
    : [...beforeWhere, ...afterWhere, ...clause.bindings];
  const projectSource = options.project_id ? "UNION SELECT ?" : "";
  const projectSourceBindings = options.project_id ? [options.project_id] : [];
  const projectBindings = [...projectSourceBindings, ...projectMatch.bindings];
  return {
    sql: `memory_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT 'memory:' || m.id, m.project_id, ${matchSelect(memoryMatch)}
      FROM memories m
      WHERE m.tenant_id = ? AND m.lifecycle_state != 'suppressed'
        ${scoped.sql.replaceAll("project_id", "m.project_id")}
        ${memoryReadable.sql}
        ${matchWhere(memoryPopulationMatch)}
    ),
    decision_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT 'decision:' || d.id, d.project_id, ${matchSelect(decisionMatch)}
      FROM decision_memories d
      WHERE d.tenant_id = ?
        ${scoped.sql.replaceAll("project_id", "d.project_id")}
        ${decisionReadable.sql}
        ${matchWhere(decisionMatch)}
    ),
    resource_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT 'resource:' || r.id, r.project_id, ${matchSelect(resourceMatch)}
      FROM knowledge_resources r
      WHERE r.tenant_id = ?
        ${scoped.sql.replaceAll("project_id", "r.project_id")}
        ${resourceReadable.sql}
        ${matchWhere(resourceMatch)}
    ),
    task_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT 'task:' || t.id, t.project_id, ${matchSelect(taskMatch)}
      FROM tasks t
      WHERE t.tenant_id = ?
        ${scoped.sql.replaceAll("project_id", "t.project_id")}
        ${matchWhere(taskMatch)}
    ),
    entity_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT DISTINCT 'entity:' || e.id, NULL, ${matchSelect(entityMatch)}
      FROM memory_entities me
      JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
      JOIN memory_nodes mn ON mn.node_id = ('memory:' || me.memory_id)
      WHERE me.tenant_id = ? ${matchWhere(entityMatch)}
    ),
    project_sources(project_id) AS MATERIALIZED (
      SELECT project_id FROM memory_nodes WHERE project_id IS NOT NULL
      UNION SELECT project_id FROM decision_nodes WHERE project_id IS NOT NULL
      UNION SELECT project_id FROM resource_nodes WHERE project_id IS NOT NULL
      UNION SELECT project_id FROM task_nodes WHERE project_id IS NOT NULL
      ${projectSource}
    ),
    project_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT 'project:' || project_id, project_id, ${matchSelect(projectMatch)}
      FROM project_sources
      WHERE project_id IS NOT NULL ${matchWhere(projectMatch)}
    ),
    all_nodes(node_id, project_id, matches_query) AS MATERIALIZED (
      SELECT node_id, project_id, matches_query FROM memory_nodes
      UNION ALL SELECT node_id, project_id, matches_query FROM decision_nodes
      UNION ALL SELECT node_id, project_id, matches_query FROM resource_nodes
      UNION ALL SELECT node_id, project_id, matches_query FROM task_nodes
      UNION ALL SELECT node_id, project_id, matches_query FROM entity_nodes
      UNION ALL SELECT node_id, project_id, matches_query FROM project_nodes
    )`,
    bindings: [
      ...matchBindings(memoryPopulationMatch, [tenantId, ...scoped.bindings, ...memoryReadable.bindings]),
      ...matchBindings(decisionMatch, [tenantId, ...scoped.bindings, ...decisionReadable.bindings]),
      ...matchBindings(resourceMatch, [tenantId, ...scoped.bindings, ...resourceReadable.bindings]),
      ...matchBindings(taskMatch, [tenantId, ...scoped.bindings]),
      ...matchBindings(entityMatch, [tenantId]),
      ...projectBindings
    ]
  };
}

async function exactUnfocusedNodeCount(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<number> {
  const scoped = projectClause(options.project_id);
  const memoryReadable = memoryReadabilityClause(options.principal, "m.permissions_json");
  const decisionReadable = decisionReadabilityClause(tenantId, options.principal, "d");
  const resourceReadable = resourceReadabilityClause(tenantId, options.project_id, options.principal, "r");
  const memoryMatch = substringMatchExpression(options.q, [
    "m.content", "m.summary", "m.kind", "m.lifecycle_state", "m.project_id"
  ]);
  const linkedEntityMatch = substringMatchExpression(options.q, [
    "linked_entity.canonical_name", "linked_entity.entity_type"
  ]);
  const memoryPopulationMatch: SqlClause = !options.q
    ? memoryMatch
    : {
        sql: `(${memoryMatch.sql} OR EXISTS (
          SELECT 1
          FROM memory_entities linked_entity_relation
          JOIN entities linked_entity
            ON linked_entity.tenant_id = linked_entity_relation.tenant_id
           AND linked_entity.id = linked_entity_relation.entity_id
          WHERE linked_entity_relation.tenant_id = m.tenant_id
            AND linked_entity_relation.memory_id = m.id
            AND ${linkedEntityMatch.sql}
        ))`,
        bindings: [...memoryMatch.bindings, ...linkedEntityMatch.bindings]
      };
  const decisionMatch = substringMatchExpression(options.q, [
    "d.title", "d.decision", "d.domain", "d.status", "d.project_id"
  ]);
  const resourceMatch = substringMatchExpression(options.q, [
    "r.title", "r.source_system", "r.resource_kind", "r.lifecycle_state", "r.project_id"
  ]);
  const taskMatch = substringMatchExpression(options.q, ["t.capability", "t.status", "t.project_id"]);
  const entityMatch = substringMatchExpression(options.q, ["e.canonical_name", "e.entity_type"]);

  const sources = [
    {
      from: "memories m",
      where: `m.tenant_id = ? AND m.lifecycle_state != 'suppressed'
        ${scoped.sql.replaceAll("project_id", "m.project_id")}
        ${memoryReadable.sql} AND ${memoryPopulationMatch.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...memoryReadable.bindings, ...memoryPopulationMatch.bindings]
    },
    {
      from: "decision_memories d",
      where: `d.tenant_id = ? ${scoped.sql.replaceAll("project_id", "d.project_id")}
        ${decisionReadable.sql} AND ${decisionMatch.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...decisionReadable.bindings, ...decisionMatch.bindings]
    },
    {
      from: "knowledge_resources r",
      where: `r.tenant_id = ? ${scoped.sql.replaceAll("project_id", "r.project_id")}
        ${resourceReadable.sql} AND ${resourceMatch.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...resourceReadable.bindings, ...resourceMatch.bindings]
    },
    {
      from: "tasks t",
      where: `t.tenant_id = ? ${scoped.sql.replaceAll("project_id", "t.project_id")}
        AND ${taskMatch.sql}`,
      bindings: [tenantId, ...scoped.bindings, ...taskMatch.bindings]
    }
  ] as const;
  const entitySql = `FROM memory_entities me
    JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
    JOIN memories m ON m.tenant_id = me.tenant_id AND m.id = me.memory_id
    WHERE me.tenant_id = ? AND m.lifecycle_state != 'suppressed'
      ${scoped.sql.replaceAll("project_id", "m.project_id")}
      ${memoryReadable.sql} AND ${entityMatch.sql}`;
  const entityBindings = [
    tenantId,
    ...scoped.bindings,
    ...memoryReadable.bindings,
    ...entityMatch.bindings
  ];

  const [sourceCounts, entityCount, sourceProjects] = await Promise.all([
    Promise.all(sources.map(async (source) => {
      const row = await env.OPEN_BRAIN_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${source.from} WHERE ${source.where}`
      ).bind(...source.bindings).first<CountRow>();
      return Math.max(0, Number(row?.count ?? 0));
    })),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(DISTINCT e.id) AS count ${entitySql}`
    ).bind(...entityBindings).first<CountRow>(),
    Promise.all(sources.map(async (source) => {
      const result = await env.OPEN_BRAIN_DB.prepare(
        `SELECT DISTINCT project_id FROM ${source.from}
         WHERE ${source.where} AND project_id IS NOT NULL`
      ).bind(...source.bindings).all<ProjectIdRow>();
      return result.results;
    }))
  ]);

  const projectIds = new Set(sourceProjects.flatMap((rows) => rows)
    .map((row) => row.project_id)
    .filter((projectId): projectId is string => Boolean(projectId)));
  if (options.project_id) projectIds.add(options.project_id);
  const matchingProjectCount = [...projectIds].filter((projectId) => (
    !options.q || projectId.toLocaleLowerCase().includes(options.q.toLocaleLowerCase())
  )).length;
  return sourceCounts.reduce((sum, count) => sum + count, 0)
    + Math.max(0, Number(entityCount?.count ?? 0))
    + matchingProjectCount;
}

async function exactRelevantNodeCount(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<number> {
  // A project focus is already normalized to project_id by getKnowledgeGraph.
  // Treating it as a recursive relationship walk makes D1 compile the large
  // relation-pairs compound query even though project membership is enough to
  // determine the visible set. Keep the bounded count on the simple scoped
  // path; this also avoids D1's compound SELECT term limit on large tenants.
  const focused = Boolean(options.focus_type && options.focus_id && options.focus_type !== "project");
  if (!focused) {
    return exactUnfocusedNodeCount(env, tenantId, options);
  }

  const nodes = readableNodeCtes(tenantId, options, focused);

  const assertionSource = storedNodeKeySql("a.subject_type", "a.subject_ref");
  const assertionTarget = assertionTargetNodeKeySql("a");
  const usageTarget = storedNodeKeySql("i.source_type", "i.source_id");
  const assertionProjectSql = options.project_id
    ? "AND (a.project_id = ? OR a.project_id IS NULL)"
    : "";
  const usageProjectSql = options.project_id ? "AND ue.project_id = ?" : "";
  const assertionResourcesReadable = assertionResourcesReadabilityClause(
    tenantId,
    options.project_id,
    options.principal,
    "a"
  );
  const focusNodeId = nodeKey(options.focus_type!, options.focus_id!);
  const row = await env.OPEN_BRAIN_DB.prepare(
    `WITH RECURSIVE ${nodes.sql},
     relation_pairs(source_node_id, target_node_id) AS (
       SELECT 'memory:' || me.from_memory_id, 'memory:' || me.to_memory_id
       FROM memory_edges me
       WHERE me.tenant_id = ?
       UNION ALL
       SELECT 'memory:' || ml.memory_id, 'entity:' || ml.entity_id
       FROM memory_entities ml
       WHERE ml.tenant_id = ?
       UNION ALL
       SELECT 'decision:' || d.id, 'decision:' || d.superseded_by
       FROM decision_memories d
       WHERE d.tenant_id = ? AND d.superseded_by IS NOT NULL
       UNION ALL
       SELECT ${assertionSource}, ${assertionTarget}
       FROM knowledge_assertions a
       WHERE a.tenant_id = ? AND a.confirmation_state = 'confirmed'
         AND (a.valid_until IS NULL OR a.valid_until > ?)
         ${assertionProjectSql}
         ${assertionResourcesReadable.sql}
       UNION ALL
       SELECT 'task:' || ue.task_id, ${usageTarget}
       FROM memory_usage_items i
       JOIN memory_usage_events ue
         ON ue.tenant_id = i.tenant_id AND ue.id = i.usage_event_id
       WHERE i.tenant_id = ? AND ue.task_id IS NOT NULL ${usageProjectSql}
       UNION ALL
       SELECT 'project:' || project_id, node_id
       FROM all_nodes
       WHERE project_id IS NOT NULL AND node_id NOT LIKE 'project:%'
     ),
     walk(node_id, depth) AS (
       SELECT node_id, 0
       FROM all_nodes
       WHERE node_id = ?
       UNION
       SELECT CASE
                WHEN relation_pairs.source_node_id = walk.node_id
                  THEN relation_pairs.target_node_id
                ELSE relation_pairs.source_node_id
              END,
              walk.depth + 1
       FROM walk
       JOIN relation_pairs
         ON relation_pairs.source_node_id = walk.node_id
         OR relation_pairs.target_node_id = walk.node_id
       JOIN all_nodes neighbor
         ON neighbor.node_id = CASE
           WHEN relation_pairs.source_node_id = walk.node_id
             THEN relation_pairs.target_node_id
           ELSE relation_pairs.source_node_id
         END
       WHERE walk.depth < ?
     )
     SELECT COUNT(DISTINCT walk.node_id) AS count
     FROM walk
     JOIN all_nodes node ON node.node_id = walk.node_id
     WHERE node.matches_query = 1 OR node.node_id = ?`
  ).bind(
    ...nodes.bindings,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
    options.now,
    ...(options.project_id ? [options.project_id] : []),
    ...assertionResourcesReadable.bindings,
    tenantId,
    ...(options.project_id ? [options.project_id] : []),
    focusNodeId,
    options.depth,
    focusNodeId
  ).first<CountRow>();
  return Math.max(0, Number(row?.count ?? 0));
}

async function ensureFocusCandidate(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  rows: Awaited<ReturnType<typeof queryCandidates>>
): Promise<void> {
  if (!options.focus_type || !options.focus_id || options.focus_type === "project") return;
  if (options.focus_type === "entity") {
    const project = projectClause(options.project_id);
    const memoryReadable = memoryReadabilityClause(options.principal, "m.permissions_json");
    const linked = await scanReadableCandidates<MemoryRow>(env, {
      baseSql: `SELECT m.id, m.project_id, m.content, m.summary, m.kind, m.lifecycle_state,
              m.confidence_score, m.permissions_json, m.updated_at, m.created_at,
              m.last_accessed_at
       FROM memory_entities me
       JOIN memories m ON m.tenant_id = me.tenant_id AND m.id = me.memory_id
       WHERE me.tenant_id = ? AND me.entity_id = ? AND m.lifecycle_state != 'suppressed'
         ${project.sql.replaceAll("project_id", "m.project_id")} ${memoryReadable.sql}`,
      bindings: [tenantId, options.focus_id, ...project.bindings, ...memoryReadable.bindings],
      sortExpression: "COALESCE(m.updated_at, m.created_at)",
      idExpression: "m.id",
      visibleLimit: Math.min(
        MAX_QUERY_ROWS,
        Math.max(options.node_limit * CANDIDATE_MULTIPLIER, options.node_limit + 1)
      ),
      sortAt: (row) => Number(row.updated_at ?? row.created_at),
      filterReadable: (candidates) => candidates.filter((row) =>
        stableResultReadable(row.permissions_json, options.principal)
      )
    });
    const existing = new Set(rows.memories.map((row) => row.id));
    for (const row of linked) {
      if (!existing.has(row.id)) {
        rows.memories.unshift(row);
        existing.add(row.id);
      }
    }
    return;
  }
  const collection = options.focus_type === "memory"
    ? rows.memories
    : options.focus_type === "decision"
      ? rows.decisions
      : options.focus_type === "resource"
        ? rows.resources
        : rows.tasks;
  if (collection.some((row) => row.id === options.focus_id)) return;
  const table = options.focus_type === "memory"
    ? "memories"
    : options.focus_type === "decision"
      ? "decision_memories"
      : options.focus_type === "resource"
        ? "knowledge_resources"
        : "tasks";
  const result = await env.OPEN_BRAIN_DB.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, options.focus_id).first<Record<string, unknown>>();
  if (!result) return;
  if (options.project_id && result.project_id !== null && result.project_id !== options.project_id) return;
  if (options.focus_type === "memory") {
    const row = result as MemoryRow;
    if (row.lifecycle_state !== "suppressed" && stableResultReadable(row.permissions_json, options.principal)) rows.memories.unshift(row);
  } else if (options.focus_type === "decision") {
    const readable = await filterReadableDecisions(env, tenantId, [result as DecisionRow], options.principal);
    if (readable.length) rows.decisions.unshift(readable[0]!);
  } else if (options.focus_type === "resource") {
    const readable = await filterReadableResources(env, tenantId, [result as ResourceRow], options);
    if (readable.length) rows.resources.unshift(readable[0]!);
  } else {
    rows.tasks.unshift(result as TaskRow);
  }
}

function baseCandidates(rows: Awaited<ReturnType<typeof queryCandidates>>): CandidateNode[] {
  const candidates: CandidateNode[] = [];
  for (const row of rows.memories) {
    candidates.push({
      id: nodeKey("memory", row.id),
      source_id: row.id,
      type: "memory",
      kind: normalizeMemoryKind(row.kind),
      label: compactText(row.summary, 180) ?? compactText(row.content, 180) ?? row.id,
      summary: compactText(row.content, 320),
      project_id: row.project_id,
      status: normalizeLifecycleState(row.lifecycle_state),
      confidence: finiteConfidence(row.confidence_score),
      updated_at: Number(row.updated_at ?? row.created_at),
      last_used_at: row.last_accessed_at === null ? null : Number(row.last_accessed_at),
      usage_count_30d: 0,
      degree: 0,
      cluster_ids: [],
      deep_link: `/memories?selected=${encodeURIComponent(row.id)}`,
      sort_at: Number(row.updated_at ?? row.created_at)
    });
  }
  for (const row of rows.decisions) {
    candidates.push({
      id: nodeKey("decision", row.id),
      source_id: row.id,
      type: "decision",
      kind: row.domain || "general",
      label: compactText(row.title, 180) ?? row.id,
      summary: compactText(row.decision, 320),
      project_id: row.project_id,
      status: row.status || row.confirmation_state,
      confidence: finiteConfidence(row.confidence),
      updated_at: Number(row.updated_at),
      last_used_at: null,
      usage_count_30d: 0,
      degree: 0,
      cluster_ids: [],
      deep_link: `/decisions?selected=${encodeURIComponent(row.id)}`,
      sort_at: Number(row.updated_at)
    });
  }
  for (const row of rows.resources) {
    candidates.push({
      id: nodeKey("resource", row.id),
      source_id: row.id,
      type: "resource",
      kind: row.resource_kind,
      label: compactText(row.title, 180) ?? row.id,
      summary: compactText(row.source_system, 160),
      project_id: row.project_id,
      status: row.lifecycle_state,
      confidence: null,
      updated_at: Number(row.updated_at),
      last_used_at: null,
      usage_count_30d: 0,
      degree: 0,
      cluster_ids: [],
      deep_link: `/resources?selected=${encodeURIComponent(row.id)}`,
      sort_at: Number(row.updated_at)
    });
  }
  for (const row of rows.tasks) {
    candidates.push({
      id: nodeKey("task", row.id),
      source_id: row.id,
      type: "task",
      kind: "task",
      label: compactText(row.capability, 180) ?? row.id,
      summary: null,
      project_id: row.project_id,
      status: row.status,
      confidence: null,
      updated_at: Number(row.updated_at),
      last_used_at: null,
      usage_count_30d: 0,
      degree: 0,
      cluster_ids: [],
      deep_link: `/tasks/${encodeURIComponent(row.id)}`,
      sort_at: Number(row.updated_at)
    });
  }
  return candidates;
}

async function queryDirectEntitySearch(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions
): Promise<DirectEntitySearchResult> {
  if (!options.q || options.focus_type || options.focus_id) {
    return {
      memories: [],
      links: [],
      hydratedNodeIds: new Set(),
      priorityNodeIds: [],
      truncated: false
    };
  }
  const target = Math.min(MAX_QUERY_ROWS, options.node_limit);
  const project = projectClause(options.project_id);
  const memoryReadable = memoryReadabilityClause(options.principal, "m.permissions_json");
  const entitySearch = substringSearchClause(options.q, ["e.canonical_name", "e.entity_type"]);
  const entityResult = await env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id, e.entity_type, e.canonical_name, MAX(me.created_at) AS matched_at
     FROM entities e
     JOIN memory_entities me ON me.tenant_id = e.tenant_id AND me.entity_id = e.id
     JOIN memories m ON m.tenant_id = me.tenant_id AND m.id = me.memory_id
     WHERE e.tenant_id = ? ${entitySearch.sql}
       AND m.lifecycle_state != 'suppressed'
       ${project.sql.replaceAll("project_id", "m.project_id")}
       ${memoryReadable.sql}
     GROUP BY e.id, e.entity_type, e.canonical_name
     ORDER BY matched_at DESC, e.id DESC
     LIMIT ?`
  ).bind(
    tenantId,
    ...entitySearch.bindings,
    ...project.bindings,
    ...memoryReadable.bindings,
    target + 1
  ).all<DirectEntityRow>();
  const entities = entityResult.results.slice(0, target);
  if (entities.length === 0) {
    return {
      memories: [],
      links: [],
      hydratedNodeIds: new Set(),
      priorityNodeIds: [],
      truncated: false
    };
  }

  const requestedEntities = JSON.stringify(entities.map((row, priority) => [row.id, priority]));
  const linkResult = await env.OPEN_BRAIN_DB.prepare(
    `WITH matched_entities(entity_id, entity_priority) AS (
       SELECT CAST(json_extract(value, '$[0]') AS TEXT),
              CAST(json_extract(value, '$[1]') AS INTEGER)
       FROM json_each(?)
     ),
     ranked_links AS (
       SELECT m.id AS memory_id, m.project_id, m.content, m.summary, m.kind,
              m.lifecycle_state, m.confidence_score, m.permissions_json, m.updated_at,
              m.created_at, m.last_accessed_at,
              me.id AS link_id, me.entity_id, me.role,
              me.confidence_score AS link_confidence_score,
              me.created_at AS link_created_at,
              e.entity_type, e.canonical_name, matched.entity_priority,
              ROW_NUMBER() OVER (
                PARTITION BY me.entity_id
                ORDER BY me.created_at DESC, me.id DESC
              ) AS per_entity_rank
       FROM matched_entities matched
       JOIN memory_entities me ON me.tenant_id = ? AND me.entity_id = matched.entity_id
       JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
       JOIN memories m ON m.tenant_id = me.tenant_id AND m.id = me.memory_id
       WHERE m.lifecycle_state != 'suppressed'
         ${project.sql.replaceAll("project_id", "m.project_id")}
         ${memoryReadable.sql}
     )
     SELECT * FROM ranked_links
     ORDER BY per_entity_rank, entity_priority, link_created_at DESC, link_id DESC
     LIMIT ?`
  ).bind(
    requestedEntities,
    tenantId,
    ...project.bindings,
    ...memoryReadable.bindings,
    target + 1
  ).all<DirectEntityMemoryLinkRow>();
  const readableRows = linkResult.results.filter((row) =>
    stableResultReadable(row.permissions_json, options.principal)
  );
  const selectedRows = readableRows.slice(0, target);
  const memoryById = new Map<string, MemoryRow>();
  const links: EntityLinkRow[] = [];
  const firstMemoryByEntity = new Map<string, string>();
  for (const row of selectedRows) {
    if (!memoryById.has(row.memory_id)) {
      memoryById.set(row.memory_id, {
        id: row.memory_id,
        project_id: row.project_id,
        content: row.content,
        summary: row.summary,
        kind: row.kind,
        lifecycle_state: row.lifecycle_state,
        confidence_score: row.confidence_score,
        permissions_json: row.permissions_json,
        updated_at: row.updated_at,
        created_at: row.created_at,
        last_accessed_at: row.last_accessed_at
      });
    }
    if (!firstMemoryByEntity.has(row.entity_id)) firstMemoryByEntity.set(row.entity_id, row.memory_id);
    links.push({
      id: row.link_id,
      memory_id: row.memory_id,
      entity_id: row.entity_id,
      role: row.role,
      confidence_score: row.link_confidence_score,
      created_at: row.link_created_at,
      entity_type: row.entity_type,
      canonical_name: row.canonical_name
    });
  }
  const priorityNodeIds: string[] = [];
  const seenPriorityNodes = new Set<string>();
  const addPriority = (nodeId: string | undefined): void => {
    if (!nodeId || seenPriorityNodes.has(nodeId)) return;
    seenPriorityNodes.add(nodeId);
    priorityNodeIds.push(nodeId);
  };
  for (const entity of entities) {
    addPriority(nodeKey("entity", entity.id));
    const memoryId = firstMemoryByEntity.get(entity.id);
    if (memoryId) addPriority(nodeKey("memory", memoryId));
  }
  for (const row of selectedRows) addPriority(nodeKey("memory", row.memory_id));
  return {
    memories: [...memoryById.values()],
    links,
    hydratedNodeIds: new Set([...memoryById.keys()].map((id) => nodeKey("memory", id))),
    priorityNodeIds,
    truncated: entityResult.results.length > target || readableRows.length > target
  };
}

async function queryEntityLinks(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  memoryIds: string[],
  limit: number,
  focusType: DashboardNodeType | undefined,
  focusId: string | undefined,
  preferredEdgeIds: string[]
): Promise<BoundedRows<EntityLinkRow>> {
  if (memoryIds.length === 0) return { rows: [], truncated: false };
  const focusOrder = focusId && focusType === "memory"
    ? { sql: "CASE WHEN me.memory_id = ? THEN 0 ELSE 1 END", bindings: [focusId] }
    : focusId && focusType === "entity"
      ? { sql: "CASE WHEN me.entity_id = ? THEN 0 ELSE 1 END", bindings: [focusId] }
      : { sql: "1", bindings: [] };
  const result = await env.OPEN_BRAIN_DB.prepare(
    `WITH preferred_edges(edge_id, priority) AS (
       SELECT value, CAST(key AS INTEGER) FROM json_each(?)
     ),
     ranked_links AS (
       SELECT me.id, me.memory_id, me.entity_id, me.role, me.confidence_score, me.created_at,
              e.entity_type, e.canonical_name,
              COALESCE((
                SELECT priority FROM preferred_edges
                WHERE edge_id = ('memory_entity:' || me.id)
              ), 2147483647) AS traversal_priority,
              ${focusOrder.sql} AS focus_rank,
              ROW_NUMBER() OVER (
                PARTITION BY me.memory_id ORDER BY me.created_at DESC, me.id DESC
              ) AS per_memory_rank
       FROM memory_entities me
       JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
       WHERE me.tenant_id = ?
         AND me.memory_id IN (SELECT value FROM json_each(?))
     )
     SELECT id, memory_id, entity_id, role, confidence_score, created_at,
            entity_type, canonical_name
     FROM ranked_links
     ORDER BY traversal_priority, focus_rank, per_memory_rank, created_at DESC, id DESC
     LIMIT ?`
  ).bind(
    JSON.stringify(preferredEdgeIds),
    ...focusOrder.bindings,
    tenantId,
    JSON.stringify(memoryIds),
    limit + 1
  ).all<EntityLinkRow>();
  return {
    rows: result.results.slice(0, limit),
    truncated: result.results.length > limit
  };
}

function projectCandidates(candidates: CandidateNode[], requestedProjectId: string | undefined): CandidateNode[] {
  const projects = new Map<string, number>();
  if (requestedProjectId) projects.set(requestedProjectId, 0);
  for (const node of candidates) {
    if (!node.project_id) continue;
    projects.set(node.project_id, Math.max(projects.get(node.project_id) ?? 0, node.sort_at));
  }
  return [...projects.entries()].map(([projectId, updatedAt]) => ({
    id: nodeKey("project", projectId),
    source_id: projectId,
    type: "project" as const,
    kind: "project",
    label: projectId,
    summary: null,
    project_id: projectId,
    status: null,
    confidence: null,
    updated_at: updatedAt || null,
    last_used_at: null,
    usage_count_30d: 0,
    degree: 0,
    cluster_ids: [],
    deep_link: `/memories/constellation?selected=${encodeURIComponent(nodeKey("project", projectId))}`,
    sort_at: updatedAt
  }));
}

function addEdge(target: Map<string, DashboardKnowledgeEdge>, edge: DashboardKnowledgeEdge): void {
  if (!target.has(edge.id)) target.set(edge.id, edge);
}

async function buildExplicitEdges(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: ParsedOptions,
  rows: Awaited<ReturnType<typeof queryCandidates>>,
  entityLinks: EntityLinkRow[],
  candidateById: Map<string, CandidateNode>,
  preferredEdgeIds: string[],
  focusNodeId: string | null
): Promise<ExplicitEdgeResult> {
  const edges = new Map<string, DashboardKnowledgeEdge>();
  const candidateNodeIdsJson = JSON.stringify([...candidateById.keys()]);
  const preferredEdgeIdsJson = JSON.stringify(preferredEdgeIds);
  const relationLimit = edgeCandidateLimit(options.edge_limit);
  let truncated = false;
  const memoryIds = rows.memories.map((row) => row.id);
  if (memoryIds.length) {
    const memoryEdges = await env.OPEN_BRAIN_DB.prepare(
      `WITH candidate_nodes(node_id) AS (SELECT value FROM json_each(?)),
       preferred_edges(edge_id, priority) AS (
         SELECT value, CAST(key AS INTEGER) FROM json_each(?)
       ),
       focus_node(node_id) AS (SELECT ?),
       eligible_memory_edges AS (
         SELECT id, from_memory_id, to_memory_id, relation, created_at,
                'memory_edge:' || id AS edge_id,
                'memory:' || from_memory_id AS source_node_id,
                'memory:' || to_memory_id AS target_node_id
         FROM memory_edges
         WHERE tenant_id = ?
           AND ('memory:' || from_memory_id) IN (SELECT node_id FROM candidate_nodes)
           AND ('memory:' || to_memory_id) IN (SELECT node_id FROM candidate_nodes)
       )
       SELECT id, from_memory_id, to_memory_id, relation, created_at
       FROM eligible_memory_edges
       ORDER BY COALESCE((
                  SELECT priority FROM preferred_edges
                  WHERE preferred_edges.edge_id = eligible_memory_edges.edge_id
                ), 2147483647),
                CASE WHEN source_node_id = (SELECT node_id FROM focus_node)
                       OR target_node_id = (SELECT node_id FROM focus_node)
                     THEN 0 ELSE 1 END,
                created_at DESC, id DESC
       LIMIT ?`
    ).bind(
      candidateNodeIdsJson,
      preferredEdgeIdsJson,
      focusNodeId,
      tenantId,
      relationLimit + 1
    ).all<MemoryEdgeRow>();
    truncated ||= memoryEdges.results.length > relationLimit;
    for (const row of memoryEdges.results.slice(0, relationLimit)) {
      addEdge(edges, {
        id: `memory_edge:${row.id}`,
        source: nodeKey("memory", row.from_memory_id),
        target: nodeKey("memory", row.to_memory_id),
        relation: row.relation,
        directed: true,
        inferred: false,
        weight: 1,
        confidence: null
      });
    }
  }
  for (const row of entityLinks) {
    addEdge(edges, {
      id: `memory_entity:${row.id}`,
      source: nodeKey("memory", row.memory_id),
      target: nodeKey("entity", row.entity_id),
      relation: row.role,
      directed: true,
      inferred: false,
      weight: finiteWeight(row.confidence_score),
      confidence: finiteConfidence(row.confidence_score)
    });
  }
  for (const decision of rows.decisions) {
    if (!decision.superseded_by) continue;
    addEdge(edges, {
      id: `decision_supersession:${decision.id}:${decision.superseded_by}`,
      source: nodeKey("decision", decision.id),
      target: nodeKey("decision", decision.superseded_by),
      relation: "superseded_by",
      directed: true,
      inferred: false,
      weight: 1,
      confidence: finiteConfidence(decision.confidence)
    });
  }
  const assertionProjectSql = options.project_id ? "AND (a.project_id = ? OR a.project_id IS NULL)" : "";
  const assertionResourcesReadable = assertionResourcesReadabilityClause(
    tenantId,
    options.project_id,
    options.principal,
    "a"
  );
  const assertionRows = await env.OPEN_BRAIN_DB.prepare(
    `WITH candidate_nodes(node_id) AS (SELECT value FROM json_each(?)),
     preferred_edges(edge_id, priority) AS (
       SELECT value, CAST(key AS INTEGER) FROM json_each(?)
     ),
     focus_node(node_id) AS (SELECT ?),
     eligible_assertions AS (
       SELECT a.id, a.subject_type, a.subject_ref, a.predicate, a.object_type,
              a.object_ref, a.resource_id, a.confidence, a.updated_at,
              'knowledge_assertion:' || a.id AS edge_id,
              CASE a.subject_type
                WHEN 'project' THEN 'project:' || a.subject_ref
                WHEN 'memory' THEN 'memory:' || a.subject_ref
                WHEN 'decision' THEN 'decision:' || a.subject_ref
                WHEN 'decision_memory' THEN 'decision:' || a.subject_ref
                WHEN 'resource' THEN 'resource:' || a.subject_ref
                WHEN 'knowledge_resource' THEN 'resource:' || a.subject_ref
                WHEN 'entity' THEN 'entity:' || a.subject_ref
                WHEN 'task' THEN 'task:' || a.subject_ref
                ELSE NULL
              END AS source_node_id,
              CASE
                WHEN a.object_type = 'project' THEN 'project:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.object_type = 'memory' THEN 'memory:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.object_type IN ('decision', 'decision_memory')
                  THEN 'decision:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.object_type IN ('resource', 'knowledge_resource')
                  THEN 'resource:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.object_type = 'entity' THEN 'entity:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.object_type = 'task' THEN 'task:' || COALESCE(a.object_ref, a.resource_id)
                WHEN a.resource_id IS NOT NULL THEN 'resource:' || a.resource_id
                ELSE NULL
              END AS target_node_id
       FROM knowledge_assertions a
       WHERE a.tenant_id = ? AND a.confirmation_state = 'confirmed'
         AND (a.valid_until IS NULL OR a.valid_until > ?)
         ${assertionProjectSql}
         ${assertionResourcesReadable.sql}
     )
     SELECT id, subject_type, subject_ref, predicate, object_type, object_ref,
            resource_id, confidence
     FROM eligible_assertions
     WHERE source_node_id IN (SELECT node_id FROM candidate_nodes)
       AND target_node_id IN (SELECT node_id FROM candidate_nodes)
     ORDER BY COALESCE((
                SELECT priority FROM preferred_edges
                WHERE preferred_edges.edge_id = eligible_assertions.edge_id
              ), 2147483647),
              CASE WHEN source_node_id = (SELECT node_id FROM focus_node)
                     OR target_node_id = (SELECT node_id FROM focus_node)
                   THEN 0 ELSE 1 END,
              updated_at DESC, id DESC
     LIMIT ?`
  ).bind(
    candidateNodeIdsJson,
    preferredEdgeIdsJson,
    focusNodeId,
    tenantId,
    options.now,
    ...(options.project_id ? [options.project_id] : []),
    ...assertionResourcesReadable.bindings,
    relationLimit + 1
  ).all<AssertionRow>();
  truncated ||= assertionRows.results.length > relationLimit;
  for (const row of assertionRows.results.slice(0, relationLimit)) {
    const sourceType = sourceTypeToNodeType(row.subject_type);
    const explicitObjectType = sourceTypeToNodeType(row.object_type);
    const targetType = explicitObjectType ?? (row.resource_id ? "resource" : null);
    const targetId = row.object_ref ?? row.resource_id;
    if (!sourceType || !targetType || !targetId) continue;
    addEdge(edges, {
      id: `knowledge_assertion:${row.id}`,
      source: nodeKey(sourceType, row.subject_ref),
      target: nodeKey(targetType, targetId),
      relation: row.predicate,
      directed: true,
      inferred: false,
      weight: finiteWeight(row.confidence),
      confidence: finiteConfidence(row.confidence)
    });
  }
  const usageRows = await env.OPEN_BRAIN_DB.prepare(
    `WITH candidate_nodes(node_id) AS (SELECT value FROM json_each(?)),
     preferred_edges(edge_id, priority) AS (
       SELECT value, CAST(key AS INTEGER) FROM json_each(?)
     ),
     focus_node(node_id) AS (SELECT ?),
     eligible_usage AS (
       SELECT i.id AS item_id, i.source_type, i.source_id, e.task_id, i.reference_type,
              i.used_state, i.score, i.created_at,
              'memory_usage:' || i.id AS edge_id,
              'task:' || e.task_id AS source_node_id,
              CASE i.source_type
                WHEN 'memory' THEN 'memory:' || i.source_id
                WHEN 'decision_memory' THEN 'decision:' || i.source_id
                ELSE NULL
              END AS target_node_id
       FROM memory_usage_items i
       JOIN memory_usage_events e ON e.tenant_id = i.tenant_id AND e.id = i.usage_event_id
       WHERE i.tenant_id = ? AND e.task_id IS NOT NULL
         ${options.project_id ? "AND e.project_id = ?" : ""}
     )
     SELECT item_id, source_type, source_id, task_id, reference_type, used_state,
            score, created_at
     FROM eligible_usage
     WHERE source_node_id IN (SELECT node_id FROM candidate_nodes)
       AND target_node_id IN (SELECT node_id FROM candidate_nodes)
     ORDER BY COALESCE((
                SELECT priority FROM preferred_edges
                WHERE preferred_edges.edge_id = eligible_usage.edge_id
              ), 2147483647),
              CASE WHEN source_node_id = (SELECT node_id FROM focus_node)
                     OR target_node_id = (SELECT node_id FROM focus_node)
                   THEN 0 ELSE 1 END,
              created_at DESC, item_id DESC
     LIMIT ?`
  ).bind(
    candidateNodeIdsJson,
    preferredEdgeIdsJson,
    focusNodeId,
    tenantId,
    ...(options.project_id ? [options.project_id] : []),
    relationLimit + 1
  ).all<UsageEdgeRow>();
  truncated ||= usageRows.results.length > relationLimit;
  for (const row of usageRows.results.slice(0, relationLimit)) {
    addEdge(edges, {
      id: `memory_usage:${row.item_id}`,
      source: nodeKey("task", row.task_id),
      target: nodeKey(row.source_type === "memory" ? "memory" : "decision", row.source_id),
      relation: row.used_state === "used" ? "used" : row.reference_type,
      directed: true,
      inferred: false,
      weight: finiteWeight(row.score),
      confidence: finiteConfidence(row.score)
    });
  }
  for (const node of candidateById.values()) {
    if (!node.project_id || node.type === "project") continue;
    addEdge(edges, {
      id: `project_membership:${node.project_id}:${node.id}`,
      source: nodeKey("project", node.project_id),
      target: node.id,
      relation: "contains",
      directed: true,
      inferred: false,
      weight: 1,
      confidence: null
    });
  }
  const preferredOrder = new Map(preferredEdgeIds.map((edgeId, index) => [edgeId, index]));
  return {
    edges: [...edges.values()].sort((left, right) => {
      const leftPreferred = preferredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightPreferred = preferredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      const preferred = leftPreferred - rightPreferred;
      if (preferred !== 0) return preferred;
      const leftFocus = Number(Boolean(focusNodeId && (left.source === focusNodeId || left.target === focusNodeId)));
      const rightFocus = Number(Boolean(focusNodeId && (right.source === focusNodeId || right.target === focusNodeId)));
      return rightFocus - leftFocus || left.id.localeCompare(right.id);
    }),
    truncated
  };
}

async function applyUsageStats(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  options: Pick<ParsedOptions, "now" | "project_id">,
  candidateById: Map<string, CandidateNode>
): Promise<void> {
  const candidateNodeIdsJson = JSON.stringify([...candidateById.keys()]);
  const sourceNodeId = storedNodeKeySql("i.source_type", "i.source_id");
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `WITH candidate_nodes(node_id) AS (SELECT value FROM json_each(?))
     SELECT i.source_type, i.source_id, COUNT(*) AS usage_count,
            MAX(i.created_at) AS last_used_at
     FROM memory_usage_items i
     JOIN memory_usage_events e
       ON e.tenant_id = i.tenant_id AND e.id = i.usage_event_id
     WHERE i.tenant_id = ? AND i.created_at >= ?
       ${options.project_id ? "AND e.project_id = ?" : ""}
       AND (${sourceNodeId}) IN (SELECT node_id FROM candidate_nodes)
     GROUP BY i.source_type, i.source_id
     ORDER BY i.source_type, i.source_id`
  ).bind(
    candidateNodeIdsJson,
    tenantId,
    Math.max(0, options.now - THIRTY_DAYS_MS),
    ...(options.project_id ? [options.project_id] : [])
  ).all<UsageStatRow>();
  for (const row of rows.results) {
    const id = nodeKey(row.source_type === "memory" ? "memory" : "decision", row.source_id);
    const node = candidateById.get(id);
    if (!node) continue;
    node.usage_count_30d = Math.max(0, Number(row.usage_count ?? 0));
    node.last_used_at = row.last_used_at === null ? node.last_used_at : Number(row.last_used_at);
  }
}

function focusNeighborhood(
  allNodeIds: Set<string>,
  edges: DashboardKnowledgeEdge[],
  focusId: string,
  depth: number
): Set<string> {
  if (!allNodeIds.has(focusId)) return new Set();
  const included = new Set([focusId]);
  let frontier = new Set([focusId]);
  for (let step = 0; step < depth; step += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.source) && allNodeIds.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && allNodeIds.has(edge.source)) next.add(edge.source);
    }
    for (const id of next) included.add(id);
    frontier = new Set([...next].filter((id) => !frontier.has(id)));
  }
  return included;
}

function buildClusters(nodes: DashboardKnowledgeNode[]): DashboardKnowledgeCluster[] {
  const clusters = new Map<string, DashboardKnowledgeCluster>();
  for (const node of nodes) {
    const memberships: Array<{ id: string; kind: DashboardKnowledgeCluster["kind"]; label: string }> = [];
    if (node.project_id) memberships.push({ id: `cluster:project:${node.project_id}`, kind: "project", label: node.project_id });
    if (node.type === "memory" && node.kind) {
      memberships.push({ id: `cluster:memory_kind:${node.kind}`, kind: "memory_kind", label: node.kind });
    }
    if (node.type === "decision" && node.kind) {
      memberships.push({ id: `cluster:domain:${node.kind}`, kind: "domain", label: node.kind });
    }
    node.cluster_ids = memberships.map((item) => item.id).sort();
    for (const membership of memberships) {
      const cluster = clusters.get(membership.id) ?? { ...membership, node_ids: [] };
      cluster.node_ids.push(node.id);
      clusters.set(membership.id, cluster);
    }
  }
  return [...clusters.values()]
    .map((cluster) => ({ ...cluster, node_ids: [...new Set(cluster.node_ids)].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function runKnowledgeGraphPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.error(JSON.stringify({ dashboard_view: "knowledge_graph", phase, status: "error" }));
    throw error;
  }
}

/**
 * Builds a bounded dashboard/v1 graph using only stored relations. ACL filtering is
 * completed before the final edge pass, so no edge can expose a hidden endpoint.
 */
export async function getKnowledgeGraph(
  env: Pick<Env, "OPEN_BRAIN_DB">,
  tenantId: string,
  rawOptions: KnowledgeGraphOptions = {}
): Promise<DashboardKnowledgeGraphResponse> {
  const normalizedTenant = normalizeTenantId(tenantId);
  const options = parseOptions(rawOptions);
  if (options.focus_type === "project" && options.focus_id) {
    if (options.project_id && options.project_id !== options.focus_id) {
      throw new HttpError(404, "knowledge_node_not_found", "Knowledge graph focus is outside the requested project");
    }
    options.project_id = options.focus_id;
  }
  const rows = await runKnowledgeGraphPhase("query_candidates", () =>
    queryCandidates(env, normalizedTenant, options)
  );
  await runKnowledgeGraphPhase("ensure_focus", () =>
    ensureFocusCandidate(env, normalizedTenant, options, rows)
  );
  const focusHydration = await runKnowledgeGraphPhase("hydrate_focus", () =>
    hydrateFocusNeighborhood(env, normalizedTenant, options, rows)
  );
  const directEntitySearch = await runKnowledgeGraphPhase("direct_entity_search", () =>
    queryDirectEntitySearch(env, normalizedTenant, options)
  );
  const knownMemoryIds = new Set(rows.memories.map((row) => row.id));
  for (const memory of directEntitySearch.memories) {
    if (knownMemoryIds.has(memory.id)) continue;
    knownMemoryIds.add(memory.id);
    rows.memories.push(memory);
  }
  const focusNodeId = options.focus_type && options.focus_id
    ? nodeKey(options.focus_type, options.focus_id)
    : null;
  const preferredEdgeIds = [...new Set([
    ...focusHydration.edgeIds,
    ...directEntitySearch.links.map((row) => `memory_entity:${row.id}`)
  ])];

  const candidates = baseCandidates(rows);
  const entityLinkResult = await runKnowledgeGraphPhase("query_entity_links", () =>
    queryEntityLinks(
      env,
      normalizedTenant,
      rows.memories.map((row) => row.id),
      edgeCandidateLimit(options.edge_limit),
      options.focus_type,
      options.focus_id,
      preferredEdgeIds
    )
  );
  const entityLinksById = new Map<string, EntityLinkRow>();
  for (const row of [...directEntitySearch.links, ...entityLinkResult.rows]) {
    if (!entityLinksById.has(row.id)) entityLinksById.set(row.id, row);
  }
  const entityLinks = [...entityLinksById.values()];
  const seenEntities = new Set<string>();
  for (const row of entityLinks) {
    if (seenEntities.has(row.entity_id)) continue;
    seenEntities.add(row.entity_id);
    candidates.push({
      id: nodeKey("entity", row.entity_id),
      source_id: row.entity_id,
      type: "entity",
      kind: row.entity_type,
      label: compactText(row.canonical_name, 180) ?? row.entity_id,
      summary: null,
      project_id: null,
      status: null,
      confidence: finiteConfidence(row.confidence_score),
      updated_at: Number(row.created_at),
      last_used_at: null,
      usage_count_30d: 0,
      degree: 0,
      cluster_ids: [],
      deep_link: `/memories/constellation?selected=${encodeURIComponent(nodeKey("entity", row.entity_id))}`,
      sort_at: Number(row.created_at)
    });
  }
  candidates.push(...projectCandidates(candidates, options.project_id));
  const candidateById = new Map<string, CandidateNode>();
  for (const node of candidates.sort(candidateSort)) {
    if (!candidateById.has(node.id)) candidateById.set(node.id, node);
  }
  await runKnowledgeGraphPhase("apply_usage_stats", () =>
    applyUsageStats(env, normalizedTenant, options, candidateById)
  );
  const edgeResult = await runKnowledgeGraphPhase("build_explicit_edges", () =>
    buildExplicitEdges(
      env,
      normalizedTenant,
      options,
      rows,
      entityLinks,
      candidateById,
      preferredEdgeIds,
      focusNodeId
    )
  );
  const allEdges = edgeResult.edges;

  let relevantIds = new Set([...candidateById.keys()].filter((id) =>
    textMatches(candidateById.get(id)!, options.q) || directEntitySearch.hydratedNodeIds.has(id)
  ));
  if (options.focus_type && options.focus_id) {
    const neighborhood = focusNeighborhood(new Set(candidateById.keys()), allEdges, focusNodeId!, options.depth);
    if (neighborhood.size === 0) {
      throw new HttpError(404, "knowledge_node_not_found", "Knowledge graph focus was not found or is not readable");
    }
    relevantIds = new Set([...neighborhood].filter((id) => id === focusNodeId || relevantIds.has(id)));
  }
  const directSearchPriority = new Map(
    directEntitySearch.priorityNodeIds.map((id, index) => [id, index])
  );
  const relevantNodes = [...relevantIds]
    .map((id) => candidateById.get(id)!)
    .sort((left, right) => {
      const leftFocus = options.focus_type && options.focus_id && left.id === nodeKey(options.focus_type, options.focus_id) ? 1 : 0;
      const rightFocus = options.focus_type && options.focus_id && right.id === nodeKey(options.focus_type, options.focus_id) ? 1 : 0;
      if (rightFocus !== leftFocus) return rightFocus - leftFocus;
      const leftSearchPriority = directSearchPriority.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightSearchPriority = directSearchPriority.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftSearchPriority - rightSearchPriority || candidateSort(left, right);
    });
  const selectedNodes = relevantNodes.slice(0, options.node_limit);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const eligibleEdges = allEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
  const selectedEdges = eligibleEdges.slice(0, options.edge_limit);
  const degree = new Map<string, number>();
  for (const edge of selectedEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const nodes: DashboardKnowledgeNode[] = selectedNodes.map(({ sort_at: _sortAt, ...node }) => ({
    ...node,
    degree: degree.get(node.id) ?? 0
  }));
  const exactRelevantCount = await runKnowledgeGraphPhase("exact_relevant_count", () =>
    exactRelevantNodeCount(env, normalizedTenant, options)
  );
  const omittedNodeCount = Math.max(0, exactRelevantCount - nodes.length);
  return {
    contract_version: DASHBOARD_CONTRACT_VERSION,
    nodes,
    edges: selectedEdges,
    clusters: buildClusters(nodes),
    generated_at: options.now,
    truncated: omittedNodeCount > 0 || eligibleEdges.length > selectedEdges.length ||
      entityLinkResult.truncated || edgeResult.truncated || focusHydration.truncated || directEntitySearch.truncated,
    omitted_node_count: omittedNodeCount
  };
}
