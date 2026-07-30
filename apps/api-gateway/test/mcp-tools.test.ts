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
    props = { tenantId: "default", principal: "service:test", allowedTenants: ["default"] };
  }
  return { McpAgent: MockMcpAgent };
});

describe("OrgBrainMCP tool surface", () => {
  beforeEach(() => {
    registeredTools.length = 0;
  });

  it("registers context and decision memory tools for agent preflight", async () => {
    const { OrgBrainMCP } = await import("../src/mcp");
    const agent = new (OrgBrainMCP as any)();
    await agent.init();

    expect(registeredTools).toContain("orgbrain_context_enrich");
    expect(registeredTools).toContain("orgbrain_memories_extract");
    expect(registeredTools).toContain("orgbrain_decision_memories_create");
    expect(registeredTools).toContain("orgbrain_decision_memories_search");
    expect(registeredTools).toContain("orgbrain_messages_send");
    expect(registeredTools).toContain("orgbrain_handoff_send");
    expect(registeredTools).toContain("orgbrain_messages_inbox");
    expect(registeredTools).toContain("orgbrain_messages_get");
    expect(registeredTools).toContain("orgbrain_messages_read");
    expect(registeredTools).toContain("orgbrain_messages_ack");
  });
});
