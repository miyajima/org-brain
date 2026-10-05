import type { AuthRequest, OAuthHelpers, OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { ORGBRAIN_OAUTH_SCOPES, type OrgBrainOAuthScope } from "@org-brain/contracts";
import { handleOrgBrainMcpRequest } from "./mcp";
import { authorizeMcpRequest, type McpAuthResult } from "./mcp-security";
import type { Env } from "./types";
import { remoteClientIdentity } from "./remote-client-identity";
import { OAuthDeviceSecurity } from './oauth-device-security';
import { OAuthGrantLedger } from './oauth-grant-ledger';
export { shouldUseMcpOAuth } from "./mcp-oauth-routing";

export type OAuthProps = {
  tenantId: string;
  principal: string;
  defaultRole: McpAuthResult["defaultRole"];
  scopes: OrgBrainOAuthScope[];
  projectId?: string;
  securityV2?: true;
  identity?: { issuer: string; subject: string; email: string | null };
};

type OAuthEnv = Env & { OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers };
type BaseFetch = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

export async function oauthProviderSubject(principal: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(principal));
  return `usr_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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
  if (env.ORGBRAIN_OAUTH_SECURITY_V2 === 'true' && client.tokenEndpointAuthMethod !== 'none') {
    return Response.json({ error: 'unauthorized_client' }, { status: 400 });
  }
  const access = await resolveAccessUser(request, env);
  if (access.source !== "access-user") {
    return new Response("Interactive user authentication is required", { status: 403 });
  }
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
  if (env.ORGBRAIN_OAUTH_SECURITY_V2 === 'true' && (scopes.length !== 2 || !scopes.includes('orgbrain:read') || !scopes.includes('orgbrain:write'))) {
    return Response.json({ error: 'invalid_scope' }, { status: 400 });
  }
  const subject = await oauthProviderSubject(access.principal);
  if (env.ORGBRAIN_OAUTH_SECURITY_V2 !== 'true') {
    await new OAuthGrantLedger(env, env.OAUTH_PROVIDER).revokeClientFamilies(subject, oauthRequest.clientId);
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    // The provider serializes userId with colon delimiters. OrgBrain canonical
    // principals intentionally contain colons, so use a stable opaque subject
    // there and retain the canonical principal only inside encrypted props.
    userId: subject,
    metadata: { tenant_id: access.tenantId, client_name: client.clientName ?? oauthRequest.clientId },
    scope: scopes,
    props: { tenantId: access.tenantId, principal: access.principal, defaultRole: access.defaultRole, scopes,
      ...(env.ORGBRAIN_OAUTH_SECURITY_V2 === 'true' ? { securityV2: true as const,
        identity: { issuer: access.identityIssuer!, subject: access.identitySubject!, email: access.identityEmail ?? null } } : {}) } satisfies OAuthProps,
    revokeExistingGrants: env.ORGBRAIN_OAUTH_SECURITY_V2 !== 'true'
  });
  return Response.redirect(redirectTo, 302);
}

export async function createCloudflareMcpOAuthProvider(env: Env, baseFetch: BaseFetch) {
  if (!env.OAUTH_KV) throw new Error("OAUTH_KV binding is required for MCP_AUTH_MODE=oauth or dual OAuth requests");
  const resource = env.MCP_OAUTH_RESOURCE?.trim();
  if (!resource || new URL(resource).pathname !== "/mcp" || new URL(resource).protocol !== "https:") {
    throw new Error("MCP_OAUTH_RESOURCE must be the canonical HTTPS /mcp URL");
  }
  const { default: OAuthProvider, getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
  const options: OAuthProviderOptions<Env> = {
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, oauthEnv, ctx) {
        const props = (ctx as ExecutionContext & { props?: OAuthProps }).props;
        if (!props) return new Response("Missing OAuth authorization context", { status: 500 });
        // The pinned provider's ctx.props retains original grant scopes. Refresh
        // can downscope the access token: enforce its effective scopes, not props.
        const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/iu)?.[1];
        const token = bearer ? await (oauthEnv as OAuthEnv).OAUTH_PROVIDER.unwrapToken<OAuthProps>(bearer) : null;
        if (!token || token.grant.props.principal !== props.principal || token.grant.props.tenantId !== props.tenantId ||
            token.scope.some(scope => !ORGBRAIN_OAUTH_SCOPES.includes(scope as OrgBrainOAuthScope))) {
          return new Response('Invalid OAuth authorization context', { status: 401 });
        }
        let effectiveProps = { ...props, scopes: token.scope as OrgBrainOAuthScope[] };
        const security = new OAuthDeviceSecurity(oauthEnv, (oauthEnv as OAuthEnv).OAUTH_PROVIDER,
          (req, bindings, execution) => provider.fetch(req, bindings, execution));
        if (oauthEnv.ORGBRAIN_OAUTH_SECURITY_V2 === 'true' || props.securityV2) {
          try {
            const current = await security.ledger.authorize(token.userId, token.grantId, props, token.grant.clientId);
            if (!current) {
              return new Response('OAuth grant is inactive', { status: 401 });
            }
            effectiveProps = { ...current, scopes: token.scope as OrgBrainOAuthScope[] };
          } catch { return new Response('OAuth security state unavailable', { status: 503 }); }
        }
        if (props.projectId && !await security.guardProject(request, effectiveProps)) return new Response('Forbidden project or tool', { status: 403 });
        if (new URL(request.url).pathname === '/mcp/identity') return remoteClientIdentity(request, oauthEnv, effectiveProps);
        return handleOrgBrainMcpRequest(request, oauthEnv, ctx, {
          principal: props.principal,
          tenantId: props.tenantId,
          allowedTenants: [props.tenantId],
          source: "oauth",
          defaultRole: effectiveProps.defaultRole,
          runtimeActor: `principal:${props.principal}`,
          scopes: effectiveProps.scopes
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
  };
  const provider = new OAuthProvider<Env>(options);
  const helpers = getOAuthApi(options, env);
  env.OAUTH_PROVIDER = helpers;
  return { fetch: (request: Request, oauthEnv: Env, ctx: ExecutionContext) => {
    const requestHelpers = getOAuthApi(options, oauthEnv);
    oauthEnv.OAUTH_PROVIDER = requestHelpers;
    const security = new OAuthDeviceSecurity(oauthEnv, requestHelpers, (req, bindings, execution) => provider.fetch(req, bindings, execution));
    return security.fetch(request, oauthEnv, ctx);
  } };
}
