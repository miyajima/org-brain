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
