import { planEpisodicAging } from "@org-brain/shared";
import type { EpisodicAgingCandidate } from "@org-brain/shared";
import type { Env } from "./types";

/** Shadow-only plan: verified evaluation means action and outcome evidence passed use-history checks. */
export async function getMemoryAgingPlan(env: Env, tenantId: string, projectId: string, now = Date.now()): Promise<{
  mode: "shadow"; cold_after_days: number; compaction_after_days: number;
  scanned: number; candidates: EpisodicAgingCandidate[]; mutations: 0;
}> {
  const rows = await env.OPEN_BRAIN_DB.prepare(`SELECT m.id,m.kind,m.lifecycle_state,m.current_version,m.created_at,m.deleted_at,
      m.expires_at,m.valid_until,
      COALESCE((SELECT p.legal_hold FROM retention_policies p WHERE p.tenant_id=m.tenant_id
        AND (p.project_id=m.project_id OR p.project_id IS NULL) ORDER BY (p.project_id IS NOT NULL) DESC LIMIT 1),0) AS legal_hold,
      (SELECT MAX(e.created_at) FROM memory_use_contexts c
        JOIN memory_use_evaluations e ON e.tenant_id=c.tenant_id AND e.context_id=c.id
        WHERE c.tenant_id=m.tenant_id AND c.source_type='memory' AND c.source_id=m.id
          AND c.source_version=m.current_version AND c.revoked_at IS NULL
          AND c.verification_state='verified' AND e.verification_state='verified'
          AND e.outcome IN ('positive','negative')
          AND NOT EXISTS(SELECT 1 FROM memory_use_contexts newer WHERE newer.tenant_id=c.tenant_id AND newer.supersedes_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations newer WHERE newer.tenant_id=e.tenant_id AND newer.supersedes_id=e.id)) AS last_verified_use_at,
      (EXISTS(SELECT 1 FROM memory_quality_feedback f WHERE f.tenant_id=m.tenant_id AND f.memory_id=m.id
        AND f.memory_version=m.current_version AND f.status IN ('reported','confirmed'))
       OR EXISTS(SELECT 1 FROM memory_integrity_relations r WHERE r.tenant_id=m.tenant_id AND r.status='confirmed'
         AND r.relation='contradicts' AND ((r.from_memory_id=m.id AND r.from_version=m.current_version)
           OR (r.to_memory_id=m.id AND r.to_version=m.current_version)))) AS unresolved_integrity
    FROM memories m WHERE m.tenant_id=? AND m.project_id=? ORDER BY m.id`)
    .bind(tenantId, projectId).all();
  return planEpisodicAging(rows.results, { now });
}
