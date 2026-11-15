import { actionAttemptMetricsReport, actionAttemptUseReport, preflightAction, recordActionAttempt, recordActionAttemptMetricEvent, recordActionAttemptUse, searchActionAttempts } from "../action-attempt-service";
import { z } from "zod";
import { ackAgentMessage, getAgentMessage, listAgentMessages, markAgentMessageRead, sendAgentMessage } from "../agent-message-service";
import { getTask, getTaskEvents, createTask } from "../task-service";
import { createMemoryFailurePattern, listMemoryFailurePatterns, memoryImpactReport, updateMemoryFailurePattern } from "../memory-effect-service";
import { reportMemoryImpact, startMemoryImpact } from "../memory-impact-service";
import { listMemoryIntegrityIssues, proposeMemoryRelation, reportMemoryFeedback, reviewMemoryFeedback, reviewMemoryRelation } from "../memory-integrity-service";
import { getMemoryAgingPlan } from "../memory-aging-service";
import type { OrgBrainMcpTools } from "../mcp";
import { sourceRefSchema, agentMessageTargetTypeSchema, agentMessageStatusSchema, toContent, registerTool, normalizeTenant } from "./common";

export function registerOperations(tools: OrgBrainMcpTools) {
  registerTool(tools.server, "orgbrain_memory_feedback_report", {
      tenant_id: z.string().optional(), memory_id: z.string(), memory_version: z.number().int().positive(),
      kind: z.enum(["stale", "wrong"]), reason: z.string(),
      evidence: z.array(z.object({ type: z.string(), ref: z.string() })).min(1)
    }, async ({ tenant_id, ...payload }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "write");
      return toContent(await reportMemoryFeedback(tools.env, tenantId, payload, tools.props.principal));
    }, "write");

  registerTool(tools.server, "orgbrain_memory_feedback_review", {
      tenant_id: z.string().optional(), feedback_id: z.string(), decision: z.enum(["confirm", "reject"])
    }, async ({ tenant_id, feedback_id, decision }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "write");
      return toContent(await reviewMemoryFeedback(tools.env, tenantId, feedback_id, decision, tools.props.principal));
    }, "write");

  registerTool(tools.server, "orgbrain_memory_relation_propose", {
      tenant_id: z.string().optional(), from_memory_id: z.string(), from_version: z.number().int().positive(),
      to_memory_id: z.string(), to_version: z.number().int().positive(), relation: z.enum(["contradicts", "fixes"]),
      evidence: z.array(z.object({ type: z.string(), ref: z.string() })).min(1)
    }, async ({ tenant_id, ...payload }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "write");
      return toContent(await proposeMemoryRelation(tools.env, tenantId, payload, tools.props.principal));
    }, "write");

  registerTool(tools.server, "orgbrain_memory_relation_review", {
      tenant_id: z.string().optional(), relation_id: z.string(), decision: z.enum(["confirm", "reject", "resolve"])
    }, async ({ tenant_id, relation_id, decision }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "write");
      return toContent(await reviewMemoryRelation(tools.env, tenantId, relation_id, decision, tools.props.principal));
    }, "write");

  registerTool(tools.server, "orgbrain_memory_integrity_issues", {
      tenant_id: z.string().optional(), project_id: z.string().min(1)
    }, async ({ tenant_id, project_id }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "read", project_id);
      return toContent(await listMemoryIntegrityIssues(tools.env, tenantId, project_id, tools.props.principal));
    }, "read");

  registerTool(tools.server, "orgbrain_memory_aging_plan", {
      tenant_id: z.string().optional(), project_id: z.string().min(1)
    }, async ({ tenant_id, project_id }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "read", project_id);
      return toContent(await getMemoryAgingPlan(tools.env, tenantId, project_id));
    }, "read");

  registerTool(tools.server,
      "orgbrain_attempt_record",
      { tenant_id: z.string().optional(), attempt: z.object({
        id: z.string().max(128), project_id: z.string().max(128), action_key: z.string().max(128),
        action_label: z.string().max(240), attempt_type: z.enum(["intervention", "tool_result"]).optional(), target: z.string().max(160), conditions: z.record(z.string(), z.string()).optional(),
        outcome: z.enum(["success", "failure", "inconclusive"]), result_summary: z.string().max(500),
        failure_kind: z.enum(["deterministic", "transient", "unknown"]).optional(), performed_at: z.number().int(), change_hypothesis: z.string().max(500).optional(),
        executed_by_type: z.enum(["principal", "agent", "unknown"]).optional(), executed_by: z.string().nullable().optional(),
        evidence: z.array(z.object({ ref_type: z.string(), ref_id: z.string(), content_hash: z.string() })).max(8),
        source: z.string().max(128), source_key: z.string().max(128), supersedes_id: z.string().nullable().optional()
      }) },
      async ({ tenant_id, attempt }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", attempt.project_id);
        return toContent(await tools.auditedMutation(
          tenantId, "mcp.orgbrain_attempt_record", "action_attempt",
          () => recordActionAttempt(tools.env, tenantId, tools.props.principal, attempt)
        ));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_attempts_search",
      { tenant_id: z.string().optional(), project_id: z.string().max(128), action_key: z.string().max(128).optional(), query: z.string().max(1000).optional(), limit: z.number().int().min(1).max(100).optional() },
      async ({ tenant_id, ...input }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", input.project_id);
        return toContent(await searchActionAttempts(tools.env, tenantId, input));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_attempt_use_record",
      { tenant_id: z.string().optional(), id: z.string().max(128).optional(), project_id: z.string().max(128),
        attempt_id: z.string().max(128), task_id: z.string().max(128).optional(),
        stage: z.enum(["adopted", "executed", "result_checked"]),
        evidence: z.array(z.object({ ref_type: z.string(), ref_id: z.string(), content_hash: z.string() })).max(8).optional() },
      async ({ tenant_id, ...input }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", input.project_id);
        return toContent(await tools.auditedMutation(tenantId, "mcp.orgbrain_attempt_use_record", "action_attempt_use",
          () => recordActionAttemptUse(tools.env, tenantId, input)));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_attempt_use_report",
      { tenant_id: z.string().optional(), project_id: z.string().max(128) },
      async ({ tenant_id, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        return toContent(await actionAttemptUseReport(tools.env, tenantId, project_id));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_attempt_metrics_report",
      { tenant_id: z.string().optional(), project_id: z.string().max(128) },
      async ({ tenant_id, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        return toContent(await actionAttemptMetricsReport(tools.env, tenantId, project_id));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_action_preflight_feedback",
      { tenant_id: z.string().optional(), id: z.string().max(128).optional(), project_id: z.string().max(128),
        preflight_event_id: z.string().max(128), verdict: z.enum(["false_block", "correct_block"]),
        evidence: z.array(z.object({ ref_type: z.string(), ref_id: z.string(), content_hash: z.string() })).max(8).optional() },
      async ({ tenant_id, ...input }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", input.project_id);
        return toContent(await tools.auditedMutation(tenantId, "mcp.orgbrain_action_preflight_feedback", "action_preflight_feedback",
          () => recordActionAttemptMetricEvent(tools.env, tenantId, {
            id: input.id, project_id: input.project_id, kind: "feedback", source: "mcp",
            related_event_id: input.preflight_event_id, feedback_verdict: input.verdict, evidence: input.evidence
          })));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_action_preflight",
      { tenant_id: z.string().optional(), project_id: z.string().max(128), action_key: z.string().max(128), conditions: z.record(z.string(), z.string()).optional(),
        change_hypothesis: z.string().max(500).optional(), alternatives: z.array(z.object({ action_key: z.string().max(128), label: z.string().max(240) })).max(5).optional() },
      async ({ tenant_id, ...input }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", input.project_id);
        return toContent(await preflightAction(tools.env, tenantId, input));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_memory_failure_patterns_list",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional()
      },
      async ({ tenant_id, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        return toContent(await listMemoryFailurePatterns(tools.env, tenantId, project_id));
      }, "read"
    );

  const failurePatternSchema = {
      tenant_id: z.string().optional(),
      project_id: z.string().max(128).nullable().optional(),
      business_category_id: z.string().max(128).nullable().optional(),
      work_type: z.enum(["implementation", "review", "debug", "proposal", "support", "research", "operations", "other"]).nullable().optional(),
      pattern_key: z.string().min(1).max(128).optional(),
      label: z.string().min(1).max(240).optional(),
      action_fingerprint: z.string().max(128).nullable().optional(),
      failure_fingerprint: z.string().max(128).nullable().optional(),
      is_active: z.boolean().optional()
    };

  registerTool(tools.server, 
      "orgbrain_memory_failure_pattern_create",
      { ...failurePatternSchema, pattern_key: z.string().min(1).max(128), label: z.string().min(1).max(240) },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_create",
          "memory_failure_pattern",
          () => createMemoryFailurePattern(tools.env, tenantId, payload)
        ));
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memory_failure_pattern_update",
      { pattern_id: z.string().min(1).max(128), ...failurePatternSchema },
      async ({ tenant_id, pattern_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_update",
          "memory_failure_pattern",
          () => updateMemoryFailurePattern(tools.env, tenantId, pattern_id, payload)
        ));
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memory_impact_metrics",
      {
        tenant_id: z.string().optional(),
        group_by: z.enum(["memory", "business_category", "work_type", "project", "day"]).optional()
      },
      async ({ tenant_id, group_by }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await memoryImpactReport(tools.env, tenantId, { group_by }));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_messages_send",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema,
        target_key: z.string().min(1).max(256),
        subject: z.string().max(500).nullable().optional(),
        body: z.string().min(1).max(20_000),
        metadata: z.record(z.string(), z.unknown()).optional(),
        thread_id: z.string().min(1).max(128).optional(),
        reply_to_message_id: z.string().min(1).max(128).optional(),
        idempotency_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_send",
          "agent_message",
          () => sendAgentMessage(tools.env, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_handoff_send",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema,
        target_key: z.string().min(1).max(256),
        summary: z.string().min(1).max(4_000),
        decisions: z.array(z.object({
          id: z.string().max(128).optional(),
          decision: z.string().min(1).max(2_000),
          rationale: z.string().max(4_000).optional(),
          source_references: z.array(sourceRefSchema).max(32).optional()
        })).max(32).optional(),
        unresolved: z.array(z.string().min(1).max(1_000)).max(32).optional(),
        next_actions: z.array(z.string().min(1).max(1_000)).max(32).optional(),
        idempotency_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, project_id, target_type, target_key, summary, decisions = [], unresolved = [], next_actions = [], idempotency_key }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", project_id);
        const principal = tools.props?.principal ?? "mcp";
        const body = [
          "# Agent handoff",
          "",
          summary,
          "",
          "## Decisions",
          ...(decisions.length > 0
            ? decisions.map((item) => `- ${item.decision}${item.rationale ? ` — ${item.rationale}` : ""}`)
            : ["- None recorded"]),
          "",
          "## Unresolved",
          ...(unresolved.length > 0 ? unresolved.map((item) => `- ${item}`) : ["- None"]),
          "",
          "## Next actions",
          ...(next_actions.length > 0 ? next_actions.map((item) => `- ${item}`) : ["- None"])
        ].join("\n");
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_handoff_send",
          "agent_handoff",
          () => sendAgentMessage(tools.env, {
            tenant_id: tenantId,
            project_id,
            target_type,
            target_key,
            subject: "Agent handoff package",
            body,
            metadata: {
              schema: "orgbrain-handoff-v1",
              decisions,
              unresolved,
              next_actions
            },
            idempotency_key
          }, { principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_messages_inbox",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional(),
        status: agentMessageStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().positive().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        const result = await listAgentMessages(tools.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_messages_get",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        const principal = tools.props?.principal ?? "mcp";
        const result = await getAgentMessage(tools.env, tenantId, message_id, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_messages_read",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        const principal = tools.props?.principal ?? "mcp";
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_read",
          "agent_message",
          () => markAgentMessageRead(tools.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_messages_ack",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        const principal = tools.props?.principal ?? "mcp";
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_ack",
          "agent_message",
          () => ackAgentMessage(tools.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memory_impact_start",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        task_id: z.string().optional(),
        trace_id: z.string().optional(),
        external_run_id: z.string().min(1).max(256),
        idempotency_key: z.string().min(1).max(256),
        agent_name: z.string().min(1).max(256).optional(),
        model: z.string().min(1).max(256).optional(),
        occurred_at: z.number().int().nonnegative().optional()
      },
      async (payload) => {
        const tenantId = normalizeTenant(payload.tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_start",
          "memory_impact_execution",
          () => startMemoryImpact(tools.env, tenantId, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memory_impact_report",
      {
        tenant_id: z.string().optional(),
        external_run_id: z.string().min(1).max(256),
        idempotency_key: z.string().min(1).max(256),
        outcome: z.enum(["assessed", "failed"]).optional(),
        memory_used: z.boolean().optional(),
        avoided_lookup: z.enum(["source_search", "web_search", "past_context", "none"]).optional(),
        memory_basis_ids: z.array(z.string().min(1).max(256)).max(20).optional(),
        confidence: z.enum(["low", "medium", "high"]).nullable().optional(),
        failure_category: z.enum(["agent_error", "tool_error", "cancelled", "unknown"]).optional(),
        occurred_at: z.number().int().nonnegative().optional()
      },
      async ({ tenant_id, external_run_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        const principal = tools.props?.principal ?? "mcp";
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_report",
          "memory_impact_execution",
          () => reportMemoryImpact(tools.env, tenantId, external_run_id, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_task_create",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        capability: z.enum(["memory_measurement", "skill_generation"]),
        input_ref: z.string().min(1),
        priority: z.number().int().min(0).max(10).optional(),
        trace_id: z.string().optional(),
        wait_event_type: z.string().optional(),
        idempotency_key: z.string().optional()
      },
      async (payload) => {
        const tenantId = normalizeTenant(payload.tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_task_create",
          "task",
          () => createTask(tools.env, {
            ...payload,
            tenant_id: tenantId
          }, { actorPrincipal: tools.props?.principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_task_get",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1)
      },
      async ({ tenant_id, task_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        const task = await getTask(tools.env, tenantId, task_id);
        return toContent(task);
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_task_events",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().optional()
      },
      async ({ tenant_id, task_id, limit, cursor }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        const events = await getTaskEvents(tools.env, tenantId, task_id, limit ?? 50, cursor);
        return toContent(events);
      }, "read"
    );
}
