import { registerMemoryRead } from "./mcp/memory-read";
import { registerMemoryCapture } from "./mcp/memory-capture";
import { registerContextUse } from "./mcp/context-use";
import { registerKnowledge } from "./mcp/knowledge";
import { registerOperations } from "./mcp/operations";
import { registerTool, normalizeTenant, toContent, type AgentProps } from "./mcp/common";

import { CloudAmpService, ampSourceInputShape, ampSourceReadInputShape } from "./amp-service";
import { AMP_INPUT_SCHEMAS } from "../../../packages/shared/src/agent-memory-protocol.mjs";

import { HttpError, type OrgPermission, type OrgBrainOAuthScope } from "@org-brain/shared";


import { permissionsForScopes } from "@org-brain/core";
import type { Hono } from "hono";
import { hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, McpServer, originValidationResponse } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { requirementForMcpTool } from "@org-brain/mcp-core";
import { accessServiceSubject, authorizeMcpRequest, verifyMcpAccessAssertion, type McpAuthResult } from "./mcp-security";
import { activateMcpClientInstallation } from "./mcp-client-installation-service";


import type { Env } from "./types";


import { assertPermission } from "./rbac-service";
import { appendAuditEvent } from "./audit-service";

import { assertRequestRateLimit } from "./rate-limit-service";


class McpInsufficientScopeError extends Error {
  constructor(readonly scope: OrgBrainOAuthScope) {
    super(`OAuth token does not grant ${scope}`);
    this.name = "McpInsufficientScopeError";
  }
}


async function requireMcpPermission(
  env: Env,
  props: AgentProps,
  tenantId: string,
  permission: OrgPermission,
  projectId?: string | null
) {
  const principal = props.principal;
  if (!principal) throw new HttpError(500, "misconfigured", "missing MCP principal");
  if (props.authSource === "oauth" && !permissionsForScopes(props.scopes ?? []).includes(permission)) {
    throw new HttpError(403, "insufficient_scope", `OAuth token does not grant ${permission}`);
  }
  try {
    return await assertPermission(env, {
      tenantId,
      projectId,
      principal,
      permission,
      fallbackRole: props.defaultRole
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({
      event: "mcp_permission_failed",
      auth_source: props.authSource ?? "unknown",
      permission,
      has_project_scope: Boolean(projectId),
      error_code: error instanceof HttpError ? error.code : null,
      error_status: error instanceof HttpError ? error.status : null,
      error_message: failure.message
        .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
        .slice(0, 300)
    }));
    throw error;
  }
}

export class OrgBrainMcpTools {
  server = new McpServer(
    {
      name: "OrgBrain MCP",
      version: "2.0.0"
    },
    {
      instructions:
        "Search OrgBrain before repeating source discovery. Use propose then confirm for interactive memory writes.",
      supportedProtocolVersions: ["2026-07-28"],
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" }
      }
    }
  );

  constructor(
    readonly env: Env,
    readonly props: AgentProps,
    readonly executionContext?: Pick<ExecutionContext, "waitUntil">
  ) {}

  async requirePermission(
    tenantId: string,
    permission: OrgPermission,
    projectId?: string | null
  ) {
    return requireMcpPermission(this.env, this.props, tenantId, permission, projectId);
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
        metadata: {
          transport: "mcp",
          auth_source: this.props.authSource ?? "unknown",
          runtime_actor: this.props.runtimeActor ?? principal,
          client_installation_id: this.props.clientInstallationId ?? null,
          client_type: this.props.clientType ?? null
        }
      });
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(JSON.stringify({
        event: "mcp_audited_mutation_failed",
        action,
        error_name: failure.name,
        error_code: error instanceof HttpError ? error.code : null,
        error_status: error instanceof HttpError ? error.status : null,
        error_message: failure.message
          .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
          .slice(0, 300)
      }));
      await appendAuditEvent(this.env, {
        tenantId,
        projectId: null,
        principal,
        action,
        resourceType,
        resourceId: null,
        requestId: null,
        outcome: "failed",
        metadata: {
          transport: "mcp",
          auth_source: this.props.authSource ?? "unknown",
          runtime_actor: this.props.runtimeActor ?? principal,
          client_installation_id: this.props.clientInstallationId ?? null,
          client_type: this.props.clientType ?? null
        }
      }).catch(() => undefined);
      throw error;
    }
  }

  async init() {
    if (this.env.ORGBRAIN_AMP_ENABLED === "true") {
      const scope = { tenant_id: z.string().optional(), project_id: z.string().trim().min(1).max(256), wiki_id: z.literal("personal").optional() };
      const definitions = [
        ...Object.entries(AMP_INPUT_SCHEMAS).map(([action, schema]) => ({
          name: `orgbrain_wiki_amp_${action}`, action, shape: schema.shape
        })),
        { name: "orgbrain_wiki_ingest", action: "ingest", shape: ampSourceInputShape },
        { name: "orgbrain_wiki_source_read", action: "sourceRead", shape: ampSourceReadInputShape }
      ];
      for (const { name, action, shape } of definitions) {
        registerTool(this.server, name, { ...shape, ...scope }, async input => {
          const tenantId = normalizeTenant(input.tenant_id, this.props);
          const mutation = action === "save" || action === "ingest";
          await this.requirePermission(tenantId, mutation ? "write" : "read", input.project_id);
          const amp = new CloudAmpService(this.env, { tenantId, principal: this.props.principal, projectId: input.project_id });
          const run = () => amp[action as "save" | "search" | "read" | "validate" | "ingest" | "sourceRead"](input);
          return toContent(mutation ? await this.auditedMutation(tenantId, name, "amp_document", run) : await run());
        }, (action === "save" || action === "ingest" ? "write" : "read"));
      }
    }
    registerMemoryRead(this);
    registerMemoryCapture(this);
    registerContextUse(this);
    registerKnowledge(this);
    registerOperations(this);


  }
}

export async function createOrgBrainMcpServer(env: Env, props: AgentProps, executionContext?: Pick<ExecutionContext, "waitUntil">) {
  const tools = new OrgBrainMcpTools(env, props, executionContext);
  await tools.init();
  return tools.server;
}

function mcpTransportValidationResponse(request: Request): Response | undefined {
  const requestUrl = new URL(request.url);
  const localEndpoint = localhostAllowedHostnames().includes(requestUrl.hostname);
  const workersDevEndpoint = requestUrl.hostname.endsWith(".workers.dev");
  const acceptedHostnames = localEndpoint
    ? localhostAllowedHostnames()
    : workersDevEndpoint
      ? [requestUrl.hostname]
      : undefined;
  const hostRejection = acceptedHostnames
    ? hostHeaderValidationResponse(request, acceptedHostnames)
    : undefined;
  if (hostRejection) return hostRejection;

  const acceptedOriginHostnames = new Set(localhostAllowedOrigins());
  if (workersDevEndpoint) acceptedOriginHostnames.add(requestUrl.hostname);

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "") {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
        return originValidationResponse(request, []);
      }
    } catch {
      // Delegate malformed Origin handling, including the SDK-compatible body,
      // to the public helper below.
    }
  }
  return originValidationResponse(request, [...acceptedOriginHostnames]);
}

export async function assertMcpToolAllowed(request: Request, props: AgentProps): Promise<void> {
  if (!props.allowedTools && props.authSource !== "oauth") return;
  if (request.method !== "POST") {
    throw new HttpError(403, "forbidden", "This MCP client installation can only call its allowed hook tool");
  }
  const body = await request.clone().json<{
    method?: unknown;
    params?: { name?: unknown; arguments?: Record<string, unknown> };
  }>().catch(() => null);
  if (body?.method !== "tools/call" || typeof body.params?.name !== "string") {
    if (props.authSource === "oauth" && body?.method === "server/discover") return;
    if (props.authSource === "oauth" && body?.method === "tools/list") return;
    throw new HttpError(403, "forbidden", "This MCP client installation cannot call that MCP method or tool");
  }
  if (props.allowedTools && !props.allowedTools.includes(body.params.name)) {
    throw new HttpError(403, "forbidden", "This MCP client installation cannot call that MCP method or tool");
  }
  if (props.authSource === "oauth") {
    const requirement = requirementForMcpTool(body.params.name);
    const requiredScope = body.params.name === "orgbrain_memory_quality_audit" &&
      body.params.arguments?.scope === "tenant"
      ? "orgbrain:audit"
      : requirement.scope;
    if (!props.scopes?.includes(requiredScope)) throw new McpInsufficientScopeError(requiredScope);
  }
}

function hookAuthEnv(request: Request, env: Env): Env {
  if (request.headers.get("x-orgbrain-hook-edge") !== "service-binding-v1") return env;
  if (!env.MCP_HOOK_ACCESS_AUD?.trim()) {
    throw new HttpError(503, "misconfigured", "MCP_HOOK_ACCESS_AUD is required for the hook edge");
  }
  return { ...env, MCP_ACCESS_AUD: env.MCP_HOOK_ACCESS_AUD };
}

export function mountMcp(app: Hono<any>) {
  app.post("/mcp/client-installations/activate", async (c) => {
    try {
      const claims = await verifyMcpAccessAssertion(c.req.raw, hookAuthEnv(c.req.raw, c.env));
      const accessSubject = accessServiceSubject(claims);
      if (!accessSubject) throw new HttpError(401, "unauthorized", "A Cloudflare Access service token is required");
      const body = await c.req.json<{ enrollment_code?: unknown; client_type?: unknown }>();
      if (
        typeof body.enrollment_code !== "string" ||
        (body.client_type !== "codex" && body.client_type !== "claude" && body.client_type !== "cursor")
      ) {
        throw new HttpError(400, "invalid_payload", "enrollment_code and a valid client_type are required");
      }
      const installation = await activateMcpClientInstallation(
        c.env,
        body.enrollment_code,
        accessSubject,
        body.client_type
      );
      await appendAuditEvent(c.env, {
        tenantId: installation.tenant_id,
        principal: installation.owner_principal,
        action: "mcp.client_installation.activate",
        resourceType: "mcp_client_installation",
        resourceId: installation.id,
        outcome: "succeeded",
        metadata: {
          auth_source: "access-service",
          runtime_actor: `client:${installation.id}`,
          client_installation_id: installation.id,
          client_type: installation.client_type
        }
      }).catch((error) => {
        console.warn({
          event: "orgbrain.mcp.client_installation.audit_failed",
          client_installation_id: installation.id,
          error_code: error instanceof HttpError ? error.code : "audit_write_failed"
        });
      });
      return c.json({ ok: true, data: installation }, 200);
    } catch (error) {
      if (error instanceof HttpError) return c.text(error.message, error.status as 400);
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });

  app.get("/mcp/client-installations/status", async (c) => {
    try {
      const auth = await authorizeMcpRequest(c.req.raw, hookAuthEnv(c.req.raw, c.env));
      if (auth.source !== "access-service" || !auth.clientInstallationId || !auth.clientType) {
        throw new HttpError(401, "unauthorized", "A registered Cloudflare Access service token is required");
      }
      return c.json({
        ok: true,
        data: {
          id: auth.clientInstallationId,
          tenant_id: auth.tenantId,
          client_type: auth.clientType,
          purpose: auth.clientPurpose,
          runtime_actor: auth.runtimeActor
        }
      });
    } catch (error) {
      if (error instanceof HttpError) return c.text(error.message, error.status as 400);
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });

  app.mount("/mcp", (request, env, ctx) => handleOrgBrainMcpRequest(request, env, ctx));
}

export async function handleOrgBrainMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authOverride?: McpAuthResult
): Promise<Response> {
    try {
      const hookEdge = request.headers.get("x-orgbrain-hook-edge") === "service-binding-v1";
      const auth = authOverride ?? await authorizeMcpRequest(request, hookAuthEnv(request, env));
      if (hookEdge && auth.source !== "access-service") {
        throw new HttpError(401, "unauthorized", "The hook edge accepts only registered Access service-token installations");
      }
      await assertRequestRateLimit(env, {
        tenantId: auth.tenantId,
        principal: auth.principal,
        path: "/mcp"
      });
      const props: AgentProps = {
        tenantId: auth.tenantId,
        principal: auth.principal,
        allowedTenants: auth.allowedTenants,
        defaultRole: auth.defaultRole,
        authSource: auth.source,
        runtimeActor: auth.runtimeActor,
        clientInstallationId: auth.clientInstallationId,
        clientType: auth.clientType,
        clientPurpose: auth.clientPurpose,
        ownerPrincipal: auth.ownerPrincipal,
        allowedTools: auth.allowedTools,
        scopes: auth.scopes
      };
      const transportValidationResponse = mcpTransportValidationResponse(request);
      if (transportValidationResponse) return transportValidationResponse;
      await assertMcpToolAllowed(request, props);
      const handler = createMcpHandler(
        () => createOrgBrainMcpServer(env, props, ctx),
        {
          // Hono mount strips /mcp for Access requests. The OAuth provider calls
          // this handler directly with the canonical path still present.
          route: authOverride?.source === 'oauth' ? '/mcp' : '/',
          legacy: "reject",
          corsOptions: false,
          authContext: { props }
        }
      );
      return await handler.fetch(request);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(JSON.stringify({
        event: "mcp_request_failed",
        error_name: failure.name,
        error_code: error instanceof HttpError ? error.code : null,
        error_status: error instanceof HttpError ? error.status : null,
        error_message: failure.message
          .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
          .slice(0, 300)
      }));
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status });
      }
      if (error instanceof McpInsufficientScopeError) {
        const resource = new URL(request.url);
        resource.search = "";
        resource.hash = "";
        const metadata = new URL("/.well-known/oauth-protected-resource/mcp", resource.origin);
        const challenge = [
          'Bearer error="insufficient_scope"',
          `scope="${error.scope}"`,
          `resource="${resource.toString()}"`,
          `resource_metadata="${metadata.toString()}"`
        ].join(", ");
        return new Response(error.message, {
          status: 403,
          headers: { "WWW-Authenticate": challenge }
        });
      }
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
}
