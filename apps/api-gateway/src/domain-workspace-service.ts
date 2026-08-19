import {
  domainPackWorkspaceSchema,
  type DomainPackWorkspaceV1,
  type MetricDefinitionV1
} from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import { listMetricSourceBindings, queryMetricSnapshots, type MetricSnapshotQueryRow } from "./domain-metric-service";
import { listDomainPacks } from "./domain-pack-service";
import type { Env } from "./types";

type Row = Record<string, unknown>;

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function confirmationState(value: unknown): "proposal" | "confirmed" | "retired" {
  return value === "confirmed" || value === "retired" ? value : "proposal";
}

function metricGroup(packId: string, metricKey: string) {
  if (packId === "function.pdm-b2c-marketplace") {
    if (["activation_rate", "time_to_first_value_p75", "search_success_rate", "zero_result_rate", "first_day_favorite_rate"].includes(metricKey)) return "activation";
    if (["dau_mau", "d1_retention", "d7_retention", "d30_retention", "repeat_purchase_rate"].includes(metricKey)) return "retention";
    if (["search_to_detail_rate", "detail_to_cart_rate", "cart_to_purchase_rate", "purchase_conversion", "refund_rate"].includes(metricKey)) return "purchase_funnel";
    if (["arpu", "contribution_ltv_90d", "ltv_cac", "contribution_margin_per_buyer", "coupon_dependency_rate"].includes(metricKey)) return "unit_economics";
    if (["category_coverage", "inventory_fulfillment_rate", "price_competitiveness", "delivery_promise_rate", "review_score"].includes(metricKey)) return "market_quality";
    return "custom";
  }
  if (packId === "function.build-engineering") return "delivery";
  if (packId === "function.sre") return "reliability";
  if (packId === "function.sales") return "pipeline";
  return "other";
}

const GROUP_LABELS: Record<string, string> = {
  activation: "Activation",
  retention: "Retention",
  purchase_funnel: "購買Funnel",
  unit_economics: "Unit Economics",
  market_quality: "マーケット品質",
  custom: "カスタム指標",
  delivery: "Delivery performance",
  reliability: "Service reliability",
  pipeline: "Revenue pipeline",
  other: "その他"
};

function workspaceSnapshot(row: Row | MetricSnapshotQueryRow | null, historical = false) {
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    value: typeof row.value === "number" ? row.value : null,
    state: row.state === "measured" || row.state === "stale" ? row.state : "unknown",
    observed_at: Number(row.observed_at ?? 0),
    expires_at: Number(row.expires_at ?? 0),
    evidence_ref: typeof row.evidence_ref === "string" ? row.evidence_ref : null,
    source_binding_id: typeof row.source_binding_id === "string" ? row.source_binding_id : null,
    historical
  } as const;
}

function currentSnapshot(row: Row | null, now: number) {
  const snapshot = workspaceSnapshot(row);
  if (!snapshot) return null;
  if (snapshot.state === "measured" && snapshot.expires_at < now) {
    return { ...snapshot, value: null, state: "stale" as const };
  }
  return snapshot;
}

function targetAchieved(direction: string, value: number, target: Row) {
  if (direction === "increase") return typeof target.target_value === "number" && value >= target.target_value;
  if (direction === "decrease") return typeof target.target_value === "number" && value <= target.target_value;
  if (direction === "range") return typeof target.target_min === "number" && typeof target.target_max === "number" && value >= target.target_min && value <= target.target_max;
  return typeof target.target_value === "number" && value === target.target_value;
}

function metricStatus(args: {
  current: ReturnType<typeof currentSnapshot>;
  baseline: ReturnType<typeof workspaceSnapshot>;
  target: Row | null;
  sourceState: string;
}) {
  if (!args.current) return args.sourceState === "unconfigured" ? "waiting" as const : "unknown" as const;
  if (args.current.state === "stale") return "stale" as const;
  if (args.current.state !== "measured" || args.current.value === null) return "unknown" as const;
  if (!args.target || typeof args.target.direction !== "string") return "approaching" as const;
  if (targetAchieved(args.target.direction, args.current.value, args.target)) return "achieved" as const;
  if (args.baseline?.value === null || args.baseline?.value === undefined) return "missed" as const;
  const improved = args.target.direction === "decrease"
    ? args.current.value < args.baseline.value
    : args.target.direction === "range"
      ? Math.abs(args.current.value - Number(args.target.target_min)) < Math.abs(args.baseline.value - Number(args.target.target_min))
      : args.current.value > args.baseline.value;
  return improved ? "approaching" as const : "missed" as const;
}

async function packMetricRows(env: Env, tenantId: string, packId: string, objectIds: string[]) {
  const customClause = objectIds.length
    ? `OR (d.origin_type = 'custom' AND EXISTS (
         SELECT 1 FROM metric_bindings b
         WHERE b.tenant_id = d.tenant_id AND b.metric_definition_id = d.id
           AND b.scope_id IN (${objectIds.map(() => "?").join(",")})
       ))`
    : "";
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.metric_key, d.origin_type, v.definition_json
     FROM metric_definitions d
     JOIN metric_definition_versions v
       ON v.metric_definition_id = d.id AND v.version = d.current_version
     WHERE d.tenant_id = ? AND (d.origin_pack_id = ? ${customClause})
     ORDER BY d.origin_type, d.metric_key`
  ).bind(tenantId, packId, ...objectIds).all<Row>();
  return result.results;
}

async function selectDecision(env: Env, tenantId: string, packId: string) {
  const candidate = await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.subject_type, a.subject_ref,
            MAX(CASE WHEN a.confirmation_state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
            MAX(CASE WHEN a.predicate = 'verified_by_metric' THEN 1 ELSE 0 END) AS verified,
            MAX(a.updated_at) AS updated_at
     FROM knowledge_assertions a
     WHERE a.tenant_id = ?
       AND a.subject_type IN ('decision_memory', 'decision_rationale')
       AND a.predicate IN ('about_object', 'triggered_by_metric', 'sets_metric_target', 'implemented_by_asset_run', 'verified_by_metric')
       AND (
         (a.object_type = 'managed_object' AND EXISTS (
           SELECT 1 FROM managed_objects o
           JOIN managed_object_types t ON t.id = o.object_type_id AND t.tenant_id = o.tenant_id
           WHERE o.tenant_id = a.tenant_id AND o.id = a.object_ref AND t.origin_pack_id = ?
         ))
         OR (a.object_type = 'metric_definition' AND EXISTS (
           SELECT 1 FROM metric_definitions d
           WHERE d.tenant_id = a.tenant_id AND d.id = a.object_ref AND d.origin_pack_id = ?
         ))
         OR (a.object_type = 'metric_snapshot' AND EXISTS (
           SELECT 1 FROM metric_snapshots s
           JOIN metric_definitions d ON d.id = s.metric_definition_id AND d.tenant_id = s.tenant_id
           WHERE s.tenant_id = a.tenant_id AND s.id = a.object_ref AND d.origin_pack_id = ?
         ))
       )
     GROUP BY a.subject_type, a.subject_ref
     ORDER BY verified DESC, confirmed DESC, updated_at DESC
     LIMIT 1`
  ).bind(tenantId, packId, packId, packId).first<Row>();
  if (!candidate || typeof candidate.subject_ref !== "string") return null;
  const assertions = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM knowledge_assertions
     WHERE tenant_id = ? AND subject_type = ? AND subject_ref = ? AND valid_until IS NULL
     ORDER BY updated_at DESC`
  ).bind(tenantId, candidate.subject_type, candidate.subject_ref).all<Row>();
  return { candidate, assertions: assertions.results };
}

async function decisionDetail(env: Env, tenantId: string, selected: Awaited<ReturnType<typeof selectDecision>>) {
  if (!selected) return null;
  const id = String(selected.candidate.subject_ref);
  const sourceType = selected.candidate.subject_type === "decision_rationale" ? "decision_rationale" : "decision_memory";
  const row = sourceType === "decision_memory"
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT decision AS statement, rationale, rejected_alternatives_json,
              constraints_json, source_refs_json, confirmation_state
       FROM decision_memories WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, id).first<Row>()
    : await env.OPEN_BRAIN_DB.prepare(
      `SELECT conclusion AS statement, reason_summary AS rationale,
              '[]' AS rejected_alternatives_json, '[]' AS constraints_json,
              '[]' AS source_refs_json, confirmation_state
       FROM decision_rationales WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, id).first<Row>();
  if (!row) return null;

  const rejected = jsonArray(row.rejected_alternatives_json).map((item) => {
    const value = item && typeof item === "object" ? item as Row : {};
    return {
      statement: String(value.statement ?? value.alternative ?? "代替案"),
      reason: String(value.reason ?? value.reasonRejected ?? value.reason_rejected ?? "")
    };
  });
  const resourceIds = selected.assertions
    .map((item) => typeof item.resource_id === "string" ? item.resource_id : null)
    .filter((item): item is string => Boolean(item));
  const resources = resourceIds.length
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, title, resource_kind, source_system, lifecycle_state, updated_at, canonical_uri
       FROM knowledge_resources WHERE tenant_id = ? AND id IN (${resourceIds.map(() => "?").join(",")})`
    ).bind(tenantId, ...resourceIds).all<Row>()
    : { results: [] as Row[] };
  const evidence: NonNullable<DomainPackWorkspaceV1["decision"]>["evidence"] = resources.results.map((item) => ({
    id: String(item.id),
    title: String(item.title),
    resource_kind: String(item.resource_kind),
    source_system: String(item.source_system),
    observed_at: typeof item.updated_at === "number" ? item.updated_at : null,
    verification_state: item.lifecycle_state === "stale" ? "stale" as const : "verified" as const,
    technical_ref: String(item.canonical_uri ?? item.id)
  }));
  const existingRefs = new Set(evidence.map((item) => item.technical_ref));
  for (const [index, item] of jsonArray(row.source_refs_json).entries()) {
    const value = item && typeof item === "object" ? item as Row : {};
    const ref = String(value.id ?? value.ref ?? value.uri ?? `source-${index + 1}`);
    if (existingRefs.has(ref)) continue;
    evidence.push({
      id: `source-${index + 1}`,
      title: String(value.title ?? ref),
      resource_kind: String(value.type ?? "other"),
      source_system: String(value.source ?? "decision-memory"),
      observed_at: typeof value.updatedAt === "number" ? value.updatedAt : null,
      verification_state: "unverified",
      technical_ref: ref
    });
  }
  const workflow = selected.assertions.find((item) => item.predicate === "implemented_by_asset_run");
  return {
    source_type: sourceType,
    id,
    statement: String(row.statement),
    rationale: String(row.rationale ?? ""),
    confirmation_state: confirmationState(row.confirmation_state ?? (selected.candidate.confirmed ? "confirmed" : "proposal")),
    rejected_alternatives: rejected,
    constraints: jsonArray(row.constraints_json).map(String),
    success_conditions: [],
    workflow: workflow && typeof workflow.object_ref === "string" ? workflow.object_ref : null,
    playbook: null,
    outcome_summary: null,
    followup_decision: null,
    evidence
  };
}

export async function getDomainPackWorkspace(env: Env, tenantId: string, packId: string, input: {
  scopeId?: string | null;
  from?: number;
  to?: number;
}): Promise<DomainPackWorkspaceV1> {
  if (!env.DOMAIN_WORKSPACES_MODE || env.DOMAIN_WORKSPACES_MODE === "off") {
    throw new HttpError(404, "domain_workspaces_disabled", "Domain Pack Workspaces are disabled");
  }
  const catalog = await listDomainPacks(env, tenantId);
  const entry = catalog.find((item) => item.manifest.pack_id === packId);
  if (!entry) throw new HttpError(404, "domain_pack_not_found", "Domain Pack not found");
  if (!entry.installation) throw new HttpError(404, "domain_pack_workspace_not_installed", "Install the Domain Pack before opening its Workspace");

  const typeKeys = entry.manifest.object_types.map((item) => item.key);
  const objectResult = typeKeys.length
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT o.id, o.name, t.type_key, t.label AS type_label
       FROM managed_objects o
       JOIN managed_object_types t ON t.id = o.object_type_id AND t.tenant_id = o.tenant_id
       WHERE o.tenant_id = ? AND t.type_key IN (${typeKeys.map(() => "?").join(",")})
       ORDER BY t.type_key, o.name`
    ).bind(tenantId, ...typeKeys).all<Row>()
    : { results: [] as Row[] };
  const objectIds = objectResult.results.map((item) => String(item.id));
  if (input.scopeId && !objectIds.includes(input.scopeId)) {
    throw new HttpError(404, "domain_workspace_scope_not_found", "managed object is outside this Pack Workspace");
  }

  const definitionRows = await packMetricRows(env, tenantId, packId, objectIds);
  const metricKeys = definitionRows.map((item) => String(item.metric_key));
  const [series, sources, selected] = await Promise.all([
    queryMetricSnapshots(env, tenantId, {
      metricKeys,
      scopeId: input.scopeId ?? null,
      from: input.from,
      to: input.to,
      limit: 2_000
    }),
    listMetricSourceBindings(env, tenantId, {}),
    selectDecision(env, tenantId, packId)
  ]);
  const decision = await decisionDetail(env, tenantId, selected);
  const decisionAssertions = selected?.assertions ?? [];
  const snapshotById = new Map(series.map((item) => [String(item.id), item]));
  const baselineIds = new Set(decisionAssertions.filter((item) => item.predicate === "triggered_by_metric").map((item) => String(item.object_ref)));
  const outcomeIds = new Set(decisionAssertions.filter((item) => item.predicate === "verified_by_metric").map((item) => String(item.object_ref)));
  const sourceByDefinition = new Map(sources.map((item) => [String(item.metric_definition_id), item]));
  const targets = metricKeys.length
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT t.*, d.metric_key FROM metric_targets t
       JOIN metric_definitions d ON d.id = t.metric_definition_id AND d.tenant_id = t.tenant_id
       WHERE t.tenant_id = ? AND d.metric_key IN (${metricKeys.map(() => "?").join(",")})
       ORDER BY t.effective_from DESC, t.created_at DESC`
    ).bind(tenantId, ...metricKeys).all<Row>()
    : { results: [] as Row[] };

  const now = Date.now();
  const metrics = definitionRows.map((row) => {
    const definition = JSON.parse(String(row.definition_json)) as MetricDefinitionV1;
    const metricSeries = series.filter((item) => item.metric_key === row.metric_key);
    const currentRaw = metricSeries.at(-1) ?? null;
    const baselineRaw = metricSeries.find((item) => baselineIds.has(String(item.id))) ?? null;
    const outcomeRaw = [...metricSeries].reverse().find((item) => outcomeIds.has(String(item.id))) ?? null;
    const current = currentSnapshot(currentRaw, now);
    const baseline = workspaceSnapshot(baselineRaw, true);
    const outcome = workspaceSnapshot(outcomeRaw, true);
    const sourceBinding = sourceByDefinition.get(String(row.id));
    const sourceState = String(sourceBinding?.status ?? (definition.source_type === "connector" ? "unconfigured" : current ? "active" : "configured"));
    const targetAt = current?.observed_at ?? now;
    const target = targets.results.find((item) =>
      item.metric_key === row.metric_key
      && Number(item.effective_from) <= targetAt
      && (item.effective_to === null || item.effective_to === undefined || Number(item.effective_to) >= targetAt)
    ) ?? null;
    return {
      metric_key: String(row.metric_key),
      label: definition.label,
      description: definition.description,
      group: metricGroup(packId, String(row.metric_key)),
      origin_type: row.origin_type === "custom" ? "custom" as const : "pack" as const,
      unit: definition.unit,
      aggregation_window: definition.aggregation_window,
      baseline,
      current,
      outcome,
      delta: current?.value !== null && current?.value !== undefined && baseline?.value !== null && baseline?.value !== undefined
        ? current.value - baseline.value
        : null,
      target: target ? {
        direction: target.direction as "increase" | "decrease" | "range" | "maintain",
        value: typeof target.target_value === "number" ? target.target_value : null,
        min: typeof target.target_min === "number" ? target.target_min : null,
        max: typeof target.target_max === "number" ? target.target_max : null,
        reason: typeof target.reason === "string" ? target.reason : null
      } : null,
      status: metricStatus({ current, baseline, target, sourceState }),
      source: {
        adapter_id: sourceBinding && typeof sourceBinding.adapter_id === "string" ? sourceBinding.adapter_id : definition.connector?.adapter_id ?? null,
        query_template: sourceBinding && typeof sourceBinding.query_template === "string" ? sourceBinding.query_template : definition.connector?.query_template ?? null,
        state: sourceState as "unconfigured" | "configured" | "active" | "error" | "paused",
        last_success_at: sourceBinding && typeof sourceBinding.last_success_at === "number" ? sourceBinding.last_success_at : null,
        last_error_code: sourceBinding && typeof sourceBinding.last_error_code === "string" ? sourceBinding.last_error_code : null
      },
      series: metricSeries.slice(-500).map((item) => workspaceSnapshot(item, true)!).filter(Boolean)
    };
  });
  const grouped = new Map<string, typeof metrics>();
  for (const metric of metrics) grouped.set(metric.group, [...(grouped.get(metric.group) ?? []), metric]);
  const workspace = {
    contract_version: "domain-pack/v1" as const,
    generated_at: now,
    pack: {
      pack_id: entry.manifest.pack_id,
      title: entry.manifest.title,
      version: entry.manifest.version,
      description: entry.manifest.description
    },
    installation: {
      id: String(entry.installation.id),
      state: "installed" as const,
      installed_at: Number((entry.installation as unknown as Row).installed_at ?? 0)
    },
    managed_objects: objectResult.results.map((item) => ({
      id: String(item.id),
      type_key: String(item.type_key),
      type_label: String(item.type_label),
      name: String(item.name)
    })),
    selected_scope_id: input.scopeId ?? null,
    metric_groups: [...grouped.entries()].map(([key, items]) => ({ key, label: GROUP_LABELS[key] ?? key, metrics: items })),
    decision,
    source_readiness: sources
      .filter((item) => definitionRows.some((row) => row.id === item.metric_definition_id))
      .map((item) => ({
        contract_version: "metric/v1" as const,
        id: String(item.id),
        tenant_id: String(item.tenant_id),
        metric_definition_id: String(item.metric_definition_id),
        metric_key: typeof item.metric_key === "string" ? item.metric_key : undefined,
        metric_binding_id: typeof item.metric_binding_id === "string" ? item.metric_binding_id : null,
        adapter_id: String(item.adapter_id),
        query_template: String(item.query_template),
        connection_ref: typeof item.connection_ref === "string" ? item.connection_ref : null,
        external_scope_ref: typeof item.external_scope_ref === "string" ? item.external_scope_ref : null,
        status: item.status as "unconfigured" | "configured" | "active" | "error" | "paused",
        last_attempt_at: typeof item.last_attempt_at === "number" ? item.last_attempt_at : null,
        last_success_at: typeof item.last_success_at === "number" ? item.last_success_at : null,
        last_error_code: typeof item.last_error_code === "string" ? item.last_error_code : null,
        created_at: Number(item.created_at),
        updated_at: Number(item.updated_at)
      }))
  };
  return domainPackWorkspaceSchema.parse(workspace);
}
