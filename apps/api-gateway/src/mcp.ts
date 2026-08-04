import { HttpError, type OrgPermission, type OrgRole } from "@org-brain/shared";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
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
import { confirmProposedMemory, proposeMemoryWithRationale } from "./rationale-service";
import { assertPermission } from "./rbac-service";
import { appendAuditEvent } from "./audit-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import { assertRequestRateLimit } from "./rate-limit-service";

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

export class OrgBrainMCP extends McpAgent<Env, null, AgentProps> {
  server = new McpServer({
    name: "OrgBrain MCP",
    version: "1.1.0"
  });

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
    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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
          project_id: z.string().max(128).nullable().optional()
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

    this.server.tool(
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

    this.server.tool(
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
              project_id: z.string().max(128).nullable().optional()
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

    this.server.tool(
      "orgbrain_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional(),
        include_history: z.boolean().optional(),
        entity_id: z.string().optional(),
        entity_role: z.string().optional(),
        decision_type: z.string().optional(),
        decision_status: z.string().optional(),
        confirmation_state: z.string().optional(),
        reason_text: z.string().max(240).optional()
      },
      async ({ tenant_id, project_id, q, limit, rewrite_query, search_mode, include_history, entity_id, entity_role, decision_type, decision_status, confirmation_state, reason_text }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const result = await searchMemories(this.env, {
          tenant_id: tenantId,
          project_id,
          q,
          limit,
          rewrite_query,
          search_mode,
          include_history,
          entity_id,
          entity_role,
          decision_type,
          decision_status,
          confirmation_state,
          reason_text
        }, { actorPrincipal: this.props?.principal });
        return toContent(result);
      }
    );

    this.server.tool(
      "orgbrain_memories_retrieve_context",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(50).optional(),
        token_budget: z.number().int().min(512).max(16000).optional(),
        search_mode: z.enum(["hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, q, top_k, token_budget, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await retrieveMemoryContext(this.env, {
          tenant_id: tenantId,
          project_id,
          q,
          top_k,
          token_budget,
          search_mode
        }, { actorPrincipal: this.props?.principal }));
      }
    );

    this.server.tool(
      "orgbrain_memories_profile",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().min(1).max(500).optional(),
        limit_durable: z.number().int().min(1).max(16).optional(),
        limit_recent: z.number().int().min(1).max(16).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, q, limit_durable, limit_recent, rewrite_query, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const result = await getMemoryProfile(this.env, {
          tenant_id: tenantId,
          project_id,
          q,
          limit_durable,
          limit_recent,
          rewrite_query,
          search_mode
        });
        return toContent(result);
      }
    );

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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
        allowed_principals: z.array(z.string().min(1).max(128)).max(64).optional()
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

    this.server.tool(
      "orgbrain_decision_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        user_id: z.string().max(128).optional(),
        agent_id: z.string().max(128).optional()
      },
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
      "orgbrain_messages_send",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema,
        target_key: z.string().min(1).max(256),
        subject: z.string().max(500).nullable().optional(),
        body: z.string().min(1).max(20_000),
        metadata: z.record(z.unknown()).optional(),
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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

    this.server.tool(
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
          })
        );
        return toContent(result);
      }
    );

    this.server.tool(
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

    this.server.tool(
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

  }
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
      const runtimeCtx = ctx as ExecutionContext & { props?: AgentProps };
      runtimeCtx.props = {
        tenantId: auth.tenantId,
        principal: auth.principal,
        allowedTenants: auth.allowedTenants,
        defaultRole: auth.defaultRole
      };
      return OrgBrainMCP.serve("/").fetch(request, env, runtimeCtx);
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status });
      }
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  });
}
