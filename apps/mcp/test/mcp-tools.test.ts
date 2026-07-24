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
