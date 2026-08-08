import { HttpError, type OrgPermission, type OrgRole } from "@org-brain/shared";
import type { Hono } from "hono";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authorizeMcpRequest } from "./mcp-security";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "./agent-message-service";
import { getTask, getTaskEvents, createTask } from "./task-service";
import type { Env } from "./types";
import {
  createDecisionMemory,
  enrichContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  searchDecisionMemories
} from "./context-engine-service";
import {
  getMemoryProfile,
  listMemories,
  refreshMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import {
  captureMemoryWithInferredRationale,
  confirmProposedMemory,
  proposeMemoryWithRationale
} from "./rationale-service";
import { assertPermission } from "./rbac-service";
import { appendAuditEvent } from "./audit-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import { assertRequestRateLimit } from "./rate-limit-service";
import {
  createBusinessCategory,
  listBusinessCategories,
  updateBusinessCategory
} from "./business-category-service";
import {
  createMemoryFailurePattern,
  listMemoryFailurePatterns,
  memoryImpactReport,
  recordMemoryEffect,
  recordMemoryUsage,
  updateMemoryFailurePattern,
  updateMemoryUsageStates
} from "./memory-effect-service";
import { reportMemoryImpact, startMemoryImpact } from "./memory-impact-service";
import {
  getDecisionResources,
  getResourceDecisions,
  searchKnowledgeResources
} from "./resource-decision-service";

type AgentProps = {
  tenantId: string;
  principal: string;
  allowedTenants: string[];
  defaultRole: OrgRole;
};

const sourceRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  title: z.string().max(240).optional(),
  url: z.string().max(512).optional(),
  updatedAt: z.string().max(64).optional(),
  allowedPrincipals: z.array(z.string().min(1).max(128)).max(64).optional()
});

const ownerRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  name: z.string().max(128).optional()
});

const agentMessageTargetTypeSchema = z.enum(["principal", "agent", "project", "channel"]);
const agentMessageStatusSchema = z.enum(["unread", "read", "acked", "archived", "active"]);

function toContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

type ToolHandler<Shape extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<Shape>>
) => CallToolResult | Promise<CallToolResult>;

function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  inputShape: Shape,
  handler: ToolHandler<Shape>
) {
  return server.registerTool(
    name,
    { inputSchema: z.object(inputShape) },
    handler
  );
}

function normalizeTenant(tenantInput: string | undefined, props: AgentProps | undefined): string {
  if (!props) {
    throw new HttpError(500, "misconfigured", "missing MCP auth context");
  }
  const requested = tenantInput?.trim();
  if (!requested) return props.tenantId;
  if (!props.allowedTenants.includes(requested)) {
    throw new HttpError(403, "forbidden", `tenant not allowed: ${requested}`);
  }
  return requested;
}

class OrgBrainMcpTools {
  server = new McpServer(
    {
      name: "OrgBrain MCP",
      version: "2.0.0"
    },
    {
      instructions:
        "Search OrgBrain before repeating source discovery. Use propose then confirm for interactive memory writes.",
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" }
      }
    }
  );

  constructor(
    readonly env: Env,
    readonly props: AgentProps
  ) {}

  async requirePermission(
    tenantId: string,
    permission: OrgPermission,
    projectId?: string | null
  ) {
    const principal = this.props?.principal;
    if (!principal) throw new HttpError(500, "misconfigured", "missing MCP principal");
    return assertPermission(this.env, {
      tenantId,
      projectId,
      principal,
      permission,
      fallbackRole: this.props?.defaultRole ?? "service_agent"
    });
  }

  async auditedMutation<T>(
    tenantId: string,
    action: string,
    resourceType: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const principal = this.props?.principal ?? "mcp";
    try {
      const result = await operation();
      await appendAuditEvent(this.env, {
        tenantId,
        projectId: null,
        principal,
        action,
        resourceType,
        resourceId: null,
        requestId: null,
        outcome: "succeeded",
        metadata: { transport: "mcp" }
      });
      return result;
    } catch (error) {
      await appendAuditEvent(this.env, {
        tenantId,
        projectId: null,
        principal,
        action,
        resourceType,
        resourceId: null,
        requestId: null,
        outcome: "failed",
        metadata: { transport: "mcp" }
      }).catch(() => undefined);
      throw error;
    }
  }

  async init() {
    const workTypeSchema = z.enum([
      "implementation", "review", "debug", "proposal",
      "support", "research", "operations", "other"
    ]);
    registerTool(this.server, 
      "orgbrain_business_categories_list",
      {
        tenant_id: z.string().optional(),
        include_inactive: z.boolean().optional()
      },
      async ({ tenant_id, include_inactive }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await listBusinessCategories(this.env, tenantId, include_inactive));
      }
    );

    registerTool(this.server, 
      "orgbrain_business_categories_create",
      {
        tenant_id: z.string().optional(),
        slug: z.string().min(1).max(64),
        label: z.string().min(1).max(160),
        description: z.string().max(1000).nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_create",
          "business_category",
          () => createBusinessCategory(this.env, tenantId, payload)
        ));
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_update",
          "business_category",
          () => updateBusinessCategory(this.env, tenantId, category_id, payload)
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_list",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      },
      async ({ tenant_id, source, limit }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const memories = await listMemories(this.env, tenantId, { limit: limit ?? 100, source });
        return toContent(memories);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_extract",
      {
        tenant_id: z.string().optional(),
        event_id: z.string().min(1).max(128),
        project_id: z.string().max(128).nullable().optional(),
        source: z.string().min(1).max(64),
        occurred_at: z.number().int(),
        text: z.string().min(1).max(100_000),
        source_references: z.array(z.object({
          type: z.string().min(1).max(64),
          ref: z.string().min(1).max(512),
          title: z.string().max(240).optional(),
          captured_at: z.number().int().optional()
        })).max(32).optional()
      },
      async ({ tenant_id, ...event }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", event.project_id);
        return toContent(await extractMemoryCandidates(this.env, {
          ...event,
          tenant_id: tenantId,
          actor_type: "principal",
          actor_id: this.props?.principal ?? "mcp"
        }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_propose",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        actor_type: z.string().optional(),
        actor_id: z.string().optional(),
        item: z.object({
          external_key: z.string().max(256).optional(),
          content: z.string().min(1).max(20000),
          summary: z.string().max(1000).optional(),
          tags: z.array(z.string().min(1).max(64)).max(16).optional(),
          created_at: z.number().int().optional(),
          project_id: z.string().max(128).nullable().optional(),
          business_category_id: z.string().max(128).nullable().optional(),
          work_type: workTypeSchema.nullable().optional()
        }),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.item.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_propose",
          "memory",
          () => proposeMemoryWithRationale(this.env, { tenant_id: tenantId, ...payload })
        );
        return toContent(result);
      }
    );

    registerTool(this.server,
      "orgbrain_memories_capture_rationale",
      {
        tenant_id: z.string().optional(),
        source: z.string().min(1).max(64).optional(),
        item: z.object({
          external_key: z.string().min(1).max(256),
          content: z.string().min(1).max(20000),
          summary: z.string().max(1000).optional(),
          tags: z.array(z.string().min(1).max(64)).max(16).optional(),
          created_at: z.number().int().optional(),
          project_id: z.string().max(128).nullable().optional(),
          business_category_id: z.string().max(128).nullable().optional(),
          work_type: workTypeSchema.nullable().optional()
        })
      },
      async ({ tenant_id, source, item }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", item.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_capture_rationale",
          "memory",
          () => captureMemoryWithInferredRationale(this.env, {
            tenant_id: tenantId,
            source: source?.trim() || "hook",
            actor_type: "principal",
            actor_id: this.props.principal,
            item
          })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_confirm",
      {
        tenant_id: z.string().optional(),
        confirmation_token: z.string().min(1).max(64),
        approved: z.boolean(),
        conclusion: z.string().max(240).optional(),
        reason_summary: z.string().max(500).optional(),
        decision_type: z.enum(["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"]).optional(),
        status: z.string().max(64).optional(),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_confirm",
          "memory",
          () => confirmProposedMemory(this.env, { tenant_id: tenantId, ...payload })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_upsert",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        items: z
          .array(
            z.object({
              external_key: z.string().min(1).max(256),
              content: z.string().min(1).max(20000),
              summary: z.string().max(1000).optional(),
              tags: z.array(z.string().min(1).max(64)).max(16).optional(),
              created_at: z.number().int().optional(),
              project_id: z.string().max(128).nullable().optional(),
              business_category_id: z.string().max(128).nullable().optional(),
              work_type: workTypeSchema.nullable().optional()
            })
          )
          .min(1)
          .max(200)
      },
      async ({ tenant_id, source, items }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", items[0]?.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_upsert",
          "memory",
          () => upsertMemories(this.env, {
            tenant_id: tenantId,
            source: source?.trim() || "openclaw",
            items
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
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
        trace_id: z.string().max(128).nullable().optional(),
        external_run_id: z.string().max(256).nullable().optional()
      },
      async ({ tenant_id, project_id, q, limit, rewrite_query, search_mode, retrieval_profile, search_scope, business_category_id, work_type, include_history, entity_id, entity_role, decision_type, decision_status, confirmation_state, reason_text, generation_id, ranking_profile_id, task_id, trace_id, external_run_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, generation_id || ranking_profile_id ? "admin" : "read", project_id);
        const request = {
          tenant_id: tenantId,
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
          task_id,
          trace_id,
          external_run_id
        };
        if (search_scope === "governance") {
          return toContent(await searchDecisionMemories(this.env, request, { principal: this.props?.principal }));
        }
        const evidence = await searchMemories(this.env, request, {
          actorPrincipal: this.props?.principal,
          recordUsage: search_scope !== "both"
        });
        if (search_scope !== "both") return toContent(evidence);
        const governance = await searchDecisionMemories(this.env, request, {
          principal: this.props?.principal,
          recordUsage: false
        });
        const queryHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(q))
          .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
        const governanceResults = governance.results as Array<Record<string, unknown>>;
        const usage = await recordMemoryUsage(this.env, {
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
          actor_principal: this.props?.principal ?? null,
          items: [
            ...evidence.results.filter((item) => item.kind === "memory").map((item, index) => ({
              source_type: "memory" as const,
              source_id: item.id,
              source_version: item.current_version ?? null,
              rank: index + 1,
              score: item.score,
              reference_type: "returned" as const,
              used_state: "unknown" as const
            })),
            ...governanceResults.flatMap((item, index) => typeof item.id === "string" ? [{
              source_type: "decision_memory" as const,
              source_id: item.id,
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
          meta: {
            usage_id: usage.usage_id,
            verification_sampled: usage.verification_sampled,
            channel_usage_ids: {
              evidence: usage.usage_id,
              governance: usage.usage_id
            }
          }
        });
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_retrieve_context",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(50).optional(),
        token_budget: z.number().int().min(512).max(16000).optional(),
        search_mode: z.enum(["hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, business_category_id, work_type, q, top_k, token_budget, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await retrieveMemoryContext(this.env, {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type,
          q,
          top_k,
          token_budget,
          search_mode
        }, { actorPrincipal: this.props?.principal }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_profile",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500).optional(),
        limit_durable: z.number().int().min(1).max(16).optional(),
        limit_recent: z.number().int().min(1).max(16).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, business_category_id, work_type, q, limit_durable, limit_recent, rewrite_query, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const result = await getMemoryProfile(this.env, {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type,
          q,
          limit_durable,
          limit_recent,
          rewrite_query,
          search_mode
        }, { actorPrincipal: this.props?.principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_context_enrich",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        user_id: z.string().max(128).optional(),
        agent_id: z.string().max(128).optional(),
        task_type: z.enum(["implementation", "review", "debug", "proposal", "support"]).optional(),
        task: z.object({
          title: z.string().max(240).optional(),
          description: z.string().max(2000).optional(),
          target_files: z.array(z.string().max(256)).max(32).optional(),
          related_issue_ids: z.array(z.string().max(128)).max(32).optional()
        }),
        max_tokens: z.number().int().min(500).max(32000).optional(),
        include_sources: z.boolean().optional(),
        include_conflicts: z.boolean().optional(),
        debug_scores: z.boolean().optional()
      },
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await enrichContext(this.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await preActionDecisionGate(
          this.env,
          { tenant_id: tenantId, ...payload },
          { principal: this.props?.principal ?? "mcp" }
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_review_queue",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        within_days: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await getDecisionReviewQueue(
          this.env,
          { tenant_id: tenantId, ...payload },
          { principal: this.props?.principal ?? "mcp" }
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_memories_create",
      {
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_decision_memories_create",
          "decision_memory",
          () => createDecisionMemory(this.env, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(
          tenantId,
          payload.generation_id || payload.ranking_profile_id ? "admin" : "read",
          payload.project_id
        );
        const principal = this.props?.principal ?? "mcp";
        const result = await searchDecisionMemories(this.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_failure_patterns_list",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional()
      },
      async ({ tenant_id, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await listMemoryFailurePatterns(this.env, tenantId, project_id));
      }
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
    registerTool(this.server, 
      "orgbrain_memory_failure_pattern_create",
      { ...failurePatternSchema, pattern_key: z.string().min(1).max(128), label: z.string().min(1).max(240) },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_create",
          "memory_failure_pattern",
          () => createMemoryFailurePattern(this.env, tenantId, payload)
        ));
      }
    );
    registerTool(this.server, 
      "orgbrain_memory_failure_pattern_update",
      { pattern_id: z.string().min(1).max(128), ...failurePatternSchema },
      async ({ tenant_id, pattern_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_update",
          "memory_failure_pattern",
          () => updateMemoryFailurePattern(this.env, tenantId, pattern_id, payload)
        ));
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_usage_state_update",
          "memory_usage",
          () => updateMemoryUsageStates(this.env, tenantId, payload)
        ));
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_effect_record",
          "memory_effect",
          () => recordMemoryEffect(this.env, tenantId, { tenant_id: tenantId, ...payload })
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_impact_metrics",
      {
        tenant_id: z.string().optional(),
        group_by: z.enum(["memory", "business_category", "work_type", "project", "day"]).optional()
      },
      async ({ tenant_id, group_by }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await memoryImpactReport(this.env, tenantId, { group_by }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_refresh",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        confidence_delta: z.number().optional()
      },
      async ({ tenant_id, memory_id, confidence_delta }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_refresh",
          "memory",
          () => refreshMemoryByRequest(this.env, {
            tenant_id: tenantId,
            memory_id,
            confidence_delta,
            actor_type: "principal",
            actor_id: this.props?.principal ?? null
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_suppress",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        reason: z.string().min(1).max(500)
      },
      async ({ tenant_id, memory_id, reason }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_suppress",
          "memory",
          () => suppressMemoryByRequest(this.env, {
            tenant_id: tenantId,
            memory_id,
            reason,
            actor_type: "principal",
            actor_id: this.props?.principal ?? null
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_send",
          "agent_message",
          () => sendAgentMessage(this.env, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", project_id);
        const principal = this.props?.principal ?? "mcp";
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
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_handoff_send",
          "agent_handoff",
          () => sendAgentMessage(this.env, {
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
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await listAgentMessages(this.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_get",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const principal = this.props?.principal ?? "mcp";
        const result = await getAgentMessage(this.env, tenantId, message_id, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_read",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_read",
          "agent_message",
          () => markAgentMessageRead(this.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_ack",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_ack",
          "agent_message",
          () => ackAgentMessage(this.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(payload.tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_start",
          "memory_impact_execution",
          () => startMemoryImpact(this.env, tenantId, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
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
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_report",
          "memory_impact_execution",
          () => reportMemoryImpact(this.env, tenantId, external_run_id, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_create",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        capability: z.enum(["memory_measurement"]),
        input_ref: z.string().min(1),
        priority: z.number().int().min(0).max(10).optional(),
        trace_id: z.string().optional(),
        wait_event_type: z.string().optional(),
        idempotency_key: z.string().optional()
      },
      async (payload) => {
        const tenantId = normalizeTenant(payload.tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_task_create",
          "task",
          () => createTask(this.env, {
            ...payload,
            tenant_id: tenantId
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_get",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1)
      },
      async ({ tenant_id, task_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const task = await getTask(this.env, tenantId, task_id);
        return toContent(task);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_events",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().optional()
      },
      async ({ tenant_id, task_id, limit, cursor }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const events = await getTaskEvents(this.env, tenantId, task_id, limit ?? 50, cursor);
        return toContent(events);
      }
    );

    registerTool(this.server, 
      "orgbrain_resource_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        q: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        if (this.env.KNOWLEDGE_RESOURCE_INGESTION_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await searchKnowledgeResources(this.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal, projectId: payload.project_id ?? null }));
      }
    );

    registerTool(this.server, 
      "orgbrain_resource_decisions",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        resource_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, resource_id }) => {
        if (this.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await getResourceDecisions(this.env, tenantId, resource_id, {
          principal,
          projectId: project_id ?? null
        }));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_resources",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        source_type: z.enum(["decision_memory", "decision_rationale"]),
        source_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, source_type, source_id }) => {
        if (this.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await getDecisionResources(this.env, tenantId, {
          source_type,
          source_id
        }, { principal, projectId: project_id ?? null }));
      }
    );

  }
}

export async function createOrgBrainMcpServer(env: Env, props: AgentProps) {
  const tools = new OrgBrainMcpTools(env, props);
  await tools.init();
  return tools.server;
}

export function mountMcp(app: Hono<any>) {
  app.mount("/mcp", async (request, env, ctx) => {
    try {
      const auth = authorizeMcpRequest(request, env);
      await assertRequestRateLimit(env, {
        tenantId: auth.tenantId,
        principal: auth.principal,
        path: "/mcp"
      });
      const props: AgentProps = {
        tenantId: auth.tenantId,
        principal: auth.principal,
        allowedTenants: auth.allowedTenants,
        defaultRole: auth.defaultRole
      };
      const handler = createMcpHandler(
        () => createOrgBrainMcpServer(env, props),
        {
          route: "/",
          legacy: "stateless",
          corsOptions: false,
          authContext: { props }
        }
      );
      return handler(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status });
      }
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  });
}
