import { featureMode } from "../feature-mode";
import { CloudAmpService } from "../amp-service";
import { HttpError } from "@org-brain/shared";
import { memoryUseOperation } from "../memory-use-service";
import { recordActionAttemptMetricEvent, recordActionAttemptUse, searchActionAttempts } from "../action-attempt-service";
import { z } from "zod";
import { enrichContext, preActionDecisionGate } from "../context-engine-service";
import { recordMemoryEffect, updateMemoryUsageStates } from "../memory-effect-service";
import { getDomainRecall } from "../domain-recall-service";
import type { OrgBrainMcpTools } from "../mcp";
import { contextEnrichInputShape, toContent, registerTool, normalizeTenant } from "./common";

export function registerContextUse(tools: OrgBrainMcpTools) {
  registerTool(tools.server, 
      "orgbrain_context_enrich",
      contextEnrichInputShape,
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        let projectIndex;
        if (payload.project_id && tools.env.ORGBRAIN_AMP_ENABLED === "true") {
          try {
            projectIndex = await new CloudAmpService(tools.env, { tenantId, principal, projectId: payload.project_id }).projectIndex();
          } catch { projectIndex = { status: "unavailable", reason: "amp_unavailable" }; }
        }
        const result = await enrichContext(tools.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal, projectIndex, forConversation: true });
        const priorAttempts = payload.project_id
          ? await searchActionAttempts(tools.env, tenantId, {
              project_id: payload.project_id,
              query: [payload.task?.title, payload.task?.description].filter(Boolean).join(" "),
              limit: 3
            })
          : [];
        if (payload.project_id) await recordActionAttemptMetricEvent(tools.env, tenantId, {
          project_id: payload.project_id, kind: "context_query", source: "mcp", returned_count: priorAttempts.length
        });
        const attemptUse = await Promise.allSettled(priorAttempts.map((attempt) => recordActionAttemptUse(tools.env, tenantId, {
          project_id: payload.project_id, attempt_id: attempt.id, task_id: payload.task_id, stage: "returned"
        })));
        const attemptUsageIds = attemptUse.flatMap((item) => item.status === "fulfilled" ? [item.value.id] : []);
        if (payload.include_domain_recall !== true) return toContent({ ...result, prior_attempts: priorAttempts, attempt_usage_ids: attemptUsageIds });
        const recall = await getDomainRecall(tools.env, {
          tenant_id: tenantId,
          project_id: payload.project_id,
          query: [payload.task?.title, payload.task?.description].filter(Boolean).join(" "),
          object_type_key: payload.object_type_key,
          object_id: payload.object_id,
          scope: payload.scope
        }, {
          ownerPrincipal: tools.props.ownerPrincipal ?? principal,
          runtimeActor: tools.props.runtimeActor,
          clientInstallationId: tools.props.clientInstallationId,
          clientName: tools.props.clientType ?? "mcp"
        });
        return toContent({ ...result, prior_attempts: priorAttempts, attempt_usage_ids: attemptUsageIds, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_context_pre_action_gate",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        task_type: z.enum(["implementation", "review", "debug", "proposal", "support"]).optional(),
        task: z.object({
          title: z.string().max(240).optional(),
          description: z.string().max(2000).optional(),
          target_files: z.array(z.string().max(256)).max(32).optional()
        }),
        minimum_confidence: z.number().min(0).max(1).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await preActionDecisionGate(
          tools.env,
          { tenant_id: tenantId, ...payload },
          { principal: tools.props?.principal ?? "mcp" }
        ));
      }, "read"
    );

  for (const [name,operation] of Object.entries({orgbrain_memory_use_context_record:"record",orgbrain_memory_use_history:"history",orgbrain_memory_use_evaluate:"evaluate",orgbrain_memory_use_revoke:"revoke"})) {
      registerTool(tools.server,name,{tenant_id:z.string().optional(),payload:z.record(z.string(),z.unknown())},async({tenant_id,payload})=>{
        const tenant=normalizeTenant(tenant_id,tools.props);
        let projectId=typeof payload.project_id==='string'?payload.project_id:undefined;
        if(operation==='evaluate'||operation==='revoke') {
          const id=operation==='evaluate'?payload.context_id:payload.id;
          if(typeof id==='string') {
            const row=await tools.env.OPEN_BRAIN_DB.prepare('SELECT project_id FROM memory_use_contexts WHERE tenant_id=? AND principal=? AND id=?').bind(tenant,tools.props.principal,id).first<{project_id:string}>();
            projectId=row?.project_id;
          }
        }
        await tools.requirePermission(tenant,operation==="history"?"read":"write",projectId);
        return toContent(await memoryUseOperation(tools.env,tenant,payload,tools.props.principal,operation));
      }, (operation === "history" ? "read" : "write"));
    }

  registerTool(tools.server, 
      "orgbrain_memory_usage_state_update",
      {
        tenant_id: z.string().optional(),
        usage_event_id: z.string().min(1).max(128),
        items: z.array(z.object({
          usage_item_id: z.string().min(1).max(128),
          used_state: z.enum(["used", "not_used", "unknown"])
        })).min(1).max(128)
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_usage_state_update",
          "memory_usage",
          () => updateMemoryUsageStates(tools.env, tenantId, payload)
        ));
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memory_effect_record",
      {
        tenant_id: z.string().optional(),
        usage_event_id: z.string().min(1).max(128),
        idempotency_key: z.string().min(1).max(256),
        evidence_level: z.enum(["reported", "estimated", "verified", "unverifiable"]).optional(),
        supersedes_effect_id: z.string().max(128).nullable().optional(),
        effect_outcome: z.enum(["positive", "neutral", "negative", "unknown"]),
        avoided_lookup_categories: z.array(
          z.enum(["source_search", "web_search", "past_context", "none"])
        ).max(4).optional(),
        gross_saved_tokens_estimate: z.number().int().optional(),
        token_estimation_candidates: z.object({
          paired_control_tokens: z.number().optional(),
          safe_replay_tokens: z.number().optional(),
          avoided_source_tokens: z.number().optional(),
          failure_pattern_median_tokens: z.number().optional(),
          category_median_tokens: z.number().optional(),
          text_size_heuristic_tokens: z.number().optional()
        }).optional(),
        injected_tokens: z.number().int().min(0).optional(),
        net_saved_tokens_estimate: z.number().int().optional(),
        estimate_lower_bound: z.number().int().nullable().optional(),
        estimate_upper_bound: z.number().int().nullable().optional(),
        estimation_method: z.string().max(128).nullable().optional(),
        estimator_version: z.string().max(64).nullable().optional(),
        estimate_confidence: z.number().min(0).max(1).nullable().optional(),
        failure_pattern_id: z.string().max(128).nullable().optional(),
        failure_opportunity_state: z.enum(["applicable", "not_applicable", "unknown"]).optional(),
        action_changed: z.boolean().optional(),
        alternative_executed: z.boolean().optional(),
        failure_avoided: z.boolean().optional(),
        failure_saved_tokens_estimate: z.number().int().optional(),
        verification_ref_type: z.string().max(64).nullable().optional(),
        verification_ref_id: z.string().max(256).nullable().optional(),
        estimated_tool_calls_saved: z.number().nullable().optional(),
        estimated_seconds_saved: z.number().nullable().optional(),
        attributions: z.array(z.object({
          usage_item_id: z.string().min(1).max(128),
          attribution_weight: z.number().positive().max(1)
        })).max(64).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_effect_record",
          "memory_effect",
          () => recordMemoryEffect(tools.env, tenantId, { tenant_id: tenantId, ...payload })
        ));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_prompt_recall",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        query: z.string().min(1).max(4_000),
        object_type_key: z.string().max(128).nullable().optional(),
        object_id: z.string().max(128).nullable().optional(),
        scope: z.record(z.string(), z.string().max(256)).optional(),
        session_id: z.string().max(256).nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        if (tools.props.clientPurpose === "recall" && featureMode(tools.env.DOMAIN_RECALL_HOOK_MODE) === "off") {
          throw new HttpError(404, "domain_recall_hook_disabled", "Domain Recall hook access is disabled");
        }
        return toContent(await getDomainRecall(tools.env, { tenant_id: tenantId, ...payload }, {
          ownerPrincipal: tools.props.ownerPrincipal ?? tools.props.principal,
          runtimeActor: tools.props.runtimeActor,
          clientInstallationId: tools.props.clientInstallationId,
          clientName: tools.props.clientType ?? "mcp"
        }));
      }, "read"
    );
}
