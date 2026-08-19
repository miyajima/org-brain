import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredTools = vi.hoisted(() => [] as string[]);

vi.mock("@modelcontextprotocol/server", () => {
  class MockMcpServer {
    registerTool(name: string) {
      registeredTools.push(name);
    }
  }
  return { McpServer: MockMcpServer };
});

describe("OrgBrainMCP tool surface", () => {
  beforeEach(() => {
    registeredTools.length = 0;
  });

  it("registers context and decision memory tools for agent preflight", async () => {
    const { createOrgBrainMcpServer } = await import("../src/mcp");
    await createOrgBrainMcpServer({} as never, {
      tenantId: "default",
      principal: "service:test",
      allowedTenants: ["default"],
      defaultRole: "service_agent"
    });

    expect(registeredTools).toContain("orgbrain_context_enrich");
    expect(registeredTools).toContain("orgbrain_memories_extract");
    expect(registeredTools).toContain("orgbrain_memories_capture_rationale");
    expect(registeredTools).toContain("orgbrain_decision_memories_create");
    expect(registeredTools).toContain("orgbrain_decision_memories_search");
    expect(registeredTools).toContain("orgbrain_resource_search");
    expect(registeredTools).toContain("orgbrain_resource_decisions");
    expect(registeredTools).toContain("orgbrain_decision_resources");
    expect(registeredTools).toContain("orgbrain_domain_context");
    expect(registeredTools).toContain("orgbrain_managed_object_search");
    expect(registeredTools).toContain("orgbrain_metric_query");
    expect(registeredTools.some((name) => name.includes("domain_pack_publish"))).toBe(false);
    expect(registeredTools.some((name) => name.includes("domain_pack_create"))).toBe(false);
    expect(registeredTools).toContain("orgbrain_messages_send");
    expect(registeredTools).toContain("orgbrain_handoff_send");
    expect(registeredTools).toContain("orgbrain_messages_inbox");
    expect(registeredTools).toContain("orgbrain_messages_get");
    expect(registeredTools).toContain("orgbrain_messages_read");
    expect(registeredTools).toContain("orgbrain_messages_ack");
  });
});
