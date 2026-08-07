import { ORG_ROLES, ROLE_PERMISSIONS, type OrgRole } from "@org-brain/shared";
import type { Env } from "./types";

export async function getOperationsStatus(env: Env, tenantId: string) {
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const [memories, decisions, tasks, failedTasks, audit, tokens, retention, retrieval, roles, retrievalUnits] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN lifecycle_state IS NULL OR lifecycle_state != 'suppressed' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN lifecycle_state = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
         SUM(CASE WHEN valid_until IS NOT NULL AND valid_until <= ? THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN kind = 'decision' THEN 1 ELSE 0 END) AS decisions,
         SUM(CASE WHEN conflicts_json IS NOT NULL AND conflicts_json != '[]' THEN 1 ELSE 0 END) AS conflicting
       FROM memories WHERE tenant_id = ?`
    ).bind(now, tenantId).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN confirmation_state != 'explicit_confirmed' THEN 1 ELSE 0 END) AS unconfirmed,
         SUM(CASE WHEN valid_until IS NOT NULL AND valid_until <= ? THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN confidence < 0.7 THEN 1 ELSE 0 END) AS low_confidence
       FROM decision_memories WHERE tenant_id = ?`
    ).bind(now, tenantId).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('failed', 'dead_letter') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status IN ('created', 'queued', 'leased', 'running') THEN 1 ELSE 0 END) AS active
       FROM tasks WHERE tenant_id = ?`
    ).bind(tenantId).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT id, capability, status, updated_at
       FROM tasks
       WHERE tenant_id = ? AND status IN ('failed', 'dead_letter')
       ORDER BY updated_at DESC
       LIMIT 20`
    ).bind(tenantId).all<{
      id: string;
      capability: string;
      status: string;
      updated_at: number;
    }>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS events_24h,
         SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied_24h,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_24h
       FROM audit_events WHERE tenant_id = ? AND created_at >= ?`
    ).bind(tenantId, dayAgo).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active
       FROM scoped_tokens WHERE tenant_id = ?`
    ).bind(now, tenantId).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS policies,
         SUM(CASE WHEN legal_hold = 1 THEN 1 ELSE 0 END) AS legal_holds
       FROM retention_policies WHERE tenant_id = ?`
    ).bind(tenantId).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS searches_24h,
         SUM(CASE WHEN matched_count > 0 THEN 1 ELSE 0 END) AS hits_24h,
         SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) AS fallbacks_24h,
         AVG(latency_ms) AS average_latency_ms
       FROM retrieval_events WHERE tenant_id = ? AND created_at >= ?`
    ).bind(tenantId, dayAgo).first<Record<string, number | null>>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT role, COUNT(*) AS assignments, COUNT(DISTINCT principal) AS principals
       FROM principal_role_assignments
       WHERE tenant_id = ?
       GROUP BY role
       ORDER BY role`
    ).bind(tenantId).all<{ role: string; assignments: number; principals: number }>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(DISTINCT memory_id) AS projected_memories,
         SUM(CASE WHEN extraction_state != 'ready' THEN 1 ELSE 0 END) AS degraded,
         MAX(created_at) AS latest_projection_at
       FROM memory_retrieval_units
       WHERE tenant_id = ?`
    ).bind(tenantId).first<Record<string, number | null>>()
  ]);
  const numeric = (row: Record<string, number | null> | null, key: string) =>
    Number(row?.[key] ?? 0);
  return {
    tenant_id: tenantId,
    generated_at: now,
    memories: {
      total: numeric(memories, "total"),
      active: numeric(memories, "active"),
      suppressed: numeric(memories, "suppressed"),
      expired: numeric(memories, "expired"),
      decisions: numeric(memories, "decisions"),
      conflicting: numeric(memories, "conflicting")
    },
    decision_review: {
      total: numeric(decisions, "total"),
      unconfirmed: numeric(decisions, "unconfirmed"),
      expired: numeric(decisions, "expired"),
      low_confidence: numeric(decisions, "low_confidence")
    },
    tasks: {
      total: numeric(tasks, "total"),
      active: numeric(tasks, "active"),
      failed: numeric(tasks, "failed"),
      failed_items: failedTasks.results
    },
    audit: {
      events_24h: numeric(audit, "events_24h"),
      denied_24h: numeric(audit, "denied_24h"),
      failed_24h: numeric(audit, "failed_24h")
    },
    scoped_tokens: {
      total: numeric(tokens, "total"),
      active: numeric(tokens, "active")
    },
    authorization: {
      assignments: roles.results.reduce((sum, row) => sum + Number(row.assignments || 0), 0),
      principals_by_role: Object.fromEntries(
        roles.results.map((row) => [row.role, Number(row.principals || 0)])
      ),
      roles: ORG_ROLES.map((role: OrgRole) => {
        const row = roles.results.find((candidate) => candidate.role === role);
        return {
          role,
          permissions: [...ROLE_PERMISSIONS[role]],
          assignments: Number(row?.assignments || 0),
          principals: Number(row?.principals || 0)
        };
      })
    },
    retention: {
      policies: numeric(retention, "policies"),
      legal_holds: numeric(retention, "legal_holds")
    },
    retrieval: {
      semantic_configured: Boolean(env.AI && env.MEMORY_VECTOR_INDEX),
      hybrid_v3_configured: Boolean(env.AI && env.MEMORY_VECTOR_INDEX_V3),
      hybrid_v4_mode: env.HYBRID_V4_MODE ?? "off",
      generation_routing: env.RETRIEVAL_GENERATION_ROUTING ?? "legacy",
      classification_mode: env.MEMORY_CLASSIFICATION_MODE ?? "observe",
      lexical: "d1-fts5",
      graph: "d1-memory-graph",
      retrieval_units: numeric(retrievalUnits, "total"),
      projected_memories: numeric(retrievalUnits, "projected_memories"),
      coverage:
        numeric(memories, "active") > 0
          ? Number((numeric(retrievalUnits, "projected_memories") / numeric(memories, "active")).toFixed(4))
          : 1,
      degraded_units: numeric(retrievalUnits, "degraded"),
      projection_lag_ms:
        numeric(retrievalUnits, "latest_projection_at") > 0
          ? Math.max(0, now - numeric(retrievalUnits, "latest_projection_at"))
          : null,
      searches_24h: numeric(retrieval, "searches_24h"),
      hit_rate_24h:
        numeric(retrieval, "searches_24h") > 0
          ? Number((numeric(retrieval, "hits_24h") / numeric(retrieval, "searches_24h")).toFixed(4))
          : null,
      fallback_rate_24h:
        numeric(retrieval, "searches_24h") > 0
          ? Number((numeric(retrieval, "fallbacks_24h") / numeric(retrieval, "searches_24h")).toFixed(4))
          : null,
      average_latency_ms_24h:
        numeric(retrieval, "searches_24h") > 0
          ? Number(numeric(retrieval, "average_latency_ms").toFixed(2))
          : null
    },
    slo_targets: {
      rpo_minutes: 5,
      rto_minutes: 60,
      local_100k_search_p95_ms: 500
    }
  };
}
