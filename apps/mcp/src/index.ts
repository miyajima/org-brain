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

const PROXY_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "x-orgbrain-tenant",
  "cf-access-jwt-assertion"
] as const;

const PROXY_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "www-authenticate"
] as const;

export function buildMcpProxyRequest(request: Request): Request {
  const sourceUrl = new URL(request.url);
  const suffix = sourceUrl.pathname.startsWith("/mcp")
    ? sourceUrl.pathname.slice("/mcp".length)
    : sourceUrl.pathname;
  const target = new URL(`https://internal/mcp${suffix || ""}`);
  target.search = sourceUrl.search;
  const headers = new Headers();
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
    throw new Error("MCP request body exceeds 1 MiB");
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    duplex: "half"
  };
  return new Request(target, init);
}

async function proxyMcpRequest(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get("cf-access-jwt-assertion")?.trim()) {
    return new Response("missing Cloudflare Access assertion", { status: 401 });
  }
  let upstreamRequest: Request;
  try {
    upstreamRequest = buildMcpProxyRequest(request);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 413 });
  }
  const upstream = await env.API.fetch(upstreamRequest);
  const headers = new Headers();
  for (const name of PROXY_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

const agentMessageTargetTypeSchema = z.enum(["principal", "agent", "project", "channel"]);
const agentMessageStatusSchema = z.enum(["unread", "read", "acked", "archived", "active"]);

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
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
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
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
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
        limit: z.number().int().min(1).max(50).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional(),
        include_history: z.boolean().optional(),
        entity_id: z.string().optional(),
        entity_role: z.string().optional(),
        decision_type: z.string().optional(),
        decision_status: z.string().optional(),
        confirmation_state: z.string().optional(),
        reason_text: z.string().max(240).optional(),
        task_id: z.string().max(128).nullable().optional(),
        trace_id: z.string().max(128).nullable().optional(),
        external_run_id: z.string().max(256).nullable().optional()
      },
      async ({ tenant_id, project_id, q, limit, rewrite_query, search_mode, include_history, entity_id, entity_role, decision_type, decision_status, confirmation_state, reason_text, task_id, trace_id, external_run_id }) => {
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
            reason_text,
            task_id,
            trace_id,
            external_run_id
          }
        });
        return asJsonContent(data);
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memories/retrieve-context", {
          method: "POST",
          body: {
            tenant_id: tenantId,
            project_id,
            q,
            top_k,
            token_budget,
            search_mode
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
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional()
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
        capability: z.enum(["memory_measurement"]),
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/agent-messages", {
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
      async ({ tenant_id, project_id, target_type, target_key, status, limit, cursor }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const query = new URLSearchParams({
          tenant_id: tenantId,
          limit: String(limit ?? 50)
        });
        if (project_id) query.set("project_id", project_id);
        if (target_type) query.set("target_type", target_type);
        if (target_key) query.set("target_key", target_key);
        if (status) query.set("status", status);
        if (cursor) query.set("cursor", String(cursor));
        const data = await callOrgBrainApi<unknown>(this.env, `/v1/agent-messages?${query.toString()}`);
        return asJsonContent(data);
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
      async ({ tenant_id, message_id, target_type, target_key }) => {
        const tenantId = resolveTenant(tenant_id, this.props);
        const query = new URLSearchParams({ tenant_id: tenantId });
        if (target_type) query.set("target_type", target_type);
        if (target_key) query.set("target_key", target_key);
        const route = `/v1/agent-messages/${encodeURIComponent(message_id)}?${query.toString()}`;
        const data = await callOrgBrainApi<unknown>(this.env, route);
        return asJsonContent(data);
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(
          this.env,
          `/v1/agent-messages/${encodeURIComponent(message_id)}/read`,
          {
            method: "POST",
            body: {
              tenant_id: tenantId,
              ...payload
            }
          }
        );
        return asJsonContent(data);
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(
          this.env,
          `/v1/agent-messages/${encodeURIComponent(message_id)}/ack`,
          {
            method: "POST",
            body: {
              tenant_id: tenantId,
              ...payload
            }
          }
        );
        return asJsonContent(data);
      }
    );

    this.server.tool(
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
        const tenantId = resolveTenant(payload.tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(this.env, "/v1/memory-impact-executions", {
          method: "POST",
          body: { ...payload, tenant_id: tenantId }
        });
        return asJsonContent(data);
      }
    );

    this.server.tool(
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
        const tenantId = resolveTenant(tenant_id, this.props);
        const data = await callOrgBrainApi<unknown>(
          this.env,
          `/v1/memory-impact-executions/${encodeURIComponent(external_run_id)}/report`,
          { method: "POST", body: { ...payload, tenant_id: tenantId } }
        );
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
    auth: "Cloudflare Access Managed OAuth or per-installation service token"
  })
);

export function legacyMcpFetch(request: Request, env: Env, ctx: ExecutionContext) {
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
}

app.mount("/mcp", (request, env) => proxyMcpRequest(request, env));

export default app;
