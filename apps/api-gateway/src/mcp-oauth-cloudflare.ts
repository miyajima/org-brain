import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ORGBRAIN_OAUTH_SCOPES, type OrgBrainOAuthScope } from "@org-brain/contracts";
import { handleOrgBrainMcpRequest } from "./mcp";
import { authorizeMcpRequest, type McpAuthResult } from "./mcp-security";
import type { Env } from "./types";
export { shouldUseMcpOAuth } from "./mcp-oauth-routing";

type OAuthProps = {
  tenantId: string;
  principal: string;
  defaultRole: McpAuthResult["defaultRole"];
  scopes: OrgBrainOAuthScope[];
};

type OAuthEnv = Env & { OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers };
type BaseFetch = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/gu, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[char]!);

function csrfCookie(request: Request) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("__Host-orgbrain_oauth_csrf="))?.split("=").slice(1).join("=") ?? null;
}

function consentPage(request: Request, oauthRequest: AuthRequest, clientName: string) {
  const csrf = crypto.randomUUID();
  const action = new URL(request.url);
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OrgBrain MCP接続</title></head><body><main style="max-width:640px;margin:64px auto;font:16px system-ui;line-height:1.6"><h1>OrgBrain MCP接続</h1><p>${html(clientName)}へ次の権限を許可します。</p><ul>${oauthRequest.scope.map((scope) => `<li>${html(scope)}</li>`).join("")}</ul><form method="post" action="${html(`${action.pathname}${action.search}`)}"><input type="hidden" name="csrf" value="${html(csrf)}"><label><input type="checkbox" name="confirmed" value="yes" required> 接続先と権限を確認しました</label><p><button>許可する</button></p></form></main></body></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": `__Host-orgbrain_oauth_csrf=${encodeURIComponent(csrf)}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`
    }
  });
}

async function resolveAccessUser(request: Request, env: OAuthEnv) {
  return authorizeMcpRequest(request, { ...env, MCP_AUTH_MODE: "access" });
}

async function authorizationHandler(request: Request, env: OAuthEnv, baseFetch: BaseFetch, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (url.pathname !== "/oauth/authorize") return baseFetch(request, env, ctx);
  const parseRequest = request.method === "GET" ? request : new Request(request.url, { headers: request.headers });
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(parseRequest);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return new Response("Unknown OAuth client", { status: 400 });
  const access = await resolveAccessUser(request, env);
  if (request.method === "GET") return consentPage(request, oauthRequest, client.clientName ?? oauthRequest.clientId);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  if (!csrf || csrfCookie(request) !== encodeURIComponent(csrf) || form.get("confirmed") !== "yes") {
    return new Response("Invalid or missing consent confirmation", { status: 403 });
  }
  const scopes = oauthRequest.scope.filter((scope): scope is OrgBrainOAuthScope =>
    ORGBRAIN_OAUTH_SCOPES.includes(scope as OrgBrainOAuthScope));
  if (scopes.length !== oauthRequest.scope.length) return new Response("Unsupported scope", { status: 400 });
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: access.principal,
    metadata: { tenant_id: access.tenantId, client_name: client.clientName ?? oauthRequest.clientId },
    scope: scopes,
    props: { tenantId: access.tenantId, principal: access.principal, defaultRole: access.defaultRole, scopes } satisfies OAuthProps
  });
  return Response.redirect(redirectTo, 302);
}

export async function createCloudflareMcpOAuthProvider(env: Env, baseFetch: BaseFetch) {
  if (!env.OAUTH_KV) throw new Error("OAUTH_KV binding is required for MCP_AUTH_MODE=oauth or dual OAuth requests");
  const resource = env.MCP_OAUTH_RESOURCE?.trim();
  if (!resource || new URL(resource).pathname !== "/mcp" || new URL(resource).protocol !== "https:") {
    throw new Error("MCP_OAUTH_RESOURCE must be the canonical HTTPS /mcp URL");
  }
  const { default: OAuthProvider } = await import("@cloudflare/workers-oauth-provider");
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, oauthEnv, ctx) {
        const props = (ctx as ExecutionContext & { props?: OAuthProps }).props;
        if (!props) return new Response("Missing OAuth authorization context", { status: 500 });
        return handleOrgBrainMcpRequest(request, oauthEnv, ctx, {
          principal: props.principal,
          tenantId: props.tenantId,
          allowedTenants: [props.tenantId],
          source: "oauth",
          defaultRole: props.defaultRole,
          runtimeActor: `principal:${props.principal}`,
          scopes: props.scopes
        });
      }
    },
    defaultHandler: { fetch: (request, oauthEnv, ctx) => authorizationHandler(request, oauthEnv as OAuthEnv, baseFetch, ctx) },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...ORGBRAIN_OAUTH_SCOPES],
    allowPlainPKCE: false,
    accessTokenTTL: 600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource,
      authorization_servers: [new URL(resource).origin],
      scopes_supported: [...ORGBRAIN_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "OrgBrain MCP"
    }
  });
}
