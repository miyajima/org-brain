import { MEMORY_READ_SCOPES, HttpError, sha256 } from "@org-brain/shared";
import { z } from "zod";
import { searchDecisionMemories } from "../context-engine-service";
import { getMemoryProfile, listMemoriesCursorPage, retrieveMemoryContext, searchMemories } from "../memory-service";
import { sharedKnowledgeForSearch } from "../team-knowledge-service";
import { recordMemoryUsage } from "../memory-effect-service";
import { getMemoryQualityAudit } from "../memory-quality-service";
import { isResumeInstruction } from "../natural-task-search-service";
import type { OrgBrainMcpTools } from "../mcp";
import { toContent, registerTool, normalizeTenant, workTypeSchema } from "./common";

export function registerMemoryRead(tools: OrgBrainMcpTools) {
  registerTool(tools.server, 
      "orgbrain_memories_list",
      {
        tenant_id: z.string().optional(),
        scope: z.enum(MEMORY_READ_SCOPES).optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(512).optional(),
        view: z.enum(["full", "compact"]).optional()
      },
      async ({ scope, tenant_id, source, limit, cursor, view }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read");
        const memories = await listMemoriesCursorPage(tools.env, tenantId, {
          readAccess: { principal: tools.props.principal, scope, isAdmin: tools.props.defaultRole === "tenant_admin" },
          limit: limit ?? (view === "compact" ? 500 : 100),
          source,
          cursor,
          view
        });
        return toContent(memories);
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_memory_quality_audit",
      {
        tenant_id: z.string().optional(),
        scope: z.enum(["project", "tenant"]),
        project_id: z.string().min(1).max(128).nullable().optional()
      },
      async ({ tenant_id, scope, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        const projectId = project_id?.trim() || null;
        if (scope === "project" && !projectId) {
          throw new HttpError(400, "project_id_required", "project_id is required for project audit");
        }
        await tools.requirePermission(
          tenantId,
          scope === "tenant" ? "memory:audit" : "read",
          scope === "project" ? projectId : null
        );
        return toContent(await getMemoryQualityAudit(tools.env, tenantId, {
          scope,
          projectId,
          principal: tools.props.principal
        }));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_memories_search",
      {
        tenant_id: z.string().optional(),
        scope: z.enum(MEMORY_READ_SCOPES).optional(),
        project_id: z.string().nullable().optional(),
        strict_project: z.boolean().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional(),
        retrieval_profile: z.enum(["default", "lexical", "hybrid", "structured"]).optional(),
        search_scope: z.enum(["evidence", "governance", "both"]).optional(),
        include_history: z.boolean().optional(),
        entity_id: z.string().optional(),
        entity_role: z.string().optional(),
        decision_type: z.string().optional(),
        decision_status: z.string().optional(),
        confirmation_state: z.string().optional(),
        reason_text: z.string().max(240).optional(),
        generation_id: z.string().max(128).nullable().optional(),
        ranking_profile_id: z.string().max(128).nullable().optional(),
        task_id: z.string().max(128).nullable().optional(),
        task_context: z.object({project_id:z.string().min(1).max(128),task_key:z.string().min(1).max(128),subject_query:z.string().min(1).max(500)}).strict().optional(),
        use_snapshot_id: z.string().max(128).optional(),
        use_context: z.object({task:z.string().max(600).optional(),target:z.string().max(600).optional(),constraints:z.string().max(600).optional(),conditions:z.string().max(600).optional()}).optional(),
        trace_id: z.string().max(128).nullable().optional(),
        external_run_id: z.string().max(256).nullable().optional(),
        token_budget: z.number().int().min(512).max(16000).optional()
          .describe("Caller token budget. Currently bounds only the shared team knowledge appended to results (25% of it).")
      },
      async ({ scope, tenant_id, project_id, strict_project, q, limit, rewrite_query, search_mode, retrieval_profile, search_scope, business_category_id, work_type, include_history, entity_id, entity_role, decision_type, decision_status, confirmation_state, reason_text, generation_id, ranking_profile_id, task_id, task_context, use_context, use_snapshot_id, trace_id, external_run_id, token_budget }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        if (strict_project && (!project_id?.trim() || search_scope && search_scope !== 'evidence')) {
          throw new HttpError(400, 'explicit_evidence_project_required', 'Strict project search requires an explicit evidence project');
        }
        await tools.requirePermission(tenantId, generation_id || ranking_profile_id ? "admin" : "read", project_id);
        const request = {
          tenant_id: tenantId,
          scope,
          project_id,
          business_category_id,
          work_type,
          q,
          limit,
          rewrite_query,
          search_mode,
          retrieval_profile,
          include_history,
          entity_id,
          entity_role,
          decision_type,
          decision_status,
          confirmation_state,
          reason_text,
          generation_id,
          ranking_profile_id,
          task_id, task_context,
          use_context,
          use_snapshot_id,
          trace_id,
          external_run_id
        };
        if (isResumeInstruction(q) && search_scope && search_scope !== "evidence") throw new HttpError(400,"resume_evidence_scope_required","Resume context currently supports evidence memory only");
        const shared = () => strict_project || isResumeInstruction(q)
          ? {}
          : sharedKnowledgeForSearch(tools.env, { tenantId, principal: tools.props.principal }, { ...request, token_budget },
            { accessPath: "memory_search_mcp", waitUntil: tools.executionContext && (promise => tools.executionContext!.waitUntil(promise)) });
        if (search_scope === "governance") {
          return toContent({ ...await searchDecisionMemories(tools.env, request, { principal: tools.props?.principal }), ...await shared() });
        }
        const evidence = await searchMemories(tools.env, request, {
          actorPrincipal: tools.props?.principal,
          allowedProjectId: strict_project ? project_id! : undefined,
          recordUsage: search_scope !== "both"
        });
        if (search_scope !== "both") return toContent({ ...evidence, ...await shared() });
        const governance = await searchDecisionMemories(tools.env, request, {
          principal: tools.props?.principal,
          recordUsage: false
        });
        const queryHash = await sha256(q);
        const governanceResults = governance.results as Array<Record<string, unknown>>;
        const usage = await recordMemoryUsage(tools.env, {
          tenant_id: tenantId,
          project_id: project_id ?? undefined,
          task_id: task_id ?? undefined,
          trace_id: trace_id ?? undefined,
          external_run_id: external_run_id ?? undefined,
          capability: "memory_search_both",
          access_path: "search",
          request_source: "mcp",
          query_hash: queryHash,
          requested_business_category_id: business_category_id ?? null,
          requested_work_type: work_type ?? null,
          retrieval_generation_id: evidence.meta.retrieval?.generation_id === governance.meta.retrieval.generation_id
            ? evidence.meta.retrieval?.generation_id
            : null,
          ranking_profile_id: evidence.meta.retrieval?.ranking_profile_id === governance.meta.retrieval.ranking_profile_id
            ? evidence.meta.retrieval?.ranking_profile_id
            : null,
          actor_principal: tools.props?.principal ?? null,
          items: [
            ...evidence.results.filter((item) => item.kind === "memory").map((item, index) => ({
              source_type: "memory" as const,
              source_id: item.id,
              source_tenant_id: item.tenant_id,
              source_version: item.current_version ?? null,
              rank: index + 1,
              score: item.score,
              reference_type: "returned" as const,
              used_state: "unknown" as const
            })),
            ...governanceResults.flatMap((item, index) => typeof item.id === "string" ? [{
              source_type: "decision_memory" as const,
              source_id: item.id,
              source_tenant_id: typeof item.tenant_id === "string" ? item.tenant_id : undefined,
              rank: index + 1,
              score: typeof (item.score as Record<string, unknown> | undefined)?.finalScore === "number"
                ? Number((item.score as Record<string, unknown>).finalScore)
                : null,
              reference_type: "returned" as const,
              used_state: "unknown" as const
            }] : [])
          ]
        });
        return toContent({
          search_scope: "both",
          governance,
          evidence,
          ...await shared(),
          meta: {
            usage_id: usage.usage_id,
            verification_sampled: usage.verification_sampled,
            channel_usage_ids: {
              evidence: usage.usage_id,
              governance: usage.usage_id
            }
          }
        });
      }, "read"
    );

  registerTool(tools.server,
      "orgbrain_memories_retrieve_context",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        task_id:z.string().max(128).optional(),
        task_context: z.object({project_id:z.string().min(1).max(128),task_key:z.string().min(1).max(128),subject_query:z.string().min(1).max(500)}).strict().optional(),
        use_snapshot_id:z.string().max(128).optional(),
        use_context:z.object({task:z.string().max(600).optional(),target:z.string().max(600).optional(),constraints:z.string().max(600).optional(),conditions:z.string().max(600).optional()}).optional(),
        q: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(50).optional(),
        token_budget: z.number().int().min(512).max(16000).optional(),
        search_mode: z.enum(["hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, business_category_id, work_type, task_id, task_context, use_context, use_snapshot_id, q, top_k, token_budget, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        return toContent(await retrieveMemoryContext(tools.env, {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type, task_id, task_context, use_context, use_snapshot_id,
          q,
          top_k,
          token_budget,
          search_mode
        }, { actorPrincipal: tools.props?.principal }));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_memories_profile",
      {
        tenant_id: z.string().optional(),
        scope: z.enum(MEMORY_READ_SCOPES).optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500).optional(),
        limit_durable: z.number().int().min(1).max(16).optional(),
        limit_recent: z.number().int().min(1).max(16).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ scope, tenant_id, project_id, business_category_id, work_type, q, limit_durable, limit_recent, rewrite_query, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", project_id);
        const result = await getMemoryProfile(tools.env, {
          tenant_id: tenantId,
          scope,
          project_id,
          business_category_id,
          work_type,
          q,
          limit_durable,
          limit_recent,
          rewrite_query,
          search_mode
        }, { actorPrincipal: tools.props?.principal });
        return toContent(result);
      }, "read"
    );
}
