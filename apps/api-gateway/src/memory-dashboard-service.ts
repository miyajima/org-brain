import type { Env } from "./types";

export type MemoryAnalyticsOptions = {
  tenantId: string;
  principal: string;
  scope: "mine" | "org";
  perspective: "work" | "spread";
  projectId?: string | null;
  ownerPrincipal?: string | null;
  consumerPrincipal?: string | null;
  canViewConsumerDetails?: boolean;
  from: number;
  to: number;
};

export type MemoryMapOptions = {
  tenantId: string;
  principal: string;
  scope: "mine" | "org";
  display?: "top" | "cluster" | "all";
  projectId?: string | null;
  ownerPrincipal?: string | null;
  q?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
};

type UsageQuery = {
  cte: string;
  bindings: unknown[];
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function numeric(value: unknown): number {
  return Number(value ?? 0);
}

function memoryFilter(
  options: Pick<MemoryAnalyticsOptions, "tenantId" | "scope" | "perspective" | "principal" | "projectId" | "ownerPrincipal"> & { alias?: string }
) {
  const alias = options.alias ?? "m";
  const clauses = [`${alias}.tenant_id = ?`, `${alias}.deleted_at IS NULL`, `(${alias}.lifecycle_state IS NULL OR ${alias}.lifecycle_state != 'suppressed')`];
  const bindings: unknown[] = [options.tenantId];
  if (options.projectId) {
    clauses.push(`${alias}.project_id = ?`);
    bindings.push(options.projectId);
  }
  if (options.ownerPrincipal) {
    clauses.push(`${alias}.owner_principal = ?`);
    bindings.push(options.ownerPrincipal);
  } else if (options.scope === "mine" && options.perspective === "spread") {
    clauses.push(`${alias}.owner_principal = ?`);
    bindings.push(options.principal);
  }
  return { sql: clauses.join(" AND "), bindings };
}

function usageQuery(options: MemoryAnalyticsOptions): UsageQuery {
  const memory = memoryFilter(options);
  const usageClauses = [
    memory.sql,
    "ui.tenant_id = ?",
    "ue.created_at >= ?",
    "ue.created_at <= ?"
  ];
  const bindings: unknown[] = [
    ...memory.bindings,
    options.tenantId,
    options.from,
    options.to
  ];
  if (options.scope === "mine" && options.perspective === "work") {
    usageClauses.push("ue.actor_principal = ?");
    bindings.push(options.principal);
  }
  if (options.consumerPrincipal) {
    usageClauses.push("ue.actor_principal = ?");
    bindings.push(options.consumerPrincipal);
  }
  return {
    cte: `WITH latest_effect AS (
       SELECT e.* FROM memory_effect_events e
       WHERE e.tenant_id = ? AND NOT EXISTS (
         SELECT 1 FROM memory_effect_events child
         WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
       )
     ), usage AS (
       SELECT ui.id AS usage_item_id,
              ui.usage_event_id,
              ui.source_id AS memory_id,
              ui.used_state,
              ue.actor_principal,
              ue.project_id,
              ue.created_at,
              ue.verification_sampled,
              m.owner_principal,
              m.created_by_principal,
              m.summary,
              m.content,
              CASE WHEN ea.usage_item_id IS NOT NULL
                   THEN COALESCE(ea.net_saved_tokens, 0)
                   ELSE 0 END AS net_saved_tokens,
              CASE WHEN ea.usage_item_id IS NOT NULL
                   THEN COALESCE(ea.gross_saved_tokens - ea.net_saved_tokens, 0)
                   ELSE COALESCE(ui.injected_token_estimate, 0) END AS injected_tokens,
              CASE WHEN ea.usage_item_id IS NOT NULL THEN le.effect_outcome ELSE NULL END AS effect_outcome,
              CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE NULL END AS evidence_level
       FROM memory_usage_items ui
       JOIN memory_usage_events ue
         ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
       JOIN memories m
         ON m.tenant_id = ui.tenant_id AND m.id = ui.source_id
       LEFT JOIN latest_effect le
         ON le.tenant_id = ui.tenant_id AND le.usage_event_id = ui.usage_event_id
       LEFT JOIN memory_effect_attributions ea
         ON ea.tenant_id = ui.tenant_id AND ea.effect_event_id = le.id AND ea.usage_item_id = ui.id
       WHERE ui.source_type = 'memory' AND ${usageClauses.join(" AND ")}
     )`,
    bindings: [options.tenantId, ...bindings]
  };
}

function measurementState(row: Record<string, unknown>): "verified" | "estimated" | "unmeasured" {
  if (numeric(row.verified_count) > 0) return "verified";
  if (numeric(row.effect_reported_count) > 0) return "estimated";
  return "unmeasured";
}

type SerializedMetricRow = Record<string, unknown> & {
  reference_count: number;
  used_count: number;
  consumer_count: number;
  net_saved_tokens: number;
  injected_tokens: number;
  utilization_rate: number | null;
  positive_effect_rate: number | null;
  negative_effect_rate: number | null;
  token_efficiency: number | null;
  measurement_state: "verified" | "estimated" | "unmeasured";
};

function serializeMetricRow(row: Record<string, unknown>): SerializedMetricRow {
  const referenceCount = numeric(row.reference_count);
  const usedCount = numeric(row.used_count);
  const effectReportedCount = numeric(row.effect_reported_count);
  const positiveCount = numeric(row.positive_count);
  const negativeCount = numeric(row.negative_count);
  const injectedTokens = numeric(row.injected_tokens);
  const netSavedTokens = numeric(row.net_saved_tokens);
  return {
    ...row,
    reference_count: referenceCount,
    used_count: usedCount,
    consumer_count: numeric(row.consumer_count),
    net_saved_tokens: netSavedTokens,
    injected_tokens: injectedTokens,
    utilization_rate: ratio(usedCount, referenceCount),
    positive_effect_rate: ratio(positiveCount, effectReportedCount),
    negative_effect_rate: ratio(negativeCount, effectReportedCount),
    token_efficiency: ratio(netSavedTokens, injectedTokens),
    measurement_state: measurementState(row)
  } as SerializedMetricRow;
}

async function runMetricQuery(env: Env, source: UsageQuery, select: string, groupBy = "") {
  const query = await env.OPEN_BRAIN_DB.prepare(`${source.cte} SELECT ${select} FROM usage ${groupBy}`)
    .bind(...source.bindings)
    .all<Record<string, unknown>>();
  return query.results.map(serializeMetricRow);
}

async function runImpactRunSummary(env: Env, options: MemoryAnalyticsOptions) {
  const clauses = [
    "tenant_id = ?",
    "occurred_at >= ?",
    "occurred_at <= ?"
  ];
  const bindings: unknown[] = [options.tenantId, options.from, options.to];
  if (options.projectId) {
    clauses.push("project_id = ?");
    bindings.push(options.projectId);
  }
  if (options.scope === "mine" && options.perspective === "work") {
    clauses.push("reporter_principal = ?");
    bindings.push(options.principal);
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COUNT(DISTINCT external_run_id) AS evaluated_runs,
            COUNT(DISTINCT CASE WHEN event_type = 'assessed' AND memory_used = 1 THEN external_run_id END) AS memory_used_runs,
            COUNT(DISTINCT CASE WHEN event_type IN ('assessed', 'failed') THEN external_run_id END) AS terminal_runs,
            COUNT(DISTINCT CASE WHEN event_type = 'failed' THEN external_run_id END) AS failed_runs
     FROM memory_impact_events
     WHERE ${clauses.join(" AND ")}`
  ).bind(...bindings).first<Record<string, unknown>>();
  return {
    evaluated_runs: numeric(row?.evaluated_runs),
    memory_used_runs: numeric(row?.memory_used_runs),
    terminal_runs: numeric(row?.terminal_runs),
    failed_runs: numeric(row?.failed_runs)
  };
}

async function activeMemoryStats(env: Env, options: MemoryAnalyticsOptions) {
  const filter = memoryFilter(options);
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COUNT(*) AS memory_count,
            COUNT(CASE WHEN owner_principal IS NULL OR owner_principal = '' THEN 1 END) AS unassigned_count
     FROM memories m
     WHERE ${filter.sql}`
  ).bind(...filter.bindings).first<Record<string, unknown>>();
  const unused = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COUNT(*) AS unused_count
     FROM memories m
     WHERE ${filter.sql}
       AND NOT EXISTS (
         SELECT 1 FROM memory_usage_items ui
         WHERE ui.tenant_id = m.tenant_id AND ui.source_type = 'memory' AND ui.source_id = m.id
       )`
  ).bind(...filter.bindings).first<Record<string, unknown>>();
  return {
    memory_count: numeric(row?.memory_count),
    unassigned_count: numeric(row?.unassigned_count),
    unused_count: numeric(unused?.unused_count)
  };
}

function diagnostic(
  id: string,
  severity: "info" | "warning" | "critical",
  title: string,
  reason: string,
  recommendation: string,
  measurementState: "verified" | "estimated" | "unmeasured"
) {
  return { id, severity, title, reason, recommendation, measurement_state: measurementState };
}

export async function getMemoryAnalytics(env: Env, options: MemoryAnalyticsOptions) {
  const source = usageQuery(options);
  const summaryRows = await runMetricQuery(
    env,
    source,
    `COUNT(DISTINCT usage_event_id) AS reference_count,
     COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
     COUNT(DISTINCT actor_principal) AS consumer_count,
     COUNT(DISTINCT CASE WHEN actor_principal != owner_principal AND actor_principal IS NOT NULL AND owner_principal IS NOT NULL THEN usage_event_id END) AS org_reuse_count,
     COUNT(DISTINCT CASE WHEN effect_outcome IS NOT NULL THEN usage_event_id END) AS effect_reported_count,
     COUNT(DISTINCT CASE WHEN effect_outcome = 'positive' THEN usage_event_id END) AS positive_count,
     COUNT(DISTINCT CASE WHEN effect_outcome = 'negative' THEN usage_event_id END) AS negative_count,
     COUNT(DISTINCT CASE WHEN verification_sampled = 1 THEN usage_event_id END) AS verification_sampled_count,
     COUNT(DISTINCT CASE WHEN verification_sampled = 1 AND evidence_level = 'verified' THEN usage_event_id END) AS verified_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens`
  );
  const summary = summaryRows[0] ?? serializeMetricRow({});
  const runs = await runImpactRunSummary(env, options);
  const memories = await activeMemoryStats(env, options);
  const evaluatedRuns = runs.evaluated_runs;
  const ownerUnknownRate = ratio(memories.unassigned_count, memories.memory_count);
  const unusedMemoryRate = ratio(memories.unused_count, memories.memory_count);
  const diagnostics = [];
  const coverage = ratio(runs.terminal_runs, evaluatedRuns);
  if (coverage !== null && coverage < 0.8) {
    diagnostics.push(diagnostic("measurement-coverage", "warning", "計測カバレッジが低い", `終端レポート済みは${Math.round(coverage * 100)}%です。`, "対象実行の終端レポートを記録する", "estimated"));
  }
  if (summary.utilization_rate !== null && summary.utilization_rate < 0.3) {
    diagnostics.push(diagnostic("memory-utilization", "warning", "有効利用率が低い", `参照された${summary.reference_count}件のうち、usedは${summary.used_count}件です。`, "検索結果の注入条件とメモリの粒度を見直す", summary.measurement_state));
  }
  if (unusedMemoryRate !== null && unusedMemoryRate > 0.4) {
    diagnostics.push(diagnostic("unused-memory", "warning", "未参照メモリが多い", `有効メモリの${Math.round(unusedMemoryRate * 100)}%に参照記録がありません。`, "要確認タブで棚卸しし、不要なものをゴミ箱へ移す", "estimated"));
  }
  if (summary.negative_effect_rate !== null && summary.negative_effect_rate > 0.1) {
    diagnostics.push(diagnostic("negative-effect", "critical", "ネガティブ効果が高い", `効果報告の${Math.round(summary.negative_effect_rate * 100)}%がnegativeです。`, "該当メモリの本文・条件・有効期限を確認する", summary.measurement_state));
  }
  if (summary.injected_tokens > 0 && summary.net_saved_tokens <= 0) {
    diagnostics.push(diagnostic("token-regression", "critical", "注入トークンが削減につながっていない", `${summary.injected_tokens.toLocaleString()} tokensを注入しましたが、純削減は${summary.net_saved_tokens.toLocaleString()}です。`, "ハーネスの注入上限と検索対象を見直す", summary.measurement_state));
  }
  if (ownerUnknownRate !== null && ownerUnknownRate > 0.05) {
    diagnostics.push(diagnostic("unassigned-owner", "warning", "所有者未割り当てが残っている", `有効メモリの${Math.round(ownerUnknownRate * 100)}%が未割り当てです。`, "管理者がproducer-owner対応または一括割当を行う", "estimated"));
  }

  const trend = await runMetricQuery(
    env,
    source,
    `date(created_at / 1000, 'unixepoch') AS day,
     COUNT(DISTINCT usage_event_id) AS reference_count,
     COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
     COUNT(DISTINCT actor_principal) AS consumer_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens`,
    "GROUP BY day ORDER BY day"
  );
  const memoryRanking = await runMetricQuery(
    env,
    source,
    `memory_id AS id,
     COALESCE(NULLIF(summary, ''), substr(content, 1, 96)) AS label,
     MAX(project_id) AS project_id,
     MAX(owner_principal) AS owner_principal,
     COUNT(DISTINCT usage_event_id) AS reference_count,
     COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
     COUNT(DISTINCT actor_principal) AS consumer_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens,
     COUNT(DISTINCT CASE WHEN effect_outcome IS NOT NULL THEN usage_event_id END) AS effect_reported_count`,
    "GROUP BY memory_id ORDER BY reference_count DESC, net_saved_tokens DESC LIMIT 12"
  );
  const ownerRanking = await runMetricQuery(
    env,
    source,
    `COALESCE(owner_principal, 'unassigned') AS id,
     COALESCE(owner_principal, '未割り当て') AS label,
     COUNT(DISTINCT memory_id) AS memory_count,
     COUNT(DISTINCT usage_event_id) AS reference_count,
     COUNT(DISTINCT actor_principal) AS consumer_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens,
     COUNT(DISTINCT CASE WHEN effect_outcome IS NOT NULL THEN usage_event_id END) AS effect_reported_count`,
    "GROUP BY owner_principal ORDER BY reference_count DESC, net_saved_tokens DESC LIMIT 12"
  );
  const projectRanking = await runMetricQuery(
    env,
    source,
    `COALESCE(project_id, 'unassigned') AS id,
     COALESCE(project_id, 'プロジェクト未設定') AS label,
     COUNT(DISTINCT memory_id) AS memory_count,
     COUNT(DISTINCT usage_event_id) AS reference_count,
     COUNT(DISTINCT actor_principal) AS consumer_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens,
     COUNT(DISTINCT CASE WHEN effect_outcome IS NOT NULL THEN usage_event_id END) AS effect_reported_count`,
    "GROUP BY project_id ORDER BY reference_count DESC, net_saved_tokens DESC LIMIT 12"
  );
  const consumerRanking = await runMetricQuery(
    env,
    source,
    `actor_principal AS id,
     actor_principal AS label,
     COUNT(DISTINCT memory_id) AS memory_count,
     COUNT(DISTINCT usage_event_id) AS reference_count,
     COALESCE(SUM(net_saved_tokens), 0) AS net_saved_tokens,
     COALESCE(SUM(injected_tokens), 0) AS injected_tokens,
     COUNT(DISTINCT CASE WHEN effect_outcome IS NOT NULL THEN usage_event_id END) AS effect_reported_count`,
    "WHERE actor_principal IS NOT NULL GROUP BY actor_principal ORDER BY reference_count DESC LIMIT 12"
  );
  const visibleConsumerRanking = options.canViewConsumerDetails
    ? consumerRanking
    : consumerRanking.map((row, index) => ({
        ...row,
        id: `anonymous-${index + 1}`,
        label: `匿名利用者 ${String(index + 1).padStart(2, "0")}`
      }));
  return {
    tenant_id: options.tenantId,
    scope: options.scope,
    perspective: options.perspective,
    period: { from: options.from, to: options.to },
    summary: {
      ...summary,
      evaluated_runs: evaluatedRuns,
      memory_used_runs: runs.memory_used_runs,
      failed_runs: runs.failed_runs,
      utilization_rate: ratio(runs.memory_used_runs, evaluatedRuns),
      effective_utilization_rate: summary.utilization_rate,
      org_reuse_rate: ratio(numeric(summary.org_reuse_count), summary.reference_count),
      token_efficiency: ratio(summary.net_saved_tokens, summary.injected_tokens),
      measurement_coverage: coverage,
      verification_coverage: ratio(numeric(summary.verified_count), numeric(summary.verification_sampled_count)),
      unused_memory_rate: unusedMemoryRate,
      unassigned_owner_rate: ownerUnknownRate,
      measurement_state: measurementState(summary)
    },
    trend,
    rankings: {
      memories: memoryRanking,
      owners: ownerRanking,
      projects: projectRanking,
      consumers: visibleConsumerRanking
    },
    diagnostics,
    definitions: {
      utilization_rate: "memory_used_runs / evaluated_runs",
      effective_utilization_rate: "used references / all references",
      org_reuse_rate: "references where owner and consumer differ / all references",
      token_efficiency: "net_saved_tokens / injected_tokens",
      measurement_coverage: "terminal reports / evaluated runs"
    }
  };
}

function mapMemoryFilter(options: MemoryMapOptions) {
  const clauses = [
    "m.tenant_id = ?",
    "m.deleted_at IS NULL",
    "(m.lifecycle_state IS NULL OR m.lifecycle_state != 'suppressed')"
  ];
  const bindings: unknown[] = [options.tenantId];
  if (options.scope === "mine") {
    clauses.push("m.owner_principal = ?");
    bindings.push(options.principal);
  } else if (options.ownerPrincipal) {
    clauses.push("m.owner_principal = ?");
    bindings.push(options.ownerPrincipal);
  }
  if (options.projectId) {
    clauses.push("m.project_id = ?");
    bindings.push(options.projectId);
  }
  if (options.q?.trim()) {
    clauses.push("(m.summary LIKE ? OR m.content LIKE ? OR m.id = ?)");
    const query = `%${options.q.trim().slice(0, 128)}%`;
    bindings.push(query, query, options.q.trim());
  }
  if (options.from !== undefined && options.from !== null) {
    clauses.push("COALESCE(m.updated_at, m.created_at) >= ?");
    bindings.push(options.from);
  }
  if (options.to !== undefined && options.to !== null) {
    clauses.push("COALESCE(m.updated_at, m.created_at) <= ?");
    bindings.push(options.to);
  }
  return { sql: clauses.join(" AND "), bindings };
}

export async function getMemoryMap(env: Env, options: MemoryMapOptions) {
  const filter = mapMemoryFilter(options);
  const countRow = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COUNT(*) AS total_count FROM memories m WHERE ${filter.sql}`
  ).bind(...filter.bindings).first<{ total_count: number }>();
  const totalCount = numeric(countRow?.total_count);
  const limit = Math.max(1, Math.min(1500, options.limit ?? 1500));
  if (options.display !== "top" && options.display !== "all" && totalCount > limit) {
    const clusters = await env.OPEN_BRAIN_DB.prepare(
      `SELECT COALESCE(m.project_id, 'unassigned') AS id,
              COALESCE(m.project_id, 'プロジェクト未設定') AS label,
              COUNT(*) AS count
       FROM memories m
       WHERE ${filter.sql}
       GROUP BY m.project_id
       ORDER BY count DESC`
    ).bind(...filter.bindings).all<Record<string, unknown>>();
    return {
      tenant_id: options.tenantId,
      scope: options.scope,
      cluster_mode: true,
      total_count: totalCount,
      visible_count: clusters.results.length,
      memory_visible_count: 0,
      project_count: clusters.results.length,
      entity_count: 0,
      decision_count: 0,
      related_count: 0,
      relationship_count: 0,
      cross_project_link_count: 0,
      truncated: false,
      nodes: [
        {
          id: `tenant:${options.tenantId}`,
          node_type: "tenant" as const,
          memory_id: null,
          decision_id: null,
          label: options.tenantId,
          summary: `${clusters.results.length} projects · ${totalCount} memories`,
          project_id: null,
          owner_principal: null,
          created_by_principal: null,
          reference_count: totalCount,
          consumer_count: 0,
          used_count: 0,
          utilization_rate: null,
          net_saved_tokens: 0,
          injected_tokens: 0,
          cluster_key: `tenant:${options.tenantId}`,
          member_count: clusters.results.length,
          fx: 0,
          fy: 0,
          fz: 0
        },
        ...clusters.results.map((row) => ({
        id: `cluster:project:${row.id}`,
        node_type: "project" as const,
        memory_id: null,
        decision_id: null,
        label: row.label,
        project_id: row.id === "unassigned" ? null : row.id,
        owner_principal: null,
        created_by_principal: null,
        reference_count: numeric(row.count),
        consumer_count: 0,
        used_count: 0,
        utilization_rate: null,
        net_saved_tokens: 0,
        injected_tokens: 0,
        cluster_key: `project:${row.id}`
        }))
      ],
      links: clusters.results.map((row) => ({
        id: `tenant_project:${options.tenantId}:${row.id}`,
        source: `tenant:${options.tenantId}`,
        target: `cluster:project:${row.id}`,
        relation: "tenant:contains",
        directed: true,
        inferred: true,
        weight: 2,
        confidence: null
      })),
      clusters: []
    };
  }
  const usageClauses = ["ui.tenant_id = ?", "ui.source_type = 'memory'"];
  const usageBindings: unknown[] = [options.tenantId];
  if (options.from !== undefined && options.from !== null) {
    usageClauses.push("ue.created_at >= ?");
    usageBindings.push(options.from);
  }
  if (options.to !== undefined && options.to !== null) {
    usageClauses.push("ue.created_at <= ?");
    usageBindings.push(options.to);
  }
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `WITH usage_stats AS (
       SELECT ui.source_id AS memory_id,
              COUNT(DISTINCT ue.id) AS reference_count,
              COUNT(DISTINCT CASE WHEN ui.used_state = 'used' THEN ue.id END) AS used_count,
              COUNT(DISTINCT ue.actor_principal) AS consumer_count,
              COALESCE(SUM(CASE WHEN ea.usage_item_id IS NOT NULL THEN ea.net_saved_tokens ELSE 0 END), 0) AS net_saved_tokens,
              COALESCE(SUM(CASE WHEN ea.usage_item_id IS NOT NULL THEN ea.gross_saved_tokens - ea.net_saved_tokens ELSE ui.injected_token_estimate END), 0) AS injected_tokens
       FROM memory_usage_items ui
       JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
       LEFT JOIN memory_effect_attributions ea ON ea.tenant_id = ui.tenant_id AND ea.usage_item_id = ui.id
       WHERE ${usageClauses.join(" AND ")}
       GROUP BY ui.source_id
     )
     SELECT m.id, m.project_id, m.content, m.summary, m.owner_principal,
            m.created_by_principal, COALESCE(m.updated_at, m.created_at) AS updated_at,
            COALESCE(s.reference_count, 0) AS reference_count,
            COALESCE(s.used_count, 0) AS used_count,
            COALESCE(s.consumer_count, 0) AS consumer_count,
            COALESCE(s.net_saved_tokens, 0) AS net_saved_tokens,
            COALESCE(s.injected_tokens, 0) AS injected_tokens
     FROM memories m
     LEFT JOIN usage_stats s ON s.memory_id = m.id
     WHERE ${filter.sql}
     ORDER BY reference_count DESC, updated_at DESC
     LIMIT ?`
  ).bind(...usageBindings, ...filter.bindings, limit).all<Record<string, unknown>>();
  const memoryNodes = rows.results.map((row) => {
    const references = numeric(row.reference_count);
    return {
      id: String(row.id),
      node_type: "memory" as const,
      memory_id: String(row.id),
      decision_id: null,
      label: String(row.summary ?? row.content ?? row.id).slice(0, 120),
      summary: row.summary ?? null,
      project_id: row.project_id ?? null,
      owner_principal: row.owner_principal ?? null,
      created_by_principal: row.created_by_principal ?? null,
      reference_count: references,
      consumer_count: numeric(row.consumer_count),
      used_count: numeric(row.used_count),
      utilization_rate: ratio(numeric(row.used_count), references),
      net_saved_tokens: numeric(row.net_saved_tokens),
      injected_tokens: numeric(row.injected_tokens),
      updated_at: numeric(row.updated_at),
      cluster_key: `project:${row.project_id ?? "unassigned"}`
    };
  });
  const nodeIds = new Set(memoryNodes.map((node) => node.id));
  const edgeRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, from_memory_id AS source, to_memory_id AS target, relation
     FROM memory_edges WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 3000`
  ).bind(options.tenantId).all<{ id: string; source: string; target: string; relation: string }>();
  type MemoryMapLink = {
    id: string;
    source: string;
    target: string;
    relation: string;
    directed: boolean;
    inferred: boolean;
    weight: number;
    confidence: number | null;
    cross_project?: boolean;
  };
  const projectByMemoryId = new Map<string, string>(
    memoryNodes.map((node) => [node.id, node.project_id ?? "unassigned"] as [string, string])
  );
  const links: MemoryMapLink[] = edgeRows.results
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      directed: true,
      inferred: false,
      weight: 1,
      confidence: null,
      cross_project: projectByMemoryId.get(edge.source) !== projectByMemoryId.get(edge.target)
    }));
  const decisionRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, memory_id, project_id, decision_type, conclusion,
            reason_summary, confirmation_state, confidence_score,
            created_at
     FROM decision_rationales
     WHERE tenant_id = ?
       AND memory_id IN (SELECT value FROM json_each(?))
     ORDER BY created_at DESC, id DESC
     LIMIT 20`
  ).bind(options.tenantId, JSON.stringify([...nodeIds])).all<{
    id: string;
    memory_id: string;
    project_id: string | null;
    decision_type: string;
    conclusion: string;
    reason_summary: string | null;
    confirmation_state: string | null;
    confidence_score: number | null;
    created_at: number;
  }>();
  const decisionNodes = decisionRows.results
    .filter((row) => nodeIds.has(row.memory_id))
    .map((row) => ({
      id: `decision:${row.id}`,
      node_type: "decision" as const,
      memory_id: null,
      decision_id: row.id,
      related_memory_id: row.memory_id,
      label: `${row.decision_type}: ${row.conclusion}`.slice(0, 120),
      summary: row.reason_summary ?? row.conclusion,
      project_id: row.project_id ?? memoryNodes.find((node) => node.id === row.memory_id)?.project_id ?? null,
      owner_principal: null,
      created_by_principal: null,
      reference_count: 0,
      consumer_count: 0,
      used_count: 0,
      utilization_rate: null,
      net_saved_tokens: 0,
      injected_tokens: 0,
      updated_at: numeric(row.created_at),
      cluster_key: `project:${row.project_id ?? memoryNodes.find((node) => node.id === row.memory_id)?.project_id ?? "unassigned"}`,
      decision_type: row.decision_type,
      confirmation_state: row.confirmation_state,
      confidence_score: row.confidence_score
    }));
  for (const row of decisionRows.results.slice(0, decisionNodes.length)) {
    if (!nodeIds.has(row.memory_id)) continue;
    links.push({
      id: `decision_rationale:${row.id}`,
      source: row.memory_id,
      target: `decision:${row.id}`,
      relation: `decision:${row.decision_type}`,
      directed: true,
      inferred: row.confirmation_state !== "user_confirmed" && row.confirmation_state !== "confirmed",
      weight: numeric(row.confidence_score) || 1,
      confidence: row.confidence_score === null ? null : numeric(row.confidence_score)
    });
  }
  const projectMembers = new Map<string, number>();
  for (const node of [...memoryNodes, ...decisionNodes]) {
    const projectKey = typeof node.project_id === "string" && node.project_id ? node.project_id : "unassigned";
    projectMembers.set(projectKey, (projectMembers.get(projectKey) ?? 0) + 1);
  }
  const projectNodes = [...projectMembers.entries()].map(([projectId, memberCount]) => ({
    id: `project:${projectId}`,
    node_type: "project" as const,
    memory_id: null,
    decision_id: null,
    label: projectId === "unassigned" ? "プロジェクト未設定" : projectId,
    summary: `${memberCount} visible memories or decisions`,
    project_id: projectId === "unassigned" ? null : projectId,
    owner_principal: null,
    created_by_principal: null,
    reference_count: memberCount,
    consumer_count: 0,
    used_count: 0,
    utilization_rate: null,
    net_saved_tokens: 0,
    injected_tokens: 0,
    updated_at: null,
    cluster_key: `project:${projectId}`,
    member_count: memberCount
  }));
  const tenantNode = {
    id: `tenant:${options.tenantId}`,
    node_type: "tenant" as const,
    memory_id: null,
    decision_id: null,
    label: options.tenantId,
    summary: `${projectNodes.length} projects · ${memoryNodes.length} memories · ${decisionNodes.length} decisions`,
    project_id: null,
    owner_principal: null,
    created_by_principal: null,
    reference_count: totalCount,
    consumer_count: 0,
    used_count: 0,
    utilization_rate: null,
    net_saved_tokens: 0,
    injected_tokens: 0,
    updated_at: null,
    cluster_key: `tenant:${options.tenantId}`,
    member_count: projectNodes.length,
    fx: 0,
    fy: 0,
    fz: 0
  };
  for (const projectNode of projectNodes) {
    links.push({
      id: `tenant_project:${options.tenantId}:${projectNode.project_id ?? "unassigned"}`,
      source: tenantNode.id,
      target: projectNode.id,
      relation: "tenant:contains",
      directed: true,
      inferred: true,
      weight: 2,
      confidence: null
    });
  }
  for (const node of [...memoryNodes, ...decisionNodes]) {
    const projectId = typeof node.project_id === "string" && node.project_id ? node.project_id : "unassigned";
    links.push({
      id: `project_membership:${projectId}:${node.id}`,
      source: `project:${projectId}`,
      target: node.id,
      relation: "project:contains",
      directed: true,
      inferred: true,
      weight: 1,
      confidence: null
    });
  }
  const entityRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT me.id AS link_id, me.memory_id, me.entity_id, me.role,
            me.confidence_score, me.created_at,
            e.entity_type, e.canonical_name
     FROM memory_entities me
     JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
     WHERE me.tenant_id = ?
       AND me.memory_id IN (SELECT value FROM json_each(?))
     ORDER BY COALESCE(me.confidence_score, 0) DESC, me.created_at DESC, me.id DESC
     LIMIT 800`
  ).bind(options.tenantId, JSON.stringify([...nodeIds])).all<{
    link_id: string;
    memory_id: string;
    entity_id: string;
    role: string;
    confidence_score: number | null;
    created_at: number;
    entity_type: string;
    canonical_name: string;
  }>();
  const ignoredEntityNames = new Set([
    "recordedat", "project", "event", "source", "memory", "reusable",
    "takeaway", "evidence", "users", "redacted_phone"
  ]);
  const graphEntityRows = entityRows.results.filter((row) => {
    const label = row.canonical_name.trim();
    const normalized = label.toLowerCase();
    return Boolean(label) && !ignoredEntityNames.has(normalized) && !/^t\d{2}$/i.test(label) && !normalized.includes("redacted");
  });
  const entityMemoryCounts = new Map<string, Set<string>>();
  for (const row of graphEntityRows) {
    const memorySet = entityMemoryCounts.get(row.entity_id) ?? new Set<string>();
    memorySet.add(row.memory_id);
    entityMemoryCounts.set(row.entity_id, memorySet);
  }
  const sharedEntityIds = new Set(
    [...entityMemoryCounts.entries()]
      .filter(([, memories]) => memories.size >= 2)
      .map(([entityId]) => entityId)
  );
  const sharedEntityRows = graphEntityRows.filter((row) => sharedEntityIds.has(row.entity_id));
  const entityProjectIds = new Map<string, Set<string>>();
  for (const row of sharedEntityRows) {
    const projects = entityProjectIds.get(row.entity_id) ?? new Set<string>();
    projects.add(projectByMemoryId.get(row.memory_id) ?? "unassigned");
    entityProjectIds.set(row.entity_id, projects);
  }
  const crossProjectEntityIds = new Set(
    [...entityProjectIds.entries()]
      .filter(([, projects]) => projects.size > 1)
      .map(([entityId]) => entityId)
  );
  const entityNodes = [...sharedEntityIds].map((entityId) => {
    const row = sharedEntityRows.find((candidate) => candidate.entity_id === entityId);
    const memberCount = entityMemoryCounts.get(entityId)?.size ?? 0;
    return {
      id: `entity:${entityId}`,
      node_type: "entity" as const,
      memory_id: null,
      decision_id: null,
      label: row?.canonical_name || entityId,
      summary: `${row?.entity_type || "concept"} · shared by ${memberCount} visible memories`,
      project_id: null,
      owner_principal: null,
      created_by_principal: null,
      reference_count: memberCount,
      consumer_count: 0,
      used_count: 0,
      utilization_rate: null,
      net_saved_tokens: 0,
      injected_tokens: 0,
      updated_at: numeric(row?.created_at),
      cluster_key: "entity:shared",
      entity_id: entityId,
      entity_type: row?.entity_type || "concept",
      entity_link_count: sharedEntityRows.filter((candidate) => candidate.entity_id === entityId).length,
      cross_project_link_count: crossProjectEntityIds.has(entityId)
        ? sharedEntityRows.filter((candidate) => candidate.entity_id === entityId).length
        : 0
    };
  });
  for (const row of sharedEntityRows) {
    links.push({
      id: `memory_entity:${row.link_id}`,
      source: row.memory_id,
      target: `entity:${row.entity_id}`,
      relation: `${crossProjectEntityIds.has(row.entity_id) ? "entity-cross" : "entity"}:${row.role}`,
      directed: true,
      inferred: false,
      weight: numeric(row.confidence_score) || 1,
      confidence: row.confidence_score === null ? null : numeric(row.confidence_score),
      cross_project: crossProjectEntityIds.has(row.entity_id)
    });
  }
  for (const entityId of sharedEntityIds) {
    const rowsForEntity = sharedEntityRows.filter((row) => row.entity_id === entityId);
    const memoryIds = [...new Set(rowsForEntity.map((row) => row.memory_id))];
    const label = rowsForEntity[0]?.canonical_name || entityId;
    let pairCount = 0;
    for (let left = 0; left < memoryIds.length && pairCount < 180; left += 1) {
      for (let right = left + 1; right < memoryIds.length && pairCount < 180; right += 1) {
        links.push({
          id: `shared_entity:${entityId}:${memoryIds[left]}:${memoryIds[right]}`,
          source: memoryIds[left],
          target: memoryIds[right],
          relation: `${projectByMemoryId.get(memoryIds[left]) !== projectByMemoryId.get(memoryIds[right]) ? "shared-cross" : "shared"}:${label}`,
          directed: false,
          inferred: true,
          weight: 0.65,
          confidence: null,
          cross_project: projectByMemoryId.get(memoryIds[left]) !== projectByMemoryId.get(memoryIds[right])
        });
        pairCount += 1;
      }
    }
  }
  const nodes = [tenantNode, ...projectNodes, ...memoryNodes, ...decisionNodes, ...entityNodes];
  const relationshipCount = links.length;
  const crossProjectLinkCount = links.filter((link) => link.cross_project).length;
  const clusterMap = new Map<string, { id: string; kind: "project" | "owner" | "utilization"; label: string; node_ids: string[] }>();
  for (const node of nodes) {
    if (node.node_type === "tenant") continue;
    const projectKey = `project:${node.project_id ?? "unassigned"}`;
    const ownerKey = `owner:${node.owner_principal ?? "unassigned"}`;
    const utilizationKey = node.utilization_rate === null
      ? "utilization:unmeasured"
      : node.utilization_rate >= 0.7 ? "utilization:high" : node.utilization_rate >= 0.3 ? "utilization:medium" : "utilization:low";
    for (const [key, kind, label] of [
      [projectKey, "project", node.project_id ?? "プロジェクト未設定"],
      [ownerKey, "owner", node.owner_principal ?? "所有者未設定"],
      [utilizationKey, "utilization", utilizationKey.replace("utilization:", "")]
    ] as Array<[string, "project" | "owner" | "utilization", string]>) {
      const cluster = clusterMap.get(key) ?? { id: key, kind, label, node_ids: [] };
      cluster.node_ids.push(node.id);
      clusterMap.set(key, cluster);
    }
  }
  return {
    tenant_id: options.tenantId,
    scope: options.scope,
    cluster_mode: false,
    total_count: totalCount,
    visible_count: nodes.length,
    memory_visible_count: memoryNodes.length,
    project_count: projectNodes.length,
    entity_count: entityNodes.length,
    decision_count: decisionNodes.length,
    related_count: projectNodes.length + entityNodes.length + decisionNodes.length,
    relationship_count: relationshipCount,
    cross_project_link_count: crossProjectLinkCount,
    truncated: totalCount > memoryNodes.length,
    nodes,
    links,
    clusters: [...clusterMap.values()]
  };
}
