import { describe, expect, it } from "vitest";
import { domainRecallBundleSchema, domainRecallFeedbackSchema } from "../src/domain-recall";
import {
  domainPackManifestSchema,
  domainPackWorkspaceSchema,
  metricDefinitionSchema,
  metricSnapshotSchema,
  metricSourceBindingSchema
} from "../src/domain-pack";

describe("Domain Pack contracts", () => {
  it("accepts custom derived metrics without a pack origin", () => {
    const metric = metricDefinitionSchema.parse({
      key: "quality_adjusted_activation_rate",
      label: "Quality adjusted activation",
      origin_type: "custom",
      scope_type: "managed_object",
      source_type: "derived",
      unit: "ratio",
      aggregation_window: "P7D",
      freshness_seconds: 86_400,
      target_direction: "increase",
      formula: { operation: "ratio", metric_keys: ["qualified_activated_users", "new_users"] }
    });
    expect(metric.origin_type).toBe("custom");
  });

  it("rejects arbitrary connector/script fields and invalid formulas", () => {
    expect(() => metricDefinitionSchema.parse({
      key: "unsafe",
      label: "Unsafe",
      origin_type: "custom",
      scope_type: "tenant",
      source_type: "derived",
      unit: "ratio",
      aggregation_window: "P1D",
      freshness_seconds: 60,
      target_direction: "increase",
      formula: { operation: "ratio", metric_keys: ["one"] },
      script: "process.exit()"
    })).toThrow();
    expect(() => metricDefinitionSchema.parse({
      key: "unsafe_connector",
      label: "Unsafe connector",
      origin_type: "custom",
      scope_type: "tenant",
      source_type: "connector",
      unit: "count",
      aggregation_window: "P1D",
      freshness_seconds: 60,
      target_direction: "increase",
      connector: { adapter_id: "crm", query_template: "SELECT * FROM leads" }
    })).toThrow();
  });

  it("keeps unknown and stale snapshots numeric-free", () => {
    expect(() => metricSnapshotSchema.parse({
      metric_key: "availability",
      scope_type: "managed_object",
      scope_id: "payments-api",
      value: 0,
      state: "stale",
      observed_at: 1,
      expires_at: 2,
      idempotency_key: "snapshot-1"
    })).toThrow();
  });

  it("accepts a minimal function pack", () => {
    const pack = domainPackManifestSchema.parse({
      pack_id: "function.sre",
      version: "1.0.0",
      classification: "function",
      title: "SRE",
      description: "Service reliability operating pack",
      min_orgbrain_version: "0.2.0"
    });
    expect(pack.metrics).toEqual([]);
    expect(pack.recall_profile).toBeUndefined();
  });

  it("validates recall feedback effects and never exposes stale numeric values", () => {
    expect(() => domainRecallFeedbackSchema.parse({
      recall_id: "recall-1",
      feedback: "wrong_scope",
      effect: "team_review_proposal",
      occurred_at: 1
    })).toThrow();
    expect(() => domainRecallBundleSchema.parse({
      id: "recall-1",
      generated_at: 1,
      query_hash: "a".repeat(64),
      primary: {
        recall_unit_id: "unit-1",
        role: "primary",
        why_recalled: ["scope"],
        scope: { service: "payments-api" },
        score: { object_match: 0.35, intent_match: 0.2, scope_match: 0.15, decision_link: 0.1, active_confirmed: 0.08, verified_evidence: 0.07, fresh_metric: 0, total: 0.95 },
        decision: { source_type: "decision_memory", id: "DEC-1", statement: "Use a breaker", rationale: "Retries amplify failures", confirmation_state: "confirmed", valid_from: null, valid_until: null, rejected_alternatives: [], constraints: [], success_conditions: [] },
        metrics: [{ metric_key: "burn_rate", role: "current", value: 3.4, unit: "ratio", state: "stale", observed_at: 1 }],
        evidence: [], workflow: null, follow_up: null
      },
      supporting: [], conflicts: [], warnings: ["stale"], trace_url: "/domain-recalls/recall-1", summary: "Recall"
    })).toThrow();
  });

  it("accepts connector-ready source bindings without credentials", () => {
    const binding = metricSourceBindingSchema.parse({
      id: "source-build-success",
      tenant_id: "tenant-a",
      metric_definition_id: "metric-build-success",
      metric_key: "build_success_rate",
      adapter_id: "github-actions",
      query_template: "workflow-success-rate-v1",
      status: "unconfigured",
      created_at: 1,
      updated_at: 1
    });
    expect(binding.connection_ref).toBeNull();
    expect(binding.status).toBe("unconfigured");
  });

  it("keeps unknown Workspace metrics numeric-free and source-readable", () => {
    const workspace = domainPackWorkspaceSchema.parse({
      generated_at: 10,
      pack: { pack_id: "function.sre", title: "SRE", version: "1.0.0", description: "Reliability" },
      installation: { id: "install-sre", state: "installed", installed_at: 1 },
      managed_objects: [],
      selected_scope_id: null,
      metric_groups: [{
        key: "reliability",
        label: "Service reliability",
        metrics: [{
          metric_key: "availability",
          label: "Availability",
          description: "",
          group: "reliability",
          origin_type: "pack",
          unit: "percent",
          aggregation_window: "PT5M",
          baseline: null,
          current: null,
          outcome: null,
          delta: null,
          target: null,
          status: "waiting",
          source: {
            adapter_id: "datadog",
            query_template: "availability-slo-v1",
            state: "unconfigured",
            last_success_at: null,
            last_error_code: null
          },
          series: []
        }]
      }],
      decision: null,
      source_readiness: []
    });
    expect(workspace.metric_groups[0]?.metrics[0]?.current).toBeNull();
    expect(workspace.metric_groups[0]?.metrics[0]?.status).toBe("waiting");
  });
});
