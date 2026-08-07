export function memoryImpactUtcDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function previousMemoryImpactUtcDay(timestamp = Date.now()) {
  return memoryImpactUtcDay(timestamp - 86_400_000);
}

export async function rebuildMemoryImpactMetricsForDay(db: D1Database, day: string, now = Date.now()) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("day must be YYYY-MM-DD");
  const end = start + 86_400_000;
  const statements = [
    db.prepare("DELETE FROM memory_effect_daily_metrics WHERE day = ?").bind(day),
    db.prepare(
      `INSERT INTO memory_effect_daily_metrics(
         id, day, tenant_id, source_type, source_id, project_id_snapshot,
         business_category_id_snapshot, work_type_snapshot, quality_category_snapshot,
         reference_count, used_count, effect_reported_count,
         positive_count, neutral_count, negative_count, unknown_count,
         avoided_source_search_count, avoided_web_search_count,
         avoided_past_context_count, avoided_none_count,
         gross_saved_tokens, injected_tokens, net_saved_tokens,
         failure_opportunity_count, failure_avoided_count, failure_saved_tokens,
         verification_sampled_count, verified_count, estimator_absolute_error_sum,
         created_at, updated_at
       )
       WITH latest_effect AS (
         SELECT e.* FROM memory_effect_events e
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_effect_events child
           WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
         )
       )
       SELECT
         lower(hex(? || char(0) || ui.tenant_id || char(0) || ui.source_type || char(0) ||
           ui.source_id || char(0) || IFNULL(ue.project_id, '') || char(0) ||
           IFNULL(ui.business_category_id_snapshot, '') || char(0) ||
           IFNULL(ui.work_type_snapshot, '') || char(0) || IFNULL(ui.quality_category_snapshot, ''))),
         ?, ui.tenant_id, ui.source_type, ui.source_id, ue.project_id,
         ui.business_category_id_snapshot, ui.work_type_snapshot, ui.quality_category_snapshot,
         COUNT(DISTINCT ui.usage_event_id),
         COUNT(DISTINCT CASE WHEN ui.used_state = 'used' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'positive' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'neutral' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'negative' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'unknown' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%source_search%' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%web_search%' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%past_context%' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json = '["none"]' THEN ui.usage_event_id END),
         COALESCE(SUM(ea.gross_saved_tokens), 0),
         COALESCE(SUM(ea.gross_saved_tokens - ea.net_saved_tokens), 0),
         COALESCE(SUM(ea.net_saved_tokens), 0),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_opportunity_state = 'applicable' THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_avoided = 1 THEN ui.usage_event_id END),
         COALESCE(SUM(ea.failure_saved_tokens), 0),
         COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 THEN ui.usage_event_id END),
         COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 AND ea.usage_item_id IS NOT NULL AND le.evidence_level = 'verified' THEN ui.usage_event_id END),
         COALESCE(SUM(CASE
           WHEN le.evidence_level = 'verified' AND previous.id IS NOT NULL
           THEN ABS(COALESCE(ea.gross_saved_tokens, 0) - COALESCE(previous_attribution.gross_saved_tokens, 0))
           ELSE 0 END), 0),
         ?, ?
       FROM memory_usage_items ui
       JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
       LEFT JOIN latest_effect le ON le.tenant_id = ui.tenant_id AND le.usage_event_id = ui.usage_event_id
       LEFT JOIN memory_effect_events previous ON previous.tenant_id = le.tenant_id AND previous.id = le.supersedes_effect_id
       LEFT JOIN memory_effect_attributions previous_attribution
         ON previous_attribution.tenant_id = previous.tenant_id
        AND previous_attribution.effect_event_id = previous.id
        AND previous_attribution.usage_item_id = ui.id
       LEFT JOIN memory_effect_attributions ea
         ON ea.tenant_id = ui.tenant_id AND ea.effect_event_id = le.id AND ea.usage_item_id = ui.id
       WHERE ui.created_at >= ? AND ui.created_at < ?
       GROUP BY ui.tenant_id, ui.source_type, ui.source_id, ue.project_id,
         ui.business_category_id_snapshot, ui.work_type_snapshot, ui.quality_category_snapshot`
    ).bind(day, day, now, now, start, end)
  ];
  if (typeof db.batch === "function") await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { day };
}

export async function rebuildMemoryImpactExecutionMetricsForDay(
  db: D1Database,
  day: string,
  now = Date.now()
) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("day must be YYYY-MM-DD");
  const end = start + 86_400_000;
  const statements = [
    db.prepare("DELETE FROM memory_impact_daily_metrics WHERE day = ?").bind(day),
    db.prepare(
      `INSERT INTO memory_impact_daily_metrics(
         day, tenant_id, project_id, eligible_runs, assessed_runs, failed_runs,
         memory_used_runs, avoided_runs, reporting_rate, memory_usage_rate,
         avoided_lookup_rate, source_search_count, web_search_count,
         past_context_count, none_count, created_at, updated_at
       )
       WITH runs AS (
         SELECT tenant_id, external_run_id, COALESCE(MAX(project_id), '') AS project_id,
           MAX(CASE WHEN event_type = 'eligible' THEN 1 ELSE 0 END) AS eligible,
           MAX(CASE WHEN event_type = 'assessed' THEN 1 ELSE 0 END) AS assessed,
           MAX(CASE WHEN event_type = 'failed' THEN 1 ELSE 0 END) AS failed,
           MAX(CASE WHEN event_type = 'assessed' AND memory_used = 1 THEN 1 ELSE 0 END) AS memory_used,
           MAX(CASE WHEN event_type = 'assessed' THEN avoided_lookup END) AS avoided_lookup
         FROM memory_impact_events
         WHERE occurred_at >= ? AND occurred_at < ?
         GROUP BY tenant_id, external_run_id
       ), grouped AS (
         SELECT tenant_id, project_id,
           SUM(eligible) AS eligible_runs,
           SUM(assessed) AS assessed_runs,
           SUM(failed) AS failed_runs,
           SUM(CASE WHEN assessed = 1 AND memory_used = 1 THEN 1 ELSE 0 END) AS memory_used_runs,
           SUM(CASE WHEN assessed = 1 AND memory_used = 1 AND avoided_lookup != 'none' THEN 1 ELSE 0 END) AS avoided_runs,
           SUM(CASE WHEN assessed = 1 AND avoided_lookup = 'source_search' THEN 1 ELSE 0 END) AS source_search_count,
           SUM(CASE WHEN assessed = 1 AND avoided_lookup = 'web_search' THEN 1 ELSE 0 END) AS web_search_count,
           SUM(CASE WHEN assessed = 1 AND avoided_lookup = 'past_context' THEN 1 ELSE 0 END) AS past_context_count,
           SUM(CASE WHEN assessed = 1 AND avoided_lookup = 'none' THEN 1 ELSE 0 END) AS none_count
         FROM runs GROUP BY tenant_id, project_id
       )
       SELECT ?, tenant_id, project_id, eligible_runs, assessed_runs, failed_runs,
         memory_used_runs, avoided_runs,
         CASE WHEN eligible_runs > 0 THEN CAST(assessed_runs + failed_runs AS REAL) / eligible_runs ELSE NULL END,
         CASE WHEN assessed_runs > 0 THEN CAST(memory_used_runs AS REAL) / assessed_runs ELSE NULL END,
         CASE WHEN memory_used_runs > 0 THEN CAST(avoided_runs AS REAL) / memory_used_runs ELSE NULL END,
         source_search_count, web_search_count, past_context_count, none_count, ?, ?
       FROM grouped`
    ).bind(start, end, day, now, now)
  ];
  if (typeof db.batch === "function") await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { day };
}
