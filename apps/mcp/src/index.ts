import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type Env = {
  API: Fetcher;
  ORG_BRAIN_API_KEY: string;
  MCP_BEARER_TOKEN: string;
};

type AgentProps = {
  tenantId: string;
};

type JsonOk<T> = {
  ok: true;
  data: T;
};

type JsonError = {
  ok: false;
  error?: {
    code?: string;
    message?: string;
  };
};

function asJsonContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function resolveTenant(input: string | undefined, props: AgentProps | undefined): string {
  const candidate = input?.trim() || props?.tenantId || "default";
  return candidate.length > 0 ? candidate : "default";
}

function parseApiErrorBody(body: unknown): string {
  if (!body || typeof body !== "object") return "unexpected API response";
  const maybe = body as JsonError;
  if (maybe.error?.message) return maybe.error.message;
  return "unexpected API response";
}

async function callOrgBrainApi<T>(
  env: Env,
  route: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const method = init?.method ?? "GET";
  const headers = new Headers({ "x-api-key": env.ORG_BRAIN_API_KEY });
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }

  const response = await env.API.fetch(`https://internal${route}`, {
    method,
    headers,
    body
  });

  const payload = (await response.json().catch(() => null)) as JsonOk<T> | JsonError | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const detail = parseApiErrorBody(payload);
    throw new Error(`OrgBrain API error (${response.status}): ${detail}`);
  }

  return payload.data;
}

function normalizeAuthHeader(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  return auth.trim();
}

function isAuthorized(req: Request, expectedToken: string): boolean {
  const auth = normalizeAuthHeader(req);
  if (!auth) return false;
  if (auth === expectedToken) return true;
  return auth === `Bearer ${expectedToken}`;
}

export class OrgBrainMCP extends McpAgent<Env, null, AgentProps> {
  server = new McpServer({
    name: "OrgBrain Remote MCP",
    version: "1.0.0"
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const query = new URLSearchParams({
          tenant_id: tenantId,
          limit: String(limit ?? 100)
        });
        if (source && source.trim()) query.set("source", source.trim());
        const data = await callOrgBrainApi<unknown[]>(this.env, `/v1/memories?${query.toString()}`);
        return asJsonContent(data);
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
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memories/propose", {
          method: "POST",
          body: {
            tenant_id: tenantId,
            ...payload
          }
        });
        return asJsonContent(data);
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
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memories/confirm", {
          method: "POST",
          body: {
            tenant_id: tenantId,
            ...payload
          }
        });
        return asJsonContent(data);
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
              project_id: z.string().max(128).optional()
            })
          )
          .min(1)
          .max(200)
      },
      async ({ tenant_id, source, items }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<{ inserted: number; updated: number; source: string; tenant_id: string }>(
          this.env,
          "/v1/memories/upsert",
          {
            method: "POST",
            body: {
              tenant_id: tenantId,
              source: source?.trim() || "openclaw",
              items
            }
          }
        );
        return asJsonContent(data);
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memories/search", {
          method: "POST",
          body: {
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
          }
        });
        return asJsonContent(data);
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memories/profile", {
          method: "POST",
          body: {
            tenant_id: tenantId,
            project_id,
            q,
            limit_durable,
            limit_recent,
            rewrite_query,
            search_mode
          }
        });
        return asJsonContent(data);
      }
    );

    this.server.tool(
      "orgbrain_task_create",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        capability: z.enum(["plan_writer", "code_gen", "code_review"]),
        input_ref: z.string().min(1),
        priority: z.number().int().min(0).max(10).optional(),
        trace_id: z.string().optional(),
        wait_event_type: z.string().optional(),
        idempotency_key: z.string().optional()
      },
      async (payload) => {
        const tenantId = resolveTenant(payload.tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/tasks", {
          method: "POST",
          body: {
            ...payload,
            tenant_id: tenantId
          }
        });
        return asJsonContent(data);
      }
    );

    this.server.tool(
      "orgbrain_task_get",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1)
      },
      async ({ tenant_id, task_id }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const route = `/v1/tasks/${encodeURIComponent(task_id)}?tenant_id=${encodeURIComponent(tenantId)}`;
        const data = await callOrgBrainApi<unknown>(this.env, route);
        return asJsonContent(data);
      }
    );

    this.server.tool(
      "orgbrain_task_events",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional()
      },
      async ({ tenant_id, task_id, limit }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const query = new URLSearchParams({
          tenant_id: tenantId,
          limit: String(limit ?? 50)
        });
        const route = `/v1/tasks/${encodeURIComponent(task_id)}/events?${query.toString()}`;
        const data = await callOrgBrainApi<unknown[]>(this.env, route);
        return asJsonContent(data);
      }
    );

  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    ok: true,
    name: "open-brain-mcp",
    mcp_path: "/mcp",
    auth: "Authorization: Bearer <MCP_BEARER_TOKEN>"
  })
);

app.mount("/mcp", (request, env, ctx) => {
  if (!env.MCP_BEARER_TOKEN || !env.ORG_BRAIN_API_KEY) {
    return new Response("misconfigured: missing MCP_BEARER_TOKEN or ORG_BRAIN_API_KEY", { status: 500 });
  }

  if (!isAuthorized(request, env.MCP_BEARER_TOKEN)) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" }
    });
  }

  const tenantHeader = request.headers.get("x-orgbrain-tenant");
  const tenantId = tenantHeader?.trim() || "default";
  const nextCtx = ctx as ExecutionContext & { props?: AgentProps };
  nextCtx.props = { tenantId };

  // Hono strips the mount prefix before delegating to the mounted handler.
  return OrgBrainMCP.serve("/").fetch(request, env, nextCtx);
});

export default app;
