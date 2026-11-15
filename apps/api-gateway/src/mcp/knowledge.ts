import { HttpError } from "@org-brain/shared";
import { z } from "zod";
import { createDecisionMemory, getDecisionReviewQueue, searchDecisionMemories, getDecisionMemoryContext } from "../context-engine-service";
import { getMemoryDetails } from "../memory-service";
import { allTenantPayload, assertAllTenantReadable } from "../all-tenant-search";
import { searchKnowledgeDocs, getKnowledgeDoc, upsertKnowledgeDoc } from "../knowledge-docs-service";
import { getSharedKnowledge, teamKnowledgeEnabled } from "../team-knowledge-service";
import { createBusinessCategory, listBusinessCategories, updateBusinessCategory } from "../business-category-service";
import { getDomainContext, queryMetrics, searchManagedObjects } from "../domain-metric-service";
import { recordDomainRecallFeedback } from "../domain-recall-service";
import { getDecisionResources, getResourceDecisions, searchKnowledgeResources } from "../resource-decision-service";
import type { OrgBrainMcpTools } from "../mcp";
import { sourceRefSchema, ownerRefSchema, toContent, registerTool, normalizeTenant, workTypeSchema } from "./common";

export function registerKnowledge(tools: OrgBrainMcpTools) {
  registerTool(tools.server, 
      "orgbrain_business_categories_list",
      {
        tenant_id: z.string().optional(),
        include_inactive: z.boolean().optional()
      },
      async ({ tenant_id, include_inactive }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await listBusinessCategories(tools.env, tenantId, include_inactive));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_business_categories_create",
      {
        tenant_id: z.string().optional(),
        slug: z.string().min(1).max(64),
        label: z.string().min(1).max(160),
        description: z.string().max(1000).nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_create",
          "business_category",
          () => createBusinessCategory(tools.env, tenantId, payload)
        ));
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_business_categories_update",
      {
        tenant_id: z.string().optional(),
        category_id: z.string().min(1).max(128),
        slug: z.string().min(1).max(64).optional(),
        label: z.string().min(1).max(160).optional(),
        description: z.string().max(1000).nullable().optional(),
        is_active: z.boolean().optional()
      },
      async ({ tenant_id, category_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_update",
          "business_category",
          () => updateBusinessCategory(tools.env, tenantId, category_id, payload)
        ));
      }, "write"
    );

  if (teamKnowledgeEnabled(tools.env)) {
      registerTool(tools.server, "orgbrain_shared_knowledge_get", {
        tenant_id: z.string().optional(),
        id: z.string().min(1).max(160)
      }, async ({ tenant_id, id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await getSharedKnowledge(tools.env, { tenantId, principal: tools.props.principal }, id));
      }, "read");
    }

  registerTool(tools.server, 
      "orgbrain_decision_review_queue",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        within_days: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await getDecisionReviewQueue(
          tools.env,
          { tenant_id: tenantId, ...payload },
          { principal: tools.props?.principal ?? "mcp" }
        ));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_decision_memories_create",
      {
        target_tenant_id: z.literal("all").optional(),
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        domain: z.enum(["engineering", "sales", "cs", "ops", "finance", "general"]).optional(),
        title: z.string().min(1).max(240),
        decision: z.string().min(1).max(1000),
        rationale: z.string().min(1).max(2000),
        rejected_alternatives: z.array(z.object({
          alternative: z.string().min(1).max(500),
          reasonRejected: z.string().min(1).max(500)
        })).max(16).optional(),
        constraints: z.array(z.string().min(1).max(500)).max(32).optional(),
        known_pitfalls: z.array(z.string().min(1).max(500)).max(32).optional(),
        source_refs: z.array(sourceRefSchema).max(16).optional(),
        owner_refs: z.array(ownerRefSchema).max(16).optional(),
        valid_from: z.union([z.string(), z.number()]).nullable().optional(),
        valid_until: z.union([z.string(), z.number()]).nullable().optional(),
        status: z.enum(["active", "deprecated", "superseded", "uncertain"]).optional(),
        superseded_by: z.string().max(128).nullable().optional(),
        confidence: z.number().min(0).max(1).optional(),
        visibility: z.enum(["tenant", "project", "restricted"]).optional(),
        allowed_principals: z.array(z.string().min(1).max(128)).max(64).optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        const request = { tenant_id: tenantId, ...payload };
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_decision_memories_create",
          "decision_memory",
          () => createDecisionMemory(tools.env,
            payload.target_tenant_id ? allTenantPayload("decision_memory", request) : request, { principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, "orgbrain_shared_record_get", {
      tenant_id: z.string().optional(),
      project_id: z.string().optional(),
      target_tenant_id: z.literal("all"),
      kind: z.enum(["memory", "decision_memory", "doc"]),
      id: z.string().min(1).max(300),
      expected_version: z.number().int().positive().optional()
    }, async ({ tenant_id, project_id, kind, id, expected_version }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "read", project_id);
      await assertAllTenantReadable(tools.env, kind, id);
      const principal = tools.props.principal;
      if (kind === "doc") return toContent(await getKnowledgeDoc(tools.env, "all", id, { principal }));
      if (kind === "decision_memory") return toContent(await getDecisionMemoryContext(tools.env, {
        tenantId: "all", usageTenantId: tenantId, id, userId: principal, agentId: principal
      }));
      return toContent(await getMemoryDetails(tools.env, "all", id, {
        actorPrincipal: principal, usageTenantId: tenantId, expectedVersion: expected_version
      }));
    }, "read");

  registerTool(tools.server, "orgbrain_knowledge_docs_search", {
      tenant_id: z.string().optional(), project_id: z.string().optional(),
      q: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional()
    }, async ({ tenant_id, project_id, ...payload }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "read", project_id);
      return toContent(await searchKnowledgeDocs(tools.env, { ...payload, tenant_id: tenantId, project_id }, { principal: tools.props.principal }));
    }, "read");

  registerTool(tools.server, "orgbrain_shared_doc_upsert", {
      tenant_id: z.string().optional(), project_id: z.string().optional(),
      target_tenant_id: z.literal("all"),
      title: z.string().min(1).max(200), slug: z.string().min(1).max(300),
      scope: z.string().min(1), kind: z.string().min(1), markdown: z.string().min(1).max(200_000)
    }, async ({ tenant_id, project_id, ...payload }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      await tools.requirePermission(tenantId, "write", project_id);
      return toContent(await tools.auditedMutation(tenantId, "mcp.orgbrain_shared_doc_upsert", "knowledge_doc",
        () => upsertKnowledgeDoc(tools.env, allTenantPayload("doc", payload), { principal: tools.props.principal })));
    }, "write");

  registerTool(tools.server,
      "orgbrain_decision_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        user_id: z.string().max(128).optional(),
        agent_id: z.string().max(128).optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        generation_id: z.string().max(128).nullable().optional(),
        ranking_profile_id: z.string().max(128).nullable().optional()
      },
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(
          tenantId,
          payload.generation_id || payload.ranking_profile_id ? "admin" : "read",
          payload.project_id
        );
        const principal = tools.props?.principal ?? "mcp";
        const result = await searchDecisionMemories(tools.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal });
        return toContent(result);
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_resource_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        q: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        if (tools.env.KNOWLEDGE_RESOURCE_INGESTION_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        const principal = tools.props?.principal ?? "mcp";
        return toContent(await searchKnowledgeResources(tools.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal, projectId: payload.project_id ?? null }));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_resource_decisions",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        resource_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, resource_id }) => {
        if (tools.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        const principal = tools.props?.principal ?? "mcp";
        return toContent(await getResourceDecisions(tools.env, tenantId, resource_id, {
          principal,
          projectId: project_id ?? null
        }));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_decision_resources",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        source_type: z.enum(["decision_memory", "decision_rationale"]),
        source_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, source_type, source_id }) => {
        if (tools.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        const principal = tools.props?.principal ?? "mcp";
        return toContent(await getDecisionResources(tools.env, tenantId, {
          source_type,
          source_id
        }, { principal, projectId: project_id ?? null }));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_domain_context",
      {
        tenant_id: z.string().optional(),
        object_id: z.string().min(1).max(128).optional(),
        metric_key: z.string().min(1).max(128).optional(),
        decision_id: z.string().min(1).max(128).optional()
      },
      async ({ tenant_id, object_id, metric_key, decision_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await getDomainContext(tools.env, tenantId, {
          objectId: object_id,
          metricKey: metric_key,
          decisionId: decision_id
        }));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_managed_object_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        q: z.string().max(256).optional(),
        type_key: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(200).optional()
      },
      async ({ tenant_id, project_id, q, type_key, limit }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        return toContent(await searchManagedObjects(tools.env, tenantId, {
          projectId: project_id,
          q,
          typeKey: type_key,
          limit
        }));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_metric_query",
      {
        tenant_id: z.string().optional(),
        metric_keys: z.array(z.string().min(1).max(128)).max(100).optional(),
        scope_id: z.string().max(128).nullable().optional(),
        limit: z.number().int().min(1).max(500).optional()
      },
      async ({ tenant_id, metric_keys, scope_id, limit }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await queryMetrics(tools.env, tenantId, {
          metricKeys: metric_keys,
          scopeId: scope_id,
          limit
        }));
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_domain_recall_feedback",
      {
        tenant_id: z.string().optional(),
        recall_id: z.string().min(1).max(256),
        candidate_id: z.string().max(256).nullable().optional(),
        feedback: z.enum(["useful", "not_relevant", "wrong_scope", "outdated", "incorrect_relation", "dismiss_for_session"]),
        session_id: z.string().max(256).nullable().optional(),
        note: z.string().max(2_000).nullable().optional()
      },
      async ({ tenant_id, recall_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        return toContent(await recordDomainRecallFeedback(tools.env, tenantId, recall_id, payload, {
          ownerPrincipal: tools.props.ownerPrincipal ?? tools.props.principal,
          runtimeActor: tools.props.runtimeActor,
          clientInstallationId: tools.props.clientInstallationId,
          clientName: tools.props.clientType ?? "mcp"
        }));
      }, "write"
    );
}
