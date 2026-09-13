import { describe, expect, it } from "vitest";
import { domainRecallBundleSchema, domainRecallFeedbackSchema } from "../src/domain-recall";
import {
  domainPackManifestSchema,
  domainPackWorkspaceSchema,
  knowledgePackDataSourcesSchema,
  knowledgePackGoalsSchema,
  knowledgePackOnboardingSchema,
  knowledgePackScopeSchema,
  improvementActionSchema,
  metricImportJobSchema,
  metricDefinitionSchema,
  metricSnapshotSchema,
  metricSourceBindingSchema,
  organizationDashboardSchema,
  retrospectiveSessionSchema
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

  it("validates a resumable Knowledge Pack onboarding without storing connector secrets", () => {
    const goals = knowledgePackGoalsSchema.parse({
      goals: [{ metric_key: "build_success_rate", direction: "increase", target_value: 98, due_at: 2_000 }]
    });
    const sources = knowledgePackDataSourcesSchema.parse({
      sources: [{ metric_key: "build_success_rate", mode: "connector", connection_ref: "connection:github-actions:primary" }]
    });
    const onboarding = knowledgePackOnboardingSchema.parse({
      id: "onboarding-1",
      tenant_id: "tenant-a",
      project_id: "project-a",
      state: "in_progress",
      current_step: "data_sources",
      revision: 4,
      answers: {
        purpose: { name: "Build reliability", objective: "Reduce failed builds" },
        template: { pack_ids: ["function.build-engineering"] },
        scope: { project_id: "project-a", scope_type: "project" },
        goals,
        data_sources: sources
      },
      plan_digest: null,
      plan: null,
      completion: null,
      created_by_principal: "user:admin",
      completed_at: null,
      created_at: 1,
      updated_at: 2
    });
    expect(onboarding.answers.data_sources?.sources[0]?.connection_ref).toBe("connection:github-actions:primary");
    expect(JSON.stringify(onboarding)).not.toContain("secret");
    expect(() => knowledgePackScopeSchema.parse({
      project_id: "project-a",
      scope_type: "tenant"
    })).toThrow("tenant scope must not include project_id");
  });

  it("rejects incomplete goals and connector credentials in onboarding answers", () => {
    expect(() => knowledgePackGoalsSchema.parse({
      goals: [{ metric_key: "availability", direction: "range", target_min: 99.9 }]
    })).toThrow();
    expect(() => knowledgePackDataSourcesSchema.parse({
      sources: [{
        metric_key: "availability",
        mode: "connector",
        connection_ref: "connection:datadog:primary",
        api_key: "must-not-be-accepted"
      }]
    })).toThrow();
    expect(() => knowledgePackDataSourcesSchema.parse({
      sources: [{
        metric_key: "availability",
        mode: "connector",
        connection_ref: "raw-secret-value"
      }]
    })).toThrow();
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

  it("validates the post-onboarding measurement loop contracts", () => {
    const dashboard = organizationDashboardSchema.parse({
      generated_at: 10,
      knowledge: { decisions: 2, rules: 3, rationales: 2 },
      goals: []
    });
    expect(dashboard.goals).toEqual([]);
    expect(metricImportJobSchema.parse({
      contract_version: "metric-import-job/v1",
      run_id: "run-1", tenant_id: "tenant-a", source_binding_id: "source-1", requested_at: 10, attempt: 0
    }).attempt).toBe(0);
    expect(retrospectiveSessionSchema.parse({
      id: "retro-1", tenant_id: "tenant-a", project_id: null, schedule_id: null,
      status: "open", title: "Weekly review", created_by: "user:admin", opened_at: 10,
      closed_at: null, cancelled_at: null, items: [], created_at: 10, updated_at: 10
    }).status).toBe("open");
    expect(improvementActionSchema.parse({
      id: "action-1", tenant_id: "tenant-a", project_id: null, retrospective_session_id: null,
      retrospective_item_id: null, goal_link_id: null, title: "Document the rule", description: "",
      owner_principal: null, due_at: null, status: "open", external_issue_url: null,
      implementation_completed_at: null, baseline_snapshot_id: null, verification_snapshot_id: null,
      comparator_version: null, verification_outcome: null, created_by: "user:admin", created_at: 10, updated_at: 10
    }).status).toBe("open");
    expect(() => improvementActionSchema.parse({
      id: "action-2", tenant_id: "tenant-a", project_id: null, retrospective_session_id: null,
      retrospective_item_id: null, goal_link_id: null, title: "Track externally", description: "",
      owner_principal: null, due_at: null, status: "open", external_issue_url: "ftp://example.com/issue/1",
      implementation_completed_at: null, baseline_snapshot_id: null, verification_snapshot_id: null,
      comparator_version: null, verification_outcome: null, created_by: "user:admin", created_at: 10, updated_at: 10
    })).toThrow(/http or https/);
  });
});
