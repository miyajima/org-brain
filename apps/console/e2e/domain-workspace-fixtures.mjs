import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const packs = ["build-engineering", "sre", "sales", "pdm-b2c"].map((folder) => ({
  manifest: JSON.parse(fs.readFileSync(path.join(root, "domain-packs/first-party", folder, "manifest.json"), "utf8")),
  story: JSON.parse(fs.readFileSync(path.join(root, "domain-packs/first-party", folder, "examples/story-v1.json"), "utf8"))
}));

export const domainPackCatalog = (installed = false) => packs.map(({ manifest }, index) => ({
  manifest,
  digest: String(index + 1).repeat(64),
  publisher: "orgbrain",
  visibility: "first_party",
  installation: installed ? {
    id: `install-${manifest.pack_id}`,
    pack_id: manifest.pack_id,
    version: manifest.version,
    manifest_digest: String(index + 1).repeat(64),
    state: "installed",
    installed_at: Date.UTC(2026, 5, 30)
  } : null
}));

const config = {
  "function.build-engineering": {
    keys: ["build_success_rate", "build_duration_p95", "queue_duration_p95", "change_failure_rate", "deployment_frequency"],
    outcome: "Build時間9.7分、成功率98.6%、Queue時間1.4分まで改善"
  },
  "function.sre": {
    keys: ["availability", "error_budget_burn_rate", "latency_p95", "http_5xx_rate", "mttr"],
    outcome: "Availability 99.97%、Burn Rate 0.6倍、5xx 0.5%、MTTR 29分へ改善"
  },
  "function.sales": {
    keys: ["appointment_count", "appointment_rate", "opportunity_count", "opportunity_conversion_rate", "won_count", "revenue"],
    outcome: "Appointment 72件、商談23件、受注7件、売上890万円"
  },
  "function.pdm-b2c-marketplace": {
    keys: ["activation_rate", "time_to_first_value_p75", "d7_retention", "zero_result_rate", "purchase_conversion", "repeat_purchase_rate", "ltv_cac", "contribution_ltv_90d", "cac", "inventory_fulfillment_rate"],
    outcome: "D7 27%・Purchase Conversion 3.0%・Contribution Margin +4%。実験条件は達成し、長期Targetは継続追跡",
  }
};

const groups = (packId, key) => {
  if (packId === "function.build-engineering") return ["delivery", "Delivery performance"];
  if (packId === "function.sre") return ["reliability", "Service reliability"];
  if (packId === "function.sales") return ["pipeline", "Revenue pipeline"];
  if (["activation_rate", "time_to_first_value_p75", "zero_result_rate"].includes(key)) return ["activation", "Activation"];
  if (["d7_retention", "repeat_purchase_rate"].includes(key)) return ["retention", "Retention"];
  if (["purchase_conversion"].includes(key)) return ["purchase_funnel", "購買Funnel"];
  if (["ltv_cac", "contribution_ltv_90d", "cac"].includes(key)) return ["unit_economics", "Unit Economics"];
  if (["inventory_fulfillment_rate"].includes(key)) return ["market_quality", "マーケット品質"];
  return ["custom", "カスタム指標"];
};

const sourceState = (metric, value) => {
  if (metric.source_type !== "connector") return value == null ? "configured" : "active";
  return value == null ? "unconfigured" : "active";
};

const achieved = (metric, value, target) => {
  if (value == null || target == null) return false;
  if (metric.target_direction === "decrease") return value <= target;
  return value >= target;
};

const snapshot = (key, suffix, value, observedAt, expiresAt, historical) => value == null ? null : ({
  id: `${key}-${suffix}`,
  value,
  state: "measured",
  observed_at: observedAt,
  expires_at: expiresAt,
  evidence_ref: `${key}-evidence`,
  source_binding_id: `${key}-source`,
  historical
});

function metricView(packId, story, metric) {
  const key = metric.key;
  const baselineValue = story.baseline?.[key] ?? null;
  const after = story.after_four_weeks ?? story.after ?? {};
  const currentValue = after[key] ?? baselineValue;
  const targetValue = story.targets?.[key] ?? null;
  const baselineAt = Date.parse(story.fixture_date);
  const currentAt = Date.parse(story.followup_date ?? story.fixture_date) + (story.followup_date ? 0 : 28 * 86_400_000);
  const expiresAt = currentAt + 90 * 86_400_000;
  const [group] = groups(packId, key);
  const points = baselineValue == null || currentValue == null
    ? []
    : [0, 1, 2, 3].map((index) => snapshot(
      key,
      `series-${index}`,
      Number((baselineValue + ((currentValue - baselineValue) * index / 3)).toFixed(2)),
      baselineAt + ((currentAt - baselineAt) * index / 3),
      expiresAt,
      true
    ));
  return {
    metric_key: key,
    label: metric.label,
    description: metric.description ?? "",
    group,
    origin_type: "pack",
    unit: metric.unit,
    aggregation_window: metric.aggregation_window,
    baseline: snapshot(key, "baseline", baselineValue, baselineAt, expiresAt, true),
    current: snapshot(key, "current", currentValue, currentAt, expiresAt, false),
    outcome: snapshot(key, "outcome", currentValue, currentAt, expiresAt, true),
    delta: baselineValue == null || currentValue == null ? null : currentValue - baselineValue,
    target: targetValue == null ? null : {
      direction: metric.target_direction,
      value: targetValue,
      min: null,
      max: null,
      reason: packId === "function.sre" && key === "error_budget_burn_rate" ? "Error Budget消費を1.0倍以下へ戻す" : null
    },
    status: targetValue == null ? "approaching" : achieved(metric, currentValue, targetValue) ? "achieved" : "approaching",
    source: {
      adapter_id: metric.connector?.adapter_id ?? (metric.source_type === "derived" ? "derived" : null),
      query_template: metric.connector?.query_template ?? (metric.source_type === "derived" ? "safe-formula" : null),
      state: sourceState(metric, currentValue),
      last_success_at: currentValue == null ? null : currentAt,
      last_error_code: null
    },
    series: points.filter(Boolean)
  };
}

function customMetric(story) {
  const test = story.custom_metric_test;
  const observedAt = Date.parse(story.followup_date);
  return {
    metric_key: test.key,
    label: "Quality adjusted activation rate",
    description: test.formula_text,
    group: "custom",
    origin_type: "custom",
    unit: "percent",
    aggregation_window: "P7D",
    baseline: null,
    current: snapshot(test.key, "coupon-case", test.coupon_case.quality_adjusted_activation_rate, observedAt, observedAt + 90 * 86_400_000, false),
    outcome: null,
    delta: null,
    target: null,
    status: "missed",
    source: { adapter_id: "derived", query_template: "safe-ratio", state: "active", last_success_at: observedAt, last_error_code: null },
    series: []
  };
}

export function workspaceFor(packId) {
  const entry = packs.find(({ manifest }) => manifest.pack_id === packId);
  if (!entry) return null;
  const { manifest, story } = entry;
  const selected = config[packId];
  const metricByKey = new Map(manifest.metrics.map((metric) => [metric.key, metric]));
  const metrics = selected.keys.map((key) => metricView(packId, story, metricByKey.get(key))).filter(Boolean);
  if (packId === "function.pdm-b2c-marketplace") metrics.push(customMetric(story));
  const grouped = new Map();
  for (const metric of metrics) {
    const [key, label] = groups(packId, metric.metric_key);
    if (!grouped.has(key)) grouped.set(key, { key, label, metrics: [] });
    grouped.get(key).metrics.push(metric);
  }
  const observedAt = Date.parse(story.followup_date ?? story.fixture_date);
  const evidence = (story.decision.evidence_details ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    resource_kind: item.resource_kind,
    source_system: item.source_system,
    observed_at: Date.parse(item.observed_at),
    verification_state: item.verification_state,
    technical_ref: item.id
  }));
  const sourceReadiness = metrics.filter((metric) => metric.source.adapter_id && metric.source.adapter_id !== "derived").map((metric) => ({
    contract_version: "metric/v1",
    id: `${metric.metric_key}-source`,
    tenant_id: "workspace-demo",
    metric_definition_id: `${metric.metric_key}-definition`,
    metric_key: metric.metric_key,
    metric_binding_id: null,
    adapter_id: metric.source.adapter_id,
    query_template: metric.source.query_template,
    connection_ref: `demo:${metric.source.adapter_id}`,
    external_scope_ref: story.objects[0]?.id ?? null,
    status: metric.source.state,
    last_attempt_at: observedAt,
    last_success_at: observedAt,
    last_error_code: null,
    created_at: Date.parse(story.fixture_date),
    updated_at: observedAt
  }));
  return {
    contract_version: "domain-pack/v1",
    generated_at: observedAt,
    pack: { pack_id: manifest.pack_id, title: manifest.title, version: manifest.version, description: manifest.description },
    installation: { id: `install-${manifest.pack_id}`, state: "installed", installed_at: Date.parse(story.fixture_date) - 86_400_000 },
    managed_objects: story.objects.map((item) => ({ id: item.id, type_key: item.type, type_label: item.type.replaceAll("_", " "), name: item.name })),
    selected_scope_id: null,
    metric_groups: [...grouped.values()],
    decision: {
      source_type: "decision_memory",
      id: story.decision.id,
      statement: story.decision.statement,
      rationale: story.decision.rationale,
      confirmation_state: "confirmed",
      rejected_alternatives: story.decision.rejected_alternatives ?? [],
      constraints: story.decision.constraints ?? [],
      success_conditions: story.decision.success_conditions ?? [],
      workflow: story.decision.workflow ?? null,
      playbook: story.decision.playbook ?? null,
      outcome_summary: selected.outcome,
      followup_decision: story.followup_decision?.statement ?? null,
      evidence
    },
    recall_history: packId === "function.build-engineering" ? [{
      id: "recall-build-e2e",
      created_at: observedAt,
      mode: "shadow",
      client_name: "Codex",
      candidate_count: 1,
      candidates: [{
        recall_unit_id: "unit-build-e2e",
        role: "primary",
        score: 0.91,
        why_recalled: ["object exact", "intent matched"],
        decision_statement: story.decision.statement
      }],
      feedback: ["useful"],
      trace_url: "/domain-recalls/recall-build-e2e?tenant_id=workspace-demo"
    }] : [],
    source_readiness: sourceReadiness,
    fixture_context: packId === "function.pdm-b2c-marketplace" ? {
      experiment_success: [
        { label: "D7 Retention 26%以上", result: "27%", achieved: true, strategic_target: "28%", strategic_achieved: false },
        { label: "Purchase Conversion 2.8%以上", result: "3.0%", achieved: true, strategic_target: "3.0%", strategic_achieved: true },
        { label: "Contribution Marginを悪化させない", result: "+4%", achieved: true, strategic_target: null, strategic_achieved: true }
      ],
      coupon_case: story.custom_metric_test.coupon_case
    } : null
  };
}
