
import { canonicalLocalProjectId } from "./common.mjs";

export const operationsDefinitions = [
  {name:"orgbrain_memory_feedback_report",description:"Report stale or wrong information for an exact version; requires evidence and does not change retrieval.",inputSchema:{type:"object",required:["payload"],properties:{tenant_id:{type:"string"},payload:{type:"object"}}}},
  {name:"orgbrain_memory_feedback_review",description:"Confirm or reject a memory feedback report as its owner.",inputSchema:{type:"object",required:["feedback_id","decision"],properties:{tenant_id:{type:"string"},feedback_id:{type:"string"},decision:{type:"string",enum:["confirm","reject"]},reviewer_principal:{type:"string"}}}},
  {name:"orgbrain_memory_relation_propose",description:"Propose an evidence-backed contradicts or fixes relationship between exact current versions.",inputSchema:{type:"object",required:["payload"],properties:{tenant_id:{type:"string"},payload:{type:"object"}}}},
  {name:"orgbrain_memory_relation_review",description:"Confirm, reject, or resolve a relationship as owner.",inputSchema:{type:"object",required:["relation_id","decision"],properties:{tenant_id:{type:"string"},relation_id:{type:"string"},decision:{type:"string",enum:["confirm","reject","resolve"]},reviewer_principal:{type:"string"}}}},
  {name:"orgbrain_memory_integrity_issues",description:"List confirmed unresolved contradictions for a project.",inputSchema:{type:"object",properties:{tenant_id:{type:"string"},project_id:{type:"string"}}}},
  {name:"orgbrain_memory_aging_plan",description:"Read-only episodic aging candidates from verified use history; performs no changes.",inputSchema:{type:"object",properties:{tenant_id:{type:"string"},project_id:{type:"string"}}}},
  {
    name: "orgbrain_attempt_record",
    description: "Record one action attempt with source evidence. Public calls remain reported until a trusted collector verifies the evidence.",
    inputSchema: { type: "object", required: ["attempt"], properties: { tenant_id: { type: "string" }, attempt: { type: "object" } } }
  },
  {
    name: "orgbrain_attempts_search",
    description: "Search evidence-backed attempts in one project. Absence means no accessible matching record, not that the action has never been tried.",
    inputSchema: { type: "object", required: ["project_id"], properties: {
      tenant_id: { type: "string" }, project_id: { type: "string" }, action_key: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }
    } }
  },
  {
    name: "orgbrain_attempt_use_record",
    description: "Report adoption, execution, or result checking for an existing attempt with a bounded evidence reference. A public report is not verified use.",
    inputSchema: { type: "object", required: ["project_id", "attempt_id", "stage"], properties: {
      tenant_id: { type: "string" }, id: { type: "string" }, project_id: { type: "string" }, attempt_id: { type: "string" },
      task_id: { type: "string" }, stage: { type: "string", enum: ["adopted", "executed", "result_checked"] },
      evidence: { type: "array", maxItems: 8, items: { type: "object" } }
    } }
  },
  { name: "orgbrain_attempt_use_report", description: "Read separate returned, injected, adopted, executed, and result-checked counts for one project.",
    inputSchema: { type: "object", required: ["project_id"], properties: { tenant_id: { type: "string" }, project_id: { type: "string" } } } },
  { name: "orgbrain_attempt_metrics_report", description: "Read history return, preflight, false-block feedback, repeated failure, and opaque-operation metrics for one project.",
    inputSchema: { type: "object", required: ["project_id"], properties: { tenant_id: { type: "string" }, project_id: { type: "string" } } } },
  { name: "orgbrain_action_preflight_feedback", description: "Report whether a recorded block was correct or false. Public feedback remains unverified until source evidence is checked.",
    inputSchema: { type: "object", required: ["project_id", "preflight_event_id", "verdict"], properties: {
      tenant_id: { type: "string" }, id: { type: "string" }, project_id: { type: "string" },
      preflight_event_id: { type: "string" }, verdict: { type: "string", enum: ["false_block", "correct_block"] },
      evidence: { type: "array", maxItems: 8, items: { type: "object" } }
    } } },
  {
    name: "orgbrain_action_preflight",
    description: "Check whether a proposed action repeats a verified deterministic failure under the same conditions.",
    inputSchema: { type: "object", required: ["project_id", "action_key"], properties: {
      tenant_id: { type: "string" }, project_id: { type: "string" }, action_key: { type: "string" }, conditions: { type: "object" },
      change_hypothesis: { type: "string", maxLength: 500 }, alternatives: { type: "array", maxItems: 5, items: { type: "object", required: ["action_key", "label"], properties: { action_key: { type: "string" }, label: { type: "string" } } } }
    } }
  },
  {
    name: "orgbrain_memory_failure_patterns_list",
    description: "List tenant failure-pattern identifiers used for same-failure avoidance measurement.",
    inputSchema: {
      type: "object",
      properties: { tenant_id: { type: "string" }, project_id: { type: ["string", "null"] } }
    }
  },
  {
    name: "orgbrain_memory_failure_pattern_create",
    description: "Create a normalized failure pattern without storing prompts or commands.",
    inputSchema: {
      type: "object",
      required: ["pattern_key", "label"],
      properties: {
        tenant_id: { type: "string" }, project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] }, work_type: { type: ["string", "null"] },
        pattern_key: { type: "string" }, label: { type: "string" },
        action_fingerprint: { type: ["string", "null"] }, failure_fingerprint: { type: ["string", "null"] },
        is_active: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_memory_failure_pattern_update",
    description: "Update or deactivate a normalized failure pattern.",
    inputSchema: {
      type: "object",
      required: ["pattern_id"],
      properties: {
        tenant_id: { type: "string" }, pattern_id: { type: "string" }, project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] }, work_type: { type: ["string", "null"] },
        pattern_key: { type: "string" }, label: { type: "string" },
        action_fingerprint: { type: ["string", "null"] }, failure_fingerprint: { type: ["string", "null"] },
        is_active: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_start",
    description: "Start run-level Memory Impact measurement for an eligible local execution.",
    inputSchema: {
      type: "object",
      required: ["external_run_id", "idempotency_key"],
      properties: {
        tenant_id: { type: "string" },
        project_id: { type: "string" },
        task_id: { type: "string" },
        trace_id: { type: "string" },
        external_run_id: { type: "string" },
        idempotency_key: { type: "string" },
        agent_name: { type: "string" },
        model: { type: "string" },
        occurred_at: { type: "number" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_report",
    description: "Report the assessed or failed result for one eligible local execution.",
    inputSchema: {
      type: "object",
      required: ["external_run_id", "idempotency_key"],
      properties: {
        tenant_id: { type: "string" },
        external_run_id: { type: "string" },
        idempotency_key: { type: "string" },
        outcome: { type: "string", enum: ["assessed", "failed"] },
        memory_used: { type: "boolean" },
        avoided_lookup: { type: "string", enum: ["source_search", "web_search", "past_context", "none"] },
        memory_basis_ids: { type: "array", items: { type: "string" }, maxItems: 20 },
        confidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
        failure_category: { type: "string", enum: ["agent_error", "tool_error", "cancelled", "unknown"] },
        occurred_at: { type: "number" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_metrics",
    description: "Report durable memory reference and effect metrics without mixing evidence levels.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        source_type: { type: "string" },
        source_id: { type: "string" },
        business_category_id: { type: "string" },
        work_type: { type: "string" },
        day: { type: "string" },
        group_by: { type: "string", enum: ["memory", "business_category", "work_type", "project", "day"] }
      }
    }
  }
];

export async function callOperations(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_memory_feedback_report") return store.reportMemoryFeedback({...input.payload,tenant_id:tenantId,reporter_principal:process.env.USER||"local-user"});
  if (name === "orgbrain_memory_feedback_review") return store.reviewMemoryFeedback({tenant_id:tenantId,feedback_id:input.feedback_id,decision:input.decision,reviewer_principal:process.env.USER||"local-user"});
  if (name === "orgbrain_memory_relation_propose") return store.proposeMemoryRelation({...input.payload,tenant_id:tenantId,proposer_principal:process.env.USER||"local-user"});
  if (name === "orgbrain_memory_relation_review") return store.reviewMemoryRelation({tenant_id:tenantId,relation_id:input.relation_id,decision:input.decision,reviewer_principal:process.env.USER||"local-user"});
  if (name === "orgbrain_memory_integrity_issues") return store.listMemoryIntegrityIssues(tenantId,input.project_id||null);
  if (name === "orgbrain_memory_aging_plan") return store.planEpisodicAging(tenantId,input.project_id||null);
  if (name === "orgbrain_attempt_record") return store.recordAttempt(tenantId,
    { ...input.attempt, executed_by_type: "unknown", executed_by: null },
    { principal: process.env.ORGBRAIN_USE_PRINCIPAL || process.env.USER || "local" });
  if (name === "orgbrain_attempts_search") return store.searchAttempts(tenantId, { ...input, project_id: await canonicalLocalProjectId(input.project_id) });
  if (name === "orgbrain_attempt_use_record") return store.recordAttemptUse(tenantId, { ...input, project_id: await canonicalLocalProjectId(input.project_id) });
  if (name === "orgbrain_attempt_use_report") return store.attemptUseReport(tenantId, await canonicalLocalProjectId(input.project_id));
  if (name === "orgbrain_attempt_metrics_report") return store.actionAttemptMetricsReport(tenantId, await canonicalLocalProjectId(input.project_id));
  if (name === "orgbrain_action_preflight_feedback") return store.recordAttemptMetricEvent(tenantId, {
    id: input.id, project_id: await canonicalLocalProjectId(input.project_id), kind: "feedback", source: "mcp",
    related_event_id: input.preflight_event_id, feedback_verdict: input.verdict, evidence: input.evidence
  });
  if (name === "orgbrain_action_preflight") return store.preflightAction(tenantId, { ...input, project_id: await canonicalLocalProjectId(input.project_id) });
  if (name === "orgbrain_memory_failure_patterns_list") {
    return store.listFailurePatterns(tenantId, { projectId: input.project_id ?? null });
  }
  if (name === "orgbrain_memory_failure_pattern_create") return store.createFailurePattern(tenantId, input);
  if (name === "orgbrain_memory_failure_pattern_update") {
    const { pattern_id: patternId, tenant_id: _tenant, ...update } = input;
    return store.updateFailurePattern(tenantId, patternId, update);
  }
  if (name === "orgbrain_memory_impact_start") {
    return store.startMemoryImpact(tenantId, input, process.env.USER || "local-user");
  }
  if (name === "orgbrain_memory_impact_report") {
    return store.reportMemoryImpactExecution(
      tenantId,
      input.external_run_id,
      input,
      process.env.USER || "local-user"
    );
  }
  if (name === "orgbrain_memory_impact_metrics") return store.memoryImpactReport(tenantId, input);
  throw new Error(`unknown tool: ${name}`);
}
