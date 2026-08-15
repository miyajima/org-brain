import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredTools = vi.hoisted(() => [] as string[]);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    tool(name: string) {
      registeredTools.push(name);
    }
  }
  return { McpServer: MockMcpServer };
});

vi.mock("agents/mcp", () => {
  class MockMcpAgent {
    env = {};
    props = { tenantId: "default" };
  }
  return { McpAgent: MockMcpAgent };
});

describe("legacy OrgBrain MCP tool surface", () => {
  beforeEach(() => {
    registeredTools.length = 0;
  });

  it("registers agent message tools", async () => {
    const { OrgBrainMCP } = await import("../src/index");
    const agent = new (OrgBrainMCP as any)();
    await agent.init();

    expect(registeredTools).toContain("orgbrain_messages_send");
    expect(registeredTools).toContain("orgbrain_messages_inbox");
    expect(registeredTools).toContain("orgbrain_messages_get");
    expect(registeredTools).toContain("orgbrain_messages_read");
    expect(registeredTools).toContain("orgbrain_messages_ack");
  });
});

describe("Access MCP proxy", () => {
  it("forwards only signed Access and MCP protocol headers", async () => {
    const { buildMcpProxyRequest } = await import("../src/index");
    const request = buildMcpProxyRequest(new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-oauth-token",
        "cf-access-client-id": "client-id",
        "cf-access-client-secret": "client-secret",
        "cf-access-jwt-assertion": "signed.assertion.jwt",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "x-orgbrain-tenant": "default",
        "x-untrusted": "drop-me"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }));

    expect(request.url).toBe("https://internal/mcp");
    expect(request.headers.get("cf-access-jwt-assertion")).toBe("signed.assertion.jwt");
    expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(request.headers.get("x-orgbrain-tenant")).toBe("default");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cf-access-client-id")).toBeNull();
    expect(request.headers.get("cf-access-client-secret")).toBeNull();
    expect(request.headers.get("x-untrusted")).toBeNull();
  });
});
