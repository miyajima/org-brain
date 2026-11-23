import type { Env } from "./types";

export function shouldUseMcpOAuth(request: Request, env: Env) {
  const mode = env.MCP_AUTH_MODE ?? "access";
  if (mode !== "oauth" && mode !== "dual") return false;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) return true;
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    if (mode === "oauth" || request.headers.has("authorization")) return true;
    if (path !== "/mcp" || !env.OAUTH_KV || !env.MCP_OAUTH_RESOURCE?.trim()) return false;
    return !["cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]
      .some((header) => request.headers.has(header));
  }
  return false;
}
