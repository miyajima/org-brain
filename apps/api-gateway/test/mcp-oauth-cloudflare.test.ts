import { describe, expect, it } from "vitest";
import { shouldUseMcpOAuth } from "../src/mcp-oauth-routing";
import type { Env } from "../src/types";

const env = (mode: Env["MCP_AUTH_MODE"]) => ({ MCP_AUTH_MODE: mode }) as Env;

describe("Cloudflare MCP OAuth routing", () => {
  it("routes all OAuth surfaces through the provider in oauth mode", () => {
    expect(shouldUseMcpOAuth(new Request("https://example.com/.well-known/oauth-protected-resource/mcp"), env("oauth"))).toBe(true);
    expect(shouldUseMcpOAuth(new Request("https://example.com/oauth/token"), env("oauth"))).toBe(true);
    expect(shouldUseMcpOAuth(new Request("https://example.com/mcp"), env("oauth"))).toBe(true);
  });

  it("keeps Access/service-token requests working during dual migration", () => {
    expect(shouldUseMcpOAuth(new Request("https://example.com/mcp"), env("dual"))).toBe(false);
    expect(shouldUseMcpOAuth(new Request("https://example.com/mcp", { headers: { authorization: "Bearer provider-token" } }), env("dual"))).toBe(true);
  });

  it("does not affect non-MCP HTTP APIs", () => {
    expect(shouldUseMcpOAuth(new Request("https://example.com/v1/memories"), env("oauth"))).toBe(false);
  });
});
