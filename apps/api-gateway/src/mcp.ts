import { HttpError } from "@org-brain/shared";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { authorizeMcpRequest } from "./mcp-security";
import { getTask, getTaskEvents, createTask } from "./task-service";
import type { Env } from "./types";
import {
  getMemoryProfile,
  listMemories,
  refreshMemoryByRequest,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import { confirmProposedMemory, proposeMemoryWithRationale } from "./rationale-service";

type AgentProps = {
  tenantId: string;
  principal: string;
  allowedTenants: string[];
};

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
        const memories = await listMemories(this.env, tenantId, { limit: limit ?? 100, source });
        return toContent(memories);
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
        const result = await proposeMemoryWithRationale(this.env, { tenant_id: tenantId, ...payload });
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
        const result = await confirmProposedMemory(this.env, { tenant_id: tenantId, ...payload });
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
        const result = await upsertMemories(this.env, {
          tenant_id: tenantId,
          source: source?.trim() || "openclaw",
          items
        });
        return toContent(result);
      }
    );

    this.server.tool(
      "orgbrain_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid"]).optional(),
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
        });
        return toContent(result);
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
        search_mode: z.enum(["memories", "hybrid"]).optional()
      },
      async ({ tenant_id, project_id, q, limit_durable, limit_recent, rewrite_query, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
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
      "orgbrain_memories_refresh",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        confidence_delta: z.number().optional()
      },
      async ({ tenant_id, memory_id, confidence_delta }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        const result = await refreshMemoryByRequest(this.env, {
          tenant_id: tenantId,
          memory_id,
          confidence_delta,
          actor_type: "principal",
          actor_id: this.props?.principal ?? null
        });
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
        const result = await suppressMemoryByRequest(this.env, {
          tenant_id: tenantId,
          memory_id,
          reason,
          actor_type: "principal",
          actor_id: this.props?.principal ?? null
        });
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
        const result = await createTask(this.env, {
          ...payload,
          tenant_id: tenantId
        });
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
        const events = await getTaskEvents(this.env, tenantId, task_id, limit ?? 50, cursor);
        return toContent(events);
      }
    );

  }
}

export function mountMcp(app: Hono<{ Bindings: Env }>) {
  app.mount("/mcp", (request, env, ctx) => {
    try {
      const auth = authorizeMcpRequest(request, env);
      const runtimeCtx = ctx as ExecutionContext & { props?: AgentProps };
      runtimeCtx.props = {
        tenantId: auth.tenantId,
        principal: auth.principal,
        allowedTenants: auth.allowedTenants
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
