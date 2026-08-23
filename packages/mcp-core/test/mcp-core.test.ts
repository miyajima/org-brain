import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  McpProtocolError,
  McpToolRegistry,
  oauthBearerChallenge,
  protectedResourceMetadata,
  validateMcpEnvelope,
  validateMcpTransport
} from "../src/index.js";

describe("MCP 2026-07-28 core", () => {
  it("requires self-describing stateless headers", () => {
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "orgbrain_prompt_recall"
      }
    });
    const transport = validateMcpTransport(request);
    expect(transport).toMatchObject({ method: "tools/call", name: "orgbrain_prompt_recall" });
    expect(() => validateMcpEnvelope(transport, {
      method: "tools/call", params: { name: "orgbrain_prompt_recall" }
    })).not.toThrow();
    expect(() => validateMcpEnvelope(transport, {
      method: "tools/call", params: { name: "orgbrain_memories_list" }
    })).toThrowError(expect.objectContaining({ code: "mcp_name_mismatch" }));
  });

  it("rejects missing routing metadata", () => {
    expect(() => validateMcpTransport(new Request("https://example.com/mcp", { method: "POST" })))
      .toThrow(McpProtocolError);
  });

  it("builds OAuth resource discovery and challenge values", () => {
    expect(protectedResourceMetadata({
      resource: "https://example.com/mcp",
      authorizationServers: ["https://example.com"],
      scopesSupported: ["orgbrain:read"]
    }).resource).toBe("https://example.com/mcp");
    expect(oauthBearerChallenge("https://example.com/.well-known/oauth-protected-resource/mcp", ["orgbrain:read"]))
      .toContain("orgbrain:read");
  });

  it("intersects token scope, role permission, and installation allow-list", async () => {
    const registry = new McpToolRegistry().register({
      name: "orgbrain_recall",
      inputSchema: { type: "object" },
      requirement: { permission: "read", scope: "orgbrain:read" },
      execute: async (input) => input
    });
    const context = {
      principal: "user:1", tenant_id: "tenant-1", role: "reader" as const,
      permissions: ["read" as const], auth_source: "oauth-access-token" as const,
      client_id: "client-1", scopes: ["orgbrain:read" as const], token_id: "jti-1",
      expires_at: Date.now() + 60_000, allowed_tools: ["orgbrain_recall"]
    };
    expect(registry.list(context)).toHaveLength(1);
    await expect(registry.call("orgbrain_recall", { query: "x" }, context)).resolves.toEqual({ query: "x" });
    await expect(registry.call("orgbrain_recall", {}, { ...context, scopes: [] }))
      .rejects.toMatchObject({ code: "insufficient_scope" });
    await expect(registry.call("orgbrain_recall", {}, { ...context, allowed_tools: [] }))
      .rejects.toMatchObject({ code: "tool_not_allowed" });
  });
});
